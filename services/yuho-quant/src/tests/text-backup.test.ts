/**
 * 有報テキスト Notion 保管ヘルパーのテスト。
 *
 * notion-archive 層はモックし (実体は P1 の stock-text.test.ts が保証)、
 * ここでは 3 書込経路の共通分岐 (空スキップ・引数写像・force 透過・
 * エラー伝播) を固定する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureStockTextDb,
  upsertStockTextRow,
} from "../../../../src/shared/notion-archive/index.js";
import { backupDocTextToNotion } from "../services/text-backup.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  ensureStockTextDb: vi.fn(),
  upsertStockTextRow: vi.fn(),
}));

const doc = {
  stockCode: "7203",
  docId: "S100TEST",
  d1DocumentId: 42,
  fiscalYearEnd: "2026-03-31",
  textParseStatus: "ok",
};
const sections = [
  { itemName: "事業の内容", sectionKey: "business", text: "本文A" },
];

describe("text-backup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("空セクションは Notion を呼ばず skipped_empty", async () => {
    const got = await backupDocTextToNotion({ ...doc, sections: [] });
    expect(got).toEqual({ rowPageId: null, outcome: "skipped_empty" });
    expect(ensureStockTextDb).not.toHaveBeenCalled();
    expect(upsertStockTextRow).not.toHaveBeenCalled();
  });

  it("DB 確保→行 upsert の順に呼び、行 ID を返す", async () => {
    vi.mocked(ensureStockTextDb).mockResolvedValue({
      dbId: "db-7203",
    });
    vi.mocked(upsertStockTextRow).mockResolvedValue({
      rowPageId: "row-new",
      outcome: "recorded",
    });
    const got = await backupDocTextToNotion({ ...doc, sections });
    expect(got).toEqual({ rowPageId: "row-new", outcome: "recorded" });
    expect(ensureStockTextDb).toHaveBeenCalledWith();
    expect(upsertStockTextRow).toHaveBeenCalledWith({
      dbId: "db-7203",
      doc,
      sections,
      force: undefined,
    });
  });

  it("force を透過する", async () => {
    vi.mocked(ensureStockTextDb).mockResolvedValue({
      dbId: "db-7203",
    });
    vi.mocked(upsertStockTextRow).mockResolvedValue({
      rowPageId: "row-new",
      outcome: "recorded",
    });
    await backupDocTextToNotion({ ...doc, sections, force: true });
    expect(upsertStockTextRow).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    );
  });

  it("失敗は throw する (呼び出し側で当該通だけ計上する)", async () => {
    vi.mocked(ensureStockTextDb).mockRejectedValue(new Error("429 boom"));
    await expect(backupDocTextToNotion({ ...doc, sections })).rejects.toThrow(
      "429 boom"
    );
  });
});
