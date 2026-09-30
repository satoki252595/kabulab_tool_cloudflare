/**
 * Yutai ABC/全文修復の実再入 0 の offline 証明 (Issue #199 系。保存済み証跡のみ)。
 *
 * - 入力は SHA pin 済みの保存済み証跡のみ。live D1/Notion/R2/source GET なし。
 * - 送信口は throw-if-called。効果文が 1 文でもあれば送信経路で throw する
 *   (0 writes の構造強制。dry-run や gate STOP による見せかけの 0 を作らない)。
 * - 共有の実 planner/builder (`planSummaryImport` / `planAtomicBatches` /
 *   `computeYieldEntries` / `classifyDescriptionRepair` /
 *   `buildDescriptionUpdateStatements`) をそのまま使い、判定を写さない。
 * - 私用 generator (`gen-yutai-abc.mts` 等) の複写・旧証跡の上書きはしない。
 *
 * 使い方:
 *   node --import tsx services/otakara-yutai/data-scripts/verify-repair-reentry.ts \
 *     [--dir /tmp/yutai-src-repair-20260929] [--c45dir /tmp/c45] \
 *     [--upstream /tmp/c45/upstream] [--physical /tmp/physical34/manifest-34.json] \
 *     [--out /tmp/yutai-reentry-20260930/evidence.json]
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyAtomicBatches,
  planAtomicBatches,
  type AtomicBatchSender,
  type StockPreimage,
} from "./atomic-apply.js";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { assertNotCommittable } from "./private-path.js";
import {
  computeYieldEntries,
  type YieldInputs,
  type YieldRecomputePlan,
} from "./recompute-yields.js";
import { benefitKey } from "./benefit-key.js";
import { normalizeSummary } from "./summary-contract.js";
import {
  buildDescriptionUpdateStatements,
  classifyDescriptionRepair,
  planSummaryImport,
  type PlannedUpdate,
} from "./summary-import.js";
import {
  parseTaskFile,
  type BenefitRow,
  type SummaryTask,
} from "./summary-tasks.js";

/** SHA pin (保存済み証跡の固定。1 文字でも違えば HOLD)。 */
export const PINS: Record<string, string> = {
  "yutai-abc-manifest.json":
    "f3586e6fcfaaef9f3d773f755720a642652986d7c9adf08de12a3d46135379fe",
  "yutai-fulltext-manifest.postabc.json":
    "e90e32358c1362e9fca15eed2e8d29b331d0bccebb3e9e8d7fa5266ed9a1b43e",
  "yutai-row-manifest.json":
    "23638f8db974145cee38af34896b527b61fce8a83abffe58967161f40403dbd0",
  "yutai-before-inventory.v3.json":
    "1a8cfabee16b52d01a71ae8fa7478fb65faaab3fa681240fdb0db8c051f1f25b",
  "yutai-ftbefore-inventory.v1.json":
    "15d30dc2c62fe49b3333b1ffe20af3abf96916ca5c75dd2103194da4417ce779",
  "abc-apply-post.json":
    "8e5b987e1443eb354ec95ac648bcefe52dea89a50da6dc2d45213b163484e2d4",
  "ft-apply-post.json":
    "c466ea905951df1d4a2b513170910264bea7d352a35b15a908a3795330610d22",
  "manifest-34.json":
    "be5996c0e3eb3c1fbbf3147ff17e83ba97af54fbd8347e275cb64d57a2aa69cc",
};

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function fail(msg: string): never {
  throw new Error(`[reentry-verify] HOLD: ${msg}`);
}

function readPinned(dir: string, name: string): string {
  const text = readFileSync(join(dir, name), "utf-8");
  if (sha256Hex(text) !== PINS[name]) fail(`SHA pin 不一致: ${name}`);
  return text;
}

/** 送信口。呼ばれたら即 throw (offline 証明は 1 文も送らない)。 */
export const throwingSender: AtomicBatchSender = async () => {
  throw new Error("[reentry-verify] HOLD: 効果文があるのに送信しようとした (0 writes 違反)");
};

type Args = {
  dir: string;
  c45dir: string;
  upstream: string;
  physical: string;
  out: string;
};

export function parseVerifyArgs(argv: readonly string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] as string : def;
  };
  return {
    dir: get("--dir", "/tmp/yutai-src-repair-20260929"),
    c45dir: get("--c45dir", "/tmp/c45"),
    upstream: get("--upstream", "/tmp/c45/upstream"),
    physical: get("--physical", "/tmp/physical34/manifest-34.json"),
    out: get("--out", "/tmp/yutai-reentry-20260930/evidence.json"),
  };
}

type NamedRow = {
  id: number;
  stockId: number;
  stockCode: string;
  minShares: number;
  recordMonth: number;
  oldDescription: string;
  oldSha: string;
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
  updatedAt: number;
  newFull: string;
  newFullSha: string;
  provenance: {
    manifestHtmlSha: string;
    manifestJsonSha: string;
    localHtmlSha: string;
    localJsonSha: string;
  };
};

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${what} が object ではない`);
  return v as Record<string, unknown>;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} が配列ではない`);
  return v;
}

type FiledUpdateStatement = {
  stockId: number;
  index: number;
  shortSummary: string;
  estimatedValue: number | null;
  estimateValueSource: string | null;
  ids: number[];
};

/**
 * filed manifest の短文 UPDATE 1 文 → DISTINCT PlannedUpdate 1 件。
 * 銘柄まとめ (Map grouping) しない。statement 順序と ID 帰属を維持し、
 * 出典は spread で保存する (`{...u, ids: [...u.ids]}`)。
 */
export function producePlannedUpdate(stmt: FiledUpdateStatement): PlannedUpdate {
  if (stmt.estimateValueSource !== null && stmt.estimateValueSource !== "company") {
    fail(`filed 出典が想定外: stockId=${stmt.stockId} index=${stmt.index}`);
  }
  const u = {
    taskId: `abc-filed:${stmt.stockId}:${stmt.index}`,
    shortSummary: stmt.shortSummary,
    estimatedValue: stmt.estimatedValue,
    estimateValueSource: stmt.estimateValueSource as "company" | null,
    ids: stmt.ids,
  };
  return { ...u, ids: [...u.ids] };
}

type AbcParsed = {
  preimages: Map<number, StockPreimage>;
  filed: FiledUpdateStatement[];
  benefitUpdateCount: number;
  yieldStmts: { stockId: number; next: number | null }[];
  scoreStmts: { stockId: number; triple: { fundamentalScore: number; technicalScore: number; totalScore: number } }[];
  yieldEntries: {
    stockId: number;
    prev: number | null;
    next: number | null;
    changed: boolean;
    scorePrev: { fundamentalScore: number; technicalScore: number; totalScore: number } | null;
    scoreNext: { fundamentalScore: number; technicalScore: number; totalScore: number } | null;
    scoreChanged: boolean;
  }[];
  skippedNoRow: number[];
  skippedNoScore: number[];
  changedStocks: number;
  scoreChangedStocks: number;
};

const BENEFIT_UPDATE_PREFIX = "UPDATE yutai_benefits SET short_summary = ?";

export function parseAbcManifest(text: string): AbcParsed {
  const root = asRecord(JSON.parse(text), "abc-manifest");
  const batches = asRecord(root["batches"], "abc-manifest.batches");
  const perStock = asArray(batches["perStock"], "abc-manifest.batches.perStock");
  const preimages = new Map<number, StockPreimage>();
  const filedStatements: FiledUpdateStatement[] = [];
  const yieldStmts: AbcParsed["yieldStmts"] = [];
  const scoreStmts: AbcParsed["scoreStmts"] = [];
  let benefitUpdateCount = 0;
  for (const entry of perStock) {
    const e = asRecord(entry, "perStock 要素");
    const stockId = e["stockId"];
    if (typeof stockId !== "number") fail("perStock.stockId が数値ではない");
    const statements = asArray(e["statements"], `perStock ${stockId} statements`);
    if (statements.length === 0) fail(`perStock ${stockId} の statements が空`);
    const first = asRecord(statements[0], `perStock ${stockId} statements[0]`);
    const params = asArray(first["params"], `perStock ${stockId} preflight params`);
    if (typeof params[0] !== "string") fail(`perStock ${stockId} の preimage params[0] が文字列ではない`);
    const preimage = JSON.parse(params[0] as string) as StockPreimage;
    if (preimage.stockId !== stockId || !Array.isArray(preimage.benefits)) {
      fail(`perStock ${stockId} の preimage 形状が不正`);
    }
    preimages.set(stockId, preimage);
    let idx = 0;
    for (const s of statements.slice(1)) {
      const st = asRecord(s, `perStock ${stockId} statement`);
      const sql = st["sql"];
      if (typeof sql !== "string") fail(`perStock ${stockId} の文に sql が無い`);
      const p = asArray(st["params"], `perStock ${stockId} statement params`);
      if ((sql as string).startsWith(BENEFIT_UPDATE_PREFIX)) {
        if (typeof p[0] !== "string") fail(`perStock ${stockId} の UPDATE summary が文字列ではない`);
        if (p[1] !== null && typeof p[1] !== "number") fail(`perStock ${stockId} の UPDATE value が数値/null ではない`);
        if (p[2] !== null && typeof p[2] !== "string") fail(`perStock ${stockId} の UPDATE source が文字列/null ではない`);
        const ids = p.slice(3);
        if (ids.length === 0 || !ids.every((v): v is number => typeof v === "number")) {
          fail(`perStock ${stockId} の UPDATE ids が非空数値列ではない`);
        }
        filedStatements.push({
          stockId,
          index: idx++,
          shortSummary: p[0] as string,
          estimatedValue: p[1] as number | null,
          estimateValueSource: p[2] as string | null,
          ids: ids as number[],
        });
        benefitUpdateCount++;
      } else if ((sql as string).startsWith("UPDATE otakara_stock_financials SET yutai_yield = ?")) {
        if ((p[0] !== null && typeof p[0] !== "number") || p[1] !== stockId) {
          fail(`perStock ${stockId} の利回り文 params が想定外`);
        }
        yieldStmts.push({ stockId, next: p[0] as number | null });
      } else if ((sql as string).startsWith("UPDATE otakara_stock_scores SET ")) {
        const [f, t, tot, sid] = p as unknown[];
        if (typeof f !== "number" || typeof t !== "number" || typeof tot !== "number" || sid !== stockId) {
          fail(`perStock ${stockId} のスコア文 params が想定外`);
        }
        scoreStmts.push({ stockId, triple: { fundamentalScore: f, technicalScore: t, totalScore: tot } });
      } else {
        fail(`perStock ${stockId} の非 preflight 文が想定外: ${(sql as string).slice(0, 60)}`);
      }
    }
  }
  const y = asRecord(root["yield"], "abc-manifest.yield");
  const entries = asArray(y["entries"], "abc-manifest.yield.entries").map((v) => {
    const e = asRecord(v, "yield entry");
    const triple = (x: unknown) => {
      if (x === null) return null;
      const t = asRecord(x, "score triple");
      return {
        fundamentalScore: t["fundamentalScore"] as number,
        technicalScore: t["technicalScore"] as number,
        totalScore: t["totalScore"] as number,
      };
    };
    return {
      stockId: e["stockId"] as number,
      prev: e["prev"] as number | null,
      next: e["next"] as number | null,
      changed: e["changed"] as boolean,
      scorePrev: triple(e["scorePrev"]),
      scoreNext: triple(e["scoreNext"]),
      scoreChanged: e["scoreChanged"] as boolean,
    };
  });
  return {
    preimages,
    filed: filedStatements,
    benefitUpdateCount,
    yieldStmts,
    scoreStmts,
    yieldEntries: entries,
    skippedNoRow: (y["skippedNoRow"] ?? []) as number[],
    skippedNoScore: (y["skippedNoScore"] ?? []) as number[],
    changedStocks: y["changed"] as number,
    scoreChangedStocks: y["scoreChanged"] as number,
  };
}

/** 473 ID の完全被覆 + 一意 + target 同一性の証明 (shared 同値化の前段)。 */
export function proveTargetCoverage(
  filed: FiledUpdateStatement[],
  preimages: Map<number, StockPreimage>
): { plannedIds: number[]; plannedById: Map<number, { shortSummary: string; estimatedValue: number | null; estimateValueSource: string | null }> } {
  const plannedById = new Map<number, { shortSummary: string; estimatedValue: number | null; estimateValueSource: string | null }>();
  for (const f of filed) {
    for (const id of f.ids) {
      const prev = plannedById.get(id);
      const triple = {
        shortSummary: f.shortSummary,
        estimatedValue: f.estimatedValue,
        estimateValueSource: f.estimateValueSource,
      };
      if (prev) {
        // 一意性: 同一 ID の複数文への出現は target の一致不一致にかかわらず STOP。
        if (prev.shortSummary !== triple.shortSummary || prev.estimatedValue !== triple.estimatedValue || prev.estimateValueSource !== triple.estimateValueSource) {
          fail(`ID ${id} の target が文で衝突 (conflicting targets)`);
        }
        fail(`ID ${id} が複数文に出現 (duplicate)`);
      }
      plannedById.set(id, triple);
    }
  }
  const plannedIds = [...plannedById.keys()].sort((a, b) => a - b);
  // 被覆: 全 planned ID がいずれかの preimage に属する。
  const memberOf = new Map<number, number>();
  for (const [stockId, pre] of preimages) {
    for (const b of pre.benefits) memberOf.set(b.id, stockId);
  }
  for (const id of plannedIds) {
    if (!memberOf.has(id)) fail(`planned ID ${id} が preimage に無い (被覆欠落)`);
  }
  return { plannedIds, plannedById };
}

type Triple = { shortSummary: string; estimatedValue: number | null; estimateValueSource: string | null };

/** post 適用状態の模擬: pre benefits に planned 3 値を ID 単位で適用する。 */
export function simulatePostBenefits(
  preimages: Map<number, StockPreimage>,
  plannedById: Map<number, Triple>
): Map<number, StockPreimage> {
  const out = new Map<number, StockPreimage>();
  for (const [stockId, pre] of preimages) {
    out.set(stockId, {
      ...pre,
      financial: pre.financial ? { ...pre.financial } : null,
      scores: pre.scores ? { ...pre.scores } : null,
      benefits: pre.benefits.map((b) => {
        const p = plannedById.get(b.id);
        if (!p) return { ...b };
        return {
          ...b,
          shortSummary: p.shortSummary,
          estimatedValue: p.estimatedValue,
          estimateValueSource: p.estimateValueSource,
        };
      }),
    });
  }
  return out;
}

export type ProofBResult = {
  stocks: number;
  benefitStatements: number;
  plannedIds: number;
  omitted: number;
  changed: number;
  missing: number;
  yieldChanged: number;
  scoreChanged: number;
  effectiveStatements: number;
  batches: number;
  senderCalls: number;
};

/**
 * 証明 B: legacy ABC の shared 原子同値化。再入は優待文 0・利回り変化 0。
 * - planned (filed UPDATE) と post (pre+planned 模擬) の per-ID 厳密比較を
 *   独立集計し、shared planAtomicBatches の出力と突き合わせる。
 * - 利回りは実 computeYieldEntries で post 再計算し、changed 0 を確認する。
 * - planner の実 batch を既存 applyAtomicBatches にそのまま渡し、送信 0 回を
 *   実経路で確認する (条件付き sender-fail だけに頼らない)。
 */
export async function proveAbcReentry(
  abc: AbcParsed,
  filed: FiledUpdateStatement[],
  plannedById: Map<number, Triple>,
  plannedIds: number[],
  sender: AtomicBatchSender
): Promise<ProofBResult> {
  // post preimages (3 値のみ適用。updatedAt は offline では模擬しない)。
  const post = simulatePostBenefits(abc.preimages, plannedById);
  // producer: filed 文ごとに DISTINCT PlannedUpdate (順序・帰属維持)。
  const updates: PlannedUpdate[] = filed.map((f) => producePlannedUpdate(f));
  const stockOfBenefit = new Map<number, number>();
  for (const [stockId, pre] of post) {
    for (const b of pre.benefits) stockOfBenefit.set(b.id, stockId);
  }
  // YieldInputs を post snapshot から再構成する。
  const nextByStock = new Map(abc.yieldEntries.map((e) => [e.stockId, e.next] as const));
  const scoreNextByStock = new Map(
    abc.yieldEntries.filter((e) => e.scoreChanged && e.scoreNext).map((e) => [e.stockId, e.scoreNext!] as const)
  );
  const prices: YieldInputs["prices"] = new Map();
  const scoreInputs: YieldInputs["scoreInputs"] = new Map();
  const scores: YieldInputs["scores"] = new Map();
  const parents: YieldInputs["parents"] = new Map();
  const benefits: YieldInputs["benefits"] = new Map();
  for (const [stockId, pre] of abc.preimages) {
    const postPre = post.get(stockId)!;
    const fin = pre.financial;
    if (fin) {
      // post 利回り: 変化分は manifest 計画値 (live 適用で確認済み)、不変分は pre 値。
      const postYield = nextByStock.has(stockId) ? nextByStock.get(stockId)! : fin.yutaiYield;
      prices.set(stockId, { price: fin.price, yutaiYield: postYield, dataDate: fin.dataDate, fetchedAt: fin.fetchedAt });
      scoreInputs.set(stockId, {
        price: fin.price,
        per: fin.per,
        pbr: fin.pbr,
        dividendYield: fin.dividendYield,
        roe: fin.roe,
        ma25: fin.ma25,
        rsi14: fin.rsi14,
        macd: fin.macd,
        macdSignal: fin.macdSignal,
        yutaiYield: postYield,
      });
    }
    const postScores = scoreNextByStock.get(stockId) ?? (pre.scores ? { ...pre.scores } : null);
    if (postScores) {
      scores.set(stockId, {
        fundamentalScore: (postScores as { fundamentalScore: number }).fundamentalScore,
        technicalScore: (postScores as { technicalScore: number }).technicalScore,
        totalScore: (postScores as { totalScore: number }).totalScore,
      });
    }
    parents.set(stockId, pre.parent ? { ...pre.parent } : null);
    benefits.set(
      stockId,
      postPre.benefits.map((b) => ({
        rowId: b.id,
        minShares: b.minShares,
        recordMonth: b.recordMonth,
        description: b.description,
        shortSummary: b.shortSummary,
        estimatedValue: b.estimatedValue,
        estimateValueSource: b.estimateValueSource,
        updatedAt: b.updatedAt,
      }))
    );
  }
  // manifest 計画値の裏づけ: entry.prev は pre 利回りと一致する。
  for (const e of abc.yieldEntries) {
    const preYield = abc.preimages.get(e.stockId)?.financial?.yutaiYield ?? null;
    if (e.prev !== preYield) fail(`yield entry prev が pre 利回りと不一致: stockId=${e.stockId}`);
  }
  const stockIds = [...abc.preimages.keys()].sort((a, b) => a - b);
  const overlay = new Map<number, number | null>();
  for (const [id, t] of plannedById) overlay.set(id, t.estimatedValue);
  const yieldPlan: YieldRecomputePlan = computeYieldEntries(stockIds, { prices, benefits, scoreInputs, scores, parents }, overlay);
  // post 再計算は全銘柄不変のはず。変化があれば STOP (再入で書くものがある)。
  let yieldChanged = 0;
  let scoreChanged = 0;
  for (const e of yieldPlan.entries) {
    if (e.changed) yieldChanged++;
    if (e.scoreChanged) scoreChanged++;
    const wantYield = prices.get(e.stockId)?.yutaiYield ?? null;
    if (e.next !== wantYield) fail(`post 利回り再計算が保存値と不一致: stockId=${e.stockId}`);
  }
  // skipped 集合も manifest と一致する。
  const skippedNoRow = [...yieldPlan.skippedNoRow].sort((a, b) => a - b);
  const wantSkippedNoRow = [...abc.skippedNoRow].sort((a, b) => a - b);
  if (JSON.stringify(skippedNoRow) !== JSON.stringify(wantSkippedNoRow)) {
    fail(`skippedNoRow が manifest と不一致: ${skippedNoRow.join(",")} vs ${wantSkippedNoRow.join(",")}`);
  }
  const skippedNoScore = [...yieldPlan.skippedNoScore].sort((a, b) => a - b);
  const wantSkippedNoScore = [...abc.skippedNoScore].sort((a, b) => a - b);
  if (JSON.stringify(skippedNoScore) !== JSON.stringify(wantSkippedNoScore)) {
    fail(`skippedNoScore が manifest と不一致`);
  }
  // shared 原子計画へ再入 (post preimage + 同一 updates)。
  const batches = planAtomicBatches({
    updates,
    yieldPlan,
    stockOfBenefit: (id) => stockOfBenefit.get(id),
    preimages: post,
  });
  let benefitStatements = 0;
  let effectiveStatements = 0;
  for (const b of batches) {
    for (const s of b.statements) {
      if (s.sql.startsWith("UPDATE yutai_benefits")) benefitStatements++;
    }
    // preflight 先頭以外の全 effective 文を数える (利回り文は changed 時のみ出る)。
    effectiveStatements += Math.max(0, b.statements.length - 1);
  }
  // 実送信経路: planner の実 batch を既存 apply に渡す。batch が残れば
  // throwingSender が throw する。0 batch なら sender は呼ばれない。
  let senderCalls = 0;
  const counting: AtomicBatchSender = async (statements) => {
    senderCalls++;
    return sender(statements);
  };
  const applied = await applyAtomicBatches(counting, batches);
  if (applied.stocks !== 0 || applied.statements !== 0 || senderCalls !== 0) {
    fail(`ABC 再入で実 apply が送信した (stocks=${applied.stocks} statements=${applied.statements} calls=${senderCalls})`);
  }
  // 独立集計: planned と post の per-ID 厳密比較 (planner 出力と突き合わせ)。
  let omitted = 0;
  let changed = 0;
  let missing = 0;
  for (const id of plannedIds) {
    const stockId = stockOfBenefit.get(id);
    const row = stockId === undefined ? undefined : post.get(stockId)?.benefits.find((b) => b.id === id);
    const p = plannedById.get(id)!;
    if (!row) {
      missing++;
      continue;
    }
    if (
      row.shortSummary === p.shortSummary &&
      row.estimatedValue === p.estimatedValue &&
      row.estimateValueSource === p.estimateValueSource
    ) {
      omitted++;
    } else {
      changed++;
    }
  }
  return {
    stocks: abc.preimages.size,
    benefitStatements,
    plannedIds: plannedIds.length,
    omitted,
    changed,
    missing,
    yieldChanged,
    scoreChanged,
    effectiveStatements,
    batches: batches.length,
    senderCalls,
  };
}

export type FulltextRow = {
  id: number;
  stockCode: string;
  oldDescription: string;
  newFull: string;
  updatedAt: number;
};

export type ProofCResult = {
  rows: number;
  applied: number;
  candidates: number;
  stops: number;
  descStatements: number;
  wouldWrite: number;
  senderCalls: number;
};

/**
 * 証明 C: 全文 62 行の分類再入。現文 (post 模擬) が新全文と一致すれば
 * ALREADY_APPLIED。CANDIDATE/STOP が 1 行でもあれば STOP (0 の偽装なし)。
 * ALREADY_APPLIED 行も現文起点で実 builder を呼び、実リストから数えて
 * 実送信経路に渡す (固定値 0 を置かない。filter が壊れれば落ちる)。
 * builder が無力なための 0 ではないこと (wouldWrite) も同時に示す。
 */
export async function proveFulltextReentry(
  rows: FulltextRow[],
  currentById: Map<number, string>,
  sender: AtomicBatchSender
): Promise<ProofCResult> {
  let applied = 0;
  let candidates = 0;
  let stops = 0;
  const stopIds: number[] = [];
  for (const r of rows) {
    const current = currentById.get(r.id);
    if (current === undefined) fail(`全文行 ${r.id} の現文が無い`);
    // 旧 regen の 0 は descStop gate によるもの。ここでは旧≠新の実変化を確認する。
    if (r.oldDescription === r.newFull) fail(`全文行 ${r.id} の旧文と新全文が同一 (実変化なし)`);
    const cls = classifyDescriptionRepair({ current: current!, oldDescription: r.oldDescription, newFull: r.newFull });
    if (cls === "ALREADY_APPLIED") applied++;
    else if (cls === "CANDIDATE") candidates++;
    else {
      stops++;
      stopIds.push(r.id);
    }
  }
  if (stops > 0) fail(`全文 ${stops} 行が STOP (drift): ids=${stopIds.slice(0, 10).join(",")}`);
  if (candidates > 0) fail(`全文 ${candidates} 行が未適用のまま (再入 0 不成立)`);
  // 実経路: 現文 (適用済みなら新全文) を起点に実 builder を呼び、実リストから数える。
  const actual: D1BatchStatement[] = [];
  for (const r of rows) {
    const current = currentById.get(r.id);
    if (current === undefined) fail(`全文行 ${r.id} の現文が無い`);
    actual.push(
      ...buildDescriptionUpdateStatements(
        [{ id: r.id, oldDescription: current!, updatedAt: r.updatedAt }],
        r.newFull
      )
    );
  }
  const descStatements = actual.length;
  let senderCalls = 0;
  const counting: AtomicBatchSender = async (statements) => {
    senderCalls++;
    return sender(statements);
  };
  if (descStatements > 0) {
    await counting(actual); // throwingSender ならここで HOLD。
    fail(`全文再入で実 builder が ${descStatements} 文出した (再入 0 不成立)`);
  }
  // builder の実力確認: 旧文のままなら 62 文出る (0 は分類の結果)。
  let wouldWrite = 0;
  for (const r of rows) {
    wouldWrite += buildDescriptionUpdateStatements(
      [{ id: r.id, oldDescription: r.oldDescription, updatedAt: r.updatedAt }],
      r.newFull
    ).length;
  }
  return { rows: rows.length, applied, candidates, stops, descStatements, wouldWrite, senderCalls };
}

export type ProofAResult = {
  tasks: number;
  results: number;
  skippedEquivalent: number;
  pendingTasks: number;
  pendingRows: number;
  sourceOnlyRows: number;
  stale: number;
  staleCausedByFulltext: number;
  staleSourceOnlyRows: number;
  rejected: Record<string, number>;
  contractRejects: number;
  unanswered: number;
};

/**
 * 証明 A: normal 45 JSONL の実 planner 正直集計。0-writes が成立するのは
 * equivalent 集合のみ。pending/stale は正直に数え、範囲を明示する。
 * 来歴の隠蔽 (missing-source を company と同値扱い) が無いことも検証する。
 */
export function proveNormal45(
  tasks: SummaryTask[],
  resultsText: string,
  currentRows: readonly BenefitRow[],
  preFulltextRows: readonly BenefitRow[]
): ProofAResult {
  const plan = planSummaryImport({ tasks, resultsText, currentRows });
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const updatedIds = new Set(plan.updates.map((u) => u.taskId));
  const rejectedIds = new Set(
    plan.rejections.filter((r) => r.taskId && taskIds.has(r.taskId)).map((r) => r.taskId as string)
  );
  const unansweredIds = new Set(plan.unansweredTaskIds);
  // 完全会計: 各タスクは unanswered/updates/rejected/skipped のちょうど 1 つ。
  for (const id of updatedIds) {
    if (rejectedIds.has(id) || unansweredIds.has(id)) fail(`タスク ${id} が複数区分に現れる`);
  }
  for (const id of rejectedIds) {
    if (unansweredIds.has(id)) fail(`タスク ${id} が複数区分に現れる`);
  }
  const resolved = new Set([...updatedIds, ...rejectedIds, ...unansweredIds]);
  const skippedIds = [...taskIds].filter((id) => !resolved.has(id));
  if (skippedIds.length !== plan.skippedEquivalent) {
    fail(`skipped 数の不整合: 残差 ${skippedIds.length} vs 報告 ${plan.skippedEquivalent}`);
  }
  // 来歴検証: skipped 集合の全行を独立に 3 値比較し、missing-source が
  // company と同値扱いされていないことを確認する。
  const byKey = new Map<string, BenefitRow[]>();
  for (const r of currentRows) {
    const key = benefitKey(r.stockCode, r.description);
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const resultById = new Map<string, { shortSummary: string; estimatedValue: number | null }>();
  for (const line of resultsText.split("\n")) {
    if (line.trim() === "") continue;
    const raw = JSON.parse(line) as { taskId?: unknown; shortSummary?: unknown; estimatedValue?: unknown };
    if (typeof raw.taskId === "string") {
      resultById.set(raw.taskId, {
        shortSummary: typeof raw.shortSummary === "string" ? raw.shortSummary : "",
        estimatedValue: typeof raw.estimatedValue === "number" ? raw.estimatedValue : null,
      });
    }
  }
  for (const id of skippedIds) {
    const res = resultById.get(id);
    if (!res) fail(`skipped タスク ${id} の結果が無い`);
    const plannedSource = res!.estimatedValue !== null ? "company" : null;
    const task = tasks.find((t) => t.taskId === id)!;
    const rows = byKey.get(benefitKey(task.stockCode, task.description)) ?? [];
    if (rows.length === 0) fail(`skipped タスク ${id} の現行行が無い`);
    for (const r of rows) {
      // planner は normalizeSummary 済み要約で比べる。ここでは出典・金額の
      // 来歴一致だけを独立検証する (要約の正規化判定は planner の責務)。
      if (r.estimatedValue !== res!.estimatedValue || r.estimateValueSource !== plannedSource) {
        fail(`skipped タスク ${id} に金額/出典の不一致行あり (来歴隠蔽の疑い)`);
      }
    }
  }
  // pending 内訳: 出典のみ差 vs 値・要約差 (実データ由来の正直内訳)。
  let pendingRows = 0;
  let sourceOnlyRows = 0;
  for (const u of plan.updates) {
    const task = tasks.find((t) => t.taskId === u.taskId)!;
    const rows = byKey.get(benefitKey(task.stockCode, task.description)) ?? [];
    for (const r of rows) {
      pendingRows++;
      if (
        r.shortSummary === u.shortSummary &&
        r.estimatedValue === u.estimatedValue &&
        r.estimateValueSource !== u.estimateValueSource
      ) {
        sourceOnlyRows++;
      }
    }
  }
  const rejected: Record<string, number> = {};
  let stale = 0;
  let contractRejects = 0;
  const staleTaskIds: string[] = [];
  for (const r of plan.rejections) {
    rejected[r.reason] = (rejected[r.reason] ?? 0) + 1;
    if (r.reason === "stale") {
      stale++;
      if (r.taskId) staleTaskIds.push(r.taskId);
    }
    if (r.reason === "contract_version") contractRejects++;
  }
  // stale の原因特定: 全文適用前のキーにあれば全文起因。全件そうでなければ STOP。
  const preKeys = new Set(preFulltextRows.map((r) => benefitKey(r.stockCode, r.description)));
  const taskById2 = new Map(tasks.map((t) => [t.taskId, t]));
  let staleCausedByFulltext = 0;
  let staleSourceOnlyRows = 0;
  for (const id of staleTaskIds) {
    const task = taskById2.get(id)!;
    if (!preKeys.has(benefitKey(task.stockCode, task.description))) {
      fail(`stale タスク ${id} が全文適用前にも無い (原因不明)`);
    }
    staleCausedByFulltext++;
    // 全文適用前状態では出典のみ差の pending だったことを確認する。
    const res = resultById.get(id);
    if (!res) fail(`stale タスク ${id} の結果が無い`);
    const plannedSource = res!.estimatedValue !== null ? "company" : null;
    const wantSummary = normalizeSummary(res!.shortSummary);
    for (const r of preFulltextRows) {
      if (benefitKey(r.stockCode, r.description) !== benefitKey(task.stockCode, task.description)) continue;
      if (
        r.shortSummary === wantSummary &&
        r.estimatedValue === res!.estimatedValue &&
        r.estimateValueSource !== plannedSource
      ) {
        staleSourceOnlyRows++;
      } else {
        fail(`stale タスク ${id} の行 ${r.id} が出典のみ差ではない`);
      }
    }
  }
  return {
    tasks: tasks.length,
    results: resultsText.split("\n").filter((l) => l.trim() !== "").length,
    skippedEquivalent: plan.skippedEquivalent,
    pendingTasks: plan.updates.length,
    pendingRows,
    sourceOnlyRows,
    stale,
    staleCausedByFulltext,
    staleSourceOnlyRows,
    rejected,
    contractRejects,
    unanswered: plan.unansweredTaskIds.length,
  };
}

type Evidence = {
  at: string;
  pins: Record<string, string>;
  proofA: ProofAResult & { verdict: string };
  proofB: ProofBResult & { verdict: string; filedChecks: Record<string, number | boolean> };
  proofC: ProofCResult & { verdict: string };
  verdict: string;
};

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<Evidence> {
  const args = parseVerifyArgs(argv);
  for (const p of [args.dir, args.c45dir, args.upstream, args.out]) assertNotCommittable(p);
  assertNotCommittable(args.physical);

  // 0. pin 固定入力の読み込み。
  const abcText = readPinned(args.dir, "yutai-abc-manifest.json");
  const ftText = readPinned(args.dir, "yutai-fulltext-manifest.postabc.json");
  const rowText = readPinned(args.dir, "yutai-row-manifest.json");
  const v3Text = readPinned(args.dir, "yutai-before-inventory.v3.json");
  const ftbeforeText = readPinned(args.dir, "yutai-ftbefore-inventory.v1.json");
  const abcPostText = readPinned(args.dir, "abc-apply-post.json");
  const ftPostText = readPinned(args.dir, "ft-apply-post.json");
  const m34Text = readFileSync(args.physical, "utf-8");
  if (sha256Hex(m34Text) !== PINS["manifest-34.json"]) fail("SHA pin 不一致: manifest-34.json");
  const tasksText = readFileSync(join(args.c45dir, "tasks-c45.jsonl"), "utf-8");
  const resultsText = readFileSync(join(args.c45dir, "results-c45.jsonl"), "utf-8");

  // 1. ABC manifest の解析 + 被覆証明。
  const abc = parseAbcManifest(abcText);
  if (abc.preimages.size !== 131) fail(`ABC stocks=${abc.preimages.size} (want 131)`);
  if (abc.benefitUpdateCount !== 264) fail(`ABC benefit UPDATEs=${abc.benefitUpdateCount} (want 264)`);
  const { plannedIds, plannedById } = proveTargetCoverage(abc.filed, abc.preimages);
  if (plannedIds.length !== 473) fail(`planned unique IDs=${plannedIds.length} (want 473)`);

  // 2. v3 独立 snapshot との全行突き合わせ (1557 行)。
  const v3 = asRecord(JSON.parse(v3Text), "before-inventory.v3");
  const v3stocks = asArray(v3["abcStocksFull"], "v3.abcStocksFull");
  let v3rows = 0;
  for (const s of v3stocks) {
    const st = asRecord(s, "v3 stock");
    const set = asArray(st["wholeBenefitSet"], `v3 stock ${st["stockId"]} wholeBenefitSet`);
    const pre = abc.preimages.get(st["stockId"] as number);
    if (!pre) fail(`v3 stock ${st["stockId"]} が manifest preimage に無い`);
    const byId = new Map(pre.benefits.map((b) => [b.id, b]));
    for (const w of set) {
      const r = asRecord(w, "v3 benefit row");
      const id = r["id"] as number;
      const p = byId.get(id);
      if (!p) fail(`v3 row ${id} が manifest preimage に無い`);
      const cols: (keyof typeof p)[] = ["shortSummary", "estimatedValue", "estimateValueSource", "description", "minShares", "recordMonth", "updatedAt"];
      for (const c of cols) {
        if ((p[c] as unknown) !== (r[c as string] as unknown)) {
          fail(`v3 row ${id} の ${c} が manifest preimage と不一致`);
        }
      }
      v3rows++;
    }
  }
  if (v3rows !== 1557) fail(`v3 rows=${v3rows} (want 1557)`);

  // 3. 証明 B (legacy ABC shared 原子同値化)。
  const proofB = await proveAbcReentry(abc, abc.filed, plannedById, plannedIds, throwingSender);
  if (proofB.omitted !== 473 || proofB.changed !== 0 || proofB.missing !== 0) {
    fail(`ABC per-ID 集計の不整合: omitted=${proofB.omitted} changed=${proofB.changed} missing=${proofB.missing}`);
  }
  if (proofB.benefitStatements !== 0 || proofB.yieldChanged !== 0 || proofB.scoreChanged !== 0) {
    fail(`ABC 再入で効果文あり: benefit=${proofB.benefitStatements} yield=${proofB.yieldChanged} score=${proofB.scoreChanged}`);
  }
  // 508 = 131 preflight + 264 benefit + 113 yieldScore の filed 内訳を再検算する。
  // 利回り・スコア文の params は yield entry の next と突き合わせる。
  const entryByStock = new Map(abc.yieldEntries.map((e) => [e.stockId, e]));
  if (abc.yieldStmts.length !== 61 || abc.scoreStmts.length !== 52) {
    fail(`filed 利回り/スコア文=${abc.yieldStmts.length}/${abc.scoreStmts.length} (want 61/52)`);
  }
  for (const y of abc.yieldStmts) {
    if (entryByStock.get(y.stockId)?.next !== y.next) fail(`利回り文と entry.next の不一致: stockId=${y.stockId}`);
  }
  for (const s of abc.scoreStmts) {
    const want = entryByStock.get(s.stockId)?.scoreNext;
    if (
      !want ||
      want.fundamentalScore !== s.triple.fundamentalScore ||
      want.technicalScore !== s.triple.technicalScore ||
      want.totalScore !== s.triple.totalScore
    ) {
      fail(`スコア文と entry.scoreNext の不一致: stockId=${s.stockId}`);
    }
  }
  const filedTotal = abc.preimages.size + abc.benefitUpdateCount + abc.changedStocks + abc.scoreChangedStocks;
  const abcPost = asRecord(JSON.parse(abcPostText), "abc-apply-post");
  const newMatch = asRecord(abcPost["newMatch"], "abc-apply-post.newMatch");
  if (filedTotal !== 508) fail(`filed 内訳=${filedTotal} (want 508)`);
  if (newMatch["benefit"] !== 473 || newMatch["mismatch"] !== 0) fail("abc-apply-post の benefit/mismatch が想定外");
  if (newMatch["fin"] !== 61 || newMatch["score"] !== 52) fail("abc-apply-post の fin/score が想定外");
  const regen = asRecord(abcPost["regen"], "abc-apply-post.regen");
  if ((regen["aMatch"] as number) + (regen["aDrift"] as number) !== 430) fail("aMatch+aDrift が 430 ではない");

  // 4. 証明 C (全文 62)。
  const ft = asRecord(JSON.parse(ftText), "fulltext-manifest");
  const ftBatches = asArray(ft["batches"], "fulltext-manifest.batches");
  if (ftBatches.length !== 13) fail(`全文 batches stocks=${ftBatches.length} (want 13)`);
  const descUpdates = new Map<number, { newFull: string; old: string; updatedAt: number }>();
  for (const b of ftBatches) {
    const batch = asRecord(b, "fulltext batch");
    for (const s of asArray(batch["statements"], "fulltext statements").slice(1)) {
      const st = asRecord(s, "fulltext statement");
      const sql = st["sql"] as string;
      if (typeof sql !== "string" || !sql.startsWith("UPDATE yutai_benefits SET description = ?")) {
        fail("全文の非 preflight 文が description UPDATE ではない");
      }
      const p = asArray(st["params"], "fulltext params");
      const id = p[1] as number;
      if (descUpdates.has(id)) fail(`全文 ID ${id} の重複`);
      descUpdates.set(id, { newFull: p[0] as string, old: p[2] as string, updatedAt: p[3] as number });
    }
  }
  if (descUpdates.size !== 62) fail(`全文 batched rows=${descUpdates.size} (want 62)`);
  const ftbefore = asRecord(JSON.parse(ftbeforeText), "ftbefore-inventory");
  const preById = new Map<number, string>();
  for (const s of asArray(ftbefore["stocks"], "ftbefore.stocks")) {
    for (const w of asArray(asRecord(s, "ftbefore stock")["wholeBenefitSet"], "wholeBenefitSet")) {
      const r = asRecord(w, "ftbefore row");
      preById.set(r["id"] as number, r["description"] as string);
    }
  }
  const rowManifest = asRecord(JSON.parse(rowText), "row-manifest");
  const rowById = new Map<number, NamedRow>();
  for (const w of asArray(rowManifest["rows"], "row-manifest.rows")) {
    const r = asRecord(w, "row-manifest row");
    rowById.set(r["id"] as number, {
      id: r["id"] as number,
      stockId: r["stockId"] as number,
      stockCode: r["stockCode"] as string,
      minShares: r["minShares"] as number,
      recordMonth: r["recordMonth"] as number,
      oldDescription: r["oldDescription"] as string,
      oldSha: r["oldSha"] as string,
      shortSummary: (r["shortSummary"] ?? null) as string | null,
      estimatedValue: (r["estimatedValue"] ?? null) as number | null,
      estimateValueSource: (r["estimateValueSource"] ?? null) as string | null,
      updatedAt: r["updatedAt"] as number,
      newFull: r["newFull"] as string,
      newFullSha: r["newFullSha"] as string,
      provenance: r["provenance"] as NamedRow["provenance"],
    });
  }
  if (rowById.size !== 349) fail(`row-manifest rows=${rowById.size} (want 349)`);
  // provenance source SHA: upstream 実ファイルと manifest-34 記録の両方と突き合わせる。
  const m34 = asRecord(JSON.parse(m34Text), "manifest-34");
  const m34res = new Map<string, { htmlSha256: string; jsonSha256: string }>();
  for (const w of asArray(m34["results"], "manifest-34.results")) {
    const r = asRecord(w, "manifest-34 result");
    m34res.set(r["code"] as string, { htmlSha256: r["htmlSha256"] as string, jsonSha256: r["jsonSha256"] as string });
  }
  let provenanceOk = 0;
  const htmlCache = new Map<string, string>();
  const jsonCache = new Map<string, string>();
  for (const r of rowById.values()) {
    let htmlSha = htmlCache.get(r.stockCode);
    if (!htmlSha) {
      htmlSha = sha256Hex(readFileSync(join(args.upstream, `${r.stockCode}.html`)));
      htmlCache.set(r.stockCode, htmlSha);
    }
    let jsonSha = jsonCache.get(r.stockCode);
    if (!jsonSha) {
      jsonSha = sha256Hex(readFileSync(join(args.upstream, `${r.stockCode}.json`)));
      jsonCache.set(r.stockCode, jsonSha);
    }
    const p = r.provenance;
    const m = m34res.get(r.stockCode);
    if (!m) fail(`manifest-34 に code=${r.stockCode} が無い`);
    if (
      htmlSha !== p.localHtmlSha || htmlSha !== p.manifestHtmlSha || htmlSha !== m!.htmlSha256 ||
      jsonSha !== p.localJsonSha || jsonSha !== p.manifestJsonSha || jsonSha !== m!.jsonSha256
    ) {
      fail(`code=${r.stockCode} の source SHA 不一致`);
    }
    provenanceOk++;
  }
  const ftRows: FulltextRow[] = [];
  const currentById = new Map<number, string>();
  for (const [id, u] of descUpdates) {
    const row = rowById.get(id);
    if (!row) fail(`全文 ID ${id} が row-manifest に無い`);
    const pre = preById.get(id);
    if (pre === undefined) fail(`全文 ID ${id} が ftbefore に無い`);
    if (u.old !== pre || u.old !== row!.oldDescription) fail(`全文 ID ${id} の旧文が 3 者不一致`);
    if (sha256Hex(u.old) !== row!.oldSha) fail(`全文 ID ${id} の oldSha 不一致`);
    if (u.newFull !== row!.newFull) fail(`全文 ID ${id} の newFull が row-manifest と不一致`);
    if (sha256Hex(u.newFull) !== row!.newFullSha) fail(`全文 ID ${id} の newFullSha 不一致`);
    ftRows.push({ id, stockCode: row!.stockCode, oldDescription: u.old, newFull: u.newFull, updatedAt: row!.updatedAt });
    currentById.set(id, u.newFull); // post 模擬 (live 適用で desc 62/mismatch 0 確認済み)。
  }
  const proofC = await proveFulltextReentry(ftRows, currentById, throwingSender);
  const ftPost = asRecord(JSON.parse(ftPostText), "ft-apply-post");
  if (ftPost["newFull"] !== 62 || ftPost["mismatch"] !== 0) fail("ft-apply-post の newFull/mismatch が想定外");

  // 5. 証明 A (normal 45)。
  const tasks = parseTaskFile(tasksText);
  if (tasks.length !== 45) fail(`tasks=${tasks.length} (want 45)`);
  // post 現行行: row-manifest 349 行に ABC 3 値 + 全文 newFull を適用する。
  // preFT 行: 同じく ABC 3 値のみ (ABC regen 時の状態の再現)。
  const nameByCode = new Map<string, string>();
  const currentRows: BenefitRow[] = [];
  const preFulltextRows: BenefitRow[] = [];
  for (const r of rowById.values()) {
    let name = nameByCode.get(r.stockCode);
    if (name === undefined) {
      const uj = asRecord(JSON.parse(readFileSync(join(args.upstream, `${r.stockCode}.json`), "utf-8")), `upstream ${r.stockCode}.json`);
      if (typeof uj["name"] !== "string") fail(`upstream ${r.stockCode}.json に name が無い`);
      name = uj["name"] as string;
      nameByCode.set(r.stockCode, name);
    }
    const planned = plannedById.get(r.id);
    const ft = descUpdates.get(r.id);
    const base = {
      id: r.id,
      stockId: r.stockId,
      stockCode: r.stockCode,
      stockName: name!,
      shortSummary: planned ? planned.shortSummary : r.shortSummary,
      estimatedValue: planned ? planned.estimatedValue : r.estimatedValue,
      estimateValueSource: planned ? planned.estimateValueSource : r.estimateValueSource,
      minShares: r.minShares,
      recordMonth: r.recordMonth,
      updatedAt: r.updatedAt,
    };
    currentRows.push({ ...base, description: ft ? ft.newFull : r.oldDescription });
    preFulltextRows.push({ ...base, description: r.oldDescription });
  }
  const proofA = proveNormal45(tasks, resultsText, currentRows, preFulltextRows);
  // live ABC regen (post-ABC/pre-FT) との突き合わせ: pending + stale == cUpdates。
  const cUpdates = regen["cUpdates"] as number;
  if (proofA.pendingTasks + proofA.stale !== cUpdates) {
    fail(`pending+stale=${proofA.pendingTasks + proofA.stale} vs live cUpdates=${cUpdates}`);
  }
  if (proofA.sourceOnlyRows + proofA.staleSourceOnlyRows !== 50) {
    fail(`出典差行=${proofA.sourceOnlyRows + proofA.staleSourceOnlyRows} (want 50)`);
  }

  // 6. 送信強制は各証明内の実経路で済み (実 apply/実 builder→throwingSender)。
  // ここに条件付き gate は置かない (実経路の二重化は偽装の温床のため)。

  const evidence: Evidence = {
    at: new Date().toISOString(),
    pins: { ...PINS },
    proofA: { ...proofA, verdict: "HONEST_COUNTS" },
    proofB: {
      ...proofB,
      verdict: "REENTRY_ZERO",
      filedChecks: {
        filedTotal508: filedTotal === 508,
        v3rows1557: v3rows === 1557,
        provenanceRows349: provenanceOk === 349,
        aDriftArithmetic430: true,
      },
    },
    proofC: { ...proofC, verdict: "REENTRY_ZERO" },
    verdict: "REENTRY_ZERO_ABC_FT__NORMAL_HONEST",
  };
  mkdirSync(dirname(args.out), { recursive: true, mode: 0o700 });
  chmodSync(dirname(args.out), 0o700);
  writeFileSync(args.out, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  chmodSync(args.out, 0o600);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((e) => {
      console.info(
        `DONE verdict=${e.verdict} ` +
          `A[tasks=${e.proofA.tasks} pending=${e.proofA.pendingTasks}/${e.proofA.pendingRows}rows srcOnly=${e.proofA.sourceOnlyRows} skipped=${e.proofA.skippedEquivalent} stale=${e.proofA.stale} unanswered=${e.proofA.unanswered}] ` +
          `B[stocks=${e.proofB.stocks} planned=${e.proofB.plannedIds} omitted=${e.proofB.omitted} changed=${e.proofB.changed} missing=${e.proofB.missing} benefitStmts=${e.proofB.benefitStatements} yield=${e.proofB.yieldChanged} score=${e.proofB.scoreChanged} calls=${e.proofB.senderCalls}] ` +
          `C[rows=${e.proofC.rows} applied=${e.proofC.applied} candidates=${e.proofC.candidates} stops=${e.proofC.stops} descStmts=${e.proofC.descStatements} wouldWrite=${e.proofC.wouldWrite} calls=${e.proofC.senderCalls}]`
      );
    })
    .catch((e) => {
      console.error("[reentry-verify] エラー:", e);
      process.exit(1);
    });
}

