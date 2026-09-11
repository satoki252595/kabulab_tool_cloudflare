/**
 * JPX 上場銘柄一覧 (data_j.xlsx) から 33 業種区分を取得するモジュール
 *
 * ソース: https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx
 *   - 毎月第3営業日以降に前月末版へ更新、~838KB
 *   - 東証上場銘柄（株式・ETF 等、~4400 行）× 東証 33 業種区分 + 市場区分
 *
 * なぜ JPX XLS か:
 *   - Yahoo JP の per-stock スクレイピングは rate limit で ~100 銘柄でブロックされる
 *   - JPX XLS は 1 回のダウンロードで 4400 銘柄を取れる。レート制限無し、公式、無料
 *   - 東証 33 業種区分 (輸送用機器 / 情報・通信業 / 銀行業 等) が正規の形式で取れる
 *
 * 以前は scripts/sync/sectors.ts に CLI スクリプトとしてべた書きされていたが、
 * 月次 sync オーケストレータから呼べるよう関数として切り出した。
 */

import * as XLSX from "xlsx";
import { recordPrimaryData } from "../notion-archive/index.js";
import { isValidStockCode, normalizeStockCode } from "./stock-code.js";

// JPX は 2026-08-10 〜 2026-09-10 の間に配布形式を .xls から .xlsx へ差し替えた。
// 旧 URL (.xls) は HTTP 404 を返すようになり、月次の universe sync が 2026-09-10 の
// 実行から失敗している (core_stocks.MAX(updated_at) は 2026-08-10 で止まっていた)。
// パスとファイル名の他の部分・列構成 (10列) は変わっていない。
// 一覧ページ https://www.jpx.co.jp/markets/statistics-equities/misc/01.html が
// 指すリンクを正とする。
export const JPX_LISTING_URL =
  "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx";

/** JPX XLS の 1 行 (必要なカラムのみ) */
export interface JpxRow {
  /** JPX ファイル「日付」の基準日 (YYYY-MM-DD) */
  asOf: string;
  /** 4 桁 0 パディング済み */
  code: string;
  name: string;
  marketCategory: string;
  /** 33 業種区分。"-" (ETF/REIT) は null */
  sector33: string | null;
}

/** JPX XLS の YYYYMMDD 値を、推定せず検証して YYYY-MM-DD に正規化する。 */
export function parseJpxAsOf(value: unknown): string {
  const compact = String(value ?? "").trim();
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`JPX XLS: 日付が YYYYMMDD 形式ではありません: ${compact}`);
  }
  const year = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const day = Number(compact.slice(6, 8));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`JPX XLS: 実在しない日付です: ${compact}`);
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * JPX 公式 XLS をダウンロードして銘柄リストを返す
 *
 * @throws HTTP エラー / XLS パース失敗時
 */
export async function downloadJpxListing(): Promise<JpxRow[]> {
  const res = await fetch(JPX_LISTING_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0",
      Accept:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*",
    },
  });
  if (!res.ok) {
    // 404 は配布形式の差し替えを真っ先に疑う (2026-09 に .xls → .xlsx が起きた)。
    // ここで黙って空配列を返すと母集団が全滅するので必ず throw する。
    throw new Error(
      `JPX listing HTTP エラー: ${res.status} ${res.statusText} (${JPX_LISTING_URL})` +
        (res.status === 404
          ? " — 配布ファイルの拡張子/URL が変わっていないか一覧ページで確認すること"
          : "")
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());

  const workbook = XLSX.read(buf, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("JPX XLS: Sheet1 が見つかりません");
  }
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });

  const rows: JpxRow[] = [];
  for (const raw of json) {
    const asOf = parseJpxAsOf(raw["日付"]);
    const codeRaw = raw["コード"];
    const name = String(raw["銘柄名"] ?? "").trim();
    const marketCategory = String(raw["市場・商品区分"] ?? "").trim();
    const sectorRaw = String(raw["33業種区分"] ?? "").trim();

    // コードを正準形 (大文字・半角) に正規化してから 4 桁 0 パディング。
    // 母集団マスタ (core.stocks の正本) の書込を、読込側 parseStockCode と同じ
    // 正準形へ揃える (ルール2: フォールバックでなく表現揺れの吸収)。
    if (typeof codeRaw !== "number" && typeof codeRaw !== "string") {
      continue;
    }
    const code = normalizeStockCode(String(codeRaw)).padStart(4, "0");

    // "-" は ETF/REIT 等で業種無し → null
    const sector33 = sectorRaw && sectorRaw !== "-" ? sectorRaw : null;
    rows.push({ asOf, code, name, marketCategory, sector33 });
  }

  if (rows.length === 0) {
    throw new Error("JPX XLS: データ行が 0 件です");
  }
  const sourceDates = new Set(rows.map((row) => row.asOf));
  if (sourceDates.size !== 1) {
    throw new Error(
      `JPX XLS: 基準日が複数混在しています: ${[...sourceDates].join(", ")}`
    );
  }
  const sourceAsOf = rows[0].asOf;
  const sourceMonth = sourceAsOf.slice(0, 7);

  // ルール6: JPX 公式 XLS は物理ファイルの一次取得物。母集団 (universe)
  // の正本ソースなので、その実体を Notion へ必ずアップロードする。
  // 実行月ではなくファイル内の基準月をキーにする。公開差替え前の旧ファイルを
  // 翌月名で誤アーカイブせず、同一の一次データは冪等に skip する。
  await recordPrimaryData({
    service: "universe",
    key: `jpx-listing-${sourceMonth}`,
    source: JPX_LISTING_URL,
    metadata: {
      rowCount: rows.length,
      listedEquityCount: rows.filter(isListedEquity).length,
      bytes: buf.byteLength,
      sourceAsOf,
      sourceMonth,
    },
    files: [
      {
        bytes: buf,
        filename: `data_j-${sourceAsOf}.xlsx`,
        contentType: "application/vnd.ms-excel",
      },
    ],
  });

  return rows;
}

/**
 * 共有 Yahoo パイプラインの対象となる東証内国普通株かを判定する。
 *
 * data_j.xlsx の「市場・商品区分」の代表値:
 *   - プライム（内国株式） / スタンダード（内国株式） / グロース（内国株式）  ← 対象
 *   - プライム（外国株式） 等                                                ← 除外 (海外株)
 *   - ETF・ETN / REIT・ベンチャーファンド… / PRO Market / 出資証券          ← 除外 (非株式)
 *
 * 母集団を JPX 内国株式かつ共通4文字コード形式に限定するためのフィルタ。
 * JPX一覧には種類株等の5桁コードも「内国株式」として含まれるが、共有サービスの
 * 銘柄コード契約・Yahoo正規化は4文字の普通株を対象とするため除外する。
 * 株主優待 REIT などは除外されるが、is_yutai 銘柄の active 維持は
 * 月次 sync 側で「raw JPX に存在する限り inactivate しない」ことで担保する。
 */
export function isListedEquity(row: JpxRow): boolean {
  const mc = row.marketCategory;
  if (!isValidStockCode(row.code)) return false;
  if (!mc.includes("内国株式")) return false;
  return (
    mc.includes("プライム") ||
    mc.includes("スタンダード") ||
    mc.includes("グロース")
  );
}
