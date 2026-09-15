/**
 * 証券コードの zod スキーマ (route param / フォーム / クエリ共通)。
 *
 * 正準パターン・正規化は `stock-code.ts` を唯一の source of truth とし、
 * ここでは zod へのアダプタのみを提供する。各サービスは個別に
 * `z.string().regex(/^\d{4}$/)` を書かず、本スキーマを import して使う。
 */
import { z } from "../zod-mini.js";
import {
  STOCK_CODE_REGEX,
  STOCK_CODE_ERROR,
  normalizeStockCode,
} from "./stock-code.js";

/**
 * 必須の証券コード。入力を正規化 (trim / 全角半角 / 大文字化) してから
 * 正準パターンで検証する。route param `:code` や必須フォーム項目に使う。
 *
 * 出力は正準形 (大文字・半角) の string。検証失敗時は
 * {@link STOCK_CODE_ERROR} を message に持つ ZodError を投げる。
 */
export const stockCodeSchema = z.pipe(
  z.pipe(
    z.string(),
    z.transform<string, string>((v) => normalizeStockCode(v))
  ),
  z.string().check(z.regex(STOCK_CODE_REGEX, STOCK_CODE_ERROR))
);

/**
 * 任意の証券コード (プリフィル用クエリ `?code=...` 等)。
 *
 * HTML form の標準挙動で未入力は空文字列 `""` が送られるため、空文字列・
 * 空白のみ・未指定は `undefined` に正規化する (ルール: `z.coerce` 単独だと
 * `""` が誤変換される事故を避ける)。非空の値は {@link stockCodeSchema} で
 * 正規化+検証し、不正なら throw する (黙って捨てない)。
 */
export const optionalStockCodeSchema = z.pipe(
  z.transform<unknown, unknown>((v) =>
    typeof v === "string" && v.trim() === "" ? undefined : v
  ),
  z.optional(stockCodeSchema)
);
