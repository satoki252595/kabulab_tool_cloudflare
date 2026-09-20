// JPX「銘柄別信用取引週末残高」週次PDFを取得・解析（全銘柄・無料）。
import { extractText, getDocumentProxy } from "unpdf";
import { marginCodeToKey } from "../../../src/shared/jpx/stock-code.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const BASE = "https://www.jpx.co.jp";
const PAGE = `${BASE}/markets/statistics-equities/margin/05.html`;

export interface MarginRow { code: string; sell: number; buy: number; sell_chg: number; buy_chg: number; }
export interface MarginData {
  week: string;
  rows: MarginRow[];
  /** 取得した PDF の実体 (ルール6: Notion 一次データへの実体アップロード用) */
  pdfBytes: Uint8Array;
  /** 取得元 PDF の URL (来歴用) */
  pdfUrl: string;
}

// 一覧ページから最新の syumatsu*.pdf の URL を得る。
export async function latestMarginPdfUrl(): Promise<string> {
  const html = await (await fetch(PAGE, { headers: { "User-Agent": UA } })).text();
  const m = [...html.matchAll(/\/markets\/statistics-equities\/margin\/[^"']*?syumatsu(\d+)\.pdf/g)];
  if (!m.length) throw new Error("margin pdf link not found");
  m.sort((a, b) => a[1].localeCompare(b[1]));
  return BASE + m[m.length - 1][0];
}

const toInt = (s: string) => parseInt(s.replace(/,/g, "").replace(/▲/g, "-").replace(/\s/g, ""), 10) || 0;

export function parseMarginText(
  text: string
): Pick<MarginData, "week" | "rows"> {
  const wk = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s*申込/);
  const week = wk ? `${wk[1]}-${wk[2].padStart(2, "0")}-${wk[3].padStart(2, "0")}` : "";
  const num = "(?:▲\\s*)?[\\d,]+";
  // 5桁コード(末尾照合) + JP始まりISIN + 売残/前週比/買残/前週比
  const re = new RegExp(`(\\d{3}[0-9A-Z]\\d)\\s+(JP\\w{10})\\s+(${num})\\s+(${num})\\s+(${num})\\s+(${num})`, "g");
  const rows: MarginRow[] = [];
  for (const mm of text.matchAll(re)) {
    // 末尾 "0" は 4 文字ティッカー、末尾 "1"-"9" (種類株) は 5 文字のまま。
    // 以前は無条件に slice(0, 4) しており、実 PDF で毎週 7 行の種類株を同社普通株の
    // コードへ潰していた (stockStock docs/CONTRACTS.md 銘柄コード契約)。
    // sourceCodeToTicker だとこの 7 行を落とすので使わない。
    const code = marginCodeToKey(mm[1]);
    // 正規表現が 5 文字目を数字に限るので null は起こり得ない。起きたら別銘柄として
    // 書くより、その回を失敗させる (ルール2: 不正値を黙って別の値にしない)。
    if (code === null) throw new Error(`margin code not interpretable: ${mm[1]}`);
    rows.push({
      code,
      sell: toInt(mm[3]), sell_chg: toInt(mm[4]),
      buy: toInt(mm[5]), buy_chg: toInt(mm[6]),
    });
  }
  return { week, rows };
}

export async function fetchMargin(): Promise<MarginData> {
  const url = await latestMarginPdfUrl();
  const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
  const bytes = new Uint8Array(buf);
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return { ...parseMarginText(text), pdfBytes: bytes, pdfUrl: url };
}

/**
 * ルール6: Notion 一次データ記録の入力を組み立てる純関数。
 * キーは週次で冪等 (`jpx-margin-YYYY-MM-DD`)。ファイルは PDF 実体。
 */
export function marginArchiveInput(data: MarginData): {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  return {
    service: "vwap-analysis",
    key: `jpx-margin-${data.week}`,
    source: data.pdfUrl,
    metadata: {
      week: data.week,
      rowCount: data.rows.length,
      bytes: data.pdfBytes.byteLength,
    },
    files: [
      {
        bytes: data.pdfBytes,
        filename: `margin-${data.week}.pdf`,
        contentType: "application/pdf",
      },
    ],
  };
}
