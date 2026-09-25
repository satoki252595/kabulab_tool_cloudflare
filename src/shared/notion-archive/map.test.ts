/**
 * 索引ページ配置定義のテスト (純粋関数のみ。fetch 不使用)。
 *
 * 固定したい契約:
 *   - 5 サービスの一次データ DB が全て載る (落とすと索引が嘘になる)
 *   - Notion 1 要求上限の内側 (100 ブロック / rich_text 2000 文字)
 *   - 区切りは全角｜(U+FF5C)
 */
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SECTIONS,
  INDEX_PAGE_TITLE,
  buildIndexBlocks,
} from "./map.js";

interface BuiltBlock {
  type: string;
  paragraph?: { rich_text: Array<{ text: { content: string } }> };
  heading_2?: { rich_text: Array<{ text: { content: string } }> };
  bulleted_list_item?: {
    rich_text: Array<{ text: { content: string }; annotations: { bold: boolean } }>;
  };
}

describe("notion-archive map", () => {
  it("索引タイトルは固定", () => {
    expect(INDEX_PAGE_TITLE).toBe("アーカイブ索引");
  });

  it("5 サービスの一次データ DB が全て載る", () => {
    const titles = ARCHIVE_SECTIONS.flatMap((s) => s.bullets.map((b) => b.title));
    for (const service of [
      "yuho-quant",
      "ir-catalog",
      "otakara-yutai",
      "vwap-analysis",
      "universe",
    ]) {
      expect(titles).toContain(`一次データ｜${service}`);
    }
  });

  it("銘柄別・ごみ・運用メモの節がある", () => {
    const titles = ARCHIVE_SECTIONS.flatMap((s) => s.bullets.map((b) => b.title));
    expect(titles).toContain("銘柄一覧｜ir-catalog (DB)");
    expect(titles).toContain("有報テキスト (単一 DB)");
    expect(titles).toContain("ごみ｜<service> (DB)");
  });

  it("タイトルの区切りは全角｜(U+FF5C) のみ", () => {
    const titles = ARCHIVE_SECTIONS.flatMap((s) => s.bullets.map((b) => b.title));
    expect(titles.join("")).toContain("｜");
    for (const t of titles) {
      expect(t).not.toContain("|");
    }
  });

  it("ブロック列: 冒頭パラグラフ + 見出しと箇条書き", () => {
    const blocks = buildIndexBlocks("2026-09-24T00:00:00.000Z") as BuiltBlock[];
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[0]?.paragraph?.rich_text[0]?.text.content).toContain(
      "2026-09-24T00:00:00.000Z"
    );
    const types = blocks.map((b) => b.type);
    expect(types).toContain("heading_2");
    expect(types).toContain("bulleted_list_item");
    const bullet = blocks.find((b) => b.type === "bulleted_list_item")
      ?.bulleted_list_item?.rich_text;
    expect(bullet?.[0]?.annotations.bold).toBe(true);
    expect(bullet?.[0]?.text.content).toContain("一次データ｜yuho-quant");
  });

  it("Notion 1 要求上限の内側に収まる", () => {
    const blocks = buildIndexBlocks("2026-09-24T00:00:00.000Z") as BuiltBlock[];
    expect(blocks.length).toBeLessThan(100);
    for (const b of blocks) {
      const texts =
        b.paragraph?.rich_text ??
        b.heading_2?.rich_text ??
        b.bulleted_list_item?.rich_text ??
        [];
      for (const t of texts) {
        expect([...t.text.content].length).toBeLessThan(2000);
      }
    }
  });
});
