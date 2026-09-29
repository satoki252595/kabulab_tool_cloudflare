/**
 * Issue #102 単発解消の回帰テスト (オフライン・純粋関数のみ)。
 *
 * 実 Notion/D1 への I/O は持たない。件数・日時は 2026-09-28 実測のパターン
 * (同分タイ・逆 relation 件数・子 DB) を再現する。テストが参照する 4 ページ ID
 * は `TARGETS` 定数と同じ運用 ID のみ (db_ids.json と同じ扱い)。全
 * properties・本文・relation 配列を含む snapshot は private 領域 (tmp/) に
 * だけ置き、ここには入れない。
 */
import { describe, expect, it } from "vitest";
import {
  FWD_PROP_RAW,
  LIFECYCLE_PATCH_3681_STATUS,
  type KeeperRowProof,
  type MasterPageView,
  type MasterTarget,
  type MigrationOp,
  REL_PROP_MASTER,
  REL_PROP_RELATED,
  RELATION_PATCH_BYTES_MAX,
  REVERSE_PROP_DISCLOSURES,
  REVERSE_PROP_FINANCIALS,
  REVERSE_PROP_JUKYU,
  REVERSE_PROP_YUTAI,
  SUPPLEMENT_7129_PAGE_ID,
  TARGETS,
  allMigrated,
  completedMigrationRowIds,
  decideMigrationAction,
  decideRetireAction,
  decideSnapshotAction,
  emptyReceipt,
  guardIncomingSchema,
  guardKeeperIncomingIds,
  guardMasterView,
  guardSupplement,
  hasSnapshotProgress,
  incomingRelationProblems,
  nonRelationPropsEqual,
  normalizePageId,
  olderSide,
  pendingMigrationOps,
  planMigration,
  propertiesEqualExcept,
  relationArraysEqual,
  relationPatchBytes,
  replaceRelationId,
  selectKeepId,
  sha256HexBytes,
  sha256HexUtf8,
  stableStringify,
  verifyIntermediateUnion,
  verifyOpResult,
  verifyPreD1Union,
  verifyReverseUnion,
} from "./master-dedup.js";

// 合成 ID (実ページ ID ではない。タイ再現のため辞書順を意識した値)。
const KEEP_3681 = "38dd74ff-84cd-8147-842a-ea9c88839ce6";
const RETIRE_3681 = "38dd74ff-84cd-81e9-a5bc-fa1c52a29572";
const KEEP_7129 = "38dd74ff-84cd-8130-a65e-dd0b0ab4e089";
const RETIRE_7129 = "38dd74ff-84cd-8167-a03c-cc53b4e5028b";

function rel(ids: string[]): { ids: string[]; has_more: boolean } {
  return { ids, has_more: false };
}

function view3681Keep(overrides: Partial<MasterPageView> = {}): MasterPageView {
  return {
    id: KEEP_3681,
    code: "3681",
    created_time: "2026-06-28T02:34:00.000Z",
    last_edited_time: "2026-09-15T16:20:00.000Z",
    archived: false,
    in_trash: false,
    listed: false,
    status: null,
    relations: {
      [REVERSE_PROP_DISCLOSURES]: rel([]),
      [REVERSE_PROP_FINANCIALS]: rel([]),
      [REVERSE_PROP_JUKYU]: rel([]),
      [REVERSE_PROP_YUTAI]: rel([]),
      [FWD_PROP_RAW]: rel(["raw-keep-3681"]),
    },
    rawIds: ["raw-keep-3681"],
    blockCount: 0,
    childDatabases: [],
    ...overrides,
  };
}

function view3681Retire(overrides: Partial<MasterPageView> = {}): MasterPageView {
  return {
    id: RETIRE_3681,
    code: "3681",
    created_time: "2026-06-28T02:34:00.000Z",
    last_edited_time: "2026-09-01T23:40:00.000Z",
    archived: false,
    in_trash: false,
    listed: true,
    status: "上場廃止",
    relations: {
      [REVERSE_PROP_DISCLOSURES]: rel(Array.from({ length: 12 }, (_, i) => `disc-${i}`)),
      [REVERSE_PROP_FINANCIALS]: rel(Array.from({ length: 8 }, (_, i) => `fin-${i}`)),
      [REVERSE_PROP_JUKYU]: rel([]),
      [REVERSE_PROP_YUTAI]: rel([]),
      [FWD_PROP_RAW]: rel(["raw-retire-3681"]),
    },
    rawIds: ["raw-retire-3681"],
    blockCount: 0,
    childDatabases: [],
    ...overrides,
  };
}

describe("master-dedup (純粋関数)", () => {
  describe("最古規則 (pipeline upsert.oldest_page と同一)", () => {
    it("同分タイは正規化 id の辞書順最小が正 (3681 パターン)", () => {
      expect(
        olderSide(
          { id: KEEP_3681, created_time: "2026-06-28T02:34:00.000Z" },
          { id: RETIRE_3681, created_time: "2026-06-28T02:34:00.000Z" }
        )
      ).toBe("a");
      // 引数順を入れ替えても同じ正を選ぶ。
      expect(
        olderSide(
          { id: RETIRE_3681, created_time: "2026-06-28T02:34:00.000Z" },
          { id: KEEP_3681, created_time: "2026-06-28T02:34:00.000Z" }
        )
      ).toBe("b");
    });

    it("created_time が異なれば最古が正 (7129 パターン)", () => {
      expect(
        olderSide(
          { id: KEEP_7129, created_time: "2026-06-28T02:44:00.000Z" },
          { id: RETIRE_7129, created_time: "2026-06-28T06:44:00.000Z" }
        )
      ).toBe("a");
    });

    it("created_time 欠損は推測せず throw", () => {
      expect(() =>
        olderSide({ id: "a", created_time: null }, { id: "b", created_time: "2026-01-01T00:00:00.000Z" })
      ).toThrow();
    });

    it("TARGETS 定数は最古規則と一致する (実測定数の自己検証)", () => {
      for (const t of TARGETS) {
        expect(selectKeepId(t)).toBe(t.keepId);
      }
    });

    it("keep/retire を逆にすると selectKeepId が throw", () => {
      // 3681 は同分タイのため ID 入替だけで最古規則と不一致になる。
      const swapped: MasterTarget = {
        ...TARGETS[0],
        keepId: TARGETS[0].retireId,
        retireId: TARGETS[0].keepId,
      };
      expect(() => selectKeepId(swapped)).toThrow();
    });

    it("normalizePageId はハイフン除去・小文字化", () => {
      expect(normalizePageId("38DD74FF-84CD-8147-842A-EA9C88839CE6")).toBe(
        "38dd74ff84cd8147842aea9c88839ce6"
      );
    });
  });

  describe("replaceRelationId (他銘柄 ID を保つ)", () => {
    it("単一の退避 ID を保持 ID へ置換する", () => {
      expect(replaceRelationId([RETIRE_3681], RETIRE_3681, KEEP_3681)).toEqual({
        after: [KEEP_3681],
        changed: true,
      });
    });

    it("他銘柄 ID は順序も含め一文字も変えない", () => {
      const others = ["other-1", "other-2", "other-3"];
      const before = [others[0], RETIRE_3681, others[1], others[2]];
      const { after, changed } = replaceRelationId(before, RETIRE_3681, KEEP_3681);
      expect(changed).toBe(true);
      expect(after).toEqual([others[0], KEEP_3681, others[1], others[2]]);
    });

    it("退避・保持の両方を含む配列は保持へ一本化 (重複除去)", () => {
      const { after, changed } = replaceRelationId(
        ["other-1", RETIRE_3681, KEEP_3681, "other-2"],
        RETIRE_3681,
        KEEP_3681
      );
      expect(changed).toBe(true);
      expect(after).toEqual(["other-1", KEEP_3681, "other-2"]);
    });

    it("退避 ID が無ければ無変更", () => {
      expect(replaceRelationId(["other-1", KEEP_3681], RETIRE_3681, KEEP_3681)).toEqual({
        after: ["other-1", KEEP_3681],
        changed: false,
      });
    });

    it("数千件の多銘柄配列でも他 ID を保つ (3818 件の ⑤ 規模)", () => {
      const before = Array.from({ length: 3818 }, (_, i) =>
        i === 2000 ? RETIRE_3681 : `stock-${i}`
      );
      const { after, changed } = replaceRelationId(before, RETIRE_3681, KEEP_3681);
      expect(changed).toBe(true);
      expect(after.length).toBe(3818);
      expect(after[2000]).toBe(KEEP_3681);
      expect(after[0]).toBe("stock-0");
      expect(after[3817]).toBe("stock-3817");
      expect(after.filter((id) => normalizePageId(id) === normalizePageId(RETIRE_3681))).toEqual([]);
    });

    it("retire と keep が同一なら throw", () => {
      expect(() => replaceRelationId(["a"], KEEP_3681, KEEP_3681)).toThrow();
    });
  });

  describe("guardMasterView (不一致は 1 件でも停止)", () => {
    const t3681 = TARGETS[0];

    it("期待どおりは合格", () => {
      expect(guardMasterView(t3681, "keep", view3681Keep())).toEqual([]);
      expect(guardMasterView(t3681, "retire", view3681Retire())).toEqual([]);
    });

    const keepMutations: Array<[string, Partial<MasterPageView>]> = [
      ["上場状態の反転", { listed: true }],
      ["状態の変化", { status: "上場" }],
      ["最終更新のずれ", { last_edited_time: "2026-09-16T00:00:00.000Z" }],
      ["作成日時のずれ", { created_time: "2026-06-29T02:34:00.000Z" }],
      ["archived", { archived: true }],
      ["⑧への参照", { relations: { ...view3681Keep().relations, [REVERSE_PROP_JUKYU]: rel(["x"]) } }],
      ["原本 0 件", { rawIds: [] }],
      ["原本 2 件", { rawIds: ["a", "b"] }],
    ];
    it.each(keepMutations)("%sを検出する (keep)", (_label, overrides) => {
      expect(guardMasterView(t3681, "keep", view3681Keep(overrides)).length).toBeGreaterThan(0);
    });

    it("退避候補の本文ブロックを検出する", () => {
      expect(
        guardMasterView(t3681, "retire", view3681Retire({ blockCount: 1 })).length
      ).toBeGreaterThan(0);
    });

    it("保持先の子 DB 変化を検出する (7129)", () => {
      const t7129 = TARGETS[1];
      const base: MasterPageView = {
        ...view3681Keep(),
        id: t7129.keepId,
        code: "7129",
        created_time: t7129.keepCreated,
        last_edited_time: t7129.keepEdited,
        listed: true,
        status: null,
        relations: {
          [REVERSE_PROP_DISCLOSURES]: rel(Array.from({ length: 10 }, (_, i) => `d${i}`)),
          [REVERSE_PROP_FINANCIALS]: rel(Array.from({ length: 8 }, (_, i) => `f${i}`)),
          [REVERSE_PROP_JUKYU]: rel([]),
          [REVERSE_PROP_YUTAI]: rel([]),
          [FWD_PROP_RAW]: rel(["raw-keep-7129"]),
        },
        rawIds: ["raw-keep-7129"],
        blockCount: 1,
        childDatabases: ["株価テクニカル履歴"],
      };
      expect(guardMasterView(t7129, "keep", base)).toEqual([]);
      expect(
        guardMasterView(t7129, "keep", { ...base, childDatabases: [] }).length
      ).toBeGreaterThan(0);
    });

    it("keep の ④③ 件数は問わない (集合ガードへ委譲。10→11 valid-addition 対応)", () => {
      const t7129 = TARGETS[1];
      const withEleven = {
        ...view3681Keep(),
        id: t7129.keepId,
        code: "7129",
        created_time: t7129.keepCreated,
        last_edited_time: t7129.keepEdited,
        listed: true,
        status: null,
        relations: {
          [REVERSE_PROP_DISCLOSURES]: rel(Array.from({ length: 11 }, (_, i) => `kd${i}`)),
          [REVERSE_PROP_FINANCIALS]: rel(Array.from({ length: 8 }, (_, i) => `kf${i}`)),
          [REVERSE_PROP_JUKYU]: rel([]),
          [REVERSE_PROP_YUTAI]: rel([]),
        },
        rawIds: ["raw-keep-7129"],
        blockCount: 1,
        childDatabases: ["株価テクニカル履歴"],
      };
      expect(guardMasterView(t7129, "keep", withEleven)).toEqual([]);
    });

    it("retire の ④③ 件数・has_more は引き続き縛る", () => {
      const t3681 = TARGETS[0];
      const base = view3681Retire();
      expect(guardMasterView(t3681, "retire", base)).toEqual([]);
      expect(
        guardMasterView(t3681, "retire", {
          ...base,
          relations: { ...base.relations, [REVERSE_PROP_DISCLOSURES]: rel(["only-one"]) },
        }).length
      ).toBeGreaterThan(0);
      expect(
        guardMasterView(t3681, "retire", {
          ...base,
          relations: { ...base.relations, [REVERSE_PROP_FINANCIALS]: { ids: [], has_more: true } },
        }).length
      ).toBeGreaterThan(0);
    });
  });

  describe("guardKeeperIncomingIds (保持先の ID 集合ガード)", () => {
    const TAG = "7129/keep/開示書類";
    function proof(rowPageId: string, overrides: Partial<KeeperRowProof> = {}): KeeperRowProof {
      return {
        rowPageId,
        issuerCode: "7129",
        originHasMore: false,
        originCount: 1,
        masterIdsFull: [KEEP_7129],
        ...overrides,
      };
    }

    it("完全一致は合格 (順序・表記ゆれを吸収)", () => {
      expect(
        guardKeeperIncomingIds({
          tag: TAG,
          code: "7129",
          keepId: KEEP_7129,
          liveIds: ["AA-11", "bb22"],
          baselineIds: ["bb22", "aa11"],
          addedProofs: [],
        })
      ).toBeNull();
    });

    it("空集合どうしは合格 (3681 keep 形)", () => {
      expect(
        guardKeeperIncomingIds({
          tag: "3681/keep/開示書類",
          code: "3681",
          keepId: KEEP_3681,
          liveIds: [],
          baselineIds: [],
          addedProofs: [],
        })
      ).toBeNull();
    });

    it("baseline 喪失は STOP する", () => {
      const p = guardKeeperIncomingIds({
        tag: TAG,
        code: "7129",
        keepId: KEEP_7129,
        liveIds: ["kd0"],
        baselineIds: ["kd0", "kd-vanished"],
        addedProofs: [],
      });
      expect(p).toMatch(/喪失/);
      expect(p).toContain("kd-vanished");
    });

    it("完全証明つきの追加行は許可する (valid-addition 形)", () => {
      expect(
        guardKeeperIncomingIds({
          tag: TAG,
          code: "7129",
          keepId: KEEP_7129,
          liveIds: ["kd0", "kd-new"],
          baselineIds: ["kd0"],
          addedProofs: [proof("kd-new")],
        })
      ).toBeNull();
    });

    it("未証明の追加行は STOP する", () => {
      expect(
        guardKeeperIncomingIds({
          tag: TAG,
          code: "7129",
          keepId: KEEP_7129,
          liveIds: ["kd0", "kd-new"],
          baselineIds: ["kd0"],
          addedProofs: [],
        })
      ).toMatch(/未証明の追加行/);
    });

    it("追加行の誤 issuer・原本なし・原本未完は STOP する", () => {
      const base = {
        tag: TAG,
        code: "7129" as const,
        keepId: KEEP_7129,
        liveIds: ["kd0", "kd-new"],
        baselineIds: ["kd0"],
      };
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { issuerCode: "3681" })] })
      ).toMatch(/発行者が不一致/);
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { issuerCode: null })] })
      ).toMatch(/発行者が不一致/);
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { originCount: 0 })] })
      ).toMatch(/原本が無い/);
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { originHasMore: true })] })
      ).toMatch(/未完/);
    });

    it("追加行が keep-only でなければ STOP する", () => {
      const base = {
        tag: TAG,
        code: "7129" as const,
        keepId: KEEP_7129,
        liveIds: ["kd0", "kd-new"],
        baselineIds: ["kd0"],
      };
      expect(
        guardKeeperIncomingIds({
          ...base,
          addedProofs: [proof("kd-new", { masterIdsFull: [KEEP_7129, RETIRE_7129] })],
        })
      ).toMatch(/keep-only でない/);
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { masterIdsFull: ["other"] })] })
      ).toMatch(/keep-only でない/);
      expect(
        guardKeeperIncomingIds({ ...base, addedProofs: [proof("kd-new", { masterIdsFull: [] })] })
      ).toMatch(/keep-only でない/);
    });
  });

  describe("guardSupplement", () => {
    const good = {
      byCode: {
        "3681": [],
        "7129": [{ pageId: SUPPLEMENT_7129_PAGE_ID, masterIds: [] as string[] }],
      },
      rowsReferencingTargets: [],
    };

    it("期待どおりは合格", () => {
      expect(guardSupplement(good)).toEqual([]);
    });

    it("3681 行の出現を検出する", () => {
      expect(
        guardSupplement({
          ...good,
          byCode: { ...good.byCode, "3681": [{ pageId: "x", masterIds: [] }] },
        }).length
      ).toBeGreaterThan(0);
    });

    it("7129 の行数・page id・master 設定済みを検出する", () => {
      expect(guardSupplement({ ...good, byCode: { ...good.byCode, "7129": [] } }).length).toBeGreaterThan(0);
      expect(
        guardSupplement({
          ...good,
          byCode: { ...good.byCode, "7129": [{ pageId: "other", masterIds: [] }] },
        }).length
      ).toBeGreaterThan(0);
      expect(
        guardSupplement({
          ...good,
          byCode: {
            ...good.byCode,
            "7129": [{ pageId: SUPPLEMENT_7129_PAGE_ID, masterIds: ["some-id"] }],
          },
        }).length
      ).toBeGreaterThan(0);
    });

    it("対象 4 ページへの参照行を検出する", () => {
      expect(
        guardSupplement({
          ...good,
          rowsReferencingTargets: [{ pageId: "x", code: "9999" }],
        }).length
      ).toBeGreaterThan(0);
    });
  });

  describe("planMigration / verifyOpResult", () => {
    it("実配列から op を作り、退避なし行は落とす", () => {
      const ops = planMigration({
        retireId: RETIRE_3681,
        keepId: KEEP_3681,
        rows: [
          { rowPageId: "disc-0", db: "disclosures", prop: REL_PROP_MASTER, actualBefore: [RETIRE_3681] },
          { rowPageId: "disc-9", db: "disclosures", prop: REL_PROP_MASTER, actualBefore: [KEEP_3681] },
          {
            rowPageId: "raw-big",
            db: "raw_files",
            prop: REL_PROP_RELATED,
            actualBefore: ["s-1", RETIRE_3681, "s-2"],
          },
        ],
      });
      expect(ops.map((o) => o.rowPageId)).toEqual(["disc-0", "raw-big"]);
      expect(ops[0].after).toEqual([KEEP_3681]);
      expect(ops[1].after).toEqual(["s-1", KEEP_3681, "s-2"]);
    });

    it("移行結果の完全一致を検証する (他 ID 欠落・順序変化も検出)", () => {
      const op: MigrationOp = {
        rowPageId: "raw-big",
        db: "raw_files",
        prop: REL_PROP_RELATED,
        before: ["s-1", RETIRE_3681, "s-2"],
        after: ["s-1", KEEP_3681, "s-2"],
      };
      expect(verifyOpResult(op, ["s-1", KEEP_3681, "s-2"])).toBeNull();
      expect(verifyOpResult(op, [KEEP_3681, "s-2"])).not.toBeNull();
      expect(verifyOpResult(op, ["s-1", "s-2", KEEP_3681])).not.toBeNull();
      expect(verifyOpResult(op, ["s-1", RETIRE_3681, "s-2"])).not.toBeNull();
    });
  });

  describe("verifyReverseUnion (逆 relation の和の保存)", () => {
    it("保持先の移行後が移行前の和と一致すれば合格", () => {
      expect(
        verifyReverseUnion({
          label: "3681/開示書類",
          keepBefore: [],
          retireBefore: ["d0", "d1"],
          keepAfter: ["d1", "d0"],
          retireId: RETIRE_3681,
          keepId: KEEP_3681,
        })
      ).toBeNull();
    });

    it("欠落があれば検出する", () => {
      expect(
        verifyReverseUnion({
          label: "3681/開示書類",
          keepBefore: [],
          retireBefore: ["d0", "d1"],
          keepAfter: ["d0"],
          retireId: RETIRE_3681,
          keepId: KEEP_3681,
        })
      ).not.toBeNull();
    });
  });

  describe("verifyPreD1Union (D1 前の union 一致・意図移行状態)", () => {
    const LABEL = "3681/開示書類";
    type PreD1Args = Parameters<typeof verifyPreD1Union>[0];
    function args(overrides: Partial<PreD1Args> = {}): PreD1Args {
      return {
        label: LABEL,
        snapKeep: ["k0"],
        snapRetire: ["d0", "d1"],
        liveKeepFull: ["k0", "d0"],
        liveRetireFull: ["d1"],
        expectedMigrated: ["d0"],
        retireArchived: false,
        ...overrides,
      };
    }

    it("意図状態どおり (部分移行・未移行) は合格", () => {
      expect(verifyPreD1Union(args())).toBeNull();
      expect(
        verifyPreD1Union(args({ liveKeepFull: ["k0"], liveRetireFull: ["d0", "d1"], expectedMigrated: [] }))
      ).toBeNull();
    });

    it("keep 側の欠落・不明は STOP する", () => {
      expect(verifyPreD1Union(args({ liveKeepFull: ["d0"] }))).toMatch(/keep 集合/);
      expect(verifyPreD1Union(args({ liveKeepFull: ["k0", "d0", "ghost"] }))).toMatch(/不明 1 件/);
    });

    it("stale 移行記録・retire 側 drift は STOP する", () => {
      expect(verifyPreD1Union(args({ expectedMigrated: ["d0", "stale"] }))).toMatch(/stale/);
      expect(verifyPreD1Union(args({ liveRetireFull: ["d1", "d0"] }))).toMatch(/retire 集合/);
      expect(verifyPreD1Union(args({ liveRetireFull: [] }))).toMatch(/retire 集合/);
    });

    it("retire archived は retire 側を問わない", () => {
      expect(verifyPreD1Union(args({ retireArchived: true, liveRetireFull: null }))).toBeNull();
      expect(verifyPreD1Union(args({ liveRetireFull: null }))).toMatch(/live retire 集合がありません/);
    });

    it("completedMigrationRowIds は code+DB+記録済みで絞る", () => {
      const ops: MigrationOp[] = [
        { rowPageId: "d0", db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
        { rowPageId: "d1", db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
        { rowPageId: "f0", db: "financials", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
        { rowPageId: "x0", db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_7129], after: [KEEP_7129] },
      ];
      const receipt = emptyReceipt();
      const rec = (db: "disclosures" | "financials") => ({
        db,
        prop: REL_PROP_MASTER,
        before: [RETIRE_3681],
        after: [KEEP_3681],
        verifiedAt: "2026-09-28T00:00:00.000Z",
      });
      receipt.migrated["d0"] = rec("disclosures");
      receipt.migrated["f0"] = rec("financials");
      receipt.migrated["x0"] = { ...rec("disclosures"), before: [RETIRE_7129], after: [KEEP_7129] };
      expect(completedMigrationRowIds(ops, receipt.migrated, RETIRE_3681, "disclosures")).toEqual(["d0"]);
      expect(completedMigrationRowIds(ops, receipt.migrated, RETIRE_3681, "financials")).toEqual(["f0"]);
      expect(completedMigrationRowIds(ops, receipt.migrated, RETIRE_7129, "disclosures")).toEqual(["x0"]);
    });
  });

  describe("propertiesEqualExcept / 正準化・ハッシュ", () => {
    it("除外プロパティ以外が等しければ真", () => {
      const a = { a: { number: 1 }, [REL_PROP_MASTER]: { relation: [{ id: "x" }] } };
      const b = { a: { number: 1 }, [REL_PROP_MASTER]: { relation: [{ id: "y" }] } };
      expect(propertiesEqualExcept(REL_PROP_MASTER, a, b)).toBe(true);
      expect(propertiesEqualExcept("other", a, b)).toBe(false);
    });

    function hostedFile(name: string, key: string, sig: string, expiry: string) {
      return {
        name,
        type: "file",
        file: { url: `https://prod-files-secure.invalid/${key}/${name}?X-Amz-Signature=${sig}`, expiry_time: expiry },
      };
    }

    it("Files の署名 rotation (同 object 再署名) は同一判定する", () => {
      const a = { ファイル: { type: "files", files: [hostedFile("a.zip", "key1", "sig-old", "2026-09-28T23:00:00.000Z")] } };
      const b = { ファイル: { type: "files", files: [hostedFile("a.zip", "key1", "sig-new", "2026-09-29T01:00:00.000Z")] } };
      expect(propertiesEqualExcept("other", a, b)).toBe(true);
    });

    it("Files の resource/name/type 変化は不一致にする", () => {
      const base = { ファイル: { type: "files", files: [hostedFile("a.zip", "key1", "s1", "2026-09-28T23:00:00.000Z")] } };
      const diffPath = { ファイル: { type: "files", files: [hostedFile("a.zip", "key2", "s1", "2026-09-28T23:00:00.000Z")] } };
      expect(propertiesEqualExcept("other", base, diffPath)).toBe(false);
      const diffName = { ファイル: { type: "files", files: [hostedFile("b.zip", "key1", "s1", "2026-09-28T23:00:00.000Z")] } };
      expect(propertiesEqualExcept("other", base, diffName)).toBe(false);
      const toExternal = { ファイル: { type: "files", files: [{ name: "a.zip", type: "external", external: { url: "https://example.invalid/a.zip" } }] } };
      expect(propertiesEqualExcept("other", base, toExternal)).toBe(false);
      const dropped = { ファイル: { type: "files", files: [] } };
      expect(propertiesEqualExcept("other", base, dropped)).toBe(false);
    });

    it("外部 URL の query 変化・未知形状は無差別 strip せず不一致にする", () => {
      const a = { ファイル: { type: "files", files: [{ name: "e", type: "external", external: { url: "https://example.invalid/f?v=1" } }] } };
      const b = { ファイル: { type: "files", files: [{ name: "e", type: "external", external: { url: "https://example.invalid/f?v=2" } }] } };
      expect(propertiesEqualExcept("other", a, b)).toBe(false);
      const unknown = { ファイル: { type: "files", files: [{ name: "x", type: "file" }] } };
      const known = { ファイル: { type: "files", files: [hostedFile("x", "k", "s", "2026-09-28T23:00:00.000Z")] } };
      expect(propertiesEqualExcept("other", unknown, known)).toBe(false);
      expect(propertiesEqualExcept("other", unknown, unknown)).toBe(false);
    });

    it("非署名 query (versionId) の差は除去せず不一致にする", () => {
      const f = (versionId: string, sig: string) => ({
        name: "a.zip",
        type: "file",
        file: {
          url: `https://prod-files-secure.invalid/key/a.zip?versionId=${versionId}&X-Amz-Signature=${sig}`,
          expiry_time: sig,
        },
      });
      const a = { ファイル: { type: "files", files: [f("v1", "s1")] } };
      const rotatedSameVersion = { ファイル: { type: "files", files: [f("v1", "s2")] } };
      const diffVersion = { ファイル: { type: "files", files: [f("v2", "s2")] } };
      expect(propertiesEqualExcept("other", a, rotatedSameVersion)).toBe(true);
      expect(propertiesEqualExcept("other", a, diffVersion)).toBe(false);
    });

    it("未知 field の差は drop せず不一致にする", () => {
      const f = (flag: boolean) => ({
        name: "a.zip",
        type: "file",
        file: {
          url: "https://prod-files-secure.invalid/key/a.zip?X-Amz-Signature=s",
          expiry_time: "t",
          future_flag: flag,
        },
      });
      const a = { ファイル: { type: "files", files: [f(true)] } };
      const b = { ファイル: { type: "files", files: [f(false)] } };
      expect(propertiesEqualExcept("other", a, b)).toBe(false);
    });

    it("rotation と同時に他 props が変われば不一致にする", () => {
      const a = {
        タイトル: { type: "title", title: [{ plain_text: "t" }] },
        ファイル: { type: "files", files: [hostedFile("a.zip", "key1", "s1", "2026-09-28T23:00:00.000Z")] },
      };
      const b = {
        タイトル: { type: "title", title: [{ plain_text: "changed" }] },
        ファイル: { type: "files", files: [hostedFile("a.zip", "key1", "s2", "2026-09-29T01:00:00.000Z")] },
      };
      expect(propertiesEqualExcept("other", a, b)).toBe(false);
    });

    it("stableStringify はキー順に依らない", () => {
      expect(stableStringify({ b: 1, a: { d: 4, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }));
    });

    it("sha256 の既知ベクトル", () => {
      expect(sha256HexUtf8("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
      expect(sha256HexBytes(new Uint8Array([0x61, 0x62, 0x63]))).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
      );
    });
  });

  describe("receipt (中断再開・再実行不変)", () => {
    const ops: MigrationOp[] = [
      { rowPageId: "r1", db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
      { rowPageId: "r2", db: "financials", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
    ];

    it("receipt 済みを除いて未実行だけ返す", () => {
      const receipt = emptyReceipt();
      expect(pendingMigrationOps(ops, receipt).map((o) => o.rowPageId)).toEqual(["r1", "r2"]);
      expect(allMigrated(ops, receipt)).toBe(false);
      receipt.migrated["r1"] = {
        db: "disclosures",
        prop: REL_PROP_MASTER,
        before: [RETIRE_3681],
        after: [KEEP_3681],
        verifiedAt: "2026-09-28T00:00:00.000Z",
      };
      expect(pendingMigrationOps(ops, receipt).map((o) => o.rowPageId)).toEqual(["r2"]);
      expect(allMigrated(ops, receipt)).toBe(false);
      receipt.migrated["r2"] = {
        db: "financials",
        prop: REL_PROP_MASTER,
        before: [RETIRE_3681],
        after: [KEEP_3681],
        verifiedAt: "2026-09-28T00:00:00.000Z",
      };
      expect(pendingMigrationOps(ops, receipt)).toEqual([]);
      expect(allMigrated(ops, receipt)).toBe(true);
    });

    it("退避 receipt があれば二重退避しない判定ができる", () => {
      const receipt = emptyReceipt();
      expect(receipt.retired[RETIRE_3681]).toBeUndefined();
      receipt.retired[RETIRE_3681] = { archivedAt: "2026-09-28T02:00:00.000Z", verifiedAt: "2026-09-28T02:00:00.000Z" };
      expect(receipt.retired[RETIRE_3681]?.archivedAt).toBe("2026-09-28T02:00:00.000Z");
    });
  });

  describe("relationPatchBytes (上限超過は切り詰めず停止)", () => {
    it("3818 件の ⑤ 配列は単一 PATCH に収まる", () => {
      const after = Array.from({ length: 3818 }, (_, i) => `stock-${i}`);
      expect(relationPatchBytes(REL_PROP_RELATED, after)).toBeLessThan(RELATION_PATCH_BYTES_MAX);
    });

    it("異常に大きい配列は上限超過として検出できる", () => {
      const after = Array.from({ length: 20000 }, (_, i) => `stock-${i}`);
      expect(relationPatchBytes(REL_PROP_RELATED, after)).toBeGreaterThan(RELATION_PATCH_BYTES_MAX);
    });
  });

  describe("lifecycle 決定の定数", () => {
    it("3681 の移行先の状態は上場廃止", () => {
      expect(LIFECYCLE_PATCH_3681_STATUS).toBe("上場廃止");
    });
  });

  describe("guardIncomingSchema (未知 incoming は 1 件でも STOP)", () => {
    it("既知 6 件のみは合格", () => {
      expect(
        guardIncomingSchema([
          { dbId: "d1", dbTitle: "③ 財務サマリ", propName: REL_PROP_MASTER, relType: "dual_property" },
          { dbId: "d2", dbTitle: "④ 開示書類", propName: REL_PROP_MASTER, relType: "dual_property" },
          { dbId: "d3", dbTitle: "⑤ 原本ファイル", propName: REL_PROP_RELATED, relType: "dual_property" },
          { dbId: "d4", dbTitle: "⑧ 需給", propName: REL_PROP_MASTER, relType: "dual_property" },
          { dbId: "d5", dbTitle: "⑨ 株主優待", propName: REL_PROP_MASTER, relType: "dual_property" },
          { dbId: "d6", dbTitle: "銘柄マスタ（補足）", propName: "銘柄マスタ", relType: "single_property" },
        ])
      ).toEqual([]);
    });

    it("未知の single_property を検出する", () => {
      expect(
        guardIncomingSchema([
          { dbId: "dx", dbTitle: "新規DB", propName: "銘柄マスタ", relType: "single_property" },
        ]).length
      ).toBeGreaterThan(0);
    });

    it("既知 title でも prop/rel が違えば未知扱い", () => {
      expect(
        guardIncomingSchema([
          { dbId: "d1", dbTitle: "③ 財務サマリ", propName: "新連係", relType: "dual_property" },
        ]).length
      ).toBeGreaterThan(0);
      expect(
        guardIncomingSchema([
          { dbId: "d6", dbTitle: "銘柄マスタ（補足）", propName: "銘柄マスタ", relType: "dual_property" },
        ]).length
      ).toBeGreaterThan(0);
    });
  });

  describe("nonRelationPropsEqual (relation 除外の比較)", () => {
    it("relation の差は無視し、非 relation の差は検出する", () => {
      const a = {
        listed: { type: "checkbox", checkbox: false },
        rel: { type: "relation", relation: [{ id: "x" }] },
      };
      const b = {
        listed: { type: "checkbox", checkbox: false },
        rel: { type: "relation", relation: [{ id: "y" }] },
      };
      const c = {
        listed: { type: "checkbox", checkbox: true },
        rel: { type: "relation", relation: [{ id: "x" }] },
      };
      expect(nonRelationPropsEqual(a, b)).toBe(true);
      expect(nonRelationPropsEqual(a, c)).toBe(false);
    });

    it("Files の署名 rotation は同一・resource 変化は不一致にする", () => {
      const f = (sig: string, key: string) => ({
        name: "a.zip",
        type: "file",
        file: { url: `https://prod-files-secure.invalid/${key}/a.zip?X-Amz-Signature=${sig}`, expiry_time: sig },
      });
      const a = { ファイル: { type: "files", files: [f("s1", "key1")] } };
      const rotated = { ファイル: { type: "files", files: [f("s2", "key1")] } };
      const moved = { ファイル: { type: "files", files: [f("s1", "key2")] } };
      expect(nonRelationPropsEqual(a, rotated)).toBe(true);
      expect(nonRelationPropsEqual(a, moved)).toBe(false);
    });
  });

  describe("verifyIntermediateUnion (部分移行の和の保存)", () => {
    it("部分移行でも keep∪retire の和が一致すれば合格", () => {
      expect(
        verifyIntermediateUnion({
          label: "3681/開示書類",
          snapKeep: [],
          snapRetire: ["d0", "d1", "d2"],
          freshKeep: ["d0"],
          freshRetire: ["d1", "d2"],
        })
      ).toBeNull();
    });

    it("欠落・不明があれば検出する", () => {
      expect(
        verifyIntermediateUnion({
          label: "3681/開示書類",
          snapKeep: [],
          snapRetire: ["d0", "d1"],
          freshKeep: ["d0"],
          freshRetire: [],
        })
      ).not.toBeNull();
      expect(
        verifyIntermediateUnion({
          label: "3681/開示書類",
          snapKeep: [],
          snapRetire: ["d0"],
          freshKeep: ["d0", "unknown"],
          freshRetire: [],
        })
      ).not.toBeNull();
    });
  });

  describe("decideMigrationAction (PATCH→receipt 断の回収)", () => {
    const before = [RETIRE_3681];
    const after = [KEEP_3681];

    it("未記録・fresh before なら patch", () => {
      expect(
        decideMigrationAction({ recorded: undefined, opBefore: before, opAfter: after, freshFull: before, nonTargetUnchanged: true })
      ).toBe("patch");
    });

    it("未記録・fresh after かつ非対象不変なら recover (再送しない)", () => {
      expect(
        decideMigrationAction({ recorded: undefined, opBefore: before, opAfter: after, freshFull: after, nonTargetUnchanged: true })
      ).toBe("recover");
    });

    it("未記録・fresh after でも非対象変化なら stop", () => {
      expect(
        decideMigrationAction({ recorded: undefined, opBefore: before, opAfter: after, freshFull: after, nonTargetUnchanged: false })
      ).toBe("stop");
    });

    it("記録済み・fresh after なら skip、fresh before なら repatch", () => {
      const recorded = { before, after };
      expect(
        decideMigrationAction({ recorded, opBefore: before, opAfter: after, freshFull: after, nonTargetUnchanged: true })
      ).toBe("skip");
      expect(
        decideMigrationAction({ recorded, opBefore: before, opAfter: after, freshFull: before, nonTargetUnchanged: true })
      ).toBe("repatch");
    });

    it("記録済み・想定外は stop", () => {
      const recorded = { before, after };
      expect(
        decideMigrationAction({ recorded, opBefore: before, opAfter: after, freshFull: ["other"], nonTargetUnchanged: true })
      ).toBe("stop");
    });
  });

  describe("incomingRelationProblems (entry 照合の relation CAS)", () => {
    const R = "aa".repeat(16);
    const K = "bb".repeat(16);
    const X = "cc".repeat(16);

    it("noop 行は snapshot と完全一致・差があれば問題", () => {
      expect(
        incomingRelationProblems({ rowPageId: "r1", snapRelationFull: [X], freshFull: [X], op: undefined, recorded: undefined })
      ).toEqual([]);
      expect(
        incomingRelationProblems({ rowPageId: "r1", snapRelationFull: [X], freshFull: [X, K], op: undefined, recorded: undefined })
      ).toHaveLength(1);
    });

    it("linked 行は before/after のどちらか・それ以外は問題", () => {
      const op = { before: [R], after: [K] };
      expect(
        incomingRelationProblems({ rowPageId: "d0", snapRelationFull: [R], freshFull: [R], op, recorded: undefined })
      ).toEqual([]);
      expect(
        incomingRelationProblems({ rowPageId: "d0", snapRelationFull: [R], freshFull: [K], op, recorded: undefined })
      ).toEqual([]);
      expect(
        incomingRelationProblems({ rowPageId: "d0", snapRelationFull: [R], freshFull: [X], op, recorded: undefined })
      ).toHaveLength(1);
    });

    it("receipt の before/after が op と違えば stale として問題", () => {
      const op = { before: [R], after: [K] };
      expect(
        incomingRelationProblems({ rowPageId: "d0", snapRelationFull: [R], freshFull: [K], op, recorded: { before: [R], after: [K] } })
      ).toEqual([]);
      expect(
        incomingRelationProblems({ rowPageId: "d0", snapRelationFull: [R], freshFull: [K], op, recorded: { before: [R], after: [X] } })
      ).toHaveLength(1);
    });

    it("relationArraysEqual は正規化 ID の順序つき比較", () => {
      expect(relationArraysEqual([R], [R.toUpperCase()])).toBe(true);
      expect(relationArraysEqual([R, K], [K, R])).toBe(false);
    });
  });

  describe("decideRetireAction / decideSnapshotAction", () => {
    it("退避: fresh archived 状態と marker で create/repatch/recover/stop を決める", () => {
      // active: marker なしは create、ありは repatch (PATCH 冪等で再送は安全)。
      expect(decideRetireAction({ originArchived: false, hasMarker: false })).toBe("create");
      expect(decideRetireAction({ originArchived: false, hasMarker: true })).toBe("repatch");
      // archived: marker ありは recover、なしは外部 archive として stop。
      expect(decideRetireAction({ originArchived: true, hasMarker: true })).toBe("recover");
      expect(decideRetireAction({ originArchived: true, hasMarker: false })).toBe("stop");
    });

    it("snapshot: 複数は停止・1 件は recover・0+marker は停止・0 のみ create", () => {
      expect(decideSnapshotAction({ backupHits: 2, hasMarker: false })).toBe("stop");
      expect(decideSnapshotAction({ backupHits: 1, hasMarker: true })).toBe("recover");
      expect(decideSnapshotAction({ backupHits: 0, hasMarker: true })).toBe("stop");
      expect(decideSnapshotAction({ backupHits: 0, hasMarker: false })).toBe("create");
    });
  });

  describe("hasSnapshotProgress (再開判定)", () => {
    it("空 receipt は偽・何らかの進捗で真", () => {
      expect(hasSnapshotProgress(emptyReceipt())).toBe(false);
      const r1 = emptyReceipt();
      r1.snapshotIssued = { key: "k", snapshotHash: "h", issuedAt: "2026-09-28T00:00:00.000Z" };
      expect(hasSnapshotProgress(r1)).toBe(true);
      const r2 = emptyReceipt();
      r2.migrated["x"] = { db: "disclosures", prop: REL_PROP_MASTER, before: [], after: [], verifiedAt: "2026-09-28T00:00:00.000Z" };
      expect(hasSnapshotProgress(r2)).toBe(true);
    });
  });
});
