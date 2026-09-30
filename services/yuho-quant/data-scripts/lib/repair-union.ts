/**
 * Repair PREP の docID union + membership tags (純粋部。正本はここ)。
 * data-scripts/overseas-repair-prep.ts (top-level await の CLI で import
 * できない) からテスト可能な純粋部を切り出したもの。IO・fetch なし。
 *
 * 母集合の分離契約:
 * - union は重複を正当に dedup し、全 membership tags を残す。同じ doc が
 *   複数母集合 (census/live1781/旧1695 等) に属することは禁止しない。
 * - 禁止は「旧1695 を新 qualified 候補数と偽ること/母集合混同」のみ。
 *   `computeQualified` は新 pipeline の verdict のみを受け、旧集合を
 *   引数に取らない (構造的に混同不可)。report は旧数と新数を別 field で
 *   保持する (`SeparatedCounts`)。
 */
export type MembershipTag =
  | "census-adopted"
  | "census-held"
  | "census-reverse"
  | "census-other"
  | "live1781"
  | "old-l1changed1695"
  | "pin73unknown"
  | "hist804"
  | "applied59"
  | "remain745"
  | "stable2871";

/** tags の固定順 (出力の安定用)。 */
const TAG_ORDER: readonly MembershipTag[] = [
  "census-adopted",
  "census-held",
  "census-reverse",
  "census-other",
  "live1781",
  "old-l1changed1695",
  "pin73unknown",
  "hist804",
  "applied59",
  "remain745",
  "stable2871",
];

/**
 * docID union を dedup 構築する。同じ doc の重複 entries は全 tags を
 * マージして残す (union からの脱落なし・tags の欠落なし)。
 */
export function buildUnion(
  entries: ReadonlyArray<{ doc: string; tag: MembershipTag }>
): Map<string, MembershipTag[]> {
  const acc = new Map<string, Set<MembershipTag>>();
  for (const { doc, tag } of entries) {
    const set = acc.get(doc) ?? new Set<MembershipTag>();
    set.add(tag);
    acc.set(doc, set);
  }
  const out = new Map<string, MembershipTag[]>();
  for (const [doc, set] of acc) {
    out.set(
      doc,
      [...TAG_ORDER].filter((t) => set.has(t))
    );
  }
  return out;
}

/**
 * census (旧 status → 新 status) の class tags 決定 (複数可)。
 * 最終 ok は adopted。うち un→ok は reverse も併持する (1411 採用は
 * 36 reverse を含む。union は全 tags を残すため単一化しない)。
 * ok→un は held。それ以外は other。
 */
export function censusTags(oldStatus: string, newStatus: string): MembershipTag[] {
  if (newStatus === "geo_present_unstructured" && oldStatus.startsWith("ok_")) {
    return ["census-held"];
  }
  if (newStatus.startsWith("ok_")) {
    return oldStatus === "geo_present_unstructured"
      ? ["census-adopted", "census-reverse"]
      : ["census-adopted"];
  }
  return ["census-other"];
}

/** primary unique physical full-bytes receipt の状態 (既証跡の静読のみ)。 */
export type ReceiptState = "RECEIVED" | "ARCHIVE_PENDING" | "HOLD_RECEIPT";

export interface ReceiptEvidence {
  sha256: string;
  bytes: number;
}

/**
 * receipt 分類。不在 → ARCHIVE_PENDING。存在しても sha/bytes 形状外 →
 * HOLD_RECEIPT (不正/unknown は HOLD)。receipt 証跡自体は offline の
 * 既存入力のみ (新規 fetch なし)。
 */
export function classifyReceipt(
  doc: string,
  receipts: ReadonlyMap<string, ReceiptEvidence>
): ReceiptState {
  const ev = receipts.get(doc);
  if (ev === undefined) return "ARCHIVE_PENDING";
  if (typeof ev.sha256 !== "string" || ev.sha256.length !== 64) return "HOLD_RECEIPT";
  if (typeof ev.bytes !== "number" || !Number.isFinite(ev.bytes)) return "HOLD_RECEIPT";
  return "RECEIVED";
}

/** 新 pipeline の per-doc verdict (qualified 判定の唯一の入力)。 */
export interface NewVerdict {
  doc: string;
  validateOK: boolean;
  pinPresent: boolean;
  receipt: ReceiptState;
}

/**
 * 新 qualified 候補の導出。validate 通過 + pin あり + receipt 受領の
 * 3 条件のみ。旧集合 (旧1695 等) は引数に取らないため、新 qualified 数に
 * 旧数を混入させることは構造的にできない。本 PREP (apply grant 0・
 * receipt 証跡なし) では 0 を返す。呼び出し側は 0 を assert する。
 */
export function computeQualified(verdicts: ReadonlyArray<NewVerdict>): string[] {
  return verdicts
    .filter((v) => v.validateOK && v.pinPresent && v.receipt === "RECEIVED")
    .map((v) => v.doc)
    .sort();
}

/** 旧数と新数を別 field で保持する report 用 counts (混同防止)。 */
export interface SeparatedCounts {
  /** 旧 live 観測の L1 changed 数 (旧 parser prep 由来。母集合が別)。 */
  oldL1Changed1695: number;
  /** 新 pipeline の qualified 候補数 (本 PREP では 0)。 */
  newQualified: number;
}

export function separatedCounts(oldL1Changed: number, qualifiedDocs: string[]): SeparatedCounts {
  return { oldL1Changed1695: oldL1Changed, newQualified: qualifiedDocs.length };
}
