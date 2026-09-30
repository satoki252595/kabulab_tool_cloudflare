/**
 * Repair PREP の docID union + membership tags (純粋部。正本はここ)。
 * data-scripts/overseas-repair-prep.ts (top-level await の CLI で import
 * できない) からテスト可能な純粋部を切り出したもの。IO・fetch なし。
 *
 * 母集合の分離契約:
 * - union は重複を正当に dedup し、全 membership tags を残す。同じ doc が
 *   複数母集合 (census/live1781/旧1695 等) に属することは禁止しない。
 * - 禁止は「旧1695 を新候補数と偽ること/母集合混同」のみ。
 *   `computeOfflineCandidates` は新 pipeline の verdict のみを受け、旧集合を
 *   引数に取らない (構造的に混同不可)。report は旧数・offline 候補・
 *   liveReady・applyQualified を別 field で保持する (`SeparatedCounts`)。
 *   offline 候補の意味は OFFLINE_CANDIDATE であり live READY ではない。
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
  /**
   * 既存 explicit unique/full-physical 証跡 (検証済み readback の記録)。
   * 不在のまま sha/bytes が一致しても hosted receipt を名乗らない。
   */
  receipt?: { pageId: string; manifestMatch: string };
}

export interface ReceiptVerdict {
  state: ReceiptState;
  /** 実 bytes との SHA+length 一致 (metadata として保持。単独では RECEIVED にしない)。 */
  shaMatch: boolean;
}

/**
 * receipt 分類。証跡不在 → ARCHIVE_PENDING。形状外・実 bytes 不一致 →
 * HOLD_RECEIPT (不正/unknown は HOLD)。RECEIVED は既存 explicit
 * unique/full-physical 証跡 (検証済み readback 記録) が実 bytes と一致
 * した場合のみ。{sha256,bytes} の一致は byte identity の証明であって
 * hosted receipt の証明ではないため、単独では ARCHIVE_PENDING のまま
 * shaMatch metadata のみ残す。receipt 証跡自体は offline の既存入力のみ
 * (新規 fetch なし)。検証済み loader なし → 現状 RECEIVED 到達なし。
 */
export function classifyReceipt(
  doc: string,
  receipts: ReadonlyMap<string, ReceiptEvidence>,
  actual: { sha256: string; bytes: number }
): ReceiptVerdict {
  const ev = receipts.get(doc);
  if (ev === undefined) return { state: "ARCHIVE_PENDING", shaMatch: false };
  const shapeOK =
    typeof ev.sha256 === "string" &&
    ev.sha256.length === 64 &&
    typeof ev.bytes === "number" &&
    Number.isFinite(ev.bytes);
  if (!shapeOK) return { state: "HOLD_RECEIPT", shaMatch: false };
  const shaMatch = ev.sha256 === actual.sha256 && ev.bytes === actual.bytes;
  const r = ev.receipt;
  const verified =
    r !== undefined &&
    typeof r === "object" &&
    typeof r.pageId === "string" &&
    r.pageId !== "" &&
    (r.manifestMatch === "same" || r.manifestMatch === "written");
  if (verified && shaMatch) return { state: "RECEIVED", shaMatch: true };
  if (!shaMatch) return { state: "HOLD_RECEIPT", shaMatch: false };
  return { state: "ARCHIVE_PENDING", shaMatch: true };
}

/** 新 pipeline の per-doc verdict (qualified 判定の唯一の入力)。 */
export interface NewVerdict {
  doc: string;
  parseOK: boolean;
  validateOK: boolean;
  pinPresent: boolean;
  pinMismatch: boolean;
  scopeKnown: boolean;
  receipt: ReceiptState;
}

/**
 * OFFLINE_CANDIDATE の導出。parse 通過 + validate 通過 + pin あり +
 * pin 不一致なし + scope 既知 + receipt 受領の全条件のみ。pinMismatch・
 * parse/validation HOLD・unknown scope は候補にしない。旧集合 (旧1695 等)
 * は引数に取らないため、旧数を混入させることは構造的にできない。
 * 意味は offline 候補であり live READY ではない。grant の有無で 0 に
 * 偽装しない (計算結果をそのまま報告する。本 PREP では receipt 証跡なし
 * の実結果として 0)。
 */
export function computeOfflineCandidates(verdicts: ReadonlyArray<NewVerdict>): string[] {
  return verdicts
    .filter(
      (v) =>
        v.parseOK &&
        v.validateOK &&
        v.pinPresent &&
        !v.pinMismatch &&
        v.scopeKnown &&
        v.receipt === "RECEIVED"
    )
    .map((v) => v.doc)
    .sort();
}

/** 旧数・新候補・live/apply を別 field で保持する report 用 counts (混同防止)。 */
export interface SeparatedCounts {
  /** 旧 live 観測の L1 changed 数 (旧 parser prep 由来。母集合が別)。 */
  oldL1Changed1695: number;
  /** 新 pipeline の OFFLINE_CANDIDATE 数 (計算結果そのまま)。 */
  offlineCandidates: number;
  /** fresh custody/current CAS 前の live READY 数 (grant 状態として別明示)。 */
  liveReady: number;
  /** apply 許可数 (grant 状態として別明示)。 */
  applyQualified: number;
}

export function separatedCounts(
  oldL1Changed: number,
  offlineDocs: string[],
  liveReady: number,
  applyQualified: number
): SeparatedCounts {
  return {
    oldL1Changed1695: oldL1Changed,
    offlineCandidates: offlineDocs.length,
    liveReady,
    applyQualified,
  };
}
