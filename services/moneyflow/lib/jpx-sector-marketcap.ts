/**
 * JPX「株式時価総額 (Market Capitalization by Industry Sector)」月次 PDF の
 * 取得・解析 (東証33業種別・プライム市場のみ・無料)。
 *
 * 出典: https://www.jpx.co.jp/markets/statistics-equities/misc/07.html
 * 業種内訳があるのは **プライム市場のみ** (スタンダード/グロース/TOKYO PRO Market
 * は市場区分合計のみで業種内訳は無い)。時価総額ベースでプライムは市場全体の
 * 約 97%・社数ベースでは約 4 割 (計画書「結論」節)。
 *
 * ライセンス: JPX サイト統計は personal-only。個人利用の範囲でのみ使う
 * (recordPrimaryData の service="moneyflow" 経由で Notion へのみ保管し、
 * 公開 API・エクスポートへは流さない)。
 */
import { extractText, getDocumentProxy } from "unpdf";
import { assertExactly33Sectors, JPX_33_SECTORS } from "./sector-names.js";

/** ブラウザ相当 UA (src/shared/jpx/sectors.ts / vwap-analysis margin.ts と同じ配慮)。 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.jpx.co.jp";
const LISTING_PAGE = `${BASE}/markets/statistics-equities/misc/07.html`;

export interface SegmentRow {
  /** 上場会社数 */
  companies: number;
  /** 時価総額 (百万円)。PDF 単位そのまま (円に換算しない — 出典の単位を保つ)。 */
  marketCapMillionYen: number;
}

export interface SectorMarketCapData {
  /** 月末基準日 (YYYY-MM-DD) */
  asOfDate: string;
  /** 33 業種別 (プライムのみ)。順序は PDF の掲載順。 */
  sectors: Array<SegmentRow & { sector: string }>;
  /** 市場区分別合計。プライムは 33 業種の合計と一致するはず (突合はしない: 出典の値をそのまま使う)。 */
  segments: {
    prime: SegmentRow;
    standard: SegmentRow;
    growth: SegmentRow;
    tokyoProMarket: SegmentRow;
    total: SegmentRow;
  };
  /** 取得した PDF の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  pdfBytes: Uint8Array;
  pdfUrl: string;
}

const toInt = (s: string): number => parseInt(s.replace(/,/g, ""), 10);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEGMENT_NAMES = {
  prime: "プライム",
  standard: "スタンダード",
  growth: "グロース",
  tokyoProMarket: "TOKYO PRO Market",
} as const;

interface RawRow {
  name: string;
  companies: number;
  marketCapMillionYen: number;
}

/**
 * PDF 抽出テキストから「<名前> <社数> <時価総額>」の行を全て拾う。
 *
 * 名前は既知の候補 (33 業種名 + 市場区分名 + 「合計」) の完全一致のみを対象にする
 * (英語併記・改行崩れ等で汎用の「数字の手前まで」パターンだと誤爆するため)。
 * 既知の候補以外の名前が数字と並んでいても無視する (様式変更で 33 業種の一部が
 * 見つからなければ後段の `assertExactly33Sectors` が throw する)。
 */
function extractKnownRows(text: string): RawRow[] {
  const candidates = [
    ...JPX_33_SECTORS,
    SEGMENT_NAMES.prime,
    SEGMENT_NAMES.standard,
    SEGMENT_NAMES.growth,
    SEGMENT_NAMES.tokyoProMarket,
  ].map(escapeRegExp);
  const pattern = `(${candidates.join("|")}|合\\s*計)\\s+([\\d,]+)\\s+([\\d,]+)`;
  const re = new RegExp(pattern, "g");
  const rows: RawRow[] = [];
  for (const m of text.matchAll(re)) {
    const rawName = m[1];
    const name = rawName.replace(/合\s*計/, "合計");
    rows.push({ name, companies: toInt(m[2]), marketCapMillionYen: toInt(m[3]) });
  }
  return rows;
}

function toSegmentRow(row: RawRow | undefined, label: string): SegmentRow {
  if (!row) {
    throw new Error(`jpx-sector-marketcap: 「${label}」の行が見つかりません (様式変更の疑い)`);
  }
  return { companies: row.companies, marketCapMillionYen: row.marketCapMillionYen };
}

/**
 * PDF から抽出したテキストを解析する (純関数。unpdf に依存しない)。
 *
 * @throws 基準日が取れない、33 業種が過不足なく揃わない、市場区分合計行が
 *   見つからない場合 (様式変更を疑い、推測でその場をしのがない — ルール2)。
 */
export function parseSectorMarketCapText(
  text: string
): Pick<SectorMarketCapData, "asOfDate" | "sectors" | "segments"> {
  const dateMatch = /(\d{4})年(\d{1,2})月(\d{1,2})日現在/.exec(text);
  if (!dateMatch) {
    throw new Error("jpx-sector-marketcap: 基準日 (YYYY年M月D日現在) が見つかりません");
  }
  const asOfDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;

  const rows = extractKnownRows(text);
  const byName = new Map(rows.map((r) => [r.name, r]));

  const sectorRows = JPX_33_SECTORS.map((name) => byName.get(name)).filter(
    (r): r is RawRow => r !== undefined
  );
  assertExactly33Sectors(
    sectorRows.map((r) => r.name),
    "jpx-sector-marketcap"
  );

  const sectors = JPX_33_SECTORS.map((name) => {
    const row = byName.get(name);
    if (!row) throw new Error(`jpx-sector-marketcap: 業種「${name}」の行が見つかりません`);
    return { sector: name, companies: row.companies, marketCapMillionYen: row.marketCapMillionYen };
  });

  return {
    asOfDate,
    sectors,
    segments: {
      prime: toSegmentRow(byName.get(SEGMENT_NAMES.prime), SEGMENT_NAMES.prime),
      standard: toSegmentRow(byName.get(SEGMENT_NAMES.standard), SEGMENT_NAMES.standard),
      growth: toSegmentRow(byName.get(SEGMENT_NAMES.growth), SEGMENT_NAMES.growth),
      tokyoProMarket: toSegmentRow(byName.get(SEGMENT_NAMES.tokyoProMarket), SEGMENT_NAMES.tokyoProMarket),
      total: toSegmentRow(byName.get("合計"), "合計"),
    },
  };
}

/** 一覧ページの PDF ファイル名 (`YYYYMM.pdf`) の形式を観測期間表記 (`YYYY-MM`) へ変換する。 */
export function sectorMarketCapPeriodFromYearMonth(yearMonth: string): string {
  return `${yearMonth.slice(0, 4)}-${yearMonth.slice(4, 6)}`;
}

/** ルール6 の冪等キー (`recordPrimaryData`/`isArchived` の key)。月次で一意。 */
export function sectorMarketCapKey(period: string): string {
  return `jpx-sector-marketcap-${period}`;
}

/** 一覧ページから対象月の PDF URL を得る (未指定なら最新月)。 */
export async function latestSectorMarketCapPdfUrl(): Promise<{ url: string; yearMonth: string }> {
  const html = await (await fetch(LISTING_PAGE, { headers: { "User-Agent": UA } })).text();
  const m = [...html.matchAll(/href="([^"]*\/(\d{6})\.pdf)"/g)];
  if (!m.length) throw new Error("jpx-sector-marketcap: PDF リンクが見つかりません");
  m.sort((a, b) => a[2].localeCompare(b[2]));
  const [, path, yearMonth] = m[m.length - 1];
  return { url: BASE + path, yearMonth };
}

export async function fetchSectorMarketCap(): Promise<SectorMarketCapData> {
  const { url } = await latestSectorMarketCapPdfUrl();
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    throw new Error(`jpx-sector-marketcap: PDF 取得失敗 status=${res.status} url=${url}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  const parsed = parseSectorMarketCapText(text);
  return { ...parsed, pdfBytes: bytes, pdfUrl: url };
}

/** ルール6: Notion 一次データ記録の入力を組み立てる純関数。キーは月次で冪等。 */
export function sectorMarketCapArchiveInput(data: SectorMarketCapData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  const ym = data.asOfDate.slice(0, 7);
  return {
    service: "moneyflow",
    key: sectorMarketCapKey(ym),
    source: data.pdfUrl,
    metadata: {
      asOfDate: data.asOfDate,
      sectorCount: data.sectors.length,
      segments: data.segments,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `jpx-sector-marketcap-${ym}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}
