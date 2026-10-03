/**
 * 有報テキスト Notion 保管ヘルパーのテスト。
 *
 * notion-archive 層はモックし (実体は P1 の stock-text.test.ts が保証)、
 * ここでは 3 書込経路の共通分岐と、新規/再利用とも全文・7プロパティの
 * 読み戻し前に D1 ポインタを返さない境界を固定する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureStockTextDb,
  readStockTextRow,
  upsertStockTextRow,
} from "../../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { backupDocTextToNotion, ExistingTextReadbackMismatchError } from "../services/text-backup.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  ensureStockTextDb: vi.fn(),
  readStockTextRow: vi.fn(),
  upsertStockTextRow: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/client.js", () => ({ notionRequest: vi.fn() }));

const dbId = "11111111-1111-1111-1111-111111111111";
const rowPageId = "22222222-2222-2222-2222-222222222222";

const doc = {
  stockCode: "7203",
  docId: "S100TEST",
  d1DocumentId: 42,
  fiscalYearEnd: "2026-03-31",
  textParseStatus: "ok",
};
const sections = [
  { itemName: "事業の内容", sectionKey: "business", text: "本文A\u200b𠮷" },
];

function fullPage() {
  const rich = (text: string) => [{ type: "text", plain_text: text, text: { content: text } }];
  return {
    object: "page", id: rowPageId, parent: { type: "database_id", database_id: dbId },
    archived: false, in_trash: false,
    properties: {
      文書: { type: "title", title: rich(doc.docId) },
      銘柄コード: { type: "rich_text", rich_text: rich(doc.stockCode) },
      D1文書ID: { type: "number", number: doc.d1DocumentId },
      会計期末: { type: "date", date: { start: doc.fiscalYearEnd, end: null, time_zone: null } },
      セクション件数: { type: "number", number: sections.length },
      文字数合計: { type: "number", number: [...sections[0]!.text].length },
      抽出状態: { type: "select", select: { name: doc.textParseStatus } },
    },
  };
}

describe("text-backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureStockTextDb).mockResolvedValue({ dbId });
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome: "recorded" });
    vi.mocked(notionRequest).mockResolvedValue(fullPage());
    vi.mocked(readStockTextRow).mockResolvedValue(structuredClone(sections));
  });

  it("空セクションは Notion を呼ばず skipped_empty", async () => {
    const got = await backupDocTextToNotion({ ...doc, sections: [] });
    expect(got).toEqual({ rowPageId: null, outcome: "skipped_empty" });
    expect(ensureStockTextDb).not.toHaveBeenCalled();
    expect(upsertStockTextRow).not.toHaveBeenCalled();
    expect(notionRequest).not.toHaveBeenCalled();
    expect(readStockTextRow).not.toHaveBeenCalled();
  });

  it("DB 確保→行 upsert の順に呼び、行 ID を返す", async () => {
    const got = await backupDocTextToNotion({ ...doc, sections });
    expect(got).toEqual({ rowPageId, outcome: "recorded" });
    expect(ensureStockTextDb).toHaveBeenCalledWith();
    expect(upsertStockTextRow).toHaveBeenCalledWith({
      dbId,
      doc,
      sections,
      force: undefined,
    });
    expect(notionRequest).toHaveBeenCalledWith("GET", `/pages/${rowPageId}`);
    expect(readStockTextRow).toHaveBeenCalledWith(rowPageId, true);
  });

  it("force を透過する", async () => {
    await backupDocTextToNotion({ ...doc, sections, force: true });
    expect(upsertStockTextRow).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );
  });

  it("既存行でも不可視文字が1字失われた本文は pointer を返さず、force 再送もしない", async () => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome: "skipped_existing" });
    vi.mocked(readStockTextRow).mockResolvedValue([
      { ...sections[0]!, text: sections[0]!.text.replace("\u200b", "") },
    ]);
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toBeInstanceOf(ExistingTextReadbackMismatchError);
    expect(upsertStockTextRow).toHaveBeenCalledTimes(1);
    expect(upsertStockTextRow).toHaveBeenCalledWith(expect.objectContaining({ force: undefined }));
  });

  it.each([
    { outcome: "recorded" as const, force: undefined },
    { outcome: "recorded" as const, force: true },
    { outcome: "skipped_existing" as const, force: true },
  ])("新規/forceの全文不一致は既存HOLDへ分類しない: %j", async ({ outcome, force }) => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome });
    vi.mocked(readStockTextRow).mockResolvedValue([{ ...sections[0]!, text: "不一致" }]);
    const error = await backupDocTextToNotion({ ...doc, sections, force }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExistingTextReadbackMismatchError);
  });

  it("既存行でもnative読取失敗/不正な3fieldは純全文HOLDへ分類しない", async () => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome: "skipped_existing" });
    const failure = new Error("native shape failure");
    vi.mocked(readStockTextRow).mockRejectedValueOnce(failure);
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toBe(failure);
    vi.mocked(readStockTextRow).mockResolvedValue([{ ...sections[0]!, text: null }] as never);
    const error = await backupDocTextToNotion({ ...doc, sections }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExistingTextReadbackMismatchError);
  });

  it("新規行の ACK 後も読み戻し完了まで pointer は返さない", async () => {
    let release!: (value: typeof sections) => void;
    vi.mocked(readStockTextRow).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    let returned = false;
    const pending = backupDocTextToNotion({ ...doc, sections }).then((result) => { returned = true; return result; });
    await vi.waitFor(() => expect(readStockTextRow).toHaveBeenCalledTimes(1));
    expect(returned).toBe(false);
    release(structuredClone(sections));
    await expect(pending).resolves.toEqual({ rowPageId, outcome: "recorded" });
  });

  it("再利用した既存行も所属/全文が同じ時だけ skipped_existing を返す", async () => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome: "skipped_existing" });
    await expect(backupDocTextToNotion({ ...doc, sections })).resolves.toEqual({ rowPageId, outcome: "skipped_existing" });
    expect(readStockTextRow).toHaveBeenCalledTimes(1);
  });

  it("不正 ACK ID は読取を送る前に停止する", async () => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId: "invalid", outcome: "recorded" });
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toThrow("読み戻し ID 型が不正");
    expect(notionRequest).not.toHaveBeenCalled();
    expect(readStockTextRow).not.toHaveBeenCalled();
  });

  it.each([
    ["文書", { type: "title", title: [{ type: "text", plain_text: "other", text: { content: "other" } }] }],
    ["銘柄コード", { type: "rich_text", rich_text: [{ type: "text", plain_text: "other", text: { content: "other" } }] }],
    ["D1文書ID", { type: "number", number: doc.d1DocumentId + 1 }],
    ["会計期末", { type: "date", date: { start: doc.fiscalYearEnd, end: doc.fiscalYearEnd, time_zone: null } }],
    ["セクション件数", { type: "number", number: sections.length + 1 }],
    ["文字数合計", { type: "number", number: sections[0]!.text.length }],
    ["抽出状態", { type: "select", select: { name: "parse_error" } }],
  ])("%s が異なる既存行から pointer を採用しない", async (name, value) => {
    vi.mocked(upsertStockTextRow).mockResolvedValue({ rowPageId, outcome: "skipped_existing" });
    const page = fullPage();
    vi.mocked(notionRequest).mockResolvedValue({ ...page, properties: { ...page.properties, [name]: value } });
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toThrow("読み戻し7プロパティが不一致");
    expect(readStockTextRow).not.toHaveBeenCalled();
  });

  it("別 DB の行/archived 行/不正 rich_text を採用しない", async () => {
    for (const page of [
      { ...fullPage(), parent: { type: "database_id", database_id: rowPageId } },
      { ...fullPage(), archived: true },
      { ...fullPage(), properties: { ...fullPage().properties,
        文書: { type: "title", title: [{ type: "text", plain_text: doc.docId, text: { content: "different" } }] } } },
    ]) {
      vi.mocked(notionRequest).mockResolvedValue(page);
      await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toThrow("有報テキストの読み戻し");
    }
    expect(readStockTextRow).not.toHaveBeenCalled();
  });

  it("失敗は throw する (呼び出し側で当該通だけ計上する)", async () => {
    vi.mocked(ensureStockTextDb).mockRejectedValue(new Error("429 boom"));
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toThrow(
      "429 boom"
    );
  });
});
