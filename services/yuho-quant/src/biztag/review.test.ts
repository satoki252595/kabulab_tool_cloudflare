/**
 * review.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §6.1。
 */
import { describe, expect, it } from "vitest";
import type { LedgerEntry, SupplementRow } from "../../../../src/shared/notion-archive/index.js";
import { OFFICIAL_ROOT_SOURCES, buildReviewPacket, refreshReviewPacketLedger, type ReviewPacket } from "./review.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";

function rowOf(overrides: Partial<SupplementRow>): SupplementRow {
  return {
    pageId: "p",
    stockCode: "0000",
    companyName: "テスト",
    sector33: null,
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
    texts: {},
    ...overrides,
  };
}

describe("buildReviewPacket", () => {
  it("判定済行だけを集計し、語ごとのタグ数・要確認数を数える", () => {
    const rows = [
      rowOf({
        stockCode: "6103",
        sector33: "機械",
        tagStatus: "判定済",
        candidateCount: 1,
        upstream: ["工作機械"],
        themes: ["工作機械・産業用ロボット"],
      }),
      rowOf({
        stockCode: "6104",
        sector33: "機械",
        tagStatus: "判定済",
        candidateCount: 2,
        upstream: ["工作機械", "産業用ロボット"],
        uncertain: "水素製造装置・燃料電池（0.55）",
      }),
      // 未判定行は集計対象外
      rowOf({ stockCode: "9999", sector33: "機械", tagStatus: "未判定" }),
    ];

    const packet = buildReviewPacket(rows, MINI_VOCAB, "2026-08-01T00:00:00.000Z");

    expect(packet.version).toBe(MINI_VOCAB.version);
    const machineTool = packet.termStats.find((t) => t.id === "B.MACH.MACHINE_TOOL");
    expect(machineTool?.tagCount).toBe(2);
    const robot = packet.termStats.find((t) => t.id === "B.MACH.INDUSTRIAL_ROBOT");
    expect(robot?.tagCount).toBe(1);
    const hydrogen = packet.termStats.find((t) => t.id === "B.ENERGY.HYDROGEN_FUEL_CELL");
    expect(hydrogen?.uncertainCount).toBe(1);
    const theme = packet.termStats.find((t) => t.id === "T.MACHINE_TOOL_ROBOT");
    expect(theme?.column).toBe("theme");
    expect(theme?.tagCount).toBe(1);
  });

  it("業種別「語なし」率を候補語数0の判定済行から計算する", () => {
    const rows = [
      rowOf({ stockCode: "1", sector33: "水産・農林業", tagStatus: "判定済", candidateCount: 0 }),
      rowOf({ stockCode: "2", sector33: "水産・農林業", tagStatus: "判定済", candidateCount: 0 }),
      rowOf({ stockCode: "3", sector33: "水産・農林業", tagStatus: "判定済", candidateCount: 1, upstream: ["工作機械"] }),
      rowOf({ stockCode: "4", sector33: "機械", tagStatus: "判定済", candidateCount: 1, upstream: ["工作機械"] }),
    ];
    const packet = buildReviewPacket(rows, MINI_VOCAB, "2026-08-01");
    const fishery = packet.noHitSectors.find((s) => s.sector33 === "水産・農林業");
    expect(fishery).toEqual({ sector33: "水産・農林業", judged: 3, zeroCandidate: 2, ratio: 2 / 3 });
    // 語なし率の高い順
    expect(packet.noHitSectors[0]?.sector33).toBe("水産・農林業");
  });

  it("確認不能タグが多い銘柄ほど上位に来る (uncertainHeavy)", () => {
    const rows = [
      rowOf({ stockCode: "A", tagStatus: "判定済", uncertain: "語1（0.5）" }),
      rowOf({ stockCode: "B", tagStatus: "判定済", uncertain: "語1（0.5） / 語2（0.6）" }),
      rowOf({ stockCode: "C", tagStatus: "判定済", uncertain: null }),
    ];
    const packet = buildReviewPacket(rows, MINI_VOCAB, "2026-08-01");
    expect(packet.uncertainHeavy.map((r) => r.stockCode)).toEqual(["B", "A"]);
  });

  it("公式ルート URL 5件 + 単語帳の出典 URL を重複なく含める", () => {
    const packet = buildReviewPacket([], MINI_VOCAB, "2026-08-01");
    for (const url of OFFICIAL_ROOT_SOURCES) {
      expect(packet.officialSources).toContain(url);
    }
    const vocabUrl = MINI_VOCAB.business[0]!.sources[0]!.url;
    expect(packet.officialSources).toContain(vocabUrl);
    expect(new Set(packet.officialSources).size).toBe(packet.officialSources.length);
  });
});

function ledgerEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    pageId: "review-1",
    name: "見直し材料",
    kind: "見直し材料",
    state: "最新",
    version: "v1",
    hash: "h",
    recordedAt: "2026-08-01",
    reason: "",
    diff: "",
    rollbackFrom: null,
    ...overrides,
  };
}

describe("refreshReviewPacketLedger", () => {
  const packet: ReviewPacket = {
    version: "v1",
    vocab: MINI_VOCAB,
    termStats: [],
    noHitSectors: [],
    uncertainHeavy: [],
    officialSources: [],
    generatedAt: "2026-08-02T00:00:00.000Z",
  };

  it("既存の「見直し材料」が無ければ新規作成する", async () => {
    const created = makeCreateLedgerEntrySpy();
    const result = await refreshReviewPacketLedger({
      dbId: "db",
      packet,
      listLedgerEntries: () => Promise.resolve([]),
      readLedgerJson: () => Promise.reject(new Error("呼ばれない想定")),
      createLedgerEntry: created.fn,
      replaceLedgerJson: () => Promise.reject(new Error("呼ばれない想定")),
    });
    expect(result.updated).toBe(true);
    expect(created.calls).toBe(1);
  });

  it("内容が変わっていなければ更新しない (generatedAt の違いだけでは更新しない)", async () => {
    const existing = ledgerEntry({});
    const oldPacket: ReviewPacket = { ...packet, generatedAt: "2026-01-01T00:00:00.000Z" };
    let replaceCalls = 0;
    const result = await refreshReviewPacketLedger({
      dbId: "db",
      packet,
      listLedgerEntries: () => Promise.resolve([existing]),
      readLedgerJson: () => Promise.resolve(oldPacket),
      createLedgerEntry: () => Promise.reject(new Error("呼ばれない想定")),
      replaceLedgerJson: () => {
        replaceCalls++;
        return Promise.resolve(existing);
      },
    });
    expect(result.updated).toBe(false);
    expect(replaceCalls).toBe(0);
  });

  it("内容が変わっていれば既存行を差し替える", async () => {
    const existing = ledgerEntry({});
    const oldPacket: ReviewPacket = { ...packet, generatedAt: "2026-01-01", termStats: [{ id: "x", label: "旧", column: "theme", tagCount: 0, uncertainCount: 0 }] };
    let replaceCalls = 0;
    const result = await refreshReviewPacketLedger({
      dbId: "db",
      packet,
      listLedgerEntries: () => Promise.resolve([existing]),
      readLedgerJson: () => Promise.resolve(oldPacket),
      createLedgerEntry: () => Promise.reject(new Error("呼ばれない想定")),
      replaceLedgerJson: () => {
        replaceCalls++;
        return Promise.resolve(existing);
      },
    });
    expect(result.updated).toBe(true);
    expect(replaceCalls).toBe(1);
  });

  it("「最新」状態の行が複数あれば throw する", async () => {
    await expect(
      refreshReviewPacketLedger({
        dbId: "db",
        packet,
        listLedgerEntries: () => Promise.resolve([ledgerEntry({ pageId: "a" }), ledgerEntry({ pageId: "b" })]),
        readLedgerJson: () => Promise.reject(new Error("呼ばれない想定")),
        createLedgerEntry: () => Promise.reject(new Error("呼ばれない想定")),
        replaceLedgerJson: () => Promise.reject(new Error("呼ばれない想定")),
      })
    ).rejects.toThrow(/複数/);
  });
});

function makeCreateLedgerEntrySpy() {
  let calls = 0;
  const fn = (
    _dbId: string,
    e: {
      name: string;
      kind: LedgerEntry["kind"];
      state: LedgerEntry["state"];
      version: string | null;
      reason: string;
      diff: string;
      rollbackFrom: string | null;
      json: unknown;
      recordedAt: string;
    }
  ) => {
    calls++;
    return Promise.resolve(ledgerEntry({ ...e, pageId: "new" }));
  };
  return {
    fn,
    get calls() {
      return calls;
    },
  };
}
