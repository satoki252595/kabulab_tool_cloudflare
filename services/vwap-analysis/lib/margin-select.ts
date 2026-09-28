// 信用残週スナップショット行の選択・重複検査 (純関数のみ・依存なし)。
// services/vwap-analysis/app.ts (Workers 公開 API) と scripts/vwap/ingest-margin.ts
// (Node 取込) の両方から使う。lib/margin.ts は unpdf を import するため Worker から
// 直接 import せず、この軽量モジュールに分離する (型のみ margin.ts から借りる)。
import type { MarginRow } from "./margin.js";

export type MarginRowSelection =
  | { status: "ok"; row: MarginRow }
  | { status: "missing" }
  | { status: "ambiguous"; count: number };

/**
 * 週スナップショットの行から指定銘柄の行を選ぶ純関数。
 *
 * 同一コードが 2 行以上ある週 (旧取込が種類株を 4 桁へ潰した崩壊:
 * 2026-06-12〜09-04 の 11 週で 2593/5076/7550/9201/9202/9434 に発生。JSON だけでは
 * 普通株・種類株を区別できず、ISIN は PDF 原本にしか無い) は、先頭行を黙って返すと
 * 誤った値を正常として使う。そのため status で明示し、呼び出し側に判断を委ねる
 * (ルール2)。正常な週・銘柄の振る舞いは変えない (1 行だけなら ok)。
 */
export function selectMarginRows(
  rows: readonly MarginRow[],
  code: string
): MarginRowSelection {
  const hits = rows.filter((r) => r.code === code);
  if (hits.length === 0) return { status: "missing" };
  if (hits.length === 1) return { status: "ok", row: hits[0] as MarginRow };
  return { status: "ambiguous", count: hits.length };
}

/**
 * 保存前の重複検査 (純関数)。同一コードの 2 行以上は種類株崩壊の取込であり、
 * 保存すると利用側が区別できなくなる。validateMarginData から呼ぶ。
 * 正常な取込 (全コード distinct) の振る舞いは変えない。
 */
export function assertDistinctMarginCodes(rows: readonly MarginRow[]): void {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.code)) dups.add(r.code);
    seen.add(r.code);
  }
  if (dups.size > 0) {
    throw new Error(
      `margin duplicate code: 同一コードの複数行があります (種類株崩壊の取込。保存不可): ${[...dups].sort().join(", ")}`
    );
  }
}
