/**
 * JPX 上場銘柄一覧 (data_j.xls) から 33 業種区分を取得するモジュール
 *
 * ソース: https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls
 *   - 月初更新、~838KB
 *   - 全上場銘柄 (~4400 行) × 東証 33 業種区分 + 市場区分
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
import { normalizeStockCode } from "./stock-code.js";

const JPX_LISTING_URL =
  "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xls";

/** JPX XLS の 1 行 (必要なカラムのみ) */
export interface JpxRow {
  /** 4 桁 0 パディング済み */
  code: string;
  name: string;
  marketCategory: string;
  /** 33 業種区分。"-" (ETF/REIT) は null */
  sector33: string | null;
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
      Accept: "application/vnd.ms-excel,*/*",
    },
  });
  if (!res.ok) {
    throw new Error(`JPX listing HTTP エラー: ${res.status} ${res.statusText}`);
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
    rows.push({ code, name, marketCategory, sector33 });
  }

  // ルール6: JPX 公式 XLS は物理ファイルの一次取得物。母集団 (universe)
  // の正本ソースなので、その実体を Notion へ必ずアップロードする。
  // 月初更新の単一ファイルなので YYYY-MM をキーに冪等 (月内再実行は skip)。
  const ym = new Date().toISOString().slice(0, 7);
  await recordPrimaryData({
    service: "universe",
    key: `jpx-listing-${ym}`,
    source: JPX_LISTING_URL,
    metadata: {
      rowCount: rows.length,
      listedEquityCount: rows.filter(isListedEquity).length,
      bytes: buf.byteLength,
      yearMonth: ym,
    },
    files: [
      {
        bytes: buf,
        filename: `data_j-${ym}.xls`,
        contentType: "application/vnd.ms-excel",
      },
    ],
  });

  return rows;
}

/**
 * 「日本上場株」= 内国株式 (プライム / スタンダード / グロース) かを判定する。
 *
 * data_j.xls の「市場・商品区分」の代表値:
 *   - プライム（内国株式） / スタンダード（内国株式） / グロース（内国株式）  ← 対象
 *   - プライム（外国株式） 等                                                ← 除外 (海外株)
 *   - ETF・ETN / REIT・ベンチャーファンド… / PRO Market / 出資証券          ← 除外 (非株式)
 *
 * 母集団 (sync 対象 ~4,000) を JPX 内国普通株に限定するためのフィルタ。
 * 株主優待 REIT などは除外されるが、is_yutai 銘柄の active 維持は
 * 月次 sync 側で「raw JPX に存在する限り inactivate しない」ことで担保する。
 */
export function isListedEquity(row: JpxRow): boolean {
  const mc = row.marketCategory;
  if (!mc.includes("内国株式")) return false;
  return (
    mc.includes("プライム") ||
    mc.includes("スタンダード") ||
    mc.includes("グロース")
  );
}
