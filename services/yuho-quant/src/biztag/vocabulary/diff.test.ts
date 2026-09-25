/**
 * diffVocabularies / changeStats のテスト。
 *
 * 年次見直しの関門 (§6.3-4「変更量」) が使う「変わった語の一覧」「系統別の
 * 廃止率」を、実データ抜粋 (`MINI_VOCAB`) の from→to で検証する。
 */
import { describe, expect, it } from "vitest";
import { MINI_VOCAB } from "./__fixtures__/mini-vocab.js";
import type { Vocabulary } from "./schema.js";
import { changeStats, diffVocabularies } from "./diff.js";

describe("diffVocabularies", () => {
  it("全く同じ単語帳なら差分は全て空", () => {
    const to = structuredClone(MINI_VOCAB);
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff).toEqual({
      added: [],
      deprecated: [],
      changed: [],
      renamed: [],
      changedTermIds: [],
    });
  });

  it("to にだけある id は added", () => {
    const to = structuredClone(MINI_VOCAB);
    const template = to.business[0];
    to.business.push({
      ...structuredClone(template),
      id: "B.SEMI.NEW_TERM",
      labelJa: "新しい語",
      addedIn: "v2",
    });
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.added).toEqual(["B.SEMI.NEW_TERM"]);
    expect(diff.changed).toEqual([]);
  });

  it("非廃止→廃止は deprecated", () => {
    const to = structuredClone(MINI_VOCAB);
    const id = to.business[0].id;
    to.business[0].deprecated = true;
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.deprecated).toContain(id);
    // deprecated フィールド自体が変わっているので changed にも入る
    expect(diff.changed).toContain(id);
  });

  it("from にあって to から消えた語 (id 使い回し禁止の想定外) も deprecated 扱いにする", () => {
    const to = structuredClone(MINI_VOCAB);
    const id = to.business[0].id;
    to.business = to.business.filter((t) => t.id !== id);
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.deprecated).toContain(id);
  });

  it("labelJa 以外のフィールドが変わると changed のみ (renamed には入らない)", () => {
    const to = structuredClone(MINI_VOCAB);
    const id = to.business[0].id;
    to.business[0].definitionJa = to.business[0].definitionJa + "(改訂)";
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.changed).toContain(id);
    expect(diff.renamed).not.toContain(id);
  });

  it("labelJa が変わると changed かつ renamed", () => {
    const to = structuredClone(MINI_VOCAB);
    const id = to.business[0].id;
    to.business[0].labelJa = to.business[0].labelJa + "改";
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.changed).toContain(id);
    expect(diff.renamed).toContain(id);
  });

  it("addedIn だけの変更は changed に数えない", () => {
    const to = structuredClone(MINI_VOCAB);
    const id = to.business[0].id;
    to.business[0].addedIn = "v2";
    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.changed).not.toContain(id);
    expect(diff.changedTermIds).not.toContain(id);
  });

  it("changedTermIds は added ∪ deprecated ∪ changed の昇順ソート", () => {
    const to = structuredClone(MINI_VOCAB);
    const addedId = "B.SEMI.NEW_TERM";
    to.business.push({
      ...structuredClone(to.business[0]),
      id: addedId,
      labelJa: "新しい語",
    });
    const deprecatedId = to.business.find((t) => t.id === "B.DEF.SMALL_ARMS")?.id;
    if (!deprecatedId) throw new Error("fixture に B.DEF.SMALL_ARMS が無い");
    const target = to.business.find((t) => t.id === deprecatedId);
    if (!target) throw new Error("unreachable");
    target.deprecated = true;
    const renamedId = "B.SEMI.SILICON_WAFER";
    const renamedTerm = to.business.find((t) => t.id === renamedId);
    if (!renamedTerm) throw new Error("fixture に B.SEMI.SILICON_WAFER が無い");
    renamedTerm.labelJa = renamedTerm.labelJa + "改";

    const diff = diffVocabularies(MINI_VOCAB, to);
    expect(diff.changedTermIds).toEqual(
      [addedId, deprecatedId, renamedId].sort()
    );
  });
});

describe("changeStats", () => {
  function activeCount(v: Vocabulary): number {
    return (
      v.business.filter((t) => !t.deprecated).length +
      v.themes.filter((t) => !t.deprecated).length
    );
  }

  it("changedRatio = changedTermIds.length / from の非廃止語数", () => {
    const to = structuredClone(MINI_VOCAB);
    const renamedTerm = to.business.find((t) => t.id === "B.SEMI.SILICON_WAFER");
    if (!renamedTerm) throw new Error("fixture に B.SEMI.SILICON_WAFER が無い");
    renamedTerm.labelJa = renamedTerm.labelJa + "改";
    const diff = diffVocabularies(MINI_VOCAB, to);
    const stats = changeStats(MINI_VOCAB, diff);
    expect(stats.changedRatio).toBeCloseTo(1 / activeCount(MINI_VOCAB));
  });

  it("deprecatedRatioByFamily は「その系統で廃止した件数 / from の非廃止 business 総数」", () => {
    const to = structuredClone(MINI_VOCAB);
    // MACH は 2 語 (MACHINE_TOOL, INDUSTRIAL_ROBOT) を含む fixture。両方廃止する。
    for (const id of ["B.MACH.MACHINE_TOOL", "B.MACH.INDUSTRIAL_ROBOT"]) {
      const t = to.business.find((x) => x.id === id);
      if (!t) throw new Error(`fixture に ${id} が無い`);
      t.deprecated = true;
    }
    const diff = diffVocabularies(MINI_VOCAB, to);
    const stats = changeStats(MINI_VOCAB, diff);
    const activeBusinessTotal = MINI_VOCAB.business.filter((t) => !t.deprecated).length;
    expect(stats.deprecatedRatioByFamily).toEqual({
      MACH: 2 / activeBusinessTotal,
    });
  });

  it("廃止が無い系統はキーを作らない", () => {
    const to = structuredClone(MINI_VOCAB);
    const diff = diffVocabularies(MINI_VOCAB, to);
    const stats = changeStats(MINI_VOCAB, diff);
    expect(stats.deprecatedRatioByFamily).toEqual({});
  });

  it("from に非廃止語が 1 件も無いと throw する", () => {
    const from = structuredClone(MINI_VOCAB);
    for (const t of from.business) t.deprecated = true;
    for (const t of from.themes) t.deprecated = true;
    const diff = diffVocabularies(from, from);
    expect(() => changeStats(from, diff)).toThrow();
  });
});
