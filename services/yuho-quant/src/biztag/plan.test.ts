/**
 * 保存済みタグの再利用・不足補完・新規初回の境界テスト。
 * 設計 docs/005-yuho-quant-business-tags.md §5.2。
 */
import { describe, expect, it } from "vitest";
import type { SupplementRow } from "../../../../src/shared/notion-archive/index.js";
import { INITIAL_CLEF_INPUT_PREFIX, INITIAL_SEMIF_INPUT_PREFIX, INPUT_RECEIPT_PREFIX, MAX_RETRY_ATTEMPTS,
  planWork, readInputReceipt, readTextSyncReceipt, textVerificationCodes, withInputReceipt, withTextSyncReceipt } from "./plan.js";
import type { LatestDoc, NewStockEligibility } from "./source.js";

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
    judgeInput: null,
    upstream: [],
    downstream: [],
    distribution: [],
    themes: [],
    uncertain: null,
    evidenceText: null,
    masterLinked: true,
    texts: {},
    ...overrides,
  };
}

function planSingle(
  latest: LatestDoc,
  row: SupplementRow | null,
  opts: { today?: string; eligibility?: NewStockEligibility } = {}
) {
  const items = planWork([latest], row ? [row] : [], opts.today ?? TODAY, opts.eligibility);
  expect(items).toHaveLength(1);
  return items[0];
}

describe("planWork (保存タグを再利用し、不足だけ補完)", () => {
  it("空タグの再確認は明示scopeだけ、旧入力不明を入力変更と偽称しない", () => {
    const doc = latestDocOf({ docId: "S100YFQC" });
    const row = rowOf({ docId: doc.docId, tagDoc: `${doc.docId} 2026年3月期`, tagStatus: "判定済", vocabVersion: "v1" });
    expect(planWork([latestOf({ doc })], [row], TODAY)[0].kind).toBe("sync_text");
    expect(planWork([latestOf({ doc })], [row], TODAY, undefined, true)[0]).toMatchObject({ kind: "retag", emptyTagRepair: true });
    expect(planWork([latestOf({ doc })], [row], TODAY, undefined, true)[0].sourceChangedLocalJudge).toBeUndefined();
  });
  it.each([
    { upstream: ["工作機械"], evidenceText: "保存済み根拠" },
    { tagStatus: "本文なし" as const }, { companyName: "不同会社" }, { docId: "S100OLD", tagDoc: "S100OLD 2025年3月期" },
  ])("空タグ限定scopeの非適格行はmetadata/text等の別writerへ流さずHOLD (%j)", overrides => {
    const doc = latestDocOf({ docId: "S100YFQC" });
    const row = rowOf({ docId: doc.docId, tagDoc: `${doc.docId} 2026年3月期`, tagStatus: "判定済", vocabVersion: "v1", ...overrides });
    expect(planWork([latestOf({ doc })], [row], TODAY, undefined, true)[0]).toMatchObject({ kind: "skip", qualificationHeld: true });
  });
  it.each([
    ["625A", "（株）Skyfall", "Ｓｋｙｆａｌｌ"],
    ["621A", "（株）オーディオストック", "オーディオストック"],
    ["618A", "（株）KOMPEITO", "ＫＯＭＰＥＩＴＯ"],
    ["623A", "（株）ベルテックス", "ベルテックス"],
    ["627A", "akippa（株）", "ａｋｉｐｐａ"],
    ["619A", "（株）オリバー", "オリバー"],
  ])("実保存%sの表示差はmeta補完を妨げず、保存titleを保持", (stockCode, savedName, coreName) => {
    // 2026-10-18受入済thin metadataの表示名だけを投影。sectorの分類値は作らない。
    const row = rowOf({ stockCode, companyName: savedName, sector33: null, masterLinked: false });
    expect(planSingle(latestOf({ stockCode, companyName: coreName, sector33: null, doc: null }), row)).toMatchObject({
      kind: "sync_metadata", basicMetadataOnly: true, qualificationHeld: true, row: { companyName: savedName },
    });
    const doc = latestDocOf();
    const tagged = { ...row, docId: doc.docId, tagDoc: `${doc.docId} ${doc.periodEnd}`, tagStatus: "判定済" as const, vocabVersion: "v1",
      judgeInput: withTextSyncReceipt(null, { docId: doc.docId, textPageId: doc.notionDocPageId!, textsSha256: "e".repeat(64) }) };
    expect(planSingle(latestOf({ stockCode, companyName: coreName, sector33: null }), tagged).kind).toBe("sync_metadata");
  });
  it.each(["株式会社別会社", "Sky株式会社fall", "株式会社（株）Skyfall"])("別名/内部法人格/複数法人格を表示同値にしない (%s)", companyName => {
    const row = rowOf({ stockCode: "625A", companyName, sector33: null, masterLinked: false });
    expect(planSingle(latestOf({ stockCode: "625A", companyName: "Ｓｋｙｆａｌｌ", sector33: null, doc: null }), row)).toMatchObject({ kind: "skip", qualificationHeld: true });
  });
  it("通常は50以下の巡回窓、明示scopeは全件を選び、欠落メタだけでも再選定する", () => {
    const latest = Array.from({ length: 120 }, (_, i) => latestOf({ stockCode: String(1000 + i) }));
    expect(textVerificationCodes(latest, TODAY, false).size).toBe(50);
    expect(textVerificationCodes(latest, TODAY, false)).not.toEqual(textVerificationCodes(latest, "2026-09-26", false));
    expect(textVerificationCodes(latest, TODAY, true).size).toBe(120);
    const row = rowOf({ docId: "S100AAAA", tagDoc: "S100AAAA 2026年3月期", vocabVersion: "v1", tagStatus: "判定済", masterLinked: false,
      judgeInput: withTextSyncReceipt(null, { docId: "S100AAAA", textPageId: "notion-page-aaaa", textsSha256: "e".repeat(64) }) });
    expect(planSingle(latestOf(), row)).toMatchObject({ kind: "sync_metadata" });
    expect(planSingle(latestOf({ reportedHoldReason: "reported hold" }), row)).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(planSingle(latestOf(), { ...row, companyName: "異なる保存会社", judgeInput: null })).toMatchObject({ kind: "skip", qualificationHeld: true });
  });
  it("行も最新有報も無い場合は create_row/HOLD", () => {
    expect(planSingle(latestOf({ doc: null }), null)).toMatchObject({ kind: "create_row", qualificationHeld: true });
  });
  it("現activeの有報が無くても適格な基本メタ欠落は独立選定し、本文HOLDを保持", () => {
    const item = planSingle(latestOf({ doc: null }), rowOf({ sector33: null, masterLinked: false, textStatus: "本文なし", tagStatus: "本文なし" }));
    expect(item).toMatchObject({ kind: "sync_metadata", basicMetadataOnly: true, qualificationHeld: true, doc: null });
    expect(item.row?.docId).toBeNull();
    expect(planSingle(latestOf({ doc: null }), rowOf({ companyName: "相反する保存会社", sector33: null, masterLinked: false }))).toMatchObject({ kind: "skip", qualificationHeld: true });
  });

  it("行が無く本文が読める既存銘柄は機械補完", () => {
    expect(planSingle(latestOf(), null)).toMatchObject({ kind: "sync_and_tag", initialSemif: false });
  });

  it.each([
    null,
    latestDocOf({ notionDocPageId: null, textParseStatus: "no_text_sections" }),
    latestDocOf({ notionDocPageId: "" }),
  ])("本文資格が不足している場合は保存済み結果を保持して HOLD", (doc) => {
    const row = rowOf({ docId: "S100OLD", textStatus: "取得済", tagStatus: "判定済", upstream: ["シリコンウエハ"] });
    const item = planSingle(latestOf({ doc }), row);
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.row).toBe(row);
  });

  it.each([
    { docId: "S100AAAA", vocabVersion: "v1" },
    { upstream: ["シリコンウエハ"], evidenceText: "保存済みの根拠文" },
    { uncertain: "保存済み要確認", evidenceText: "保存済みの根拠文" },
    { distribution: ["保存済み流通タグ"], evidenceText: "保存済みの根拠文", texts: {} },
  ])("保存根拠が揃う判定済みなら新有報・語彙との差 %j でも code の保存結果を再利用", (override) => {
    const row = rowOf({ docId: "S100AAAA", tagDoc: "S100AAAA 2026年3月期", vocabVersion: "v0", tagStatus: "判定済", ...override });
    const item = planSingle(latestOf(), row);
    expect(item.kind).toBe("sync_text");
    expect(item.qualificationHeld).toBeUndefined();
    expect(item.initialSemif).not.toBe(true);
    expect(item.row).toBe(row);
    expect(item.reason).toContain("保持");
  });

  it("最新有報への更新は旧判定を新docへ流用せずSemIf専用の再判定にする", () => {
    const row = rowOf({ docId: "S100OLD", tagDoc: "S100OLD 2025年3月期", vocabVersion: "v0", tagStatus: "判定済" });
    expect(planSingle(latestOf(), row)).toMatchObject({ kind: "retag", sourceChangedLocalJudge: true, row });
  });

  it.each([
    { docId: null },
    { docId: "" },
    { tagDoc: null },
    { tagDoc: "" },
    { tagDoc: "S100OTHER 2026年3月期" },
    { vocabVersion: null },
    { vocabVersion: "" },
    { upstream: ["シリコンウエハ"], evidenceText: null },
    { downstream: ["保存済み下流タグ"], evidenceText: "" },
    { distribution: ["保存済み流通タグ"], evidenceText: " " },
    { uncertain: "保存済み要確認", evidenceText: null },
  ])("判定済みでも保存根拠の欠落・不整合 %j は上書きせず HOLD", (override) => {
    const row = rowOf({ docId: "S100OLD", tagDoc: "S100OLD 2025年3月期", vocabVersion: "v0", tagStatus: "判定済", ...override });
    const item = planSingle(latestOf(), row);
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.initialSemif).not.toBe(true);
    expect(item.row).toBe(row);
  });

  it.each([
    { tagDoc: "S100OLD" },
    { judgedAt: "2026-09-24" },
    { upstream: ["シリコンウエハ"] },
    { downstream: ["保存済み下流タグ"] },
    { distribution: ["保存済み流通タグ"] },
    { themes: ["保存済みテーマ"] },
    { uncertain: "保存済み要確認" },
    { evidenceText: "保存済みの根拠文" },
  ])("判定状態は未完でも保存済みの一部結果 %j があれば上書きせず HOLD", (override) => {
    const row = rowOf({ docId: "S100OLD", tagStatus: "判定不能", ...override });
    const item = planSingle(latestOf(), row);
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.row).toBe(row);
    expect(item.initialSemif).not.toBe(true);
  });

  it("未判定の書類IDが異なる場合だけ最新有報を同期して機械補完", () => {
    const item = planSingle(latestOf(), rowOf({ docId: "S100OLD", tagStatus: "未判定" }));
    expect(item.kind).toBe("sync_and_tag");
    expect(item.initialSemif).not.toBe(true);
  });

  it.each(["判定不能", "読込失敗"] as const)("既存の %s は旧期日・外部再試行上限に依存せず機械補完", (tagStatus) => {
    const item = planSingle(latestOf(), rowOf({
      docId: "S100AAAA", tagStatus, attempts: MAX_RETRY_ATTEMPTS, nextRetryAt: "2026-09-26",
    }));
    expect(item.kind).toBe("retry");
    expect(item.initialSemif).not.toBe(true);
    expect(item.retryExhausted).toBeUndefined();
  });

  it("同じ書類の未判定は機械補完", () => {
    const item = planSingle(latestOf(), rowOf({ docId: "S100AAAA", tagStatus: "未判定" }));
    expect(item.kind).toBe("sync_and_tag");
    expect(item.initialSemif).not.toBe(true);
  });

  it("latest の並び順を保持", () => {
    const latest = [latestOf({ stockCode: "1111", doc: null }), latestOf({ stockCode: "2222", doc: null })];
    expect(planWork(latest, [], TODAY).map((item) => item.stockCode)).toEqual(["1111", "2222"]);
  });
});

describe("新規上場の初回だけ SemIf を許可する計画", () => {
  const eligible: NewStockEligibility = { eligibleCodes: new Set(["6103"]), heldCodes: new Set() };
  const held: NewStockEligibility = { eligibleCodes: new Set(), heldCodes: new Set(["6103"]) };

  it("行なし/過去未判定だけでは新規とせず、資格引数なしは機械判定", () => {
    expect(planSingle(latestOf(), null).initialSemif).toBe(false);
    expect(planSingle(latestOf(), rowOf({ tagStatus: "未判定", attempts: 0 })).initialSemif).not.toBe(true);
  });

  it("資格が成立した上場の行なし/本文ありは初回 SemIf", () => {
    const item = planSingle(latestOf(), null, { eligibility: eligible });
    expect(item.kind).toBe("sync_and_tag");
    expect(item.initialSemif).toBe(true);
  });

  it("新規でも本文未取得は create_row/HOLD、外部判定0", () => {
    const item = planSingle(latestOf({ doc: null }), null, { eligibility: eligible });
    expect(item.kind).toBe("create_row");
    expect(item.initialSemif).not.toBe(true);
    expect(item.qualificationHeld).toBe(true);
  });

  it("本文なしで作成済みの新規行は、本文取得後に初回判定可能", () => {
    const item = planSingle(latestOf(), rowOf({ tagStatus: "本文なし", textStatus: "本文なし", attempts: 0 }), { eligibility: eligible });
    expect(item.initialSemif).toBe(true);
  });

  it.each([
    { tagDoc: "保存済みの根拠書類" },
    { judgedAt: "2026-09-24" },
    { upstream: ["シリコンウエハ"] },
    { uncertain: "保存済み要確認" },
    { evidenceText: "保存済みの根拠文だけ残った行" },
    { attempts: null },
    { judgeInput: undefined },
  ])("過去判定または初回証拠が不明な行 %j は新規課金しない", (override) => {
    const item = planSingle(latestOf(), rowOf({ tagStatus: "未判定", attempts: 0, ...override }), { eligibility: eligible });
    expect(item.initialSemif).not.toBe(true);
  });

  it.each(["旧判定入力", "TypeSafe新規銘柄の初回判定／本文と候補語"])("旧 billing_error の入力 %s は eligibility にコードがあっても機械判定", (judgeInput) => {
    const item = planSingle(latestOf(), rowOf({
      docId: latestDocOf().docId, tagStatus: "判定不能", attempts: 2,
      nextRetryAt: "2026-10-03", error: "jev status=402 billing_error", judgeInput,
    }), { eligibility: eligible });
    expect(item.kind).toBe("retry");
    expect(item.initialSemif).not.toBe(true);
    expect(item.reason).toContain("機械判定");
  });

  it.each([
    { attempts: null },
    { judgeInput: undefined },
    { tagStatus: "判定不能" as const, attempts: 2, error: null },
    { tagStatus: "判定不能" as const, attempts: 2, error: "billing_error", judgeInput: undefined },
  ])("上場資格は成立しても初回履歴が不明な行 %j は機械完了にせず HOLD", (override) => {
    const item = planSingle(latestOf(), rowOf({ tagStatus: "未判定", attempts: 0, ...override }), { eligibility: eligible });
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.initialSemif).not.toBe(true);
  });

  it("資格と専用初回 marker を持つ失敗だけ期日到来後に再試行", () => {
    const row = rowOf({
      docId: latestDocOf().docId, tagStatus: "判定不能", attempts: 1,
      nextRetryAt: TODAY, error: "初回の通信失敗", judgeInput: `${INITIAL_SEMIF_INPUT_PREFIX}／本文と候補語`,
    });
    expect(planSingle(latestOf(), row, { eligibility: eligible })).toMatchObject({ kind: "retry", initialSemif: true });
    expect(planSingle(latestOf(), { ...row, nextRetryAt: "2026-09-26" }, { eligibility: eligible }).kind).toBe("skip");
    expect(() => planSingle(latestOf(), { ...row, nextRetryAt: "2026-02-30" }, { eligibility: eligible })).toThrow("実在する YYYY-MM-DD");
    expect(planSingle(latestOf(), { ...row, attempts: MAX_RETRY_ATTEMPTS }, { eligibility: eligible })).toMatchObject({ kind: "skip", retryExhausted: true });
  });

  it("現世代外/未来等の資格 HOLD は、未判定を既存扱いに変えて処理しない", () => {
    const item = planSingle(latestOf(), null, { eligibility: held });
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.initialSemif).not.toBe(true);
  });

  it("過去の判定済み銘柄も上場資格 HOLD なら新有報の機械処理を止めて既存結果保持", () => {
    const row = rowOf({ docId: "S100OLD", tagStatus: "判定済", tagDoc: "S100OLD", vocabVersion: "v1" });
    const item = planSingle(latestOf(), row, { eligibility: held });
    expect(item).toMatchObject({ kind: "skip", qualificationHeld: true });
    expect(item.row).toBe(row);
    expect(item.initialSemif).not.toBe(true);
  });

  it("既に同一有報/語彙で判定済みなら新規資格があっても skip のまま", () => {
    const item = planSingle(latestOf(), rowOf({
      docId: latestDocOf().docId, tagDoc: `${latestDocOf().docId} 2026年3月期`, tagStatus: "判定済", vocabVersion: "v1",
      upstream: ["シリコンウエハ"], evidenceText: "保存済みの根拠文",
    }), { eligibility: eligible });
    expect(item.kind).toBe("sync_text");
    expect(item.initialSemif).not.toBe(true);
  });

  it("補足行が重複したら last-wins で初回資格を選ばず停止", () => {
    expect(() => planWork([latestOf()], [rowOf(), rowOf()], TODAY, eligible)).toThrow("重複");
  });
});


describe("known input provenance", () => {
  const row = () => rowOf({ docId: "S100AAAA", docType: "有報", periodEnd: "2026-03-31", submittedAt: "2026-06-25T00:00:00.000Z", textStatus: "取得済", tagDoc: "S100AAAA 2026年3月期", tagStatus: "判定済", vocabVersion: "v0",
    judgeInput: withInputReceipt("判定済み説明", { docId: "S100AAAA", textPageId: "old-pointer", businessSha256: "a".repeat(64), sectionsSha256: "b".repeat(64), stateSha256: "c".repeat(64), vocabVersion: "v0", model: "local-model" }) });
  it("same doc with a changed known fulltext pointer reads actual sections before choosing reuse/rejudge", () => {
    expect(planSingle(latestOf(), row())).toMatchObject({ kind: "retag", sourceChangedLocalJudge: true, checkSourceInput: true });
  });
  it("an unchanged known source pointer does not fetch or rejudge merely because vocabulary changed", () => {
    const synced = { ...row(), judgeInput: withTextSyncReceipt(row().judgeInput!, { docId: "S100AAAA", textPageId: "old-pointer", textsSha256: "d".repeat(64) }) };
    expect(planSingle(latestOf({ doc: latestDocOf({ notionDocPageId: "old-pointer" }) }), synced)).toMatchObject({ kind: "skip" });
  });
  it("機械的な4SHA等価証拠があれば旧model receiptの元pointerを保持したまま再実行NOOP", () => {
    const saved = row();
    const next = withTextSyncReceipt(saved.judgeInput!, { docId: "S100AAAA", textPageId: "notion-page-aaaa", textsSha256: "d".repeat(64),
      equivalentJudgmentInputSha256: readInputReceipt(saved.judgeInput)!.sectionsSha256 });
    expect(readInputReceipt(next)!.textPageId).toBe("old-pointer");
    expect(planSingle(latestOf(), { ...saved, judgeInput: next })).toMatchObject({ kind: "skip" });
  });
  it.each(["\n[biztag-input-v1] {invalid}", withInputReceipt("", { docId: "S100OTHER", textPageId: "old-pointer", businessSha256: null, sectionsSha256: "b".repeat(64), stateSha256: null, vocabVersion: "v0", model: null })])("malformed/inconsistent provenance holds instead of treating historical input as proved", (judgeInput) => {
    expect(planSingle(latestOf(), { ...row(), judgeInput })).toMatchObject({ kind: "skip", qualificationHeld: true });
  });
});

describe("39本文同期と初回local判定の来歴を分ける", () => {
  it("旧4SHAが無い同doc判定済みをモデルへ送らず39本文だけ同期する", () => {
    const row = rowOf({ docId: "S100AAAA", tagDoc: "S100AAAA 2026年3月期", tagStatus: "判定済", vocabVersion: "v0", judgeInput: null });
    expect(planSingle(latestOf(), row)).toMatchObject({ kind: "sync_text" });
    const next = withTextSyncReceipt(null, { docId: "S100AAAA", textPageId: "notion-page-aaaa", textsSha256: "e".repeat(64) });
    expect(readInputReceipt(next)).toBeNull();
    expect(planSingle(latestOf(), { ...row, judgeInput: next, docType: "有報", periodEnd: "2026-03-31", submittedAt: "2026-06-25T00:00:00.000Z", textStatus: "取得済" })).toMatchObject({ kind: "skip" });
  });
  it("独立39markerを更新しても既存model判定JSONを1byteも書き換えない", () => {
    const original = withInputReceipt("SemIf新規銘柄の初回判定：保存済み説明", { docId: "S100AAAA", textPageId: "old-pointer", businessSha256: null,
      sectionsSha256: "a".repeat(64), stateSha256: null, vocabVersion: "v0", model: "Qwen3.5-4B@851bf6e/semif-mlx" });
    const next = withTextSyncReceipt(original, { docId: "S100AAAA", textPageId: "new-pointer", textsSha256: "b".repeat(64) });
    expect(next.startsWith("SemIf新規銘柄の初回判定：保存済み説明")).toBe(true);
    expect(next.split(INPUT_RECEIPT_PREFIX)[1]).toBe(original.split(INPUT_RECEIPT_PREFIX)[1]);
    expect(readInputReceipt(next)).toEqual(readInputReceipt(original));
    expect(readTextSyncReceipt(next)).toMatchObject({ textPageId: "new-pointer" });
  });
  it.each([INITIAL_CLEF_INPUT_PREFIX, INITIAL_SEMIF_INPUT_PREFIX])("未完初回の%sを互換フラグで再試行する", (prefix) => {
    const eligible: NewStockEligibility = { eligibleCodes: new Set(["6103"]), heldCodes: new Set() };
    const row = rowOf({ tagStatus: "判定不能", attempts: 1, error: "初回読取失敗", nextRetryAt: TODAY, judgeInput: `${prefix}：初回の本文` });
    expect(planSingle(latestOf(), row, { eligibility: eligible })).toMatchObject({ kind: "retry", initialSemif: true });
  });
});
