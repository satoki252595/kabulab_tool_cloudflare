/**
 * overlay batch の test-only helper (本番 export 禁止)。
 * vitest の include (`*.test.ts`) に当たらない配置で共有する。
 */
import type {
  OverlayBatchInput,
  OverlayCollectFn,
} from "../universe-overlay.js";

/** 空 batch。適用しても何も変わらない (state 世代のみ進む)。 */
export function emptyUniverseBatch(
  baseAsOf: string | null,
  eligibilityAsOf: string
): OverlayBatchInput {
  const src = (url: string) => ({
    rows: [],
    coveredYears: [eligibilityAsOf.slice(0, 4)],
    rawSha: "e".repeat(64),
    sourceUrl: url,
  });
  return {
    baseAsOf,
    eligibilityAsOf,
    eventsFetchedAt: "1970-01-01T00:00:00.000Z",
    eventsSha: "e".repeat(64),
    archiveKey: "e".repeat(12),
    pageId: "empty",
    coverage: {
      years: [eligibilityAsOf.slice(0, 4)],
      bootstrapPartial: baseAsOf === null,
    },
    sources: {
      delisted: src("https://www.jpx.co.jp/listing/stocks/delisted/index.html"),
      newListings: src("https://www.jpx.co.jp/listing/stocks/new/index.html"),
      transfers: src("https://www.jpx.co.jp/listing/stocks/transfers/index.html"),
    },
  };
}

/** 空 batch を返す fake collector。 */
export const fakeOverlayCollect: OverlayCollectFn = async (input) =>
  emptyUniverseBatch(input.baseAsOf, input.eligibilityAsOf);
