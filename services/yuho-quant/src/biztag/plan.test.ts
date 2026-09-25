/**
 * plan.ts の網羅テスト。設計 docs/005-yuho-quant-business-tags.md §5.2 の
 * 状態遷移表の行ごとに 1 シナリオを用意する。
 */
import { describe, expect, it } from "vitest";
import type { SupplementRow } from "../../../../src/shared/notion-archive/index.js";
import { MAX_RETRY_ATTEMPTS, planWork } from "./plan.js";
import { PREFILTER_SECTIONS, PREFILTER_SECTION_TITLE } from "./prefilter.js";
import type { LatestDoc } from "./source.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";
import type { VocabDiff } from "./vocabulary/diff.js";

/**
 * 版の影響判定 (`isImpacted`→`sectionsFromRow`) は、絞り込み対象節の本文列
 * (`PREFILTER_SECTIONS` 全て) が `row.texts` に読み込まれている前提で動く
 * (未読み込みの列があれば throw する — 黙って「影響なし」にしない)。
 * この網羅テストでは本文の中身そのものは検査対象ではない (既存タグ・変更語
 * 集合の突き合わせだけを見る) ため、全列を「読み込み済みだが空」として渡す。
 */
function allTextColumnsLoadedEmpty(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PREFILTER_SECTIONS) out[PREFILTER_SECTION_TITLE[key]] = "";
  return out;
}

const TODAY = "2026-09-25";

function latestDocOf(overrides: Partial<NonNullable<LatestDoc["doc"]>> = {}): NonNullable<LatestDoc["doc"]> {
  return {
    docId: "S100AAAA",
    docTypeCode: "120",
    periodEnd: "2026-03-31",
    submittedAt: "2026-06-25T00:00:00.000Z",
    notionDocPageId: "notion-page-aaaa",
    textParseStatus: "ok",
    ...overrides,
  };
}

function latestOf(overrides: Partial<LatestDoc> = {}): LatestDoc {
  return {
    stockCode: "6103",
    companyName: "オークマ",
    sector33: "機械",
    doc: latestDocOf(),
    ...overrides,
  };
}

function rowOf(overrides: Partial<SupplementRow> = {}): SupplementRow {
  return {
    pageId: "page-1",
    stockCode: "6103",
    companyName: "オークマ",
    sector33: "機械",
    docId: null,
    docType: null,
    periodEnd: null,
    submittedAt: null,
    textStatus: null,
    tagStatus: null,
    tagDoc: null,
    vocabVersion: null,
    judgedAt: null,
    candidateCount: null,
    attempts: null,
    nextRetryAt: null,
    error: null,
    upstream: [],
    downstream: [],
    distribution: [],
    themes: [],
    uncertain: null,
    evidenceText: null,
    masterLinked: true,
    texts: allTextColumnsLoadedEmpty(),
    ...overrides,
  };
}

const noDiff: (rowVersion: string) => VocabDiff = () => {
  throw new Error("vocabDiffFromRowVersion は呼ばれない想定のテストで呼ばれた");
};

function planSingle(
  latest: LatestDoc,
  row: SupplementRow | null,
  opts: { vocabDiff?: (rowVersion: string) => VocabDiff; today?: string } = {}
) {
  const items = planWork([latest], row ? [row] : [], MINI_VOCAB, opts.vocabDiff ?? noDiff, opts.today ?? TODAY);
  expect(items).toHaveLength(1);
  return items[0];
}

describe("planWork (§5.2 状態遷移表)", () => {
  it("行が無い・最新有報も無い → create_row", () => {
    const item = planSingle(latestOf({ doc: null }), null);
    expect(item.kind).toBe("create_row");
  });

  it("行が無い・最新有報の本文が読める → sync_and_tag (作成しつつ同期)", () => {
    const item = planSingle(latestOf(), null);
    expect(item.kind).toBe("sync_and_tag");
  });

  it("最新有報なし (既存行あり) → no_text", () => {
    const row = rowOf({ docId: "S100OLD", textStatus: "取得済", tagStatus: "判定済" });
    const item = planSingle(latestOf({ doc: null }), row);
    expect(item.kind).toBe("no_text");
  });

  it("最新有報あるが本文抽出失敗 (notion_doc_page_id が NULL) → no_text (古い書類へ戻らない)", () => {
    const row = rowOf({ docId: "S100OLD", textStatus: "取得済", tagStatus: "判定済" });
    const item = planSingle(
      latestOf({ doc: latestDocOf({ notionDocPageId: null, textParseStatus: "no_text_sections" }) }),
      row
    );
    expect(item.kind).toBe("no_text");
  });

  it("最新有報なし・既に本文なし状態 → skip (無用な書込を避ける)", () => {
    const row = rowOf({ docId: null, textStatus: "本文なし", tagStatus: "本文なし" });
    const item = planSingle(latestOf({ doc: null }), row);
    expect(item.kind).toBe("skip");
  });

  it("有報書類ID ≠ 最新 → sync_and_tag", () => {
    const row = rowOf({
      docId: "S100OLD",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: "v1",
    });
    const item = planSingle(latestOf({ doc: latestDocOf({ docId: "S100NEW" }) }), row);
    expect(item.kind).toBe("sync_and_tag");
  });

  it("同じ書類・判定済・同じ版 → skip", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: MINI_VOCAB.version,
    });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("skip");
  });

  it("同じ書類・判定済・版が違う・影響あり → retag", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: "v0",
      upstream: ["シリコンウエハ"],
    });
    const diff: VocabDiff = {
      added: [],
      deprecated: [],
      changed: ["B.SEMI.SILICON_WAFER"],
      renamed: [],
      changedTermIds: ["B.SEMI.SILICON_WAFER"],
    };
    const item = planSingle(latestOf(), row, { vocabDiff: () => diff });
    expect(item.kind).toBe("retag");
  });

  it("同じ書類・判定済・版が違う・影響なし → version_bump", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: "v0",
      upstream: ["シリコンウエハ"],
    });
    const diff: VocabDiff = {
      added: [],
      deprecated: [],
      changed: ["B.MACH.MACHINE_TOOL"],
      renamed: [],
      changedTermIds: ["B.MACH.MACHINE_TOOL"],
    };
    const item = planSingle(latestOf(), row, { vocabDiff: () => diff });
    expect(item.kind).toBe("version_bump");
  });

  it("distribution 列(第3列)のラベルも影響判定の対象になる (今の単語帳に無ければ retag)", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: "v0",
      distribution: ["もう存在しない流通ラベル"],
    });
    const diff: VocabDiff = {
      added: [],
      deprecated: ["B.SOME.GONE_DISTRIBUTION"],
      changed: [],
      renamed: [],
      changedTermIds: ["B.SOME.GONE_DISTRIBUTION"],
    };
    const item = planSingle(latestOf(), row, { vocabDiff: () => diff });
    expect(item.kind).toBe("retag");
  });

  it("同じ書類・判定済・版が違う・今の単語帳に無いラベル (廃止/改名) → 影響ありとして retag", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定済",
      vocabVersion: "v0",
      upstream: ["もう存在しないラベル"],
    });
    const diff: VocabDiff = {
      added: [],
      deprecated: ["B.SOME.GONE"],
      changed: [],
      renamed: [],
      changedTermIds: ["B.SOME.GONE"],
    };
    const item = planSingle(latestOf(), row, { vocabDiff: () => diff });
    expect(item.kind).toBe("retag");
  });

  it("判定不能・再試行期日が到来・回数<上限 → retry", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "取得済",
      tagStatus: "判定不能",
      attempts: 1,
      nextRetryAt: "2026-09-24",
    });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("retry");
  });

  it("読込失敗・再試行期日が到来・回数<上限 → retry", () => {
    const row = rowOf({
      docId: "S100AAAA",
      textStatus: "読込失敗",
      tagStatus: "読込失敗",
      attempts: 2,
      nextRetryAt: TODAY,
    });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("retry");
  });

  it("判定不能・再試行期日が未到来 → skip (再試行上限フラグは立てない)", () => {
    const row = rowOf({
      docId: "S100AAAA",
      tagStatus: "判定不能",
      attempts: 1,
      nextRetryAt: "2026-09-26",
    });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("skip");
    // 「再試行期日が来ていないだけ」の skip と、下の「上限到達」の skip は
    // 運営への通知 (docs §11.6) で区別する必要があるため、ここでは立たない。
    expect(item.retryExhausted).toBeUndefined();
  });

  it("再試行回数が上限に到達 → skip (触らない・再試行上限フラグを立てる)", () => {
    const row = rowOf({
      docId: "S100AAAA",
      tagStatus: "判定不能",
      attempts: MAX_RETRY_ATTEMPTS,
      nextRetryAt: "2026-01-01",
    });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("skip");
    expect(item.reason).toContain("上限");
    // 運営への通知 (docs §11.6「再試行上限（5回）に達したまま残っている銘柄」)
    // に使う専用フラグ。
    expect(item.retryExhausted).toBe(true);
  });

  it("同じ書類だが未判定 (部分失敗からの回復) → sync_and_tag", () => {
    const row = rowOf({ docId: "S100AAAA", tagStatus: "未判定" });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("sync_and_tag");
  });

  it("判定済なのに単語帳の版が記録されていなければ throw (不変条件違反)", () => {
    const row = rowOf({ docId: "S100AAAA", tagStatus: "判定済", vocabVersion: null });
    expect(() => planWork([latestOf()], [row], MINI_VOCAB, noDiff, TODAY)).toThrow();
  });

  it("latest の並び順どおりに WorkItem を返す", () => {
    const a = latestOf({ stockCode: "1111", doc: null });
    const b = latestOf({ stockCode: "2222", doc: null });
    const items = planWork([a, b], [], MINI_VOCAB, noDiff, TODAY);
    expect(items.map((i) => i.stockCode)).toEqual(["1111", "2222"]);
  });
});
