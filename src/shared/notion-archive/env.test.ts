/**
 * `notionEnv.NOTION_MONEYFLOW_PAGE_ID()` のガード動作のテスト (2026-09-27 新規)。
 *
 * 「資金フロー（個人用）」ページ ID が既存ページ (`NOTION_ARCHIVE_PAGE_ID` /
 * `NOTION_STOCK_INFO_PAGE_ID`) と誤って同じ値に設定された場合に、黙って
 * 動くのではなく起動時 (初回参照時) に throw することを確認する
 * (CLAUDE.md ルール2)。ID はハイフン有無を正規化してから比較する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ARCHIVE_PAGE = "a".repeat(32);
const STOCK_INFO_PAGE = "b".repeat(32);
const MONEYFLOW_PAGE = "c".repeat(32);

describe("notionEnv.NOTION_MONEYFLOW_PAGE_ID", () => {
  const ORIG_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NOTION_ARCHIVE_PAGE_ID = ARCHIVE_PAGE;
    process.env.NOTION_STOCK_INFO_PAGE_ID = STOCK_INFO_PAGE;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  const load = () => import("./env.js");

  it("既存ページ (アーカイブ/株式情報) と異なる ID なら正規化 (ハイフン除去) して返す", async () => {
    const hyphenated = `${MONEYFLOW_PAGE.slice(0, 8)}-${MONEYFLOW_PAGE.slice(8, 12)}-${MONEYFLOW_PAGE.slice(12, 16)}-${MONEYFLOW_PAGE.slice(16, 20)}-${MONEYFLOW_PAGE.slice(20)}`;
    process.env.NOTION_MONEYFLOW_PAGE_ID = hyphenated;
    const { notionEnv } = await load();
    expect(notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toBe(MONEYFLOW_PAGE);
  });

  it("ハイフン付きでも正規化して比較する (見た目が違うだけの同一 ID を見逃さない)", async () => {
    const hyphenated = `${ARCHIVE_PAGE.slice(0, 8)}-${ARCHIVE_PAGE.slice(8, 12)}-${ARCHIVE_PAGE.slice(12, 16)}-${ARCHIVE_PAGE.slice(16, 20)}-${ARCHIVE_PAGE.slice(20)}`;
    process.env.NOTION_MONEYFLOW_PAGE_ID = hyphenated;
    const { notionEnv, NotionConfigError } = await load();
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(NotionConfigError);
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(/NOTION_ARCHIVE_PAGE_ID/);
  });

  it("NOTION_ARCHIVE_PAGE_ID と同じ ID なら throw する (黙って動かさない)", async () => {
    process.env.NOTION_MONEYFLOW_PAGE_ID = ARCHIVE_PAGE;
    const { notionEnv, NotionConfigError } = await load();
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(NotionConfigError);
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(/NOTION_ARCHIVE_PAGE_ID/);
  });

  it("NOTION_STOCK_INFO_PAGE_ID と同じ ID なら throw する", async () => {
    process.env.NOTION_MONEYFLOW_PAGE_ID = STOCK_INFO_PAGE;
    const { notionEnv, NotionConfigError } = await load();
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(NotionConfigError);
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(/NOTION_STOCK_INFO_PAGE_ID/);
  });

  it("未設定なら throw する (フォールバックしない)", async () => {
    delete process.env.NOTION_MONEYFLOW_PAGE_ID;
    const { notionEnv, NotionConfigError } = await load();
    expect(() => notionEnv.NOTION_MONEYFLOW_PAGE_ID()).toThrow(NotionConfigError);
  });
});
