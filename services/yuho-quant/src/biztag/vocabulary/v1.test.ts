/**
 * 単語帳 v1 (運営承認 2026-09-25。承認後、依頼文の例に対応する 2 語
 * 「半導体パッケージ・基板材料」「防衛装備品（防衛関連機器）」の追加と、原子力・核酸医薬の
 * 定義の明確化を加えた — ゴールデンセットで見つかった抜け) の固定テスト。
 *
 * v1.json はコードで版管理する初期データで、台帳へ投入した後は台帳が正本になる
 * (docs/005-yuho-quant-business-tags.md §3.2)。v1.json を手で書き換えると、
 * 投入済みの台帳の「版 v1」とハッシュが食い違い、巻き戻し先の内容も変わってしまう。
 * 変更は年次見直しの提案か新しい版で行うこと。ここでハッシュを固定して気付けるようにする。
 */
import { readFileSync } from "node:fs";
import { parseVocabulary } from "./load.js";
import { vocabularyHash } from "./hash.js";
import { validateVocabulary } from "./validate.js";
import { NOTION_OPTIONS_PER_COLUMN_MAX } from "./schema.js";

const V1_HASH = "98753679b4b0b740306efd53dbbdef59f434f243ded66d2170ec4dc3cfde81a8";

function loadV1() {
  return parseVocabulary(JSON.parse(readFileSync(new URL("./v1.json", import.meta.url), "utf-8")));
}

describe("単語帳 v1", () => {
  it("形・意味の検査を通る", () => {
    expect(validateVocabulary(loadV1())).toEqual([]);
  });

  it("版名は v1・全語 addedIn=v1・廃止なし", () => {
    const v = loadV1();
    expect(v.version).toBe("v1");
    for (const t of [...v.business, ...v.themes]) {
      expect(t.addedIn).toBe("v1");
      expect(t.deprecated).toBe(false);
    }
  });

  it("Notion の列ごとに上限の内側 (各列 96 語・余裕 4 語)", () => {
    const v = loadV1();
    const up = v.business.filter((t) => t.notionColumn === "upstream").length;
    const down = v.business.filter((t) => t.notionColumn === "downstream").length;
    expect(up).toBe(96);
    expect(down).toBe(96);
    expect(v.themes.length).toBeLessThanOrEqual(NOTION_OPTIONS_PER_COLUMN_MAX);
  });

  it("出典はすべて政府機関 (go.jp) の資料", () => {
    const v = loadV1();
    for (const t of [...v.business, ...v.themes]) {
      for (const s of t.sources) {
        expect(new URL(s.url).hostname.endsWith(".go.jp")).toBe(true);
      }
    }
  });

  it("内容のハッシュが承認時のまま (手で書き換えていない)", async () => {
    expect(await vocabularyHash(loadV1())).toBe(V1_HASH);
  });
});
