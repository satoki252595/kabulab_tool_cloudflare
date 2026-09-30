/**
 * 海外残745 純OFFLINE PREP (laneA)。
 *
 * 固定 3675 ZIP の既存 raw のみを現在 parser (blob 07efdd0a 固定) で全件再生成し、
 * 現 parser → validateOverseasSaveSet → 保存 caller 同等変換の値を、旧 before
 * (savedfacts/fullscan) および sealed plans 適用後期待値 (59件) と比較して
 * current changed set を新導出する。745 全件 update とは仮定しない。
 *
 * オフライン保証:
 * - 冒頭で fetch を全面拒否 (source/Notion/D1/R2/dispatch への到達は 0 を断言)。
 * - 新 ZIP 取得・本番書込・Notion 新 receipt なし。旧 laneA grants は CANCELLED
 *   のため再利用しない (journal は outcome/planSHA の照合読取のみ)。
 * - 例外は empty facts へ fallback せず status/validation HOLD へ分類する。
 * - 旧 journal の blind apply なし。raw ファイルは原状保全 (書込なし)。
 *
 * 固定入力 (bytes SHA256 pins・不一致は HOLD):
 * - /tmp/overseas_laneA_raw/manifest_full.json (3602 pins) + <docID>_t1.zip (3675)
 * - /tmp/overseas_laneA_okdocs.json / _fullscan.jsonl / _fixup5.jsonl / _savedfacts.json
 * - /tmp/laneA_cas_{batches,r4xr,completions,completions_r4xr,journal,journal_r4xr,post,post_r4xr}.*
 *
 * 集合の定義 (GPT-sol actual proof):
 * - 歴史 804 = fixup5.eqSavedNew===false (fullscan eqSaved=false 109・
 *   fixup14 flip 667 とは混ぜない)。
 * - 適用 59 = base58 plans + R4XR 1 plan (disjoint・completions/journals/
 *   post mismatch 0)。59 の比較基準は sealed plans 適用後期待値。
 *   古 savedfacts が現在 D1 値とは主張しない (現 prod 59 全 rows 未観測)。
 * - 残 745 = 804−59。再結合で 804。
 *
 * 出力 (OUT_DIR のみ・0600。stdout は counts/SHA/limits のみ):
 * - prep-manifest.json (3675件の per-doc 記録)
 * - prep-journal.jsonl (changed + HOLD の before/after 全表 + reason)
 * - prep-sets.json (分類別 docID 集合)
 * - prep-report.json (集計・pins・zeros・limits)
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/overseas-745-prep.ts
 *   [--lane-dir /tmp] [--raw-dir /tmp/overseas_laneA_raw] [--out-dir /tmp/overseas745-prep-20260930]
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

// guard 設置後に repo runtime を dynamic import する (PIP-384 と同一順序)。
const parserMod = await import("../src/services/overseas-parser.js");
const { parseOverseasData, validateOverseasSaveSet } = parserMod;

// ---------------------------------------------------------------------------
// 固定 pins
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PARSER_PATH = "services/yuho-quant/src/services/overseas-parser.ts";
const PARSER_BLOB = "07efdd0a25a79328873cf34faf6a1cb5a2095bbe";

const PINS: Record<string, string> = {
  manifestFull: "398843d5c7bcb4ade93b8e9e273fa9e809c17c1e77dadd9d3e42582b2dc02ca4",
  okdocs: "034cefad5a7986f874fdc453c0e6a28f23d1ffe565be1ada5a65020718298735",
  fullscan: "b5cb5c1cd10bf371414136e45131d285292711e3829b14b2b6f12c03a3071c1f",
  fixup5: "89dafe31fac097931f4f5d227b7ef28345cfc49391e733f71a435daa8806d28d",
  savedfacts: "58122d8d51046d312c93fdc18b5851eb14c6aabcad551881ab8713a49b2bbb31",
  batches: "991e8db9bd50b26c6c9fca41222362dc2d2e170edd1a962f6bdaed443be45a4a",
  r4xr: "9f47e75c4e101ddb0f1c89bdf5657f1e20d9e60da66a75d7e9472fe84070d817",
  completions: "a8d8ae0f27695f5032bf9a44f263ba68ea29451aacc113764fb94893c1704eb7",
  completionsR4xr: "6fca896cf66c150934fc38f78cef66408dce84f56883dba9c750dc8c4de702e5",
  journal: "03254803eda4228beb7f90694d5f4a8b5a0258f5107ba8dd7513ad362fb73dcd",
  journalR4xr: "b8c4c8e25507f047c024f53481c91726d87ede66657f716a5ea99a9410824874",
  post: "ba7d0ea12197baa8b50a6ffbe7af2530c503fbece864414b3d2b55fdd7f9041b",
  postR4xr: "35a9d3a0be9c5040fbce0aa71261e84f63627dc802be2ffd209d9bc58129260b",
};
const SET_SHAS = {
  s804: "64daec93d7380ae9b91c7329eb61344d17a0f885aea614cecb707c922a4e983e",
  s59: "7ccf9a6f985622c1291e36ed25a1561621c3d91e472c02036b38b1d7d2c2f70c",
  s745: "8c09ab3447e14d231a5e39addb6d8ce2fd037d22754cd38eb3b0c778285c2d81",
};

// INSERT 11 列の固定順 (sealed plan からの期待値復元に使う。相違は HOLD)。
const INSERT_COLS = [
  "document_id", "stock_id", "fiscal_year_end", "region_name", "region_kind",
  "is_consolidated", "unit_label", "sales_raw", "sales_yen", "ratio_pct", "pattern",
];

// ---------------------------------------------------------------------------
// helpers
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

// 保存行変換は共有正準 (overseas-save-rows.ts) を使用する。
import { toOverseasSaveRows as toSaveRows, type OverseasSaveRow as SaveRow } from "../src/services/overseas-save-rows.js";

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
function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) hold(`形状外: ${label}`);
  return v as Record<string, unknown>;
}

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

interface ScanRow {
  doc: string;
  period: string;
  savedStatus: string;
  eqSaved: boolean;
}

function loadFullscan(bytes: Buffer, okdocs: Map<string, string>): {
  rows: Map<string, ScanRow>;
  eqSavedFalse: string[];
} {
  const arr = parseJSONL(bytes, "fullscan");
  if (arr.length !== 3675) hold(`fullscan 件数外: ${arr.length}`);
  const rows = new Map<string, ScanRow>();
  const eqSavedFalse: string[] = [];
  for (const e of arr) {
    const r = asRecord(e, "fullscan 要素");
    const doc = r["doc"];
    const period = r["period"];
    const savedStatus = r["savedStatus"];
    const eqSaved = r["eqSaved"];
    if (typeof doc !== "string" || typeof period !== "string" || typeof savedStatus !== "string") {
      hold("fullscan 要素形状外");
    }
    if (typeof eqSaved !== "boolean") hold(`fullscan eqSaved 非boolean: ${doc}`);
    if (!okdocs.has(doc)) hold(`fullscan が okdocs 外: ${doc}`);
    if (okdocs.get(doc) !== period) hold(`fullscan period 不一致: ${doc}`);
    if (rows.has(doc)) hold(`fullscan doc 重複: ${doc}`);
    rows.set(doc, { doc, period, savedStatus, eqSaved });
    if (eqSaved === false) eqSavedFalse.push(doc);
  }
  // 109 件は 804 へ混ぜない (除外の証明として件数のみ記録する)。
  if (eqSavedFalse.length !== 109) hold(`fullscan eqSaved=false 件数外: ${eqSavedFalse.length}`);
  return { rows, eqSavedFalse };
}

interface FixupRow {
  doc: string;
  period: string;
  newStatus: string;
  eqSavedNew: boolean;
}

function loadFixup5(bytes: Buffer, okdocs: Map<string, string>): {
  rows: Map<string, FixupRow>;
  s804: string[];
} {
  const arr = parseJSONL(bytes, "fixup5");
  if (arr.length !== 3675) hold(`fixup5 件数外: ${arr.length}`);
  const rows = new Map<string, FixupRow>();
  const s804: string[] = [];
  for (const e of arr) {
    const r = asRecord(e, "fixup5 要素");
    const doc = r["doc"];
    const period = r["period"];
    const newStatus = r["newStatus"];
    const eqSavedNew = r["eqSavedNew"];
    if (typeof doc !== "string" || typeof period !== "string" || typeof newStatus !== "string") {
      hold("fixup5 要素形状外");
    }
    if (typeof eqSavedNew !== "boolean") hold(`fixup5 eqSavedNew 非boolean: ${doc}`);
    if (!okdocs.has(doc)) hold(`fixup5 が okdocs 外: ${doc}`);
    if (okdocs.get(doc) !== period) hold(`fixup5 period 不一致: ${doc}`);
    if (rows.has(doc)) hold(`fixup5 doc 重複: ${doc}`);
    rows.set(doc, { doc, period, newStatus, eqSavedNew });
    if (eqSavedNew === false) s804.push(doc);
  }
  if (s804.length !== 804) hold(`804 件数外: ${s804.length}`);
  return { rows, s804 };
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

// ---------------------------------------------------------------------------
// sealed plans 適用後期待値の復元 (UPDATE + postflight JSON + INSERT 照合)
// ---------------------------------------------------------------------------
interface SealedExpectation {
  docID: string;
  documentId: number;
  stockId: number;
  disposition: string;
  status: string;
  honbun: string | null;
  rows: SaveRow[];
}

interface PlanStatement {
  sql: string;
  params: unknown[];
}

function extractSealed(planDoc: Record<string, unknown>, label: string): SealedExpectation {
  const docID = planDoc["docID"];
  const documentId = planDoc["documentId"];
  const stockId = planDoc["stockId"];
  const disposition = planDoc["disposition"];
  const newRows = planDoc["newRows"];
  const statements = planDoc["statements"];
  if (typeof docID !== "string" || typeof documentId !== "number" || typeof stockId !== "number") {
    hold(`${label} plan doc 形状外`);
  }
  if (typeof disposition !== "string" || typeof newRows !== "number" || !Array.isArray(statements)) {
    hold(`${label} plan doc 形状外: ${docID}`);
  }
  const stmts = statements as PlanStatement[];
  const upd = stmts.find((s) => s.sql.startsWith("UPDATE yuho_documents SET overseas_parse_status"));
  if (!upd || upd.params.length !== 3) hold(`${label} UPDATE 欠落: ${docID}`);
  const [status, honbun, id] = upd.params as [unknown, unknown, unknown];
  if (typeof status !== "string" || !(typeof honbun === "string" || honbun === null) || id !== documentId) {
    hold(`${label} UPDATE params 外: ${docID}`);
  }
  const post = stmts.find((s) => s.sql.includes("postflight"));
  if (!post || post.params.length < 1) hold(`${label} postflight 欠落: ${docID}`);
  let postFacts: unknown;
  try {
    postFacts = (JSON.parse(String(post.params[0])) as { facts: unknown }).facts;
  } catch {
    hold(`${label} postflight JSON 破損: ${docID}`);
  }
  if (!Array.isArray(postFacts)) hold(`${label} postflight facts 非配列: ${docID}`);
  const rows: SaveRow[] = (postFacts as unknown[]).map((e) => {
    const r = asRecord(e, `${label} postflight fact`);
    if (r["documentId"] !== documentId || r["stockId"] !== stockId) {
      hold(`${label} postflight ID 不一致: ${docID}`);
    }
    if (typeof r["fiscalYearEnd"] !== "string" || typeof r["regionName"] !== "string") {
      hold(`${label} postflight 行形状外: ${docID}`);
    }
    if (typeof r["regionKind"] !== "string" || typeof r["unitLabel"] !== "string") {
      hold(`${label} postflight 行形状外: ${docID}`);
    }
    if (!(r["salesRaw"] === null || typeof r["salesRaw"] === "number")) hold(`${label} salesRaw 形状外: ${docID}`);
    if (!(r["salesYen"] === null || typeof r["salesYen"] === "number")) hold(`${label} salesYen 形状外: ${docID}`);
    if (!(r["ratioPct"] === null || typeof r["ratioPct"] === "number")) hold(`${label} ratio 形状外: ${docID}`);
    if (typeof r["pattern"] !== "string") hold(`${label} pattern 形状外: ${docID}`);
    return {
      fiscalYearEnd: r["fiscalYearEnd"] as string,
      regionName: r["regionName"] as string,
      regionKind: r["regionKind"] as string,
      isConsolidated: normConsolidated(r["isConsolidated"]),
      unitLabel: r["unitLabel"] as string,
      salesRaw: r["salesRaw"] as number | null,
      salesYen: r["salesYen"] as number | null,
      ratioPct: r["ratioPct"] as number | null,
      pattern: r["pattern"] as string,
    };
  });
  if (rows.length !== newRows) hold(`${label} postflight 件数外: ${docID} (${rows.length}!=${newRows})`);
  const ins = stmts.find((s) => s.sql.startsWith("INSERT INTO yuho_overseas_facts"));
  if (newRows === 0) {
    if (ins) hold(`${label} newRows=0 だが INSERT あり: ${docID}`);
  } else {
    if (!ins) hold(`${label} INSERT 欠落: ${docID}`);
    const cols = ins.sql.slice(ins.sql.indexOf("(") + 1, ins.sql.indexOf(")")).split(",").map((c) => c.trim());
    if (JSON.stringify(cols) !== JSON.stringify(INSERT_COLS)) hold(`${label} INSERT 列順外: ${docID}`);
    if (ins.params.length !== newRows * INSERT_COLS.length) hold(`${label} INSERT binds 外: ${docID}`);
    // INSERT 行と postflight 行の多重集合一致 (sealed 内部の自己整合)。
    const insRows: SaveRow[] = [];
    for (let i = 0; i < newRows; i++) {
      const p = ins.params.slice(i * INSERT_COLS.length, (i + 1) * INSERT_COLS.length);
      insRows.push({
        fiscalYearEnd: p[2] as string, regionName: p[3] as string, regionKind: p[4] as string,
        isConsolidated: normConsolidated(p[5]), unitLabel: p[6] as string,
        salesRaw: p[7] as number | null, salesYen: p[8] as number | null,
        ratioPct: p[9] as number | null, pattern: p[10] as string,
      });
    }
    const canon = (rs: SaveRow[]): string[] =>
      rs.map((r) => JSON.stringify([r.fiscalYearEnd, r.regionName, r.regionKind,
        r.isConsolidated, r.unitLabel, r.salesRaw, r.salesYen, r.ratioPct, r.pattern])).sort();
    if (JSON.stringify(canon(insRows)) !== JSON.stringify(canon(rows))) {
      hold(`${label} INSERT/postflight 不一致: ${docID}`);
    }
  }
  return { docID, documentId, stockId, disposition, status, honbun, rows };
}

// ---------------------------------------------------------------------------
// CAS 適用証跡の照合 (journal は読取のみ。blind apply なし)
// ---------------------------------------------------------------------------
interface CasVerified {
  docIDs: string[];
  sealed: Map<string, SealedExpectation>;
}

function verifyCasPhase(
  planBytes: Buffer,
  completionsBytes: Buffer,
  journalBytes: Buffer,
  postBytes: Buffer,
  planPinKey: string,
  expectDocs: number,
  label: string
): CasVerified {
  const plan = asRecord(parseJSON(planBytes, `${label} plan`), `${label} plan`);
  const docs = plan["docs"];
  if (!Array.isArray(docs) || docs.length !== expectDocs) hold(`${label} plan 件数外`);
  const sealed = new Map<string, SealedExpectation>();
  for (const d of docs) {
    const s = extractSealed(asRecord(d, `${label} plan 要素`), label);
    if (sealed.has(s.docID)) hold(`${label} plan doc 重複: ${s.docID}`);
    sealed.set(s.docID, s);
  }
  const comp = asRecord(parseJSON(completionsBytes, `${label} completions`), `${label} completions`);
  if (comp["planSHA"] !== PINS[planPinKey]) hold(`${label} completions planSHA 外`);
  const compDocs = asRecord(comp["docs"], `${label} completions docs`);
  const compIDs = Object.keys(compDocs);
  if (compIDs.length !== expectDocs) hold(`${label} completions 件数外`);
  for (const id of compIDs) {
    if (!sealed.has(id)) hold(`${label} completions が plan 外: ${id}`);
    const c = asRecord(compDocs[id], `${label} completion`);
    if (typeof c["at"] !== "string" || typeof c["statements"] !== "number") {
      hold(`${label} completion 形状外: ${id}`);
    }
  }
  const journal = parseJSONL(journalBytes, `${label} journal`);
  if (journal.length !== expectDocs * 2) hold(`${label} journal 件数外: ${journal.length}`);
  const outcomes = new Map<string, Set<string>>();
  for (const e of journal) {
    const r = asRecord(e, `${label} journal 要素`);
    const docID = r["docID"];
    if (typeof docID !== "string" || !sealed.has(docID)) hold(`${label} journal doc 範囲外`);
    if (r["planSHA"] !== PINS[planPinKey]) hold(`${label} journal planSHA 外: ${docID}`);
    if (r["lease"] !== comp["lease"]) hold(`${label} journal lease 外: ${docID}`);
    const oc = r["outcome"];
    if (typeof oc !== "string" || typeof r["at"] !== "string") hold(`${label} journal 形状外: ${docID}`);
    const set = outcomes.get(docID) ?? new Set<string>();
    set.add(oc);
    outcomes.set(docID, set);
  }
  for (const [id, set] of outcomes) {
    if (set.size !== 2 || !set.has("issued") || !set.has("sent")) {
      hold(`${label} journal outcome 外: ${id} (${[...set].join(",")})`);
    }
  }
  const post = asRecord(parseJSON(postBytes, `${label} post`), `${label} post`);
  if (post["planSHA"] !== PINS[planPinKey]) hold(`${label} post planSHA 外`);
  if (post["docs"] !== expectDocs) hold(`${label} post docs 外`);
  if (!Array.isArray(post["mismatched"]) || post["mismatched"].length !== 0) {
    hold(`${label} post mismatched あり`);
  }
  if (post["ok"] !== true || post["sends"] !== 0) hold(`${label} post ok/sends 外`);
  return { docIDs: [...sealed.keys()], sealed };
}

// ---------------------------------------------------------------------------
// before/expected と current の比較 (reason 分類)
// ---------------------------------------------------------------------------
type NormRow = BeforeRow | SaveRow;

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
  // FY: 同一 regionName で会計期末が変わった行の検出 (key 差の内訳)。
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
const OUT_DIR = argValue("out-dir", "/tmp/overseas745-prep-20260930");
const STARTED_AT = new Date().toISOString();

type Verdict = "match" | "changed" | "HOLD_PIN_MISSING" | "HOLD_PARSE" | "HOLD_VALIDATION";

interface ManifestRecord {
  doc: string;
  set: "applied59" | "remain745" | "stable2871";
  pin: "pinned" | "fixed-now";
  zipBytes: number;
  zipSHA256: string;
  periodEnd: string;
  fixupNewStatus: string;
  savedStatus: string;
  currentStatus: string | null;
  honbunFile: string | null;
  tablesScanned: number | null;
  factsCount: number | null;
  validateOK: boolean | null;
  validateError: string | null;
  baseline: "sealed" | "before";
  verdict: Verdict;
  compareVerdict: "match" | "changed" | null;
  reasons: string[];
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
  const fullscanBytes = readPinned(join(LANE_DIR, "overseas_laneA_fullscan.jsonl"), "fullscan");
  const fixup5Bytes = readPinned(join(LANE_DIR, "overseas_laneA_fixup5.jsonl"), "fixup5");
  const savedfactsBytes = readPinned(join(LANE_DIR, "overseas_laneA_savedfacts.json"), "savedfacts");
  const batchesBytes = readPinned(join(LANE_DIR, "laneA_cas_batches.json"), "batches");
  const r4xrBytes = readPinned(join(LANE_DIR, "laneA_cas_r4xr.json"), "r4xr");
  const completionsBytes = readPinned(join(LANE_DIR, "laneA_cas_completions.json"), "completions");
  const completionsR4xrBytes = readPinned(join(LANE_DIR, "laneA_cas_completions_r4xr.json"), "completionsR4xr");
  const journalBytes = readPinned(join(LANE_DIR, "laneA_cas_journal.jsonl"), "journal");
  const journalR4xrBytes = readPinned(join(LANE_DIR, "laneA_cas_journal_r4xr.jsonl"), "journalR4xr");
  const postBytes = readPinned(join(LANE_DIR, "laneA_cas_post.json"), "post");
  const postR4xrBytes = readPinned(join(LANE_DIR, "laneA_cas_post_r4xr.json"), "postR4xr");

  // 3. 構造検証 + 集合の導出。
  const okdocs = loadOkDocs(okdocsBytes);
  const { rows: fullscan } = loadFullscan(fullscanBytes, okdocs);
  const { rows: fixup5, s804 } = loadFixup5(fixup5Bytes, okdocs);
  const savedfacts = loadSavedFacts(savedfactsBytes, okdocs);
  const manifestFull = loadManifestFull(manifestFullBytes);
  const base58 = verifyCasPhase(batchesBytes, completionsBytes, journalBytes, postBytes, "batches", 58, "base58");
  const r4xr1 = verifyCasPhase(r4xrBytes, completionsR4xrBytes, journalR4xrBytes, postR4xrBytes, "r4xr", 1, "r4xr");
  const sealedAll = new Map([...base58.sealed, ...r4xr1.sealed]);
  const s59 = [...sealedAll.keys()];
  if (s59.length !== 59) hold(`59 重複あり: ${s59.length}`);
  const set804 = new Set(s804);
  const set59 = new Set(s59);
  for (const id of set59) {
    if (!set804.has(id)) hold(`59 が 804 外: ${id}`);
  }
  const s745 = [...set804].filter((id) => !set59.has(id));
  if (s745.length !== 745) hold(`745 件数外: ${s745.length}`);
  if (setSHA(s804) !== SET_SHAS.s804) hold("804 setSHA 外");
  if (setSHA(s59) !== SET_SHAS.s59) hold("59 setSHA 外");
  if (setSHA(s745) !== SET_SHAS.s745) hold("745 setSHA 外");
  const set745 = new Set(s745);
  if (new Set([...set59, ...set745]).size !== 804) hold("59+745 再結合外");
  const missing73 = [...okdocs.keys()].filter((id) => !manifestFull.has(id)).sort();
  if (missing73.length !== 73) hold(`pin不足 件数外: ${missing73.length}`);

  // raw dir の事前スナップショット (原状保全の証跡)。
  const rawBefore = readdirSync(RAW_DIR).sort();
  if (rawBefore.length !== 3677) hold(`raw dir 件数外: ${rawBefore.length}`);

  // 4. 3675 全件の再生成 + 比較。
  const manifest: ManifestRecord[] = [];
  const journalLines: string[] = [];
  let fixupAgree = 0;
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
    if (pinEntry) {
      if (pinEntry.sha256 !== zipSHA || pinEntry.bytes !== zipBytes.length) {
        hold(`raw bytes/SHA 外: ${doc}`);
      }
    }
    const pin: "pinned" | "fixed-now" = pinEntry ? "pinned" : "fixed-now";
    const set = set59.has(doc) ? "applied59" : set745.has(doc) ? "remain745" : "stable2871";
    const fixupNewStatus = fixup5.get(doc)!.newStatus;
    const savedStatus = fullscan.get(doc)!.savedStatus;

    // 現 parser → validate → 保存 caller 同等変換。例外は HOLD 分類 (fallback なし)。
    let currentStatus: string | null = null;
    let honbunFile: string | null = null;
    let tablesScanned: number | null = null;
    let rows: SaveRow[] | null = null;
    let validateOK: boolean | null = null;
    let validateError: string | null = null;
    let parseError: string | null = null;
    try {
      const ex = parseOverseasData(zipBytes, periodEnd);
      currentStatus = ex.status;
      honbunFile = ex.honbunFile;
      tablesScanned = ex.tablesScanned;
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
    if (currentStatus === fixupNewStatus) fixupAgree += 1;

    const rec: ManifestRecord = {
      doc, set, pin, zipBytes: zipBytes.length, zipSHA256: zipSHA, periodEnd,
      fixupNewStatus, savedStatus, currentStatus, honbunFile, tablesScanned,
      factsCount: rows ? rows.length : null, validateOK, validateError,
      baseline: set === "applied59" ? "sealed" : "before",
      verdict: "match", compareVerdict: null, reasons: [],
    };

    if (parseError !== null) {
      rec.verdict = "HOLD_PARSE";
      journalLines.push(JSON.stringify({
        doc, set, pin, verdict: rec.verdict, baseline: rec.baseline,
        before: journalBefore(doc, set, sealedAll, savedfacts, fullscan),
        after: null, parseError, reasons: [],
      }));
    } else if (!validateOK) {
      rec.verdict = "HOLD_VALIDATION";
      journalLines.push(JSON.stringify({
        doc, set, pin, verdict: rec.verdict, baseline: rec.baseline,
        before: journalBefore(doc, set, sealedAll, savedfacts, fullscan),
        after: { status: currentStatus, honbunFile, tablesScanned, rows: null },
        validateError, reasons: [],
      }));
    } else {
      const after = rows as SaveRow[];
      let cmp: CompareOut;
      if (set === "applied59") {
        const exp = sealedAll.get(doc) as SealedExpectation;
        cmp = compareRows(exp.rows, after, exp.status, currentStatus as string,
          exp.honbun, honbunFile, true, true);
      } else {
        const before = savedfacts.get(doc) as BeforeRow[];
        cmp = compareRows(before, after, savedStatus, currentStatus as string,
          null, honbunFile, false, false);
      }
      rec.compareVerdict = cmp.equal ? "match" : "changed";
      rec.reasons = cmp.reasons;
      rec.verdict = pin === "fixed-now" ? "HOLD_PIN_MISSING" : rec.compareVerdict;
      if (rec.verdict !== "match") {
        const before = set === "applied59"
          ? { kind: "sealed-post", ...(sealedAll.get(doc) as SealedExpectation) }
          : { kind: "before", status: savedStatus, honbunFile: null, rows: savedfacts.get(doc) };
        journalLines.push(JSON.stringify({
          doc, set, pin, verdict: rec.verdict, compareVerdict: rec.compareVerdict,
          baseline: rec.baseline,
          before, after: { status: currentStatus, honbunFile, tablesScanned, rows: after },
          reasons: cmp.reasons, addedKeys: cmp.addedKeys, removedKeys: cmp.removedKeys,
          fieldDiffs: cmp.fieldDiffs,
        }));
      }
    }
    manifest.push(rec);
  }

  // 5. 集計 + 集合出力。
  const count = (pred: (r: ManifestRecord) => boolean): number => manifest.filter(pred).length;
  const ids = (pred: (r: ManifestRecord) => boolean): string[] =>
    manifest.filter(pred).map((r) => r.doc).sort();
  const counts = {
    total: manifest.length,
    applied59: count((r) => r.set === "applied59"),
    remain745: count((r) => r.set === "remain745"),
    stable2871: count((r) => r.set === "stable2871"),
    pinMissing73: count((r) => r.pin === "fixed-now"),
    pinMissingIn745: count((r) => r.pin === "fixed-now" && r.set === "remain745"),
    match: count((r) => r.verdict === "match"),
    changed: count((r) => r.verdict === "changed"),
    changedIn745: count((r) => r.verdict === "changed" && r.set === "remain745"),
    changedIn59: count((r) => r.verdict === "changed" && r.set === "applied59"),
    changedOutside804: count((r) => r.verdict === "changed" && r.set === "stable2871"),
    matchIn745: count((r) => r.verdict === "match" && r.set === "remain745"),
    holdParse: count((r) => r.verdict === "HOLD_PARSE"),
    holdValidation: count((r) => r.verdict === "HOLD_VALIDATION"),
    holdPinMissing: count((r) => r.verdict === "HOLD_PIN_MISSING"),
    holdIn745: count((r) => r.verdict.startsWith("HOLD") && r.set === "remain745"),
    fixupNewStatusAgree: fixupAgree,
  };
  if (counts.total !== 3675) hold(`manifest 件数外: ${counts.total}`);
  if (counts.applied59 !== 59 || counts.remain745 !== 745 || counts.stable2871 !== 2871) {
    hold("集合件数外");
  }
  if (counts.pinMissing73 !== 73 || counts.pinMissingIn745 !== 21) hold("pin不足内訳外");
  if (counts.match + counts.changed + counts.holdParse + counts.holdValidation + counts.holdPinMissing !== 3675) {
    hold("verdict 合計外");
  }
  const sets = {
    changed745: ids((r) => r.verdict === "changed" && r.set === "remain745"),
    match745: ids((r) => r.verdict === "match" && r.set === "remain745"),
    hold745: ids((r) => r.verdict.startsWith("HOLD") && r.set === "remain745"),
    changed59: ids((r) => r.verdict === "changed" && r.set === "applied59"),
    match59: ids((r) => r.verdict === "match" && r.set === "applied59"),
    hold59: ids((r) => r.verdict.startsWith("HOLD") && r.set === "applied59"),
    changedOutside804: ids((r) => r.verdict === "changed" && r.set === "stable2871"),
    holdOutside804: ids((r) => r.verdict.startsWith("HOLD") && r.set === "stable2871"),
    pinMissing73: ids((r) => r.pin === "fixed-now"),
    holdParse: ids((r) => r.verdict === "HOLD_PARSE"),
    holdValidation: ids((r) => r.verdict === "HOLD_VALIDATION"),
  };

  // 6. 成果物の書込 (OUT_DIR のみ・0600)。
  const manifestSHA = writePrivate(join(OUT_DIR, "prep-manifest.json"), JSON.stringify(manifest));
  const journalSHA = writePrivate(join(OUT_DIR, "prep-journal.jsonl"), journalLines.join("\n") + (journalLines.length > 0 ? "\n" : ""));
  const setsSHA = writePrivate(join(OUT_DIR, "prep-sets.json"), JSON.stringify(sets));

  // 7. 終端 zeros + 原状保全の再確認。
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
    mode: "offline-prep",
    workHEAD: workHead,
    parser: { path: PARSER_PATH, blobSHA: PARSER_BLOB },
    inputs: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v])),
    setSHAs: SET_SHAS,
    counts,
    diagnostic: {
      fullscanEqSavedFalse109Excluded: true,
      fixupNewStatusAgree3675: fixupAgree,
    },
    zeros: { fetchAttempts, sourceGET: 0, notionCreateUpdateArchive: 0, d1r2mutation: 0, workflow: 0, newReceipts: 0 },
    limits: [
      "savedfacts は適用前 snapshot。applied59 の現在 D1 値とは主張しない (sealed-post を基準)。現 prod 59 全 rows は未観測。",
      "非59 の before honbun は未観測 (D1 未読)。current honbun は記録のみ。",
      "73 pin不足は今回 bytes/SHA を新固定したが過去 custody 済と扱わない (HOLD)。",
      "source HTTP identity・全 physical archive・fullDL proof は later apply 前に required。",
      "旧 journal/grants は照合読取のみ。CANCELLED grants は再利用しない。",
      "本番/source GET は未実行 (fetch 0)。",
    ],
    artifacts: {
      manifest: { path: join(OUT_DIR, "prep-manifest.json"), sha256: manifestSHA },
      journal: { path: join(OUT_DIR, "prep-journal.jsonl"), sha256: journalSHA, lines: journalLines.length },
      sets: { path: join(OUT_DIR, "prep-sets.json"), sha256: setsSHA },
    },
  };
  const reportSHA = writePrivate(join(OUT_DIR, "prep-report.json"), JSON.stringify(report, null, 2));

  // stdout は counts/SHA/limits のみ (public 可)。
  console.info(JSON.stringify({
    result: "PASS",
    counts,
    setSHAs: SET_SHAS,
    zeros: report.zeros,
    limits: report.limits,
    artifacts: { ...report.artifacts, report: { path: join(OUT_DIR, "prep-report.json"), sha256: reportSHA } },
    at_end: report.at_end,
  }));
}

/** journal 用の before 側テーブル (59=sealed-post、その他=before)。 */
function journalBefore(
  doc: string,
  set: string,
  sealedAll: Map<string, SealedExpectation>,
  savedfacts: Map<string, BeforeRow[]>,
  fullscan: Map<string, ScanRow>
): unknown {
  if (set === "applied59") {
    return { kind: "sealed-post", ...(sealedAll.get(doc) as SealedExpectation) };
  }
  return {
    kind: "before",
    status: (fullscan.get(doc) as ScanRow).savedStatus,
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
    writePrivate(join(OUT_DIR, "prep-report-hold.json"), JSON.stringify(holdReport, null, 2));
  } catch { /* report 書込自体の失敗は握らず抜ける */ }
  console.error(JSON.stringify(holdReport));
  process.exit(1);
}
