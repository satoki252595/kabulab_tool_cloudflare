import { describe, expect, it } from "vitest";
import type { SupplementRow } from "../../../../src/shared/notion-archive/stock-supplement.js";
import {
  expectedBusinessTags,
  planUnifiedTags,
  runUnifiedTagsMigration,
} from "./migrate-unified-tags.js";

function row(over: Partial<SupplementRow>): SupplementRow {
  return {
    pageId: "page-1",
    stockCode: "6532",
    companyName: "テスト",
    docId: null,
    docType: null,
    periodEnd: null,
    sector33: null,
    textNormalizedChars: null,
    textStatus: null,
    tagStatus: null,
    upstream: [],
    downstream: [],
    distribution: [],
    themes: [],
    savedEvidenceInput: null,
    vocabVersion: null,
    evidenceDocId: null,
    evidencePeriod: null,
    texts: {},
    ...over,
  } as SupplementRow;
}

describe("planUnifiedTags", () => {
  it("和集合は upstream→downstream→distribution の順", () => {
    const r = row({ upstream: ["U1"], downstream: ["D1", "D2"], distribution: ["S1"] });
    expect(expectedBusinessTags(r)).toEqual(["U1", "D1", "D2", "S1"]);
  });

  it("統合列が未読 (undefined) なら書く", () => {
    const [item] = planUnifiedTags([row({ upstream: ["U1"] })]);
    expect(item.action).toBe("write");
    expect(item.current).toBeUndefined();
  });

  it("3列も統合列も空なら未読でも書かない (空PATCHを全行に打たない)", () => {
    const [item] = planUnifiedTags([row({})]);
    expect(item.action).toBe("skip-equal");
  });

  it("集合一致なら順序が違っても書かない", () => {
    const [item] = planUnifiedTags([
      row({ upstream: ["U1"], downstream: ["D1"], businessTags: ["D1", "U1"] }),
    ]);
    expect(item.action).toBe("skip-equal");
  });

  it("統合列が空で3列も空なら書かない", () => {
    const [item] = planUnifiedTags([row({ businessTags: [] })]);
    expect(item.action).toBe("skip-equal");
  });

  it("統合列に古い値が残っていれば上書き対象にする", () => {
    const [item] = planUnifiedTags([row({ upstream: ["U1"], businessTags: ["旧タグ"] })]);
    expect(item.action).toBe("write");
    expect(item.expected).toEqual(["U1"]);
  });
});

describe("runUnifiedTagsMigration (owner 安全)", () => {
  it("例外を投げず fatalError として返す (共有ownerを未閉鎖で残さないため)", async () => {
    const summary = await runUnifiedTagsMigration({ apply: true });
    expect(summary.fatalError).toContain("--journal が必須");
    expect(summary.written).toBe(0);
    expect(summary.apply).toBe(true);
    expect(summary.limited).toBe(false);
  });
});
