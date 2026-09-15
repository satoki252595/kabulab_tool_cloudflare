import { describe, expect, it } from "vitest";
import * as zClassic from "zod";
import { z } from "./zod-mini.js";

/**
 * L-59: zod/mini の共有入口は classic と同一の検証メッセージを出す。
 *
 * mini は既定で汎用メッセージ ("Invalid input") しか出さない。フォームの
 * 再表示が `issues[0].message` を出すため、en ロケール設定を外すと文言が
 * 退化する。このテストが classic との一致を固定する。
 */

describe("zod-mini の classic 互換メッセージ", () => {
  it("数値の範囲・整数チェックが classic と同文", () => {
    const mini = z.coerce.number().check(z.int(), z.minimum(3));
    const classic = zClassic.coerce.number().int().min(3);
    for (const input of ["2", "2.5", "abc"]) {
      const m = mini.safeParse(input);
      const c = classic.safeParse(input);
      expect(m.success).toBe(c.success);
      if (!m.success && !c.success) {
        expect(m.error.issues[0].message).toBe(c.error.issues[0].message);
        expect(m.error.issues[0].code).toBe(c.error.issues[0].code);
      }
    }
  });

  it("カスタムメッセージはそのまま通る", () => {
    const schema = z.coerce
      .number({ error: "数値で入力してください" })
      .check(z.positive("正の数で入力してください"));
    expect(schema.safeParse("abc").error?.issues[0].message).toBe(
      "数値で入力してください"
    );
    expect(schema.safeParse("-1").error?.issues[0].message).toBe(
      "正の数で入力してください"
    );
  });

  it("preprocess 置換形 (pipe + transform) が classic と同値", () => {
    const mini = z.pipe(
      z.transform<unknown, unknown>((v) =>
        v === "" || v === undefined ? undefined : v
      ),
      z.optional(z.coerce.number())
    );
    const classic = zClassic.preprocess(
      (v) => (v === "" || v === undefined ? undefined : v),
      zClassic.coerce.number().optional()
    );
    for (const input of ["", undefined, "5", "abc"]) {
      const m = mini.safeParse(input);
      const c = classic.safeParse(input);
      expect(m.success).toBe(c.success);
      if (m.success && c.success) {
        expect(m.data).toBe(c.data);
      }
    }
  });
});
