/**
 * JPX「空売り集計・業種別集計」日次 PDF の取得・解析 (東証33業種別・無料)。
 *
 * 出典: https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html
 * の「業種別集計」列 (`YYMMDD-g.pdf`。「空売り集計」列の `YYMMDD-m.pdf` は
 * 市場全体・業種別ではないので本モジュールの対象外)。
 *
 * 列は 実注文(a) / 空売り・価格規制あり(b) / 空売り・価格規制なし(c) / 合計(d)。
 * 空売り比率 = (b+c)/d (計画書「使う指標」)。比率であって金額の流入出ではない点に注意
 * (指標定義 DB の説明文に明記する — indicators.ts)。
 *
 * 「その他（33業種外）」行は ETF・REIT・優先出資証券の合計値 (PDF 注記) なので
 * 33 業種には含めず、`other` として別に返す。
 *
 * ライセンス: JPX サイト統計は personal-only。moneyflow の Notion 保管のみに使う。
 */
import { extractText, getDocumentProxy } from "unpdf";
import { assertExactly33Sectors, JPX_33_SECTORS } from "./sector-names.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.jpx.co.jp";
const LISTING_PAGE = `${BASE}/markets/statistics-equities/short-selling/index.html`;
const OTHER_LABEL = "その他（33業種外）";

export interface ShortSellingRow {
  /** 実注文の売買代金 (a、百万円) */
  realOrder: number;
  /** 空売り・価格規制ありの売買代金 (b、百万円) */
  restrictedShort: number;
  /** 空売り・価格規制なしの売買代金 (c、百万円) */
  unrestrictedShort: number;
  /** 合計売買代金 (d = a+b+c、百万円) */
  total: number;
  /** 空売り比率 = (b+c)/d。0〜1。 */
  shortRatio: number;
}

export interface ShortSellingData {
  /** YYYY-MM-DD */
  date: string;
  /** 33 業種別 (PDF 掲載順)。 */
  sectors: Array<ShortSellingRow & { sector: string }>;
  /** ETF・REIT・優先出資証券の合計値 (33業種には含めない)。 */
  other: ShortSellingRow;
  pdfBytes: Uint8Array;
  pdfUrl: string;
}

const toInt = (s: string): number => parseInt(s.replace(/,/g, ""), 10);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RawRow {
  name: string;
  realOrder: number;
  restrictedShort: number;
  unrestrictedShort: number;
  total: number;
}

function toRow(r: RawRow): ShortSellingRow {
  const shortAmount = r.restrictedShort + r.unrestrictedShort;
  return {
    realOrder: r.realOrder,
    restrictedShort: r.restrictedShort,
    unrestrictedShort: r.unrestrictedShort,
    total: r.total,
    shortRatio: r.total > 0 ? shortAmount / r.total : 0,
  };
}

/**
 * PDF 抽出テキストを解析する (純関数)。
 *
 * @throws 日付が取れない、33 業種が過不足なく揃わない、「その他（33業種外）」
 *   行が見つからない場合 (様式変更を疑い throw — ルール2)。
 */
export function parseShortSellingSectorText(text: string): Omit<ShortSellingData, "pdfBytes" | "pdfUrl"> {
  const dateMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  if (!dateMatch) {
    throw new Error("jpx-short-selling: 日付 (YYYY年M月D日) が見つかりません");
  }
  const date = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;

  const candidates = [...JPX_33_SECTORS, OTHER_LABEL].map(escapeRegExp);
  const num = "([\\d,]+)";
  const pct = "[\\d.]+%";
  const pattern = `(${candidates.join("|")})\\s+${num}\\s+${pct}\\s+${num}\\s+${pct}\\s+${num}\\s+${pct}\\s+${num}`;
  const re = new RegExp(pattern, "g");

  const rows: RawRow[] = [];
  for (const m of text.matchAll(re)) {
    rows.push({
      name: m[1],
      realOrder: toInt(m[2]),
      restrictedShort: toInt(m[3]),
      unrestrictedShort: toInt(m[4]),
      total: toInt(m[5]),
    });
  }
  const byName = new Map(rows.map((r) => [r.name, r]));

  assertExactly33Sectors(
    JPX_33_SECTORS.filter((name) => byName.has(name)),
    "jpx-short-selling"
  );

  const sectors = JPX_33_SECTORS.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error(`jpx-short-selling: 業種「${name}」の行が見つかりません`);
    return { sector: name, ...toRow(row) };
  });

  const otherRaw = byName.get(OTHER_LABEL);
  if (!otherRaw) {
    throw new Error(`jpx-short-selling: 「${OTHER_LABEL}」行が見つかりません (様式変更の疑い)`);
  }

  return { date, sectors, other: toRow(otherRaw) };
}

/** 日次一覧ページの「業種別集計」列から最新の `YYMMDD-g.pdf` URL を得る。 */
export async function latestShortSellingSectorPdfUrl(): Promise<{ url: string; date: string }> {
  const html = await (await fetch(LISTING_PAGE, { headers: { "User-Agent": UA } })).text();
  const m = [...html.matchAll(/href="([^"]*\/(\d{6})-g\.pdf)"/g)];
  if (!m.length) throw new Error("jpx-short-selling: 業種別集計 PDF リンクが見つかりません");
  m.sort((a, b) => a[2].localeCompare(b[2]));
  const [, path, yymmdd] = m[m.length - 1];
  const date = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
  return { url: BASE + path, date };
}

export async function fetchShortSellingSector(): Promise<ShortSellingData> {
  const { url } = await latestShortSellingSectorPdfUrl();
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`jpx-short-selling: PDF 取得失敗 status=${res.status} url=${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const parsed = parseShortSellingSectorText(text);
  return { ...parsed, pdfBytes: bytes, pdfUrl: url };
}

/** ルール6: Notion 一次データ記録の入力を組み立てる純関数。キーは日次で冪等。 */
export function shortSellingArchiveInput(data: ShortSellingData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "moneyflow",
    key: `jpx-short-selling-sector-${data.date}`,
    source: data.pdfUrl,
    metadata: {
      date: data.date,
      sectorCount: data.sectors.length,
      other: data.other,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `jpx-short-selling-sector-${data.date}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}

/**
 * 日次データを月次に集計する (観測ログには月次のみ書く設計)。
 * 比率は単純平均ではなく、業種別に「その月の売買代金合計に占める空売り売買代金合計」
 * (加重平均) で求める (1 日ごとの比率を単純平均すると、出来高の小さい日の比率が
 * 出来高の大きい日と同じ重みになり歪む)。
 *
 * @param dailyRows 同一月内の日次データ。空配列は throw (集計対象が無いのに
 *   「0」を返さない — ルール2)。
 */
export function aggregateMonthlyShortSellingRatio(
  dailyRows: readonly Omit<ShortSellingData, "pdfBytes" | "pdfUrl">[]
): { month: string; sectors: Array<{ sector: string; shortRatio: number; totalTurnover: number; tradingDays: number }> } {
  if (dailyRows.length === 0) {
    throw new Error("aggregateMonthlyShortSellingRatio: 集計対象の日次データが 0 件です");
  }
  const months = new Set(dailyRows.map((r) => r.date.slice(0, 7)));
  if (months.size !== 1) {
    throw new Error(
      `aggregateMonthlyShortSellingRatio: 複数の月が混在しています: ${[...months].join(", ")}`
    );
  }
  const month = [...months][0];

  const bySector = new Map<string, { shortAmount: number; total: number; tradingDays: number }>();
  for (const day of dailyRows) {
    for (const row of day.sectors) {
      const cur = bySector.get(row.sector) ?? { shortAmount: 0, total: 0, tradingDays: 0 };
      cur.shortAmount += row.restrictedShort + row.unrestrictedShort;
      cur.total += row.total;
      cur.tradingDays += 1;
      bySector.set(row.sector, cur);
    }
  }

  const sectors = JPX_33_SECTORS.map((sector) => {
    const agg = bySector.get(sector);
    if (!agg) {
      throw new Error(`aggregateMonthlyShortSellingRatio: 業種「${sector}」のデータがありません`);
    }
    return {
      sector,
      shortRatio: agg.total > 0 ? agg.shortAmount / agg.total : 0,
      totalTurnover: agg.total,
      tradingDays: agg.tradingDays,
    };
  });

  return { month, sectors };
}
