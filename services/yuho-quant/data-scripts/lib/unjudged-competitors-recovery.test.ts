import { describe, expect, it } from "vitest";
import { assertFreshPre, assertRecoveryReadback, assertUnjudged, assertNonTargets, assertOneWaySchema, canonicalJson, rebandRecoveryOutput, type RecoverySnapshot, type RecoveryOutput, type RecoveryPage } from "./unjudged-competitors-recovery.js";

// 取込原文やモデルの架空判定を使わず、実S100Z0VFの識別メタだけで書込境界を検査する。
const text = (value: string) => ({ id: "text", type: "rich_text", rich_text: value === "" ? [] : [{ plain_text: value }] });
function pre(): RecoveryPage {
  return { id: "row", archived: false, in_trash: false, parent: { type: "database_id", database_id: "db" }, properties: {
    "銘柄コード": text("646A"), "有報書類ID": text("S100Z0VF"), "競合判定書類ID": text(""), "競合判定の版": text(""),
    "競合判定日": { id: "date", type: "date", date: null }, "競合他社": { id: "relation", type: "relation", relation: [], has_more: false },
  } };
}
const expected = { competitorPageIds: [], judgedAt: "2026-10-14", version: "cand-v1|Qwen3.5-4B@851bf6e/semif-mlx", judgedDocId: "S100Z0VF" };
function after(): RecoveryPage {
  const p = pre(); p.properties["競合判定書類ID"] = text(expected.judgedDocId); p.properties["競合判定の版"] = text(expected.version);
  p.properties["競合判定日"] = { id: "date", type: "date", date: { start: expected.judgedAt, end: null } }; return p;
}
describe("未判定競合のPRE/単発後読戻し境界", () => {
  it("全PRE一致だけ受け入れ、元有報が変われば保持停止する", () => {
    expect(() => assertFreshPre(pre(), pre(), "db")).not.toThrow();
    const fresh = pre(); fresh.properties["有報書類ID"] = text("S100Y5S8");
    expect(() => assertFreshPre(pre(), fresh, "db")).toThrow("PREから");
  });
  it("文書IDが空でも既存relation/判定版があれば上書き対象にしない", () => {
    const related = pre(); related.properties["競合他社"].relation = [{ id: "existing" }];
    expect(() => assertUnjudged(related)).toThrow("既存競合値");
    const versioned = pre(); versioned.properties["競合判定の版"] = text(expected.version);
    expect(() => assertUnjudged(versioned)).toThrow("既存競合値");
  });
  it("既存値が完全な空であることを要求する", () => {
    const partial = pre(); partial.properties["競合他社"].has_more = true;
    expect(() => assertUnjudged(partial)).toThrow();
    delete partial.properties["競合他社"];
    expect(() => assertUnjudged(partial)).toThrow();
  });
  it("4プロパティの期待値とその他の全PRE一致を読戻す", () => {
    expect(() => assertRecoveryReadback(pre(), after(), expected, "db")).not.toThrow();
    const changed = after(); changed.properties["銘柄コード"] = text("542A");
    expect(() => assertRecoveryReadback(pre(), changed, expected, "db")).toThrow("競合以外");
  });
  it("relation打切り・書類違い・別DBを完成扱いしない", () => {
    const partial = after(); partial.properties["競合他社"].has_more = true;
    expect(() => assertRecoveryReadback(pre(), partial, expected, "db")).toThrow("読戻し");
    expect(() => assertRecoveryReadback(pre(), after(), { ...expected, judgedDocId: "S100Y5S8" }, "db")).toThrow("読戻し");
    expect(() => assertRecoveryReadback(pre(), after(), expected, "other-db")).toThrow("所属");
  });
  it("片方向の同一DB relationだけを受け入れ、逆向き自動更新を許可しない", () => {
    const properties = { "競合他社": { id: "relation", relation: { database_id: "db", type: "single_property" } } };
    expect(() => assertOneWaySchema(properties, "db")).not.toThrow();
    expect(() => assertOneWaySchema({ "競合他社": { id: "relation", relation: { database_id: "db", type: "dual_property" } } }, "db")).toThrow();
    expect(() => assertOneWaySchema(properties, "other-db")).toThrow();
  });
  it("対象外の版/入力指紋変化や消失を止める", () => {
    const before = { "646A": "sha", "542A": "sha" }, targets = new Set(["646A"]);
    expect(() => assertNonTargets(before, { "646A": "changed", "542A": "sha" }, targets)).not.toThrow();
    expect(() => assertNonTargets(before, { "646A": "sha", "542A": "changed" }, targets)).toThrow();
    expect(() => assertNonTargets(before, { "646A": "sha" }, targets)).toThrow();
  });
  it("キー順序は正規化し、未定義や非有限数を保全値へ混ぜない", () => {
    expect(canonicalJson({ b: 1, a: null })).toBe(canonicalJson({ a: null, b: 1 }));
    expect(() => canonicalJson({ value: undefined })).toThrow(); expect(() => canonicalJson({ value: NaN })).toThrow();
  });
});

it("保存済み実確率を再推論せず0.5境界で再バンド化し、元doc/判定日/生確率を保持する", () => {
  // 2026-10-14保存の145A→3962(p=.5), →9250(p=.268941...)の実観測値。
  const snapshot = { targetCodes: ["145A"], corpus: [{ stockCode: "145A", pageId: "145A", docId: "S100XRTM" }],
    calibration: { candidateVersion: "cand-v1", model: "Qwen3.5-4B@851bf6e/semif-mlx", thresholds: { yesMin: .5, noMax: .09 }, decisionVersion: "cal-thr050-eval122-20261014" },
    candidates: { "145A": [{ stockCode: "3962", pageId: "3962" }, { stockCode: "9250", pageId: "9250" }] } } as unknown as RecoverySnapshot;
  const original: RecoveryOutput = { stockCode: "145A", pageId: "145A", inputSha256: "old", startedAt: "2026-10-13T16:29:00Z", finishedAt: "2026-10-13T16:29:20Z", elapsedMs: 20000,
    expected: { competitorPageIds: ["3962", "9250"], judgedAt: "2026-10-14", judgedDocId: "S100XRTM", version: "cand-v1|Qwen3.5-4B@851bf6e/semif-mlx" },
    probabilities: { "cp.3962": .5, "cp.9250": .2689414213699951 }, candidateCodes: ["3962", "9250"], bands: { yes: 2, no: 0, uncertain: 0 }, modelCalls: 1, peakTreeRssKiB: 1 };
  const next = rebandRecoveryOutput(snapshot, original, "new");
  expect(next.expected.competitorPageIds).toEqual(["3962"]); expect(next.bands).toEqual({ yes: 1, no: 0, uncertain: 1 });
  expect(next.probabilities).toEqual(original.probabilities); expect(next.expected.judgedAt).toBe(original.expected.judgedAt);
  expect(next.expected.judgedDocId).toBe(original.expected.judgedDocId); expect(next.startedAt).toBe(original.startedAt);
  expect(next.expected.version).toContain("|cal-thr050-eval122-20261014");
  expect(original.expected.competitorPageIds).toEqual(["3962", "9250"]);
});
