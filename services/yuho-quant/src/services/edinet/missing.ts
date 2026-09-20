/**
 * 取りこぼし選別の純粋関数 (backfill-missing-docs とテストで共用)。
 * 一覧から未取込の有報だけを選ぶ。母集団外・非 120/130・取込済みは
 * 落とし、落とした量を返す (黙って落とさない)。
 */
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
  type EdinetDoc,
} from "./types.js";

export interface MissingDoc {
  doc: EdinetDoc;
  stockId: number;
}

export function selectMissingDocs(
  listed: EdinetDoc[],
  existingIds: Set<string>,
  codeToId: Map<string, number>,
  includeExisting: boolean
): { missing: MissingDoc[]; skippedExisting: number; outOfUniverse: number } {
  const missing: MissingDoc[] = [];
  let skippedExisting = 0;
  let outOfUniverse = 0;
  for (const doc of listed) {
    if (!isAnnualSecuritiesReport(doc)) continue;
    const t = secCodeToTicker(doc.secCode);
    const stockId = t === null ? undefined : codeToId.get(t);
    if (stockId === undefined) {
      outOfUniverse++;
      continue;
    }
    if (!includeExisting && existingIds.has(doc.docID)) {
      skippedExisting++;
      continue;
    }
    missing.push({ doc, stockId });
  }
  return { missing, skippedExisting, outOfUniverse };
}
