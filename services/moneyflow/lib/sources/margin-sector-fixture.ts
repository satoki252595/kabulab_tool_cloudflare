/**
 * jpx-margin-sector テスト用の合成 snapshot/mapping builder。
 * 行の形だけ実 PDF に合わせ、銘柄・数値は架空。
 * sources/adapter 両テストから使う (テスト間の import による二重実行を避ける)。
 */
import { JPX_33_SECTORS } from "../sector-names.js";

export interface SynthFig {
  sellOutstanding: number;
  sellChg: number | null;
  sellListedRatio: number;
  sellListedRatioRaw: string;
  buyOutstanding: number;
  buyChg: number | null;
  buyListedRatio: number;
  buyListedRatioRaw: string;
  negSell: number;
  negSellChg: number | null;
  negBuy: number;
  negBuyChg: number | null;
  stdSell: number;
  stdSellChg: number | null;
  stdBuy: number;
  stdBuyChg: number | null;
}

function fig(
  sell: number,
  buy: number,
  opts: { sellChg?: number | null; buyChg?: number | null; neg?: number } = {},
): SynthFig {
  const neg = opts.neg ?? sell;
  return {
    sellOutstanding: sell,
    sellChg: opts.sellChg !== undefined ? opts.sellChg : 1,
    sellListedRatio: 0,
    sellListedRatioRaw: "0.0%",
    buyOutstanding: buy,
    buyChg: opts.buyChg !== undefined ? opts.buyChg : 2,
    buyListedRatio: 0,
    buyListedRatioRaw: "0.0%",
    negSell: neg,
    negSellChg: 0,
    negBuy: buy,
    negBuyChg: 0,
    stdSell: sell - neg,
    stdSellChg: 0,
    stdBuy: 0,
    stdBuyChg: 0,
  };
}

export interface SynthRow {
  sourceCode: string;
  name: string;
  ordinaryTicker: string | null;
  eligible: boolean;
  unitLetter: string;
  sectype: string;
  market: string;
  loanKind: string;
  isin: string;
  shares: SynthFig;
  amounts: SynthFig;
}

export function synthRow(
  sourceCode: string,
  ordinaryTicker: string | null,
  sell: number,
  buy: number,
  opts: { sellChg?: number | null; buyChg?: number | null } = {},
): SynthRow {
  return {
    sourceCode,
    name: `合成${sourceCode}`,
    ordinaryTicker,
    eligible: ordinaryTicker !== null,
    unitLetter: "B",
    sectype: "普通株式",
    market: "プライム",
    loanKind: "貸",
    isin: "JP0000000000",
    shares: fig(sell, buy, opts),
    amounts: fig(sell * 1000, buy * 1000, { sellChg: 10, buyChg: 20 }),
  };
}

const NUM_KEYS = [
  "sellOutstanding",
  "sellChg",
  "buyOutstanding",
  "buyChg",
  "negSell",
  "negSellChg",
  "negBuy",
  "negBuyChg",
  "stdSell",
  "stdSellChg",
  "stdBuy",
  "stdBuyChg",
] as const;

/** 行合計と整合する最小 totals (全行を loan に集約。16 行)。 */
function totalsFor(rows: SynthRow[]) {
  const sumOf = (pick: (r: SynthRow) => SynthFig) => {
    const out: Record<string, number | string | null> = {
      sellOutstanding: 0, sellChg: 0, sellListedRatio: 0, sellListedRatioRaw: "0.0%",
      buyOutstanding: 0, buyChg: 0, buyListedRatio: 0, buyListedRatioRaw: "0.0%",
      negSell: 0, negSellChg: 0, negBuy: 0, negBuyChg: 0,
      stdSell: 0, stdSellChg: 0, stdBuy: 0, stdBuyChg: 0,
    };
    for (const k of NUM_KEYS) {
      let acc: number | null = 0;
      for (const r of rows) {
        const v = pick(r)[k];
        acc = acc === null || v === null ? null : acc + v;
      }
      out[k] = acc;
    }
    return out;
  };
  const sumS = sumOf((r) => r.shares);
  const sumA = sumOf((r) => r.amounts);
  // 合計行の null は突合不能で STOP するため、合計側の chg null は除外する。
  // (実原本の合計 38 行に null は無い。明細の null は null のまま。)
  for (const k of NUM_KEYS) {
    if (sumS[k] === null) sumS[k] = 0;
    if (sumA[k] === null) sumA[k] = 0;
  }
  const n = rows.length;
  const z = () => ({
    sellOutstanding: 0, sellChg: 0, sellListedRatio: 0, sellListedRatioRaw: "0.0%",
    buyOutstanding: 0, buyChg: 0, buyListedRatio: 0, buyListedRatioRaw: "0.0%",
    negSell: 0, negSellChg: 0, negBuy: 0, negBuyChg: 0,
    stdSell: 0, stdSellChg: 0, stdBuy: 0, stdBuyChg: 0,
  });
  const T = (label: string, scope: string, market: string | null, count: number, shares: unknown, amounts: unknown) =>
    ({ label, scope, market, count, shares, amounts });
  const block = (label: string, scope: string, count: number, shares: unknown, amounts: unknown) => [
    T(label, scope, null, count, shares, amounts),
    T("プライム 小計", scope, "プライム", count, shares, amounts),
    T("スタンダード 小計", scope, "スタンダード", 0, z(), z()),
    T("グロース 小計", scope, "グロース", 0, z(), z()),
  ];
  return [
    ...block("貸借銘柄", "loan", n, sumS, sumA),
    ...block("制度信用銘柄", "standardized", 0, z(), z()),
    ...block("一般信用銘柄", "other", 0, z(), z()),
    ...block("総合計", "grand", n, sumS, sumA),
  ];
}

export function synthSnapshot(rows: SynthRow[]) {
  return {
    format: "jpx-margin-daily-v1",
    basisDate: "2026-09-28",
    publicationDate: "2026-09-29",
    sourceUrl: "https://example.invalid/m.pdf",
    rawSha256: "a".repeat(64),
    rawPageId: "page-synth",
    rows,
    totals: totalsFor(rows),
  };
}

/** 33 業種 × 各 1 ティッカー + 端数行の合成 fixture を作る。 */
export function synthSectorFixture(): {
  rows: SynthRow[];
  tickerSector: Map<string, string | null>;
  master: Set<string>;
} {
  const rows: SynthRow[] = [];
  const tickerSector = new Map<string, string | null>();
  // 33 業種 × 1 行 (ティッカー 1001〜1033)。
  JPX_33_SECTORS.forEach((sector, i) => {
    const ticker = String(1001 + i);
    const code = `${ticker}0`;
    // 化学 (index 6) の行だけ売前日比 null (null 伝播の検査用)。
    const sellChg = i === 6 ? null : 1;
    rows.push(synthRow(code, ticker, 100 + i, 200 + i, { sellChg }));
    tickerSector.set(ticker, sector);
  });
  // 同一ティッカー複数行 (1001 に 2 行目。集計に含めるが明示する)。
  rows.push(synthRow("10011", "1001", 7, 8));
  // sector NULL の active 行 (未分類へ)。
  rows.push(synthRow("20010", "2001", 3, 4));
  tickerSector.set("2001", null);
  // 除外行: ティッカー不能 / master 外 / active 外。
  rows.push(synthRow("14900", null, 5, 6));
  rows.push(synthRow("99990", "9999", 9, 10));
  rows.push(synthRow("88880", "8888", 11, 12));
  const master = new Set([...tickerSector.keys(), "8888"]);
  return { rows, tickerSector, master };
}
