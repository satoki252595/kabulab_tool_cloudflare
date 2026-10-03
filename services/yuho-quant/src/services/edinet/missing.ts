/**
 * 取りこぼし選別の純粋関数 (backfill-missing-docs とテストで共用)。
 * 一覧から未取込の有報だけを選ぶ。母集団外・非 120/130・取込済みは
 * 落とし、落とした量を返す (黙って落とさない)。
 */
import {
  isAnnualSecuritiesReport,
  type EdinetDoc,
} from "./types.js";
import type { DocCustody } from "./archive.js";
import { resolveAnnualTicker } from "./identity.js";

export interface MissingDoc {
  doc: EdinetDoc;
  stockId: number;
  stockCode: string;
}

export function selectMissingDocs(
  listed: EdinetDoc[],
  existingIds: Set<string>,
  codeToId: Map<string, number>,
  includeExisting: boolean,
  edinetToTicker: ReadonlyMap<string, string> = new Map()
): { missing: MissingDoc[]; skippedExisting: number; outOfUniverse: number } {
  const missing: MissingDoc[] = [];
  let skippedExisting = 0;
  let outOfUniverse = 0;
  for (const doc of listed) {
    if (!isAnnualSecuritiesReport(doc)) continue;
    const t = resolveAnnualTicker(doc, edinetToTicker);
    const stockId = t === null ? undefined : codeToId.get(t);
    if (stockId === undefined) {
      outOfUniverse++;
      continue;
    }
    if (!includeExisting && existingIds.has(doc.docID)) {
      skippedExisting++;
      continue;
    }
    missing.push({ doc, stockId, stockCode: t! });
  }
  return { missing, skippedExisting, outOfUniverse };
}

export interface CompletionFilterResult {
  /** selectMissingDocs へ渡す実効 existing 集合 */
  effective: Set<string>;
  /** metadata-only 行を持つ listed 通 (tally/STOP 対象。D1 欠落があれば処理継続) */
  metadataOnly: string[];
}

/**
 * 既存扱いスキップを「完成済み」に限定するための純粋適用。
 * - pointerIncomplete (D1 ok なのに行 ID NULL) は既存集合から外して回収する
 * - custody 未完成 (missing) の既存通も外して再処理する
 * - metadata-only 行の通は STOP 報告用に列挙する (既存なら skip 維持し再処理
 *   しない。非既存 = D1 欠落の部分失敗は D1 回収のため処理継続する)
 *
 * custodyMemo の false/未完成は呼ぶたび毎回適用すること (日をまたいだ
 * memo 使い回しで除外を忘れると、未完成が成功扱いで残る)。
 */
export function applyCompletionFilter(
  existingAll: Set<string>,
  pointerIncomplete: Set<string>,
  custodyMemo: Map<string, DocCustody>,
  listedDocIDs: string[]
): CompletionFilterResult {
  const effective = new Set(existingAll);
  for (const id of pointerIncomplete) effective.delete(id);
  const metadataOnly: string[] = [];
  for (const docID of listedDocIDs) {
    const c = custodyMemo.get(docID);
    if (!c) continue;
    if (c.t1 === "metadata-only" || c.t5 === "metadata-only") {
      metadataOnly.push(docID);
      continue;
    }
    if (c.t1 === "missing" || c.t5 === "missing") {
      effective.delete(docID);
    }
  }
  return { effective, metadataOnly };
}
