import path from "node:path";
import { fileURLToPath } from "node:url";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import { loadActiveEquityCodes } from "../../../src/shared/db/active-equity.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * VWAP 取込の母集団: D1 正規の active かつ equity 集合。
 * static stocks.json fallback は無い (凍結銘柄の混入を防ぐ)。
 * D1 失敗・空集合は R2 書込前に throw する (呼び出しは main 先頭)。
 */
export async function loadCodes(): Promise<string[]> {
  const db = createD1HttpDb({});
  return loadCodesFromDb(db as Parameters<typeof loadActiveEquityCodes>[0]);
}

/** 信頼境界のテスト用 seam。空集合は throw (欠落母集団で書かない)。 */
export async function loadCodesFromDb(
  db: Parameters<typeof loadActiveEquityCodes>[0]
): Promise<string[]> {
  const codes = await loadActiveEquityCodes(db);
  if (codes.length === 0) {
    throw new Error("VWAP 取込の母集団が空 (D1 active-equity 0 件)。R2 へ書かず STOP。");
  }
  return codes;
}

/**
 * `--codes` 明示指定は正規集合の所属を必須にする。対象外が1件でもあれば
 * その場で STOP し、対象外銘柄の fetch/R2 書込に入らない。
 */
export function assertCodesInUniverse(requested: string[], universe: string[]): void {
  const set = new Set(universe);
  const outside = requested.filter((c) => !set.has(c));
  if (outside.length > 0) {
    throw new Error(
      `対象外コードの指定があるため STOP (正規 active-equity 集合外): ${outside.slice(0, 10).join(",")}`
    );
  }
}

// 引数 --key=value を読む簡易パーサ
export function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}
