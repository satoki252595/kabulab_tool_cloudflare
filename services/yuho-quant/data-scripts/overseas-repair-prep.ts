/**
 * 海外 actual-repair OFFLINE PREP (laneA 全 3675)。
 *
 * 最終 parser (PR208 merge) で固定 3675 ZIP の既存 raw のみを全件再生成し、
 * docID union (census/live1781/旧1695/73unknown/804系列の dedup + 全 tags)
 * ごとに full facts + preimage + protected 差 + reason journal を一度確定する。
 * 1411/1487/36 (3602 census) と旧 live 1695 (旧 parser prep 由来の L1changed)
 * は母集合が別のため docID 分離し、1695 を新 qualified 候補数と呼ばない。
 *
 * 再使用のみ (新 framework なし): 745-prep と同一 skeleton (fetch 全面拒否・
 * pins 照合・parse→validate→caller 同等変換・compare・0600 成果物)、同一
 * parser/validator、union/tags/分離は lib/repair-union.ts (test 済み)。
 * 804/59/745 系列は pinned prep 出力の導出を再使用し setSHA で連続確認する
 * (CAS 証跡自体の再検証は 745-prep PASS で確定済み・pins 不変で carry)。
 *
 * オフライン保証:
 * - 冒頭で fetch を全面拒否 (source/Notion/D1/R2/dispatch への到達は 0 を断言)。
 * - 新 ZIP 取得・本番書込・Notion 新 receipt なし。旧 laneA grants は CANCELLED
 *   のため再利用しない (journal は outcome/planSHA の照合読取のみ)。
 * - 例外は empty facts へ fallback せず HOLD 分類。旧 journal の blind apply なし。
 * - raw ファイルは原状保全 (書込なし)。旧 source pins mismatch は再 pin せず HOLD。
 * - 実 parser の proof + 変換前の実 facts を per-doc に保持する (proof は
 *   rounding/reconciliation 区間、facts は unitYenFactor + fiscal + scope。
 *   same-table locator は facts の行自体。private のみ)。
 * - receipt は既証跡の静読のみ (不在 → ARCHIVE_PENDING、不正/実 bytes
 *   不一致 → HOLD)。same/written + pageId は manifest 照合の記録であって
 *   hosted bytes の証明ではないため、一致しても RECEIVED にしない
 *   (metadata として保持)。検証済み physical receipt loader なし →
 *   RECEIVED は将来の explicitly verified physical closure まで到達なし。
 * - 候補は parse+validate+pin+pin不一致なし+scope既知+receipt の全条件。
 *   意味は OFFLINE_CANDIDATE。計算結果をそのまま報告し、grant で 0 に
 *   偽装しない。liveReady / applyQualified は grant 状態として別明示。
 * - live 観測行の全体 (q1/q2 の id/stockId/periodEnd/documentId 含む) を
 *   journal に保持する (照合 projection とは別)。DB 全体像の preimage は
 *   名乗らない (旧 Q1 は 7 列 projection のみ)。
 *
 * 固定入力 (bytes SHA256 pins・不一致は HOLD):
 * - overseas_laneA_raw/manifest_full.json (3602 pins) + <docID>_t1.zip (3675)
 * - overseas_laneA_okdocs.json / _savedfacts.json
 * - overseas745-prep-20260930/prep-{manifest,sets,journal}.{json,json,jsonl}
 * - overseas-census2-3602.jsonl (最終 freeze bb1cccb1)
 * - overseas745-select-20260930/select-{union,live,compare}.json
 *
 * 出力 (OUT_DIR のみ・0600。stdout は counts/SHA/limits のみ):
 * - repair-manifest.json (3675件の per-doc 記録・tags 付き)
 * - repair-journal.jsonl (changed + HOLD の before/after 全表 + reason)
 * - repair-sets.json (tag 別 docID 集合)
 * - repair-report.json (集計・pins・zeros・limits)
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/overseas-repair-prep.ts
 *   [--lane-dir /tmp] [--raw-dir /tmp/overseas_laneA_raw]
 *   [--prep-dir /tmp/overseas745-prep-20260930] [--select-dir /tmp/overseas745-select-20260930]
 *   [--census /tmp/overseas-census2-3602.jsonl] [--receipts none]
 *   [--out-dir /tmp/overseas-repair-prep-20260930]
 */

// ---------------------------------------------------------------------------
// 0. 全面 network 拒否 (repo import より前に設置)
// ---------------------------------------------------------------------------
let fetchAttempts = 0;
globalThis.fetch = (() => {
  fetchAttempts += 1;
  throw new Error("OFFLINE PREP: network fetch denied");
}) as typeof fetch;

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { OverseasFact, OverseasProof } from "../src/services/overseas-parser.js";
import type {
  MembershipTag,
  NewVerdict,
  ReceiptEvidence,
  ReceiptState,
} from "./lib/repair-union.js";

// guard 設置後に repo runtime を dynamic import する (745-prep と同一順序)。
const parserMod = await import("../src/services/overseas-parser.js");
const { parseOverseasData, validateOverseasSaveSet } = parserMod;
const unionMod = await import("./lib/repair-union.js");
const { buildUnion, censusTags, classifyReceipt, computeOfflineCandidates, separatedCounts } = unionMod;

// ---------------------------------------------------------------------------
// 固定 pins
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PARSER_PATH = "services/yuho-quant/src/services/overseas-parser.ts";
const PARSER_BLOB = "07ad7a54b975c543a604dcf52b31df91b72f23f7";

const PINS: Record<string, string> = {
  manifestFull: "398843d5c7bcb4ade93b8e9e273fa9e809c17c1e77dadd9d3e42582b2dc02ca4",
  okdocs: "034cefad5a7986f874fdc453c0e6a28f23d1ffe565be1ada5a65020718298735",
  savedfacts: "58122d8d51046d312c93fdc18b5851eb14c6aabcad551881ab8713a49b2bbb31",
  prepManifest: "c2345269b7e7c69def699ce12a8b7a032b16539768344069aceb1302547083a7",
  prepSets: "62095358c460002afcf06a41e65db14c9c75171eebfa0a5ae06e09713308b5d1",
  prepJournal: "5127c73b45e24b94eda01198b159032fc56333c72f8d53e71fbb2b2d2885b9dc",
  census: "bb1cccb1b8818f0b9d3489affe169068817dae49aeb512c2c2dc20553cde7387",
  selectUnion: "54c6fb381da57c9ef4cb9fb2c1d24693ed289ccb89f59a433a5908dfe4f16fdc",
  selectLive: "4a4cbc049d11e6cc7b617cb298092c85b5feaaf921fbb07ad4c11b253adeb517",
  selectCompare: "75ba0835f8b6592b35c416672ed8209e9dc92f36748f5c6d14ff3bf71d74e879",
};
const SET_SHAS = {
  s804: "64daec93d7380ae9b91c7329eb61344d17a0f885aea614cecb707c922a4e983e",
  s59: "7ccf9a6f985622c1291e36ed25a1561621c3d91e472c02036b38b1d7d2c2f70c",
  s745: "8c09ab3447e14d231a5e39addb6d8ce2fd037d22754cd38eb3b0c778285c2d81",
};

// ---------------------------------------------------------------------------
// helpers (745-prep と同一)
// ---------------------------------------------------------------------------
class HoldError extends Error {
  constructor(msg: string) {
    super(`HOLD: ${msg}`);
    this.name = "HoldError";
  }
}
function hold(msg: string): never {
  throw new HoldError(msg);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readPinned(path: string, pinKey: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    hold(`入力不在: ${path}`);
  }
  const got = sha256Hex(bytes);
  if (got !== PINS[pinKey]) {
    hold(`pin不一致: ${basename(path)} got=${got.slice(0, 16)}…`);
  }
  return bytes;
}

function parseJSON(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    hold(`JSON 破損: ${label}`);
  }
}

function parseJSONL(bytes: Buffer, label: string): unknown[] {
  const text = bytes.toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      hold(`JSONL 破損: ${label} 行${i + 1}`);
    }
  });
}

/** sortedDocIDs の JSON.stringify SHA (JS 既定の compact 形)。 */
function setSHA(ids: string[]): string {
  return sha256Hex(JSON.stringify([...ids].sort()));
}

const argValue = (n: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? dflt;

function writePrivate(path: string, data: string): string {
  writeFileSync(path, data, { mode: 0o600 });
  return sha256Hex(data);
}

function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) hold(`形状外: ${label}`);
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 保存 caller 同等変換 (backfill-overseas.ts + ingest.ts と同一意味)
// ---------------------------------------------------------------------------
function toYen(raw: number | null, factor: number): number | null {
  return raw === null ? null : Math.round(raw * factor);
}

function patternOf(status: string): string {
  if (status === "ok_geo_rows") return "geo_rows";
  if (status === "ok_geo_cols") return "geo_cols";
  return "none";
}

interface SaveRow {
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  salesRaw: number | null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

function toSaveRows(facts: OverseasFact[], status: string): SaveRow[] {
  return facts.map((f) => ({
    fiscalYearEnd: f.fiscalYearEnd,
    regionName: f.regionName,
    regionKind: f.regionKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    salesRaw: f.salesAmount,
    salesYen: toYen(f.salesAmount, f.unitYenFactor),
    ratioPct: f.ratioPct,
    pattern: patternOf(status),
  }));
}

const rowKey = (r: { fiscalYearEnd: string; regionName: string }): string =>
  `${r.fiscalYearEnd} ${r.regionName}`;

/** D1 の 0/1/null と JSON の true/false/null を null|boolean へ正規化する。 */
function normConsolidated(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  hold(`isConsolidated 値域外: ${String(v)}`);
}

// ---------------------------------------------------------------------------
// 入力の構造検証 (値の捏造なし。不正は HOLD)
// ---------------------------------------------------------------------------
function loadOkDocs(bytes: Buffer): Map<string, string> {
  const arr = parseJSON(bytes, "okdocs");
  if (!Array.isArray(arr) || arr.length !== 3675) hold(`okdocs 件数外: ${Array.isArray(arr) ? arr.length : "非配列"}`);
  const out = new Map<string, string>();
  for (const e of arr) {
    const r = asRecord(e, "okdocs 要素");
    const doc = r["doc_id"];
    const pe = r["period_end"];
    if (typeof doc !== "string" || doc === "") hold("okdocs doc_id 形状外");
    if (typeof pe !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pe)) hold(`okdocs period 形状外: ${doc}`);
    if (out.has(doc)) hold(`okdocs doc 重複: ${doc}`);
    out.set(doc, pe);
  }
  return out;
}

/** before 行 (savedfacts の snake_case を共通形へ)。sales_raw は before に無い。 */
interface BeforeRow {
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  salesRaw: null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

function loadSavedFacts(bytes: Buffer, okdocs: Map<string, string>): Map<string, BeforeRow[]> {
  const arr = parseJSON(bytes, "savedfacts");
  if (!Array.isArray(arr) || arr.length !== 21258) {
    hold(`savedfacts 件数外: ${Array.isArray(arr) ? arr.length : "非配列"}`);
  }
  const out = new Map<string, BeforeRow[]>();
  for (const e of arr) {
    const r = asRecord(e, "savedfacts 要素");
    const doc = r["doc_id"];
    if (typeof doc !== "string" || !okdocs.has(doc)) hold("savedfacts doc 範囲外");
    const fy = r["fiscal_year_end"];
    const rn = r["region_name"];
    const rk = r["region_kind"];
    const ul = r["unit_label"];
    const sy = r["sales_yen"];
    const rp = r["ratio_pct"];
    const pt = r["pattern"];
    if (typeof fy !== "string" || typeof rn !== "string" || typeof rk !== "string") {
      hold(`savedfacts 行形状外: ${doc}`);
    }
    if (typeof ul !== "string" || typeof pt !== "string") hold(`savedfacts 行形状外: ${doc}`);
    if (!(sy === null || typeof sy === "number") || !(rp === null || typeof rp === "number")) {
      hold(`savedfacts 値形状外: ${doc}`);
    }
    const row: BeforeRow = {
      fiscalYearEnd: fy, regionName: rn, regionKind: rk,
      isConsolidated: normConsolidated(r["is_consolidated"]),
      unitLabel: ul, salesRaw: null, salesYen: sy, ratioPct: rp, pattern: pt,
    };
    const list = out.get(doc) ?? [];
    list.push(row);
    out.set(doc, list);
  }
  if (out.size !== 3675) hold(`savedfacts doc 数外: ${out.size}`);
  return out;
}

interface ManifestEntry {
  sha256: string;
  bytes: number;
}

function loadManifestFull(bytes: Buffer): Map<string, ManifestEntry> {
  const obj = asRecord(parseJSON(bytes, "manifest_full"), "manifest_full");
  const keys = Object.keys(obj);
  if (keys.length !== 3602) hold(`manifest_full 件数外: ${keys.length}`);
  const out = new Map<string, ManifestEntry>();
  for (const k of keys) {
    const r = asRecord(obj[k], `manifest_full[${k}]`);
    if (typeof r["sha256"] !== "string" || (r["sha256"] as string).length !== 64) {
      hold(`manifest_full sha 形状外: ${k}`);
    }
    if (typeof r["bytes"] !== "number") hold(`manifest_full bytes 形状外: ${k}`);
    out.set(k, { sha256: r["sha256"] as string, bytes: r["bytes"] as number });
  }
  return out;
}

interface PrepRecord {
  doc: string;
  set: "applied59" | "remain745" | "stable2871";
  pin: "pinned" | "fixed-now";
  periodEnd: string;
  savedStatus: string;
  fixupNewStatus: string;
  verdict: string;
}

/** pinned prep-manifest から 804/59/745 系列を再構成し setSHA で連続確認する。 */
function loadPrepManifest(bytes: Buffer, okdocs: Map<string, string>): {
  records: Map<string, PrepRecord>;
  s59: string[];
  s745: string[];
  s804: string[];
  pinMissing: string[];
} {
  const arr = parseJSON(bytes, "prep-manifest");
  if (!Array.isArray(arr) || arr.length !== 3675) hold(`prep-manifest 件数外`);
  const records = new Map<string, PrepRecord>();
  for (const e of arr) {
    const r = asRecord(e, "prep-manifest 要素");
    const doc = r["doc"];
    const set = r["set"];
    const pin = r["pin"];
    const periodEnd = r["periodEnd"];
    const savedStatus = r["savedStatus"];
    const fixupNewStatus = r["fixupNewStatus"];
    const verdict = r["verdict"];
    if (typeof doc !== "string" || !okdocs.has(doc)) hold("prep-manifest doc 範囲外");
    if (set !== "applied59" && set !== "remain745" && set !== "stable2871") {
      hold(`prep-manifest set 外: ${doc}`);
    }
    if (pin !== "pinned" && pin !== "fixed-now") hold(`prep-manifest pin 外: ${doc}`);
    if (typeof periodEnd !== "string" || typeof savedStatus !== "string") {
      hold(`prep-manifest 形状外: ${doc}`);
    }
    if (typeof fixupNewStatus !== "string" || typeof verdict !== "string") {
      hold(`prep-manifest 形状外: ${doc}`);
    }
    if (okdocs.get(doc) !== periodEnd) hold(`prep-manifest period 不一致: ${doc}`);
    if (records.has(doc)) hold(`prep-manifest doc 重複: ${doc}`);
    records.set(doc, { doc, set, pin, periodEnd, savedStatus, fixupNewStatus, verdict });
  }
  const s59 = [...records.values()].filter((r) => r.set === "applied59").map((r) => r.doc);
  const s745 = [...records.values()].filter((r) => r.set === "remain745").map((r) => r.doc);
  const s804 = [...s59, ...s745];
  if (s59.length !== 59 || s745.length !== 745 || s804.length !== 804) hold("prep 系列件数外");
  if (new Set(s804).size !== 804) hold("prep 59/745 重複あり");
  if (setSHA(s804) !== SET_SHAS.s804) hold("prep 804 setSHA 外");
  if (setSHA(s59) !== SET_SHAS.s59) hold("prep 59 setSHA 外");
  if (setSHA(s745) !== SET_SHAS.s745) hold("prep 745 setSHA 外");
  const pinMissing = [...records.values()].filter((r) => r.pin === "fixed-now").map((r) => r.doc);
  if (pinMissing.length !== 73) hold(`prep pin不足 件数外: ${pinMissing.length}`);
  return { records, s59, s745, s804, pinMissing };
}

/** pinned prep-sets と manifest 導出の相互照合。 */
function loadPrepSets(bytes: Buffer, records: Map<string, PrepRecord>): void {
  const obj = asRecord(parseJSON(bytes, "prep-sets"), "prep-sets");
  const expect: Record<string, (r: PrepRecord) => boolean> = {
    changed745: (r) => r.verdict === "changed" && r.set === "remain745",
    match745: (r) => r.verdict === "match" && r.set === "remain745",
    hold745: (r) => r.verdict.startsWith("HOLD") && r.set === "remain745",
    changed59: (r) => r.verdict === "changed" && r.set === "applied59",
    match59: (r) => r.verdict === "match" && r.set === "applied59",
    hold59: (r) => r.verdict.startsWith("HOLD") && r.set === "applied59",
    changedOutside804: (r) => r.verdict === "changed" && r.set === "stable2871",
    holdOutside804: (r) => r.verdict.startsWith("HOLD") && r.set === "stable2871",
    pinMissing73: (r) => r.pin === "fixed-now",
    holdParse: (r) => r.verdict === "HOLD_PARSE",
    holdValidation: (r) => r.verdict === "HOLD_VALIDATION",
  };
  for (const [key, pred] of Object.entries(expect)) {
    const arr = obj[key];
    if (!Array.isArray(arr)) hold(`prep-sets ${key} 非配列`);
    const want = [...records.values()].filter(pred).map((r) => r.doc).sort();
    const got = [...(arr as unknown[])].map((d) => String(d)).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) hold(`prep-sets ${key} 不一致`);
  }
}

interface SealedBefore {
  status: string;
  honbun: string | null;
  rows: SaveRow[];
}

/** pinned prep-journal から applied59 の sealed-post before を索引する。 */
function loadJournalSealed(bytes: Buffer, s59: Set<string>): Map<string, SealedBefore> {
  const arr = parseJSONL(bytes, "prep-journal");
  if (arr.length !== 1728) hold(`prep-journal 件数外: ${arr.length}`);
  const out = new Map<string, SealedBefore>();
  for (const e of arr) {
    const r = asRecord(e, "prep-journal 要素");
    if (r["set"] !== "applied59") continue;
    const doc = r["doc"];
    if (typeof doc !== "string" || !s59.has(doc)) hold("prep-journal 59 doc 範囲外");
    const before = asRecord(r["before"], `prep-journal before: ${doc}`);
    if (before["kind"] !== "sealed-post") hold(`prep-journal before 種別外: ${doc}`);
    if (typeof before["status"] !== "string") hold(`prep-journal status 外: ${doc}`);
    if (!(typeof before["honbun"] === "string" || before["honbun"] === null)) {
      hold(`prep-journal honbun 外: ${doc}`);
    }
    if (!Array.isArray(before["rows"])) hold(`prep-journal rows 外: ${doc}`);
    out.set(doc as string, {
      status: before["status"] as string,
      honbun: before["honbun"] as string | null,
      rows: before["rows"] as SaveRow[],
    });
  }
  return out;
}

interface CensusEntry {
  oldStatus: string;
  status: string;
  facts: number;
}

/** 最終 freeze census (3602 = manifest keys)。class は lib censusTags で決定。 */
function loadCensus(bytes: Buffer, manifestFull: Map<string, ManifestEntry>): {
  entries: Map<string, CensusEntry>;
  adopted: string[];
  held: string[];
  reverse: string[];
} {
  const arr = parseJSONL(bytes, "census");
  if (arr.length !== 3602) hold(`census 件数外: ${arr.length}`);
  const entries = new Map<string, CensusEntry>();
  for (const e of arr) {
    const r = asRecord(e, "census 要素");
    const doc = r["doc"];
    const oldStatus = r["oldStatus"];
    const status = r["status"];
    const facts = r["facts"];
    if (typeof doc !== "string" || !manifestFull.has(doc)) hold("census doc 範囲外");
    if (typeof oldStatus !== "string" || typeof status !== "string") hold(`census 形状外: ${doc}`);
    if (typeof facts !== "number") hold(`census facts 外: ${doc}`);
    if (entries.has(doc)) hold(`census doc 重複: ${doc}`);
    entries.set(doc, { oldStatus, status, facts });
  }
  if (entries.size !== manifestFull.size) hold("census が manifest と不一致");
  const adopted: string[] = [];
  const held: string[] = [];
  const reverse: string[] = [];
  for (const [doc, en] of entries) {
    const tags = censusTags(en.oldStatus, en.status);
    if (tags.includes("census-adopted")) adopted.push(doc);
    if (tags.includes("census-held")) held.push(doc);
    if (tags.includes("census-reverse")) reverse.push(doc);
  }
  if (adopted.length !== 1411 || held.length !== 1487 || reverse.length !== 36) {
    hold(`census class 外: ${adopted.length}/${held.length}/${reverse.length}`);
  }
  return { entries, adopted, held, reverse };
}

function loadSelectUnion(bytes: Buffer, okdocs: Map<string, string>): string[] {
  const obj = asRecord(parseJSON(bytes, "select-union"), "select-union");
  if (obj["count"] !== 1781) hold("select-union count 外");
  const ids = obj["ids"];
  if (!Array.isArray(ids) || ids.length !== 1781) hold("select-union ids 外");
  const out = (ids as unknown[]).map((d) => String(d));
  if (new Set(out).size !== 1781) hold("select-union 重複あり");
  for (const d of out) {
    if (!okdocs.has(d)) hold(`select-union が okdocs 外: ${d}`);
  }
  return out;
}

function loadSelectCompare(
  bytes: Buffer,
  union: Set<string>
): { l1changed: string[]; verdicts: Map<string, string> } {
  const arr = parseJSON(bytes, "select-compare");
  if (!Array.isArray(arr) || arr.length !== 1781) hold("select-compare 件数外");
  const verdicts = new Map<string, string>();
  for (const e of arr) {
    const r = asRecord(e, "select-compare 要素");
    const doc = r["doc"];
    if (typeof doc !== "string" || !union.has(doc)) hold("select-compare doc 範囲外");
    const l1 = asRecord(r["L1"], `select-compare L1: ${doc}`);
    if (l1["verdict"] !== "match" && l1["verdict"] !== "changed") {
      hold(`select-compare L1 外: ${doc}`);
    }
    if (verdicts.has(doc)) hold(`select-compare doc 重複: ${doc}`);
    verdicts.set(doc, l1["verdict"] as string);
  }
  if (verdicts.size !== 1781) hold("select-compare union 不一致");
  const l1changed = [...verdicts.entries()].filter(([, v]) => v === "changed").map(([d]) => d);
  if (l1changed.length !== 1695) hold(`旧 L1changed 件数外: ${l1changed.length}`);
  return { l1changed, verdicts };
}

interface LiveRow {
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  salesRaw: number | null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

interface LiveDoc {
  status: string;
  honbun: string | null;
  factsCount: number;
}

/**
 * live snapshot (旧観測。live-current を保証しない)。
 * 照合 projection (docs/rows) とは別に、観測行の全体 (rawQ1/rawQ2:
 * id/stockId/periodEnd/documentId を含む) を保持する。DB 全体像の
 * preimage を名乗らない (旧 Q1 は 7 列 projection のみ。未選択の
 * protected fields は LIMIT・将来 fresh SELECT が要る)。
 */
function loadSelectLive(bytes: Buffer, union: Set<string>): {
  docs: Map<string, LiveDoc>;
  rows: Map<string, LiveRow[]>;
  rawQ1: Map<string, Record<string, unknown>>;
  rawQ2: Map<string, Array<Record<string, unknown>>>;
} {
  const obj = asRecord(parseJSON(bytes, "select-live"), "select-live");
  const q1 = obj["q1"];
  const q2 = obj["q2"];
  if (!Array.isArray(q1) || q1.length !== 1781) hold("select-live q1 外");
  if (!Array.isArray(q2) || q2.length !== 10257) hold("select-live q2 外");
  const docs = new Map<string, LiveDoc>();
  const rawQ1 = new Map<string, Record<string, unknown>>();
  let q1sum = 0;
  for (const e of q1) {
    const r = asRecord(e, "select-live q1 要素");
    const doc = r["docId"];
    if (typeof doc !== "string" || !union.has(doc)) hold("select-live q1 範囲外");
    if (typeof r["overseasParseStatus"] !== "string") hold(`select-live q1 形状外: ${doc}`);
    if (!(typeof r["overseasHonbunFile"] === "string" || r["overseasHonbunFile"] === null)) {
      hold(`select-live q1 honbun 外: ${doc}`);
    }
    if (typeof r["factsCount"] !== "number") hold(`select-live q1 count 外: ${doc}`);
    if (docs.has(doc)) hold(`select-live q1 重複: ${doc}`);
    docs.set(doc, {
      status: r["overseasParseStatus"] as string,
      honbun: r["overseasHonbunFile"] as string | null,
      factsCount: r["factsCount"] as number,
    });
    rawQ1.set(doc, r);
    q1sum += r["factsCount"] as number;
  }
  if (docs.size !== 1781) hold("select-live q1 union 不一致");
  if (q1sum !== 10257) hold(`select-live Q1総計外: ${q1sum}`);
  const rows = new Map<string, LiveRow[]>();
  const rawQ2 = new Map<string, Array<Record<string, unknown>>>();
  for (const e of q2) {
    const r = asRecord(e, "select-live q2 要素");
    const doc = r["docId"];
    if (typeof doc !== "string" || !union.has(doc)) hold("select-live q2 範囲外");
    if (typeof r["fiscalYearEnd"] !== "string" || typeof r["regionName"] !== "string") {
      hold(`select-live q2 形状外: ${doc}`);
    }
    if (typeof r["regionKind"] !== "string" || typeof r["unitLabel"] !== "string") {
      hold(`select-live q2 形状外: ${doc}`);
    }
    if (!(r["salesRaw"] === null || typeof r["salesRaw"] === "number")) hold(`select-live q2 raw 外: ${doc}`);
    if (!(r["salesYen"] === null || typeof r["salesYen"] === "number")) hold(`select-live q2 yen 外: ${doc}`);
    if (!(r["ratioPct"] === null || typeof r["ratioPct"] === "number")) hold(`select-live q2 ratio 外: ${doc}`);
    if (typeof r["pattern"] !== "string") hold(`select-live q2 pattern 外: ${doc}`);
    const list = rows.get(doc) ?? [];
    list.push({
      fiscalYearEnd: r["fiscalYearEnd"] as string,
      regionName: r["regionName"] as string,
      regionKind: r["regionKind"] as string,
      isConsolidated: normConsolidated(r["isConsolidated"]),
      unitLabel: r["unitLabel"] as string,
      salesRaw: r["salesRaw"] as number | null,
      salesYen: r["salesYen"] as number | null,
      ratioPct: r["ratioPct"] as number | null,
      pattern: r["pattern"] as string,
    });
    rows.set(doc, list);
    const rawList = rawQ2.get(doc) ?? [];
    rawList.push(r);
    rawQ2.set(doc, rawList);
  }
  return { docs, rows, rawQ1, rawQ2 };
}

/** receipt 証跡 (任意。既定 none → 全 ARCHIVE_PENDING)。 */
function loadReceipts(path: string): Map<string, ReceiptEvidence> {
  const out = new Map<string, ReceiptEvidence>();
  if (path === "none") return out;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    hold(`receipt 入力不在: ${path}`);
  }
  const obj = asRecord(parseJSON(bytes, "receipts"), "receipts");
  for (const [doc, v] of Object.entries(obj)) {
    const r = asRecord(v, `receipts[${doc}]`);
    const rec = r["receipt"];
    out.set(doc, {
      sha256: r["sha256"] as string,
      bytes: r["bytes"] as number,
      ...(rec !== undefined && typeof rec === "object" && rec !== null
        ? {
            receipt: {
              pageId: (rec as Record<string, unknown>)["pageId"] as string,
              manifestMatch: (rec as Record<string, unknown>)["manifestMatch"] as string,
            },
          }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// before/expected と current の比較 (745-prep と同一 reason 分類)
// ---------------------------------------------------------------------------
type NormRow = BeforeRow | SaveRow | LiveRow;

interface CompareOut {
  equal: boolean;
  reasons: string[];
  addedKeys: string[];
  removedKeys: string[];
  fieldDiffs: Array<{ key: string; fields: string[] }>;
}

function compareRows(
  before: NormRow[],
  after: SaveRow[],
  statusBefore: string,
  statusAfter: string,
  honbunBefore: string | null,
  honbunAfter: string | null,
  compareRaw: boolean,
  compareHonbun: boolean
): CompareOut {
  const reasons: string[] = [];
  if (statusBefore !== statusAfter) reasons.push(`STATUS:${statusBefore}→${statusAfter}`);
  if (compareHonbun && honbunBefore !== honbunAfter) reasons.push("HONBUN");
  const bMap = new Map(before.map((r) => [rowKey(r), r]));
  const aMap = new Map(after.map((r) => [rowKey(r), r]));
  const addedKeys = [...aMap.keys()].filter((k) => !bMap.has(k)).sort();
  const removedKeys = [...bMap.keys()].filter((k) => !aMap.has(k)).sort();
  if (addedKeys.length > 0 || removedKeys.length > 0) reasons.push("SCOPE");
  if (before.length > 0 && after.length === 0) reasons.push("FACTS_DELETED");
  if (before.length === 0 && after.length > 0) reasons.push("FACTS_CREATED");
  const bByRegion = new Map(before.map((r) => [r.regionName, r.fiscalYearEnd]));
  const aByRegion = new Map(after.map((r) => [r.regionName, r.fiscalYearEnd]));
  for (const [rn, bfy] of bByRegion) {
    const afy = aByRegion.get(rn);
    if (afy !== undefined && afy !== bfy) {
      reasons.push("FYEAR");
      break;
    }
  }
  const fieldDiffs: Array<{ key: string; fields: string[] }> = [];
  for (const [k, b] of bMap) {
    const a = aMap.get(k);
    if (!a) continue;
    const fields: string[] = [];
    if (b.regionKind !== a.regionKind) fields.push("regionKind");
    if (b.isConsolidated !== a.isConsolidated) fields.push("isConsolidated");
    if (b.unitLabel !== a.unitLabel) fields.push("unitLabel");
    if (compareRaw && (b as SaveRow).salesRaw !== a.salesRaw) fields.push("salesRaw");
    if (b.salesYen !== a.salesYen) fields.push("salesYen");
    if (b.ratioPct !== a.ratioPct) fields.push("ratioPct");
    if (b.pattern !== a.pattern) fields.push("pattern");
    if (fields.length > 0) {
      fieldDiffs.push({ key: k, fields });
      for (const f of fields) {
        const tag =
          f === "salesYen" ? "VALUE" : f === "salesRaw" ? "RAW" : f === "unitLabel" ? "UNIT"
          : f === "isConsolidated" ? "CONSOLIDATED" : f === "regionKind" ? "REGIONKIND"
          : f === "ratioPct" ? "RATIO" : "PATTERN";
        if (!reasons.includes(tag)) reasons.push(tag);
      }
    }
  }
  return { equal: reasons.length === 0, reasons: reasons.sort(), addedKeys, removedKeys, fieldDiffs };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const LANE_DIR = argValue("lane-dir", "/tmp");
const RAW_DIR = argValue("raw-dir", "/tmp/overseas_laneA_raw");
const PREP_DIR = argValue("prep-dir", "/tmp/overseas745-prep-20260930");
const SELECT_DIR = argValue("select-dir", "/tmp/overseas745-select-20260930");
const CENSUS_PATH = argValue("census", "/tmp/overseas-census2-3602.jsonl");
const RECEIPTS_PATH = argValue("receipts", "none");
const OUT_DIR = argValue("out-dir", "/tmp/overseas-repair-prep-20260930");
const STARTED_AT = new Date().toISOString();

type Verdict = "match" | "changed" | "HOLD_PIN_MISSING" | "HOLD_PIN_MISMATCH" | "HOLD_PARSE" | "HOLD_VALIDATION" | "HOLD_RECEIPT";

interface ManifestRecord {
  doc: string;
  tags: MembershipTag[];
  set: "applied59" | "remain745" | "stable2871";
  pin: "pinned" | "fixed-now";
  pinMismatch: boolean;
  zipBytes: number;
  zipSHA256: string;
  periodEnd: string;
  censusClasses: MembershipTag[];
  prepVerdict: string;
  savedStatus: string;
  currentStatus: string | null;
  honbunFile: string | null;
  tablesScanned: number | null;
  factsCount: number | null;
  /** 実 parser の proof (rounding/reconciliation 区間の認定証跡。private のみ)。 */
  proof: OverseasProof | null;
  /** 変換前の実 facts (unitYenFactor + fiscal + scope。proof と併置。private のみ)。 */
  facts: OverseasFact[] | null;
  scopeKnown: boolean;
  validateOK: boolean | null;
  validateError: string | null;
  baseline: "sealed" | "before";
  preimageRef: string;
  liveObserved: boolean;
  verdict: Verdict;
  compareVerdict: "match" | "changed" | null;
  reasons: string[];
  receipt: ReceiptState;
  receiptShaMatch: boolean;
  /** manifest 照合 metadata (same/written+pageId)。hosted 証明ではない。 */
  receiptMeta: { pageId: string; manifestMatch: string } | null;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);

  // 1. parser 固定の確認 (local git 読取のみ)。
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  const headBlob = git(["rev-parse", `HEAD:${PARSER_PATH}`]);
  if (headBlob !== PARSER_BLOB) hold(`parser blob 外: ${headBlob.slice(0, 16)}…`);
  if (git(["status", "--porcelain", "--", PARSER_PATH]) !== "") hold("parser に未commit変更あり");
  const workHead = git(["rev-parse", "HEAD"]);

  // 2. 固定入力の pins 照合。
  const manifestFullBytes = readPinned(join(RAW_DIR, "manifest_full.json"), "manifestFull");
  const okdocsBytes = readPinned(join(LANE_DIR, "overseas_laneA_okdocs.json"), "okdocs");
  const savedfactsBytes = readPinned(join(LANE_DIR, "overseas_laneA_savedfacts.json"), "savedfacts");
  const prepManifestBytes = readPinned(join(PREP_DIR, "prep-manifest.json"), "prepManifest");
  const prepSetsBytes = readPinned(join(PREP_DIR, "prep-sets.json"), "prepSets");
  const prepJournalBytes = readPinned(join(PREP_DIR, "prep-journal.jsonl"), "prepJournal");
  const censusBytes = readPinned(CENSUS_PATH, "census");
  const unionBytes = readPinned(join(SELECT_DIR, "select-union.json"), "selectUnion");
  const liveBytes = readPinned(join(SELECT_DIR, "select-live.json"), "selectLive");
  const compareBytes = readPinned(join(SELECT_DIR, "select-compare.json"), "selectCompare");

  // 3. 構造検証 + 集合の導出。
  const okdocs = loadOkDocs(okdocsBytes);
  const savedfacts = loadSavedFacts(savedfactsBytes, okdocs);
  const manifestFull = loadManifestFull(manifestFullBytes);
  const prep = loadPrepManifest(prepManifestBytes, okdocs);
  loadPrepSets(prepSetsBytes, prep.records);
  const set59 = new Set(prep.s59);
  const journalSealed = loadJournalSealed(prepJournalBytes, set59);
  const census = loadCensus(censusBytes, manifestFull);
  const unionIds = loadSelectUnion(unionBytes, okdocs);
  const union = new Set(unionIds);
  const compare = loadSelectCompare(compareBytes, union);
  const live = loadSelectLive(liveBytes, union);
  const receipts = loadReceipts(RECEIPTS_PATH);
  // pin73 の二重導出照合 (manifest 欠落 == prep fixed-now)。
  const missing73 = [...okdocs.keys()].filter((id) => !manifestFull.has(id)).sort();
  if (missing73.length !== 73) hold(`pin不足 件数外: ${missing73.length}`);
  if (JSON.stringify(missing73) !== JSON.stringify([...prep.pinMissing].sort())) {
    hold("pin不足 集合不一致 (manifest/prep)");
  }
  // union 組成の集合照合 (745 ∪ outside977 ∪ 59)。
  const outside977 = [...prep.records.values()]
    .filter((r) => r.set === "stable2871" && (r.verdict === "changed" || r.verdict.startsWith("HOLD")))
    .map((r) => r.doc);
  if (outside977.length !== 977) hold(`outside977 件数外: ${outside977.length}`);
  const unionExpect = new Set([...prep.s745, ...outside977, ...prep.s59]);
  if (unionExpect.size !== 1781) hold("union 組成重複あり");
  for (const d of unionExpect) {
    if (!union.has(d)) hold(`union 組成外: ${d}`);
  }

  // 4. docID union (dedup + 全 tags)。
  const tagEntries: Array<{ doc: string; tag: MembershipTag }> = [];
  const push = (docs: string[], tag: MembershipTag): void => {
    for (const d of docs) tagEntries.push({ doc: d, tag });
  };
  push(census.adopted, "census-adopted");
  push(census.held, "census-held");
  push(census.reverse, "census-reverse");
  push([...census.entries.keys()].filter((d) => {
    const en = census.entries.get(d) as { oldStatus: string; status: string };
    return censusTags(en.oldStatus, en.status).includes("census-other");
  }), "census-other");
  push(unionIds, "live1781");
  push(compare.l1changed, "old-l1changed1695");
  push(missing73, "pin73unknown");
  push(prep.s804, "hist804");
  push(prep.s59, "applied59");
  push(prep.s745, "remain745");
  push([...prep.records.values()].filter((r) => r.set === "stable2871").map((r) => r.doc), "stable2871");
  const unionTags = buildUnion(tagEntries);
  if (unionTags.size !== 3675) hold(`union doc 数外: ${unionTags.size}`);

  // raw dir の事前スナップショット (原状保全の証跡)。
  const rawBefore = readdirSync(RAW_DIR).sort();
  if (rawBefore.length !== 3677) hold(`raw dir 件数外: ${rawBefore.length}`);

  // 5. 3675 全件の再生成 + preimage 差の確定。
  const manifest: ManifestRecord[] = [];
  const journalLines: string[] = [];
  const newVerdicts: NewVerdict[] = [];
  let censusAgree = 0;
  let censusCompared = 0;
  for (const [doc, periodEnd] of okdocs) {
    const zipPath = join(RAW_DIR, `${doc}_t1.zip`);
    let zipBytes: Buffer;
    try {
      zipBytes = readFileSync(zipPath);
    } catch {
      hold(`raw ZIP 不在: ${doc}`);
    }
    if ((statSync(zipPath).mode & 0o777) !== 0o600) hold(`raw ZIP 0600 外: ${doc}`);
    const zipSHA = sha256Hex(zipBytes);
    const pinEntry = manifestFull.get(doc);
    // 旧 source pins mismatch は再 pin せず per-doc HOLD (run は継続)。
    const pinMismatch = pinEntry !== undefined &&
      (pinEntry.sha256 !== zipSHA || pinEntry.bytes !== zipBytes.length);
    const pin: "pinned" | "fixed-now" = pinEntry ? "pinned" : "fixed-now";
    const prec = prep.records.get(doc) as PrepRecord;
    const set = prec.set;
    const tags = unionTags.get(doc) as MembershipTag[];
    const cen = census.entries.get(doc);
    const censusClasses = cen ? censusTags(cen.oldStatus, cen.status) : [];
    const receiptVerdict = classifyReceipt(doc, receipts, { sha256: zipSHA, bytes: zipBytes.length });
    const receipt = receiptVerdict.state;
    const receiptMeta = receipts.get(doc)?.receipt ?? null;

    // 現 parser → validate → 保存 caller 同等変換。例外は HOLD 分類 (fallback なし)。
    let currentStatus: string | null = null;
    let honbunFile: string | null = null;
    let tablesScanned: number | null = null;
    let rows: SaveRow[] | null = null;
    let proof: OverseasProof | null = null;
    let facts: OverseasFact[] | null = null;
    let validateOK: boolean | null = null;
    let validateError: string | null = null;
    let parseError: string | null = null;
    try {
      const ex = parseOverseasData(zipBytes, periodEnd);
      currentStatus = ex.status;
      honbunFile = ex.honbunFile;
      tablesScanned = ex.tablesScanned;
      proof = ex.proof ?? null;
      facts = ex.facts;
      try {
        validateOverseasSaveSet(ex.facts, ex.proof);
        validateOK = true;
      } catch (e) {
        validateOK = false;
        validateError = (e as Error).message;
      }
      if (validateOK) rows = toSaveRows(ex.facts, ex.status);
    } catch (e) {
      parseError = (e as Error).message;
    }
    // census freeze との自己整合 (同一 parser・同一 bytes のはず)。
    if (cen && parseError === null) {
      censusCompared += 1;
      if (currentStatus === cen.status && (rows ? rows.length : 0) === cen.facts) {
        censusAgree += 1;
      }
    }

    // scope 既知: 全行の連結 scope が確定 (null 行ありは unknown scope)。
    const scopeKnown = rows !== null && rows.every((r) => r.isConsolidated !== null);
    const rec: ManifestRecord = {
      doc, tags, set, pin, pinMismatch, zipBytes: zipBytes.length, zipSHA256: zipSHA,
      periodEnd, censusClasses, prepVerdict: prec.verdict, savedStatus: prec.savedStatus,
      currentStatus, honbunFile, tablesScanned,
      factsCount: rows ? rows.length : null, proof, facts, scopeKnown, validateOK, validateError,
      baseline: set === "applied59" ? "sealed" : "before",
      preimageRef: "", liveObserved: union.has(doc),
      verdict: "match", compareVerdict: null, reasons: [], receipt,
      receiptShaMatch: receiptVerdict.shaMatch, receiptMeta,
    };
    newVerdicts.push({
      doc,
      parseOK: parseError === null,
      validateOK: validateOK === true,
      pinPresent: pin === "pinned",
      pinMismatch,
      scopeKnown,
      receipt,
    });

    if (parseError !== null) {
      rec.verdict = "HOLD_PARSE";
      rec.preimageRef = preimageRefOf(doc, set, journalSealed, union);
      journalLines.push(JSON.stringify({
        doc, tags, set, pin, pinMismatch, verdict: rec.verdict, baseline: rec.baseline,
        preimageRef: rec.preimageRef,
        before: journalBefore(doc, set, journalSealed, savedfacts, prec, live),
        after: null, parseError, receipt, reasons: [],
      }));
    } else if (!validateOK) {
      rec.verdict = "HOLD_VALIDATION";
      rec.preimageRef = preimageRefOf(doc, set, journalSealed, union);
      journalLines.push(JSON.stringify({
        doc, tags, set, pin, pinMismatch, verdict: rec.verdict, baseline: rec.baseline,
        preimageRef: rec.preimageRef,
        before: journalBefore(doc, set, journalSealed, savedfacts, prec, live),
        after: { status: currentStatus, honbunFile, tablesScanned, rows: null, proof, facts },
        validateError, receipt, reasons: [],
      }));
    } else {
      const after = rows as SaveRow[];
      let preimage: { status: string; honbun: string | null; rows: NormRow[] };
      let compareRaw: boolean;
      let compareHonbun: boolean;
      if (set === "applied59") {
        // sealed-post preimage: journal 記録があれば primary、なければ live 行を
        // L3match 59/59 (status/honbun/raw 含む全行一致) の根拠で proxy する。
        const sealed = journalSealed.get(doc);
        if (sealed) {
          rec.preimageRef = "sealed-post:prep-journal";
          preimage = { status: sealed.status, honbun: sealed.honbun, rows: sealed.rows };
        } else {
          const lv = live.docs.get(doc) as LiveDoc;
          rec.preimageRef = "sealed-via-live:L3match59of59";
          preimage = { status: lv.status, honbun: lv.honbun, rows: live.rows.get(doc) ?? [] };
        }
        compareRaw = true;
        compareHonbun = true;
      } else {
        rec.preimageRef = "before:savedfacts";
        preimage = { status: prec.savedStatus, honbun: null, rows: savedfacts.get(doc) as BeforeRow[] };
        compareRaw = false;
        compareHonbun = false;
      }
      const cmp: CompareOut = compareRows(preimage.rows, after, preimage.status, currentStatus as string,
        preimage.honbun, honbunFile, compareRaw, compareHonbun);
      rec.compareVerdict = cmp.equal ? "match" : "changed";
      rec.reasons = cmp.reasons;
      rec.verdict = receipt === "HOLD_RECEIPT" ? "HOLD_RECEIPT"
        : pin === "fixed-now" ? "HOLD_PIN_MISSING"
        : pinMismatch ? "HOLD_PIN_MISMATCH"
        : rec.compareVerdict;
      if (rec.verdict !== "match") {
        const liveObserved = union.has(doc) ? {
          kind: "live-observed-not-current",
          status: (live.docs.get(doc) as LiveDoc).status,
          rows: live.rows.get(doc) ?? [],
          rawQ1: live.rawQ1.get(doc) ?? null,
          rawQ2: live.rawQ2.get(doc) ?? [],
        } : null;
        journalLines.push(JSON.stringify({
          doc, tags, set, pin, pinMismatch, verdict: rec.verdict, compareVerdict: rec.compareVerdict,
          baseline: rec.baseline, preimageRef: rec.preimageRef,
          before: { status: preimage.status, honbunFile: preimage.honbun, rows: preimage.rows },
          after: { status: currentStatus, honbunFile, tablesScanned, rows: after, proof, facts },
          liveObserved, receipt,
          reasons: cmp.reasons, addedKeys: cmp.addedKeys, removedKeys: cmp.removedKeys,
          fieldDiffs: cmp.fieldDiffs,
        }));
      }
    }
    manifest.push(rec);
  }
  if (censusCompared !== 3602) hold(`census 照合対象外: ${censusCompared}`);
  if (censusAgree !== censusCompared) hold(`census 自己不一致: ${censusAgree}/${censusCompared}`);

  // 6. 集計 + 集合出力。候補数は計算結果そのまま (grant で偽装しない)。
  // liveReady / applyQualified は grant 状態として別明示する。
  const LIVE_READY = 0; // fresh custody/current CAS なし
  const APPLY_QUALIFIED = 0; // apply grant なし
  const offlineCandidates = computeOfflineCandidates(newVerdicts);
  const sep = separatedCounts(compare.l1changed.length, offlineCandidates, LIVE_READY, APPLY_QUALIFIED);
  const count = (pred: (r: ManifestRecord) => boolean): number => manifest.filter(pred).length;
  const ids = (pred: (r: ManifestRecord) => boolean): string[] =>
    manifest.filter(pred).map((r) => r.doc).sort();
  const counts = {
    total: manifest.length,
    applied59: count((r) => r.set === "applied59"),
    remain745: count((r) => r.set === "remain745"),
    stable2871: count((r) => r.set === "stable2871"),
    censusAdopted1411: count((r) => r.censusClasses.includes("census-adopted")),
    censusHeld1487: count((r) => r.censusClasses.includes("census-held")),
    censusReverse36: count((r) => r.censusClasses.includes("census-reverse")),
    censusAbsent73: count((r) => r.censusClasses.length === 0),
    live1781: count((r) => r.liveObserved),
    oldL1Changed1695: sep.oldL1Changed1695,
    pinMissing73: count((r) => r.pin === "fixed-now"),
    pinMismatch: count((r) => r.pinMismatch),
    match: count((r) => r.verdict === "match"),
    changed: count((r) => r.verdict === "changed"),
    holdParse: count((r) => r.verdict === "HOLD_PARSE"),
    holdValidation: count((r) => r.verdict === "HOLD_VALIDATION"),
    holdPinMissing: count((r) => r.verdict === "HOLD_PIN_MISSING"),
    holdPinMismatch: count((r) => r.verdict === "HOLD_PIN_MISMATCH"),
    holdReceipt: count((r) => r.verdict === "HOLD_RECEIPT"),
    receiptPending: count((r) => r.receipt === "ARCHIVE_PENDING"),
    receiptReceived: count((r) => r.receipt === "RECEIVED"),
    receiptShaMatch: count((r) => r.receiptShaMatch),
    offlineCandidates: sep.offlineCandidates,
    liveReady: sep.liveReady,
    applyQualified: sep.applyQualified,
    censusAgree3675: censusAgree,
  };
  if (counts.total !== 3675) hold(`manifest 件数外: ${counts.total}`);
  if (counts.censusAbsent73 !== 73) hold("census 欠落外");
  if (counts.live1781 !== 1781) hold("live 件数外");
  if (counts.pinMissing73 !== 73) hold("pin不足外");
  const sets = {
    byTag: Object.fromEntries(
      (["census-adopted", "census-held", "census-reverse", "census-other", "live1781",
        "old-l1changed1695", "pin73unknown", "hist804", "applied59", "remain745",
        "stable2871"] as MembershipTag[]).map((t) => [t, ids((r) => r.tags.includes(t))])
    ),
    changed: ids((r) => r.verdict === "changed"),
    match: ids((r) => r.verdict === "match"),
    holdParse: ids((r) => r.verdict === "HOLD_PARSE"),
    holdValidation: ids((r) => r.verdict === "HOLD_VALIDATION"),
    holdPinMissing: ids((r) => r.verdict === "HOLD_PIN_MISSING"),
    holdPinMismatch: ids((r) => r.verdict === "HOLD_PIN_MISMATCH"),
    holdReceipt: ids((r) => r.verdict === "HOLD_RECEIPT"),
    offlineCandidates,
  };

  // 7. 成果物の書込 (OUT_DIR のみ・0600)。
  const manifestSHA = writePrivate(join(OUT_DIR, "repair-manifest.json"), JSON.stringify(manifest));
  const journalSHA = writePrivate(join(OUT_DIR, "repair-journal.jsonl"), journalLines.join("\n") + (journalLines.length > 0 ? "\n" : ""));
  const setsSHA = writePrivate(join(OUT_DIR, "repair-sets.json"), JSON.stringify(sets));

  // 8. 終端 zeros + 原状保全の再確認。
  if (fetchAttempts !== 0) hold(`fetch 到達あり: ${fetchAttempts}`);
  if (sha256Hex(readFileSync(join(RAW_DIR, "manifest_full.json"))) !== PINS["manifestFull"]) {
    hold("raw manifest_full 変質");
  }
  const rawAfter = readdirSync(RAW_DIR).sort();
  if (JSON.stringify(rawAfter) !== JSON.stringify(rawBefore)) hold("raw dir 変質");

  const report = {
    at_start: STARTED_AT,
    at_end: new Date().toISOString(),
    result: "PASS",
    mode: "offline-repair-prep",
    workHEAD: workHead,
    parser: { path: PARSER_PATH, blobSHA: PARSER_BLOB },
    inputs: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v])),
    setSHAs: SET_SHAS,
    counts,
    separated: sep,
    diagnostic: {
      censusFreezeAgree3602: censusAgree,
      preimageRefKinds: [...new Set(manifest.map((r) => r.preimageRef))].sort(),
    },
    zeros: { fetchAttempts, sourceGET: 0, notionCreateUpdateArchive: 0, d1r2mutation: 0, workflow: 0, newReceipts: 0, sends: 0 },
    limits: [
      "1411/1487/36 (3602 census) と旧 live 1695 (旧 parser prep 由来 L1changed) は母集合が別。1695 を新候補数と呼ばない。候補数は dedup union join からのみ。",
      "候補の意味は OFFLINE_CANDIDATE。live READY は fresh custody/current CAS なし → 0 (別明示)。apply 許可は grant なし → 0 (別明示)。",
      "live snapshot は旧観測で live-current を保証しない。59 の sealed 代理は L3match 59/59 が根拠。観測行全体 (q1/q2 の id 含む) を保持するが DB 全体像の preimage は名乗らない (旧 Q1 は 7 列 projection のみ。未選択 protected は将来 fresh SELECT が要る)。",
      "73 pin不足は過去 custody UNKNOWN として apply HOLD。将来 official fresh GET/current identity/full-bytes/custody/current CAS で現修正資格化する道を残し、過去を偽補完しない。",
      "旧 source pins mismatch は再 pin せず per-doc HOLD。raw bytes/SHA の観測値は記録のみ。",
      "proof は rounding/reconciliation 区間。unit/locator の断定は既 output の範囲に限る (量子幅を unit 倍率/locator 証拠と偽らない。新 instrumentation なし)。",
      "receipt 証跡なし → 全 ARCHIVE_PENDING。不正/unknown 証跡は HOLD。same/written+pageId は manifest 照合の記録であり hosted 証明ではない (metadata 保持)。RECEIVED は将来の explicitly verified physical closure まで到達なし。",
      "旧 journal/grants は照合読取のみ。CANCELLED grants は再利用しない。",
      "本番/source GET は未実行 (fetch 0)。orders/text 修正 0。",
    ],
    artifacts: {
      manifest: { path: join(OUT_DIR, "repair-manifest.json"), sha256: manifestSHA },
      journal: { path: join(OUT_DIR, "repair-journal.jsonl"), sha256: journalSHA, lines: journalLines.length },
      sets: { path: join(OUT_DIR, "repair-sets.json"), sha256: setsSHA },
    },
  };
  const reportSHA = writePrivate(join(OUT_DIR, "repair-report.json"), JSON.stringify(report, null, 2));

  // stdout は counts/SHA/limits のみ (public 可)。
  console.info(JSON.stringify({
    result: "PASS",
    counts,
    separated: sep,
    setSHAs: SET_SHAS,
    zeros: report.zeros,
    limits: report.limits,
    artifacts: { ...report.artifacts, report: { path: join(OUT_DIR, "repair-report.json"), sha256: reportSHA } },
    at_end: report.at_end,
  }));
}

function preimageRefOf(
  doc: string,
  set: string,
  journalSealed: Map<string, SealedBefore>,
  union: Set<string>
): string {
  if (set !== "applied59") return "before:savedfacts";
  if (journalSealed.has(doc)) return "sealed-post:prep-journal";
  if (union.has(doc)) return "sealed-via-live:L3match59of59";
  return "sealed:unavailable-HOLD";
}

/** journal 用の before 側テーブル。 */
function journalBefore(
  doc: string,
  set: string,
  journalSealed: Map<string, SealedBefore>,
  savedfacts: Map<string, BeforeRow[]>,
  prec: PrepRecord,
  live: { docs: Map<string, LiveDoc>; rows: Map<string, LiveRow[]> }
): unknown {
  if (set === "applied59") {
    const sealed = journalSealed.get(doc);
    if (sealed) return { kind: "sealed-post", ...sealed };
    const lv = live.docs.get(doc);
    if (lv) {
      return {
        kind: "sealed-via-live",
        status: lv.status,
        honbun: lv.honbun,
        rows: live.rows.get(doc) ?? [],
        basis: "L3match59of59",
      };
    }
    return { kind: "sealed-unavailable" };
  }
  return {
    kind: "before",
    status: prec.savedStatus,
    honbunFile: null,
    rows: savedfacts.get(doc) as BeforeRow[],
  };
}

try {
  await main();
  process.exit(0);
} catch (e) {
  const reason = e instanceof Error ? e.message : String(e);
  const holdReport = {
    at_start: STARTED_AT,
    at_end: new Date().toISOString(),
    result: "HOLD",
    reason,
    zeros: { fetchAttempts },
  };
  try {
    writePrivate(join(OUT_DIR, "repair-report-hold.json"), JSON.stringify(holdReport, null, 2));
  } catch { /* report 書込自体の失敗は握らず抜ける */ }
  console.error(JSON.stringify(holdReport));
  process.exit(1);
}
