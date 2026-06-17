import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { Database } from "../db/client.js";
import type { YutaiRawData, ImportResult } from "./yutai-scraper.js";
import { importYutaiData } from "./yutai-scraper.js";
import { yutaiRawDataSchema } from "../validators/yutai-scraper.js";

/**
 * CSV文字列を優待生データにパースする
 *
 * CSVのヘッダー: code,name,market,genre,description,minShares,recordMonth,estimatedValue
 *
 * @param csvContent - CSVコンテンツ文字列
 * @returns パースされた優待データの配列
 */
export function parseYutaiCSV(csvContent: string): YutaiRawData[] {
  if (!csvContent || csvContent.trim() === "") {
    return [];
  }

  const lines = csvContent.trim().split("\n");

  // ヘッダー行のみ、またはデータ行がない場合
  if (lines.length <= 1) {
    return [];
  }

  const results: YutaiRawData[] = [];

  // ヘッダー行をスキップして処理
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {
      continue;
    }

    const fields = line.split(",");
    if (fields.length < 8) {
      continue;
    }

    const [
      code,
      name,
      market,
      genre,
      description,
      minSharesStr,
      recordMonthStr,
      estimatedValueStr,
    ] = fields;

    const minShares = parseInt(minSharesStr, 10);
    const recordMonth = parseInt(recordMonthStr, 10);
    const estimatedValue = estimatedValueStr
      ? parseInt(estimatedValueStr, 10)
      : null;

    if (code && name && !isNaN(minShares) && !isNaN(recordMonth)) {
      results.push({
        stockCode: code,
        stockName: name,
        market,
        genreName: genre,
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

  return results;
}

/**
 * JSON文字列を優待生データにパースする
 *
 * JSON配列の各要素をYutaiRawData形式でバリデーションしてパースする。
 *
 * @param jsonContent - JSON文字列（YutaiRawData[]形式）
 * @returns パースされた優待データの配列
 * @throws JSONパースエラーまたはバリデーションエラーの場合
 */
export function parseYutaiJSON(jsonContent: string): YutaiRawData[] {
  const parsed: unknown = JSON.parse(jsonContent);

  if (!Array.isArray(parsed)) {
    throw new Error("JSONデータは配列形式である必要があります");
  }

  if (parsed.length === 0) {
    return [];
  }

  const results: YutaiRawData[] = [];

  for (const item of parsed) {
    const validated = yutaiRawDataSchema.parse(item);
    results.push(validated);
  }

  return results;
}

/**
 * ファイルから優待データをインポートする
 *
 * ファイル拡張子(.csv / .json)を自動判別してパースし、DBにインポートする。
 *
 * @param db - Drizzle ORMのデータベースインスタンス
 * @param filePath - インポート対象のファイルパス
 * @returns インポート結果
 * @throws サポートされていないファイル形式の場合
 */
export async function importFromFile(
  db: Database,
  filePath: string,
): Promise<ImportResult> {
  const ext = extname(filePath).toLowerCase();
  const content = await readFile(filePath, "utf-8");

  let data: YutaiRawData[];

  switch (ext) {
    case ".csv":
      data = parseYutaiCSV(content);
      break;
    case ".json":
      data = parseYutaiJSON(content);
      break;
    default:
      throw new Error(
        `サポートされていないファイル形式です: ${ext} (.csv または .json に対応)`,
      );
  }

  return importYutaiData(db, data);
}
