/**
 * Notion rich_text 分割・結合ユーティリティのテスト。
 */
import { describe, expect, it } from "vitest";
import { RICH_TEXT_MAX, joinRichText, splitRichText } from "./rich-text.js";

describe("rich-text", () => {
  describe("splitRichText", () => {
    it("空文字列は空配列", () => {
      expect(splitRichText("")).toEqual([]);
    });

    it("上限以下は 1 要素", () => {
      const got = splitRichText("こんにちは");
      expect(got).toEqual([{ type: "text", text: { content: "こんにちは" } }]);
    });

    it("上限超は分割し、結合すると原文に戻る (欠落しない)", () => {
      const text = "あ".repeat(2001) + "い".repeat(2000);
      const got = splitRichText(text);
      expect(got).toHaveLength(3);
      expect(got.map((c) => c.text.content).join("")).toBe(text);
      for (const c of got) {
        expect([...c.text.content].length).toBeLessThanOrEqual(RICH_TEXT_MAX);
      }
    });

    it("サロゲートペアを割らない", () => {
      // U+1F600 (😀) はサロゲートペア (2 UTF-16 単位)。
      const emoji = "\u{1F600}";
      const text = "x".repeat(1999) + emoji + "y".repeat(10);
      const got = splitRichText(text, 2000);
      // 2000 文字目で切ると上位サロゲートで終わってしまうため 1999 文字目までで
      // 切り、絵文字は次のチャンクへ丸ごと入る。
      expect(got[0]?.text.content).toBe("x".repeat(1999));
      expect(got[1]?.text.content.startsWith(emoji)).toBe(true);
      expect(got.map((c) => c.text.content).join("")).toBe(text);
      // どのチャンクも不正な単独サロゲートで終わらない
      for (const c of got) {
        const last = c.text.content.charCodeAt(c.text.content.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    });

    it("max を指定できる", () => {
      const got = splitRichText("abcdef", 2);
      expect(got.map((c) => c.text.content)).toEqual(["ab", "cd", "ef"]);
    });

    it("max が 0 以下・非整数なら throw", () => {
      expect(() => splitRichText("a", 0)).toThrow();
      expect(() => splitRichText("a", 1.5)).toThrow();
    });
  });

  describe("joinRichText", () => {
    it("undefined は空文字列", () => {
      expect(joinRichText(undefined)).toBe("");
    });

    it("plain_text を優先して結合する", () => {
      const got = joinRichText([
        { plain_text: "前半", text: { content: "無視" } },
        { plain_text: "後半" },
      ]);
      expect(got).toBe("前半後半");
    });

    it("plain_text が無ければ text.content を使う", () => {
      const got = joinRichText([{ text: { content: "本文" } }]);
      expect(got).toBe("本文");
    });
  });
});
