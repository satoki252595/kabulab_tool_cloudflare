/**
 * 監査レポート (#146 A/B/C) の正準数値ブロック生成＋検証 (Issue #151)。
 *
 * A/B/C の Markdown 報告を人手転記していたため、分類・合計・日付・SHA省略・
 * 保留/候補の矛盾が混入した。本スクリプトは docs/test-logs/ の results.json を
 * 唯一の入力とし、各レポート内の生成ブロックを機械生成する。合計は内訳から
 * 計算し、本文の要約層は数値の再入力ではなく集計ID参照にする。
 *
 * 実行 (network・env 不要。CI の check ジョブから起動):
 *   tsx scripts/audit/render-data-audit.ts --check            # 検証のみ (既定)
 *   tsx scripts/audit/render-data-audit.ts --write            # 生成ブロックをレポートへ反映
 *   tsx scripts/audit/render-data-audit.ts --print <section>  # 1 section の生成文を stdout へ
 *
 * 検査内容 (いずれも違反があれば exit 1):
 *   E_SCHEMA      results.json の形状不正 (Zod)
 *   E_TOTAL       aggregate.total と内訳合計の不一致
 *   E_NUM         件数の非整数・負数、coverage の matched > total
 *   E_STATE       state=verified の coverage が matched != total
 *   E_SHA         sha256 の全文64桁hex以外 (省略形の混入防止)
 *   E_SHA_STATE   sha256 未記録なのに時刻 state が exact
 *   E_DATE        日付形式・前後関係の破れ、snapshot 未来の確定時刻
 *   E_QUARANTINE  隔離候補と保留の重なり (未証明項目の候補混入防止)
 *   E_DUPID       項目IDの重複
 *   E_BLOCK       レポート内ブロックの欠落・重複・手編集 (byte 不一致)
 *   E_REF         本文の集計ID参照の未解決
 *
 * 対象は今回の A/B/C 監査分のみ。汎用レポート基盤ではない。
 * 自動 checker は語義・源泉の正確性を保証しない。原因解釈は本文と証拠項目IDで
 * 人がレビューすること (results.json の note・unverified がレビュー対象)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rootCauseMessage } from "../../src/shared/errors.js";
import { z } from "../../src/shared/zod-mini.js";

const MANIFEST_PATH = "docs/test-logs/data-audit-2026-09-28.results.json";
const REF_PATTERN = /集計ID:([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const EXACT_TIME_PATTERN = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?$/;

/* ---------- schema (形状のみ。意味検査は validateManifest が担う) ---------- */

const PopulationSchema = z.object({
  id: z.string(),
  label: z.string(),
  n: z.number(),
  note: z.optional(z.string()),
});

const PartSchema = z.object({
  id: z.string(),
  label: z.string(),
  n: z.number(),
});

const AggregateSchema = z.object({
  id: z.string(),
  label: z.string(),
  total: z.number(),
  state: z.enum(["verified", "mismatch", "unverified"]),
  source: z.enum(["recomputed", "report-stated", "evidence-reviewed"]),
  note: z.optional(z.string()),
  parts: z.array(PartSchema),
});

const CoverageSchema = z.object({
  id: z.string(),
  label: z.string(),
  matched: z.number(),
  total: z.number(),
  state: z.enum(["verified", "mismatch", "unverified"]),
  note: z.optional(z.string()),
});

const CandidateSchema = z.object({
  id: z.string(),
  scope: z.string(),
  tables: z.array(z.string()),
});

const HoldSchema = z.object({
  id: z.string(),
  reason: z.string(),
});

const EvidenceSchema = z.object({
  id: z.string(),
  path: z.string(),
  sha256: z.nullable(z.string()),
  bytes: z.nullable(z.number()),
  timeState: z.enum(["exact", "mtime-only", "unverified"]),
  exactTime: z.optional(z.string()),
  note: z.string(),
});

const SectionSchema = z.object({
  report: z.string(),
  blockId: z.string(),
  businessDay: z.string(),
  snapshotDate: z.string(),
  savedLatest: z.nullable(z.string()),
  dateNote: z.optional(z.string()),
  populations: z.array(PopulationSchema),
  aggregates: z.array(AggregateSchema),
  coverages: z.array(CoverageSchema),
  quarantines: z.object({
    candidates: z.array(CandidateSchema),
    holds: z.array(HoldSchema),
    note: z.optional(z.string()),
  }),
  evidence: z.array(EvidenceSchema),
  unverified: z.array(z.string()),
});

const ManifestSchema = z.object({
  contractVersion: z.literal(1),
  auditDate: z.string(),
  issue: z.number(),
  note: z.string(),
  sections: z.object({
    fundamentals: SectionSchema,
    moneyflow: SectionSchema,
    market: z.optional(SectionSchema),
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Section = z.infer<typeof SectionSchema>;

export function beginMarker(blockId: string): string {
  return `<!-- audit-report:BEGIN ${blockId} -->`;
}

export function endMarker(blockId: string): string {
  return `<!-- audit-report:END ${blockId} -->`;
}

/** Zod 形状検査。失敗時は E_SCHEMA を先頭にした例外を投げる。 */
export function parseManifest(json: unknown): Manifest {
  try {
    return ManifestSchema.parse(json);
  } catch (error) {
    throw new Error(`E_SCHEMA: results.json の形状が不正です: ${rootCauseMessage(error)}`);
  }
}

function isCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function isCalendarDate(value: string): boolean {
  const m = DATE_PATTERN.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** 意味検査。違反がなければ空配列を返す。 */
export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];
  const seenIds = new Map<string, string>();
  const claimId = (id: string, where: string) => {
    if (id.trim() === "") {
      errors.push(`E_DUPID: ${where} の項目IDが空です`);
      return;
    }
    const prev = seenIds.get(id);
    if (prev !== undefined) {
      errors.push(`E_DUPID: 項目ID ${id} が重複しています (${prev} / ${where})`);
      return;
    }
    seenIds.set(id, where);
  };

  if (!isCalendarDate(manifest.auditDate)) {
    errors.push(`E_DATE: auditDate が YYYY-MM-DD の実在日付ではありません: ${manifest.auditDate}`);
  }
  for (const [sectionKey, section] of Object.entries(manifest.sections)) {
    if (section === undefined) continue;
    const where = `sections.${sectionKey}`;
    for (const field of ["businessDay", "snapshotDate"] as const) {
      if (!isCalendarDate(section[field])) {
        errors.push(`E_DATE: ${where}.${field} が実在日付ではありません: ${section[field]}`);
      }
    }
    if (section.savedLatest !== null && !isCalendarDate(section.savedLatest)) {
      errors.push(`E_DATE: ${where}.savedLatest が実在日付ではありません: ${section.savedLatest}`);
    }
    if (section.snapshotDate !== manifest.auditDate) {
      errors.push(
        `E_DATE: ${where}.snapshotDate (${section.snapshotDate}) が auditDate (${manifest.auditDate}) と一致しません`,
      );
    }
    if (section.savedLatest !== null && section.savedLatest > section.businessDay) {
      errors.push(`E_DATE: ${where}.savedLatest が businessDay より未来です`);
    }
    if (section.businessDay > section.snapshotDate) {
      errors.push(`E_DATE: ${where}.businessDay が snapshotDate より未来です`);
    }
    if (section.savedLatest === null && (section.dateNote ?? "").trim() === "") {
      errors.push(`E_DATE: ${where}.savedLatest を null にする場合は dateNote で理由が必須です`);
    }

    for (const pop of section.populations) {
      claimId(pop.id, `${where}.populations`);
      if (!isCount(pop.n)) errors.push(`E_NUM: ${pop.id} の n が非負整数ではありません: ${pop.n}`);
      if (pop.label.trim() === "") errors.push(`E_NUM: ${where}.populations に空ラベルがあります`);
    }
    for (const agg of section.aggregates) {
      claimId(agg.id, `${where}.aggregates`);
      if (!isCount(agg.total)) {
        errors.push(`E_NUM: ${agg.id} の total が非負整数ではありません: ${agg.total}`);
      }
      let sum = 0;
      for (const part of agg.parts) {
        claimId(part.id, `${where}.aggregates.${agg.id}`);
        if (!isCount(part.n)) {
          errors.push(`E_NUM: ${agg.id}.${part.id} の n が非負整数ではありません: ${part.n}`);
        } else {
          sum += part.n;
        }
      }
      if (isCount(agg.total) && sum !== agg.total) {
        errors.push(`E_TOTAL: ${agg.id} の total (${agg.total}) が内訳合計 (${sum}) と一致しません`);
      }
      if (agg.label.trim() === "") errors.push(`E_NUM: ${agg.id} のラベルが空です`);
    }
    for (const cov of section.coverages) {
      claimId(cov.id, `${where}.coverages`);
      if (!isCount(cov.matched) || !isCount(cov.total)) {
        errors.push(`E_NUM: ${cov.id} の matched/total が非負整数ではありません`);
      } else if (cov.matched > cov.total) {
        errors.push(`E_NUM: ${cov.id} の matched (${cov.matched}) が total (${cov.total}) を超えています`);
      } else if (cov.state === "verified" && cov.matched !== cov.total) {
        errors.push(`E_STATE: ${cov.id} は verified ですが matched != total です`);
      }
      if (cov.label.trim() === "") errors.push(`E_NUM: ${cov.id} のラベルが空です`);
    }

    const holdIds = new Set(section.quarantines.holds.map((h) => h.id));
    for (const cand of section.quarantines.candidates) {
      claimId(cand.id, `${where}.quarantines.candidates`);
      if (holdIds.has(cand.id)) {
        errors.push(`E_QUARANTINE: ${cand.id} が隔離候補と保留の両方に入っています`);
      }
      if (cand.tables.length === 0) errors.push(`E_QUARANTINE: ${cand.id} の tables が空です`);
    }
    for (const hold of section.quarantines.holds) {
      claimId(hold.id, `${where}.quarantines.holds`);
      if (hold.reason.trim() === "") errors.push(`E_QUARANTINE: ${hold.id} の reason が空です`);
    }

    for (const ev of section.evidence) {
      claimId(ev.id, `${where}.evidence`);
      if (ev.sha256 !== null && !SHA_PATTERN.test(ev.sha256)) {
        errors.push(`E_SHA: ${ev.id} の sha256 が全文64桁hexではありません: ${ev.sha256}`);
      }
      if (ev.bytes !== null && !isCount(ev.bytes)) {
        errors.push(`E_NUM: ${ev.id} の bytes が非負整数ではありません: ${ev.bytes}`);
      }
      if (ev.timeState === "exact") {
        if (ev.exactTime === undefined) {
          errors.push(`E_SHA_STATE: ${ev.id} は timeState=exact ですが exactTime がありません`);
        } else if (!EXACT_TIME_PATTERN.test(ev.exactTime) || Number.isNaN(Date.parse(ev.exactTime))) {
          errors.push(`E_DATE: ${ev.id} の exactTime が ISO日時ではありません: ${ev.exactTime}`);
        } else if (ev.exactTime.slice(0, 10) > section.snapshotDate) {
          errors.push(`E_DATE: ${ev.id} の exactTime が snapshot 未来です: ${ev.exactTime}`);
        }
      } else if (ev.exactTime !== undefined) {
        errors.push(
          `E_SHA_STATE: ${ev.id} は timeState=${ev.timeState} のため exactTime を持てません (mtime を観測時刻にしない)`,
        );
      }
    }
    for (const item of section.unverified) {
      if (item.trim() === "") errors.push(`E_NUM: ${where}.unverified に空項目があります`);
    }
  }
  return errors;
}

/* ---------- 生成 ---------- */

const STATE_LABEL: Record<string, string> = {
  verified: "確認済み",
  mismatch: "不一致あり",
  unverified: "未検証",
};

const SOURCE_LABEL: Record<string, string> = {
  recomputed: "既存dumpから再導出",
  "report-stated": "報告書記載値",
  "evidence-reviewed": "証拠を見た人手判定",
};

function stateLabel(state: string): string {
  const label = STATE_LABEL[state];
  if (label === undefined) throw new Error(`E_SCHEMA: 未知の state です: ${state}`);
  return label;
}

function sourceLabel(source: string): string {
  const label = SOURCE_LABEL[source];
  if (label === undefined) throw new Error(`E_SCHEMA: 未知の source です: ${source}`);
  return label;
}

function timeLabel(ev: Section["evidence"][number]): string {
  if (ev.timeState === "exact") return `確定時刻 ${ev.exactTime ?? ""}`.trimEnd();
  if (ev.timeState === "mtime-only") return "ファイルmtimeのみ（観測時刻ではない）";
  return "未確認";
}

/** 1 section の生成ブロック全文 (マーカー込み)。時刻・乱数を含まず決定的。 */
export function renderBlock(manifest: Manifest, sectionKey: string): string {
  const section = manifest.sections[sectionKey as keyof Manifest["sections"]];
  if (section === undefined) throw new Error(`E_SCHEMA: 未知の section です: ${sectionKey}`);
  const lines: string[] = [];
  lines.push(beginMarker(section.blockId));
  lines.push(`## 生成集計ブロック: ${section.blockId}（機械生成・手編集禁止）`);
  lines.push("");
  lines.push(
    `生成元 \`${MANIFEST_PATH}\`（contract v${manifest.contractVersion}・Issue #${manifest.issue}）。` +
      "本文の要約層は数値を再入力せず集計ID参照にすること。",
  );
  lines.push(
    "自動 checker は語義・源泉の正確性を保証しない。原因解釈は本文と証拠項目IDで人がレビューすること。",
  );
  lines.push("");
  lines.push(
    `監査スナップショット日 ${section.snapshotDate} / 最新確定営業日 ${section.businessDay} / ` +
      `保存系列最新 ${section.savedLatest ?? "ドメイン別（下記注）"}`,
  );
  if (section.dateNote !== undefined) lines.push(`日付注: ${section.dateNote}`);
  lines.push("");
  lines.push("### 母集団");
  lines.push("");
  lines.push("| 項目ID | 内容 | n |");
  lines.push("|---|---|---:|");
  for (const pop of section.populations) {
    lines.push(`| ${pop.id} | ${pop.label} | ${pop.n} |`);
  }
  lines.push("");
  lines.push("### 内訳集計（合計は内訳から計算）");
  lines.push("");
  lines.push("| 項目ID | 内訳 | 合計 | 状態 | 出所 |");
  lines.push("|---|---|---:|---|---|");
  for (const agg of section.aggregates) {
    const sum = agg.parts.reduce((acc, p) => acc + p.n, 0);
    const parts = agg.parts.map((p) => `${p.label}${p.n}`).join("＋");
    lines.push(`| ${agg.id} | ${parts} | ${sum} | ${stateLabel(agg.state)} | ${sourceLabel(agg.source)} |`);
    if (agg.note !== undefined) lines.push(`> ${agg.id}: ${agg.note}`);
  }
  lines.push("");
  lines.push("### 照合カバレッジ");
  lines.push("");
  lines.push("| 項目ID | 内容 | 一致/母数 | 状態 |");
  lines.push("|---|---|---:|---|");
  for (const cov of section.coverages) {
    lines.push(`| ${cov.id} | ${cov.label} | ${cov.matched}/${cov.total} | ${stateLabel(cov.state)} |`);
    if (cov.note !== undefined) lines.push(`> ${cov.id}: ${cov.note}`);
  }
  lines.push("");
  lines.push("### 隔離候補・保留");
  lines.push("");
  if (section.quarantines.candidates.length === 0 && section.quarantines.holds.length === 0) {
    lines.push(`隔離候補・保留ともに該当なし。${section.quarantines.note ?? ""}`.trimEnd());
  } else {
    for (const cand of section.quarantines.candidates) {
      lines.push(`- 候補 ${cand.id}: ${cand.scope}（${cand.tables.join("・")}）`);
    }
    for (const hold of section.quarantines.holds) {
      lines.push(`- 保留 ${hold.id}: ${hold.reason}`);
    }
  }
  lines.push("");
  lines.push("### 証拠");
  lines.push("");
  lines.push("| 項目ID | path | sha256 | bytes | 時刻state | 備考 |");
  lines.push("|---|---|---|---|---|---|");
  for (const ev of section.evidence) {
    lines.push(
      `| ${ev.id} | \`${ev.path}\` | ${ev.sha256 ?? "未記録（制約）"} | ${ev.bytes ?? "—"} | ${timeLabel(ev)} | ${ev.note} |`,
    );
  }
  lines.push("");
  lines.push("### 未検証範囲（合格に数えない）");
  lines.push("");
  for (const item of section.unverified) lines.push(`- ${item}`);
  lines.push(endMarker(section.blockId));
  return `${lines.join("\n")}\n`;
}

/* ---------- レポート検査 ---------- */

/** マーカー外の本文に残る集計ID参照を集める。 */
export function collectRefs(bodyWithoutBlocks: string): string[] {
  const refs: string[] = [];
  for (const m of bodyWithoutBlocks.matchAll(REF_PATTERN)) refs.push(m[1]);
  return refs;
}

function stripBlocks(text: string, blockIds: string[]): string {
  let out = text;
  for (const blockId of blockIds) {
    const begin = beginMarker(blockId);
    const end = endMarker(blockId);
    for (;;) {
      const s = out.indexOf(begin);
      if (s === -1) break;
      const e = out.indexOf(end, s + begin.length);
      if (e === -1) break;
      out = out.slice(0, s) + out.slice(e + end.length);
    }
  }
  return out;
}

/**
 * 全 section のレポート検査 (ブロック byte 一致＋参照解決)。
 * rootDir はリポジトリルート。違反がなければ空配列を返す。
 */
export function checkFiles(manifest: Manifest, rootDir: string): string[] {
  const errors: string[] = [];
  const idIndex = new Set<string>();
  for (const section of Object.values(manifest.sections)) {
    if (section === undefined) continue;
    for (const pop of section.populations) idIndex.add(pop.id);
    for (const agg of section.aggregates) {
      idIndex.add(agg.id);
      for (const part of agg.parts) idIndex.add(part.id);
    }
    for (const cov of section.coverages) idIndex.add(cov.id);
    for (const cand of section.quarantines.candidates) idIndex.add(cand.id);
    for (const hold of section.quarantines.holds) idIndex.add(hold.id);
    for (const ev of section.evidence) idIndex.add(ev.id);
  }

  for (const [sectionKey, section] of Object.entries(manifest.sections)) {
    if (section === undefined) continue;
    const reportPath = join(rootDir, section.report);
    if (!existsSync(reportPath)) {
      errors.push(`E_BLOCK: レポートが存在しません: ${section.report}`);
      continue;
    }
    const text = readFileSync(reportPath, "utf8");
    const begin = beginMarker(section.blockId);
    const end = endMarker(section.blockId);
    const first = text.indexOf(begin);
    const last = text.lastIndexOf(begin);
    if (first === -1) {
      errors.push(`E_BLOCK: 生成ブロックがありません: ${section.report} (${section.blockId})`);
      continue;
    }
    if (first !== last) {
      errors.push(`E_BLOCK: 生成ブロックが重複しています: ${section.report} (${section.blockId})`);
      continue;
    }
    const endPos = text.indexOf(end, first + begin.length);
    if (endPos === -1) {
      errors.push(`E_BLOCK: 生成ブロックの END マーカーがありません: ${section.report}`);
      continue;
    }
    const expected = renderBlock(manifest, sectionKey);
    const actual = text.slice(first, endPos + end.length + 1);
    const actualNormalized = actual.endsWith("\n") ? actual : `${actual}\n`;
    if (actualNormalized !== expected) {
      errors.push(
        `E_BLOCK: 生成ブロックが手編集されています (byte不一致): ${section.report} ` +
          `(--write で再生成すること。差分は目視レビュー対象)`,
      );
    }
    const body = stripBlocks(text, [section.blockId]);
    for (const ref of collectRefs(body)) {
      if (!idIndex.has(ref)) errors.push(`E_REF: 未解決の集計ID参照です: ${section.report} の集計ID:${ref}`);
    }
  }
  return errors;
}

/* ---------- CLI ---------- */

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function runCheck(rootDir: string): string[] {
  const raw = readFileSync(join(rootDir, MANIFEST_PATH), "utf8");
  const manifest = parseManifest(JSON.parse(raw) as unknown);
  return [...validateManifest(manifest), ...checkFiles(manifest, rootDir)];
}

function runWrite(rootDir: string): string[] {
  const manifestPath = join(rootDir, MANIFEST_PATH);
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  const errors = validateManifest(manifest);
  if (errors.length > 0) return errors;
  const updated: string[] = [];
  for (const [sectionKey, section] of Object.entries(manifest.sections)) {
    if (section === undefined) continue;
    const reportPath = join(rootDir, section.report);
    if (!existsSync(reportPath)) return [`E_BLOCK: レポートが存在しません: ${section.report}`];
    const text = readFileSync(reportPath, "utf8");
    const begin = beginMarker(section.blockId);
    const end = endMarker(section.blockId);
    const first = text.indexOf(begin);
    if (first === -1) return [`E_BLOCK: 生成ブロックがありません: ${section.report} (--print で生成文を出して貼ること)`];
    if (first !== text.lastIndexOf(begin)) {
      return [`E_BLOCK: 生成ブロックが重複しています: ${section.report}`];
    }
    const endPos = text.indexOf(end, first + begin.length);
    if (endPos === -1) return [`E_BLOCK: 生成ブロックの END マーカーがありません: ${section.report}`];
    const expected = renderBlock(manifest, sectionKey);
    const head = text.slice(0, first);
    const tail = text.slice(endPos + end.length);
    const tailNormalized = tail.startsWith("\n") ? tail.slice(1) : tail;
    writeFileSync(reportPath, `${head}${expected}\n${tailNormalized}`);
    updated.push(section.report);
  }
  const errorsAfter = checkFiles(manifest, rootDir);
  if (errorsAfter.length > 0) return errorsAfter;
  console.info(`[audit-report] 更新: ${updated.join(", ")}`);
  return [];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = repoRoot();
  if (args.includes("--write")) {
    const errors = runWrite(root);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return;
  }
  const printAt = args.indexOf("--print");
  if (printAt !== -1) {
    const sectionKey = args[printAt + 1];
    if (sectionKey === undefined) throw new Error("E_SCHEMA: --print には section 名が必要です");
    const manifest = parseManifest(
      JSON.parse(readFileSync(join(root, MANIFEST_PATH), "utf8")) as unknown,
    );
    const errors = validateManifest(manifest);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    process.stdout.write(renderBlock(manifest, sectionKey));
    return;
  }
  if (args.length > 0 && !args.includes("--check")) {
    throw new Error("E_SCHEMA: 指定できる引数は --check / --write / --print <section> です");
  }
  const errors = runCheck(root);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.info("[audit-report] OK: manifest 検証＋生成ブロック byte 一致＋参照解決");
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invoked) {
  main().catch((e: unknown) => {
    console.error("[audit-report] エラー:", rootCauseMessage(e));
    process.exit(1);
  });
}
