/**
 * 海外 facts → DB 保存行の正準変換 (single source of truth)。
 *
 * 共有 callers (5): backfill-overseas.ts (writer)・ingest.ts (writer)・
 * missing-backfill.ts (writer)・overseas-745-prep.ts・overseas-repair-prep.ts。
 * writers も PREP も同一関数 toOverseasSaveRows(facts, status) を呼び、
 * writers は documentId/stockId の付与のみ行う (9列組立の copy なし)。
 * orders 系は toYen のみ共用し、行組立・pattern は従来通り (orders の
 * 振舞い変更なし)。
 *
 * 型は閉 domain: OverseasParseStatus (4種) | "parse_error"。
 * 実行時未知 (閉 domain 外) は pattern 化せず throw する
 * ("none" への黙認 fallback はしない)。
 * geo_present_unstructured / no_overseas_table / parse_error → "none"
 * は valid として保持する。
 *
 * 補完なし: null は観測 NULL として素通しする (0 埋め・factor 1 埋めなし)。
 * 本 module が検査するのは status (閉 domain) と toYen 入力
 * (raw/factor の null|number) のみであり、全列の形状検証はしない。
 * JSON 等の非型付入力は呼出側が事前検証し、欠落は HOLD すること。
 */
import type { OverseasFact, OverseasParseStatus } from "./overseas-parser.js";

export type OverseasSaveStatus = OverseasParseStatus | "parse_error";

const KNOWN_SAVE_STATUS: ReadonlySet<string> = new Set([
  "ok_geo_rows",
  "ok_geo_cols",
  "geo_present_unstructured",
  "no_overseas_table",
  "parse_error",
]);

export function toYen(raw: number | null, factor: number): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || typeof factor !== "number") {
    throw new Error("toYen: 欠落/型外 (null≠missing。呼出側で事前検証すること)");
  }
  return Math.round(raw * factor);
}

export function overseasPatternOf(status: OverseasSaveStatus): string {
  if (!KNOWN_SAVE_STATUS.has(status)) {
    throw new Error(`overseasPatternOf: 未知 status を pattern 化しない: ${String(status)}`);
  }
  if (status === "ok_geo_rows") return "geo_rows";
  if (status === "ok_geo_cols") return "geo_cols";
  return "none";
}

export interface OverseasSaveRow {
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

export function toOverseasSaveRows(
  facts: OverseasFact[],
  status: OverseasSaveStatus
): OverseasSaveRow[] {
  // status は map 前に1回だけ確定する。facts=[] でも未知 status は
  // ここで throw する (空配列の黙認 return なし)。
  const pattern = overseasPatternOf(status);
  return facts.map((f) => ({
    fiscalYearEnd: f.fiscalYearEnd,
    regionName: f.regionName,
    regionKind: f.regionKind,
    isConsolidated: f.isConsolidated,
    unitLabel: f.unitLabel,
    salesRaw: f.salesAmount,
    salesYen: toYen(f.salesAmount, f.unitYenFactor),
    ratioPct: f.ratioPct,
    pattern,
  }));
}
