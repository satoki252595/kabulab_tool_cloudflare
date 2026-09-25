/**
 * biztag CLI。設計: docs/005-yuho-quant-business-tags.md §11 (運用手順)。
 *
 * リポジトリルートから `pnpm biztag <subcommand>` で呼ぶ (package.json の
 * "biztag" スクリプト実体)。標準出力に JSON サマリ、CI 実行時は
 * `$GITHUB_STEP_SUMMARY` に markdown も出す。運営が判断すべきこと (関門の
 * 不採用・見直し期限切れ等) は `$GITHUB_OUTPUT` へ `notify`/`notify_title`/
 * `notify_summary` を書く (`catchup.yml`/`backfill.yml` が読む)。
 *
 * サブコマンド: run / gate / golden / rollback / packet / stats。
 */
import "dotenv/config";
import { appendFileSync, readFileSync } from "node:fs";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import {
  createLedgerEntry,
  ensureLedgerDb,
  ensureSupplementDb,
  listLedgerEntries,
  loadSupplementRows,
  readLedgerJson,
  replaceLedgerJson,
  updateLedgerEntry,
} from "../../../src/shared/notion-archive/index.js";
import { createJevClient, jevEnv } from "../../../src/shared/jev/index.js";
import { resolveActiveVocabulary } from "../src/biztag/active-vocab.js";
import { todayJst } from "../src/biztag/date-jst.js";
import { checkDeadline, runGate } from "../src/biztag/gate.js";
import { evaluateAtThresholds, evaluateGolden, loadGoldenSet, type GoldenPerItemResult } from "../src/biztag/golden.js";
import { fetchGoldenTexts, makeEvaluateGoldenForVocab, runBiztag } from "../src/biztag/pipeline.js";
import { buildReviewPacket, refreshReviewPacketLedger } from "../src/biztag/review.js";
import { rollback } from "../src/biztag/rollback.js";
import { type BiztagSourceDb } from "../src/biztag/source.js";
import { verifySources } from "../src/biztag/sources-verify.js";
import { loadCalibration } from "../src/biztag/thresholds.js";
import { parseVocabulary } from "../src/biztag/vocabulary/load.js";
import { TEXT_SECTIONS } from "../src/services/edinet/text-sections.js";
import * as yuhoSchema from "../src/db/schema.js";

const [, , subcommand, ...rest] = process.argv;

function arg(name: string): string | undefined {
  return rest.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}
function hasFlag(name: string): boolean {
  return rest.includes(`--${name}`);
}

function writeGithubOutput(pairs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  let out = "";
  for (const [key, value] of Object.entries(pairs)) {
    if (value.includes("\n")) {
      const delimiter = `EOF_${key}_${Math.random().toString(36).slice(2)}`;
      out += `${key}<<${delimiter}\n${value}\n${delimiter}\n`;
    } else {
      out += `${key}=${value}\n`;
    }
  }
  appendFileSync(file, out, "utf-8");
}

function writeGithubStepSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, `${markdown}\n`, "utf-8");
}

async function runCommand(): Promise<void> {
  const { model, thresholds } = loadCalibration();
  const budgetMin = arg("budget-min") ? Number(arg("budget-min")) : 20;
  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const codes = arg("codes")
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const dryRun = hasFlag("dry-run");

  const summary = await runBiztag({
    budgetMs: budgetMin * 60_000,
    limit,
    codes,
    dryRun,
    thresholds,
    model,
  });

  console.info(JSON.stringify(summary, null, 2));
  writeGithubStepSummary(
    [
      `## biztag run`,
      `- 対象: ${summary.totalStocks} 銘柄 (処理 ${summary.processed} / 残 ${summary.remaining})`,
      `- 判定済率: ${(summary.coverage.ratio * 100).toFixed(1)}%`,
      `- jev: ${summary.jev.calls}回 / 入力 ${summary.jev.inputTokens}tok / 概算 $${summary.jev.estimatedCostUsd.toFixed(4)}`,
      `- Notion: ${summary.notion.requests}リクエスト (429 ${summary.notion.rateLimited}回)`,
      `- 単語帳: ${summary.vocabVersion}${summary.vocabSeeded ? " (初回投入)" : ""}`,
      `- 失敗: ${summary.failures.length}件`,
    ].join("\n")
  );

  const failureNote =
    summary.failures.length > 0
      ? `\n失敗した銘柄 (最大10件): ${summary.failures
          .slice(0, 10)
          .map((f) => `${f.stockCode}: ${f.message}`)
          .join(" / ")}`
      : "";

  const gateNotify = summary.gate.notify;
  const deadlineNotify = summary.deadline.shouldNotify
    ? { title: "[biztag] 単語帳の見直しが期限切れです", summary: `期限 (${summary.deadline.deadline}) までに提案が届きませんでした` }
    : null;
  const notify = gateNotify ?? deadlineNotify;

  if (notify) {
    writeGithubOutput({
      notify: "true",
      notify_title: notify.title,
      notify_summary: `${notify.summary}${failureNote}`,
    });
  } else {
    writeGithubOutput({ notify: "false" });
  }
}

async function gateCommand(): Promise<void> {
  const { model, thresholds } = loadCalibration();
  const db = createD1HttpDb(yuhoSchema) as unknown as BiztagSourceDb;
  const jevClient = createJevClient({ apiKey: jevEnv.TYPESAFE_API_KEY(), model });
  const ledgerDbId = await ensureLedgerDb();
  const today = todayJst();

  const result = await runGate({
    ledgerDbId,
    listLedgerEntries,
    readLedgerJson,
    createLedgerEntry,
    updateLedgerEntry,
    verifySources,
    evaluateGoldenForVocab: makeEvaluateGoldenForVocab(db, jevClient, thresholds),
    recordedAt: today,
  });
  console.info(JSON.stringify(result, null, 2));
}

/** yesMin を 0.50〜0.95 (0.05刻み) で振ったときの表。noMax は固定し、jev は呼び直さない。 */
function formatThresholdSweep(perItem: GoldenPerItemResult[], noMax: number): string {
  const fmt = (v: number | null): string => (v === null ? "—" : v.toFixed(3));
  const lines = [
    "yesMin | noMax | precisionYes | recallYes | mustHitRecall | mustNotViolations | filterMissRate",
    "---|---|---|---|---|---|---",
  ];
  for (let i = 0; i <= 9; i++) {
    const yesMin = Math.round((0.5 + i * 0.05) * 100) / 100;
    if (!(noMax > 0 && noMax < yesMin && yesMin < 1)) {
      // しきい値の前提 (0 < noMax < yesMin < 1) を満たさない組は評価不能として
      // 明示する (無効な組を無言でスキップしない — ルール2)。
      lines.push(`${yesMin.toFixed(2)} | ${noMax} | (noMax >= yesMin のため対象外) | | | |`);
      continue;
    }
    const m = evaluateAtThresholds(perItem, { yesMin, noMax });
    lines.push(
      `${yesMin.toFixed(2)} | ${noMax} | ${fmt(m.precisionYes)} | ${fmt(m.recallYes)} | ${fmt(m.mustHitRecall)} | ${m.mustNotViolations} | ${fmt(m.filterMissRate)}`
    );
  }
  return lines.join("\n");
}

async function goldenCommand(): Promise<void> {
  const yesMinArg = arg("yes-min");
  const noMaxArg = arg("no-max");
  const modelArg = arg("model");
  const outPath = arg("out");

  // calibration.json が無いブートストラップ時 (最初の較正) でも、しきい値を
  // 両方明示すれば実行できる (§11.4)。それ以外は今までどおり loadCalibration() が
  // 無ければ throw する (既定値では起動しない — ルール2)。
  let yesMin: number;
  let noMax: number;
  let model: string;
  if (yesMinArg !== undefined && noMaxArg !== undefined) {
    yesMin = Number(yesMinArg);
    noMax = Number(noMaxArg);
    if (modelArg === undefined) {
      console.error(
        "usage: calibration.json が無い状態で --yes-min= と --no-max= を指定する場合、--model=<jev モデル名> も必須です。"
      );
      process.exit(2);
    }
    model = modelArg;
  } else {
    const calibration = loadCalibration();
    yesMin = yesMinArg !== undefined ? Number(yesMinArg) : calibration.thresholds.yesMin;
    noMax = noMaxArg !== undefined ? Number(noMaxArg) : calibration.thresholds.noMax;
    model = modelArg ?? calibration.model;
  }

  const goldenSet = loadGoldenSet();
  // --vocab-file= を渡すと台帳を読まずにそのファイルの単語帳で測る (台帳へ v1 を投入する
  // 前の最初の較正や、提案前の試算で使う。台帳には何も書かない)。無ければ台帳の有効な版。
  const vocabFile = arg("vocab-file");
  const vocab =
    vocabFile !== undefined
      ? parseVocabulary(JSON.parse(readFileSync(vocabFile, "utf-8")))
      : (await resolveActiveVocabulary(todayJst())).vocab;
  const jevClient = createJevClient({ apiKey: jevEnv.TYPESAFE_API_KEY(), model });
  const db = createD1HttpDb(yuhoSchema) as unknown as BiztagSourceDb;
  const texts = await fetchGoldenTexts(db, goldenSet.items);

  const evaluation = await evaluateGolden(goldenSet, vocab, texts, jevClient, { yesMin, noMax });
  console.info(JSON.stringify(evaluation, null, 2));
  if (outPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, JSON.stringify(evaluation, null, 2), "utf-8");
  }

  // 較正用の閾値スイープ表 (yesMin だけ振る。noMax はこの実行で使った値に固定)。
  // 既に取得済みの確率 (perItem) から再計算するだけなので jev は呼び直さない。
  console.info("\n## しきい値スイープ (yesMin 0.50〜0.95, noMax 固定, jev 再呼び出しなし)\n");
  console.info(formatThresholdSweep(evaluation.perItem, noMax));
}

async function rollbackCommand(): Promise<void> {
  const to = arg("to");
  const reason = arg("reason");
  if (!to || !reason) {
    console.error("usage: pnpm biztag rollback -- --to=vN --reason=... (両方必須)");
    process.exit(2);
  }
  const result = await rollback(to, reason, todayJst());
  console.info(JSON.stringify(result, null, 2));
}

async function packetCommand(): Promise<void> {
  const { vocab } = await resolveActiveVocabulary(todayJst());
  const { dbId, propertyIds } = await ensureSupplementDb({
    textColumns: TEXT_SECTIONS.map((t) => t.title),
    upstreamOptions: vocab.business.filter((t) => !t.deprecated && t.notionColumn === "upstream").map((t) => t.labelJa),
    downstreamOptions: vocab.business
      .filter((t) => !t.deprecated && t.notionColumn === "downstream")
      .map((t) => t.labelJa),
    themeOptions: vocab.themes.filter((t) => !t.deprecated).map((t) => t.labelJa),
    versionOptions: [vocab.version],
    sector33Options: [],
  });
  const rows = await loadSupplementRows(dbId, propertyIds, {});
  const packet = buildReviewPacket(rows, vocab, new Date().toISOString());
  const ledgerDbId = await ensureLedgerDb();
  const result = await refreshReviewPacketLedger({
    dbId: ledgerDbId,
    packet,
    listLedgerEntries,
    readLedgerJson,
    createLedgerEntry,
    replaceLedgerJson,
  });
  console.info(JSON.stringify({ updated: result.updated, termStats: packet.termStats.length }, null, 2));
}

async function statsCommand(): Promise<void> {
  const { vocab, entry } = await resolveActiveVocabulary(todayJst());
  const today = todayJst();
  const deadline = checkDeadline(today, await listLedgerEntries(await ensureLedgerDb()));
  console.info(
    JSON.stringify(
      {
        vocabVersion: vocab.version,
        vocabRecordedAt: entry.recordedAt,
        businessTermCount: vocab.business.filter((t) => !t.deprecated).length,
        themeCount: vocab.themes.filter((t) => !t.deprecated).length,
        deadline,
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  switch (subcommand) {
    case "run":
      return runCommand();
    case "gate":
      return gateCommand();
    case "golden":
      return goldenCommand();
    case "rollback":
      return rollbackCommand();
    case "packet":
      return packetCommand();
    case "stats":
      return statsCommand();
    default:
      console.error(
        "usage: pnpm biztag <run|gate|golden|rollback|packet|stats> [options] (docs/005-yuho-quant-business-tags.md §11)"
      );
      process.exit(2);
  }
}

await main();
