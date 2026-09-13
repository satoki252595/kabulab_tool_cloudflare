import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { yutaiGenres, yutaiBenefits } from "../db/schema.js";
import { findActiveEquityStockId } from "../../../../src/shared/db/active-equity.js";

/**
 * 優待生データの型定義
 * スクレイピングやCSV/JSONパースで取得した優待データの共通構造
 */
export type YutaiRawData = {
  stockCode: string;
  stockName: string;
  market: string;
  genreName: string;
  description: string;
  minShares: number;
  recordMonth: number;
  estimatedValue: number | null;
};

/** インポート結果 */
export type ImportResult = {
  created: number;
  updated: number;
  skipped: number;
};

/**
 * HTMLから優待データをパースする
 *
 * HTMLテーブルから優待情報を抽出し、構造化データに変換する。
 * テーブルのカラム順序は: 銘柄コード, 銘柄名, 市場, ジャンル, 内容, 最低株数, 権利月, 優待価値
 *
 * @param html - パース対象のHTML文字列
 * @returns パースされた優待データの配列
 */
export function parseYutaiData(html: string): YutaiRawData[] {
  if (!html || html.trim() === "") {
    return [];
  }

  const results: YutaiRawData[] = [];

  // テーブルのtbody内の<tr>を抽出
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) {
    return [];
  }

  const tbodyContent = tbodyMatch[1];

  // 各行を抽出
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tbodyContent)) !== null) {
    const rowContent = rowMatch[1];

    // セルを抽出
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      // HTMLタグを除去してテキストのみ取得
      const text = cellMatch[1].replace(/<[^>]*>/g, "").trim();
      cells.push(text);
    }

    // 8カラム必要、かつ銘柄コードが存在する行のみ
    if (cells.length >= 8 && cells[0] !== "") {
      const stockCode = cells[0];
      const stockName = cells[1];
      const market = cells[2];
      const genreName = cells[3];
      const description = cells[4];
      const minShares = parseInt(cells[5], 10);
      const recordMonth = parseInt(cells[6], 10);
      const estimatedValueStr = cells[7];
      const estimatedValue = estimatedValueStr
        ? parseInt(estimatedValueStr, 10)
        : null;

      // 必須フィールドが揃っている場合のみ追加
      if (
        stockCode &&
        stockName &&
        market &&
        genreName &&
        description &&
        !isNaN(minShares) &&
        !isNaN(recordMonth)
      ) {
        results.push({
          stockCode,
          stockName,
          market,
          genreName,
          description,
          minShares,
          recordMonth,
          estimatedValue:
            estimatedValue !== null && !isNaN(estimatedValue)
              ? estimatedValue
              : null,
        });
      }
    }
  }

  return results;
}

/**
 * URLから優待ページのHTMLを取得する
 *
 * 適切なUser-Agentヘッダーを設定し、エラーハンドリングを行う。
 *
 * @param url - 取得対象のURL
 * @returns HTML文字列
 * @throws ネットワークエラーまたはHTTPエラーの場合
 */
export async function fetchYutaiPage(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; YutaiInvestmentBot/1.0; +https://github.com/yutai-investment-support)",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ja,en;q=0.9",
    },
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${url} の取得に失敗しました`,
    );
  }

  return response.text();
}

/**
 * ジャンルのスラッグを生成する
 *
 * ジャンル名からURL用のスラッグを生成する。
 * 日本語はそのまま使用し、スペースをハイフンに変換する。
 *
 * @param name - ジャンル名
 * @returns スラッグ文字列
 */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u3000-\u9fff\u30a0-\u30ff\u3040-\u309f-]/g, "");
}

/**
 * 優待データをDBにインポートする
 *
 * 銘柄は `core_stocks` の active かつ equity (日次・公開面と同じ母集団。
 * src/shared/db/active-equity.ts) から引くだけで、**行を足さない**。母集団に無い
 * コード (非普通株・区分が NULL・上場廃止・`core_stocks` に無い) は `skipped` に
 * 数えて飛ばし、ジャンルも作らない。
 *
 * 以前は見つからない銘柄を INSERT していた。足した行は区分が NULL の active 行になり、
 * 日次からも公開面からも外れたまま残る (src/cron/universe.ts の instrument_type 充填の
 * 注記にある、本番 2026-09-13 の 9 行はこの種類の取込が入れたもの)。
 *
 * ジャンルはfind or createし、優待情報はupsert（既存があれば更新）する。
 *
 * @param db - Drizzle ORMのデータベースインスタンス
 * @param data - インポートする優待生データの配列
 * @returns 作成・更新・スキップの件数
 */
export async function importYutaiData(
  db: Database,
  data: YutaiRawData[],
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0 };

  if (data.length === 0) {
    return result;
  }

  const outOfUniverse: string[] = [];

  for (const item of data) {
    try {
      // 1. 銘柄を引く (足さない)。
      // 列は id だけ。core_stocks の `personal-only` 列 (sector33 / sector17 /
      // instrument_type / license_tag / src_source / quality) を取込プロセスへ
      // 載せない。列指定なし select の禁止は
      // src/shared/db/core-stocks-license-boundary.test.ts が見ている。
      const stockId = await findActiveEquityStockId(db, item.stockCode);
      if (stockId === null) {
        outOfUniverse.push(item.stockCode);
        result.skipped += 1;
        continue;
      }

      // 2. ジャンルをfind or create
      const existingGenres = await db
        .select()
        .from(yutaiGenres)
        .where(eq(yutaiGenres.name, item.genreName));

      let genreId: number;
      if (existingGenres.length > 0) {
        genreId = existingGenres[0].id;
      } else {
        const [newGenre] = await db
          .insert(yutaiGenres)
          .values({
            name: item.genreName,
            slug: generateSlug(item.genreName),
          })
          .returning({ id: yutaiGenres.id });
        genreId = newGenre.id;
      }

      // 3. 優待情報をupsert
      await db
        .insert(yutaiBenefits)
        .values({
          stockId,
          genreId,
          description: item.description,
          minShares: item.minShares,
          recordMonth: item.recordMonth,
          estimatedValue: item.estimatedValue,
        })
        .onConflictDoUpdate({
          target: yutaiBenefits.id,
          set: {
            description: item.description,
            minShares: item.minShares,
            recordMonth: item.recordMonth,
            estimatedValue: item.estimatedValue,
            updatedAt: new Date(),
          },
        });

      result.created += 1;
    } catch (error) {
      console.error(
        `優待データのインポートに失敗 (${item.stockCode}):`,
        error instanceof Error ? error.message : error,
      );
      result.skipped += 1;
    }
  }

  if (outOfUniverse.length > 0) {
    console.warn(
      `母集団 (active かつ equity) に無い銘柄を ${outOfUniverse.length} 件飛ばしました:` +
        ` ${outOfUniverse.slice(0, 30).join(", ")}${outOfUniverse.length > 30 ? " ..." : ""}`,
    );
  }

  return result;
}

/**
 * URLから優待データをスクレイピングしてDBにインポートする
 *
 * HTMLの取得・パース・DBインポートを一括で実行する。
 *
 * @param db - Drizzle ORMのデータベースインスタンス
 * @param url - スクレイピング対象のURL
 * @returns インポート結果
 * @throws ネットワークエラーの場合
 */
export async function scrapeAndImport(
  db: Database,
  url: string,
): Promise<ImportResult> {
  const html = await fetchYutaiPage(url);
  const data = parseYutaiData(html);
  return importYutaiData(db, data);
}
