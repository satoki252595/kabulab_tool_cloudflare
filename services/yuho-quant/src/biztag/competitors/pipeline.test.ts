/**
 * pipeline.ts の増分判定ロジック (`needsRecompute`) のテスト。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §12.6。
 *
 * Notion I/O・jev を伴う `runCompetitors` 本体は candidates.ts/process.ts/
 * stock-competitors.ts で個別にテスト済みの部品を組み合わせるだけの薄い
 * オーケストレーションのため、ここでは増分方式の判定 (「未判定」「書類が
 * 変わった」「版が変わった」の3条件) という核心のロジックだけを直接検証する。
 */
import { describe, expect, it } from "vitest";
import type { CompanyProfile } from "./candidates.js";
import { needsRecompute } from "./pipeline.js";

function profile(docId: string | null): CompanyProfile {
  return {
    stockCode: "0000",
    companyName: "テスト会社",
    pageId: "page-0000",
    sector33: null,
    tags: [],
    businessText: "",
    docId,
  };
}

const versionTag = "cand-v1|jev-1.13.0";

describe("needsRecompute", () => {
  it("メタ情報が無ければ未判定として再計算対象にする", () => {
    expect(needsRecompute(profile("doc-1"), undefined, versionTag)).toBe(true);
  });

  it("判定書類IDが無ければ (空文字含む) 再計算対象にする", () => {
    expect(needsRecompute(profile("doc-1"), { judgedDocId: null, version: versionTag }, versionTag)).toBe(true);
    expect(needsRecompute(profile("doc-1"), { judgedDocId: "", version: versionTag }, versionTag)).toBe(true);
  });

  it("有報書類IDが変わっていたら再計算対象にする", () => {
    expect(needsRecompute(profile("doc-2"), { judgedDocId: "doc-1", version: versionTag }, versionTag)).toBe(true);
  });

  it("候補生成の版+モデルが変わっていたら再計算対象にする", () => {
    expect(needsRecompute(profile("doc-1"), { judgedDocId: "doc-1", version: "cand-v1|jev-1.12.0" }, versionTag)).toBe(
      true
    );
  });

  it("書類・版とも一致していれば再計算不要", () => {
    expect(needsRecompute(profile("doc-1"), { judgedDocId: "doc-1", version: versionTag }, versionTag)).toBe(false);
  });
});
