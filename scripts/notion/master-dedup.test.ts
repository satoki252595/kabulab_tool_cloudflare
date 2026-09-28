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
  decideMigrationAction,
  decideRetireAction,
  decideSnapshotAction,
  emptyReceipt,
  guardIncomingSchema,
  guardMasterView,
  guardSupplement,
  hasSnapshotProgress,
  nonRelationPropsEqual,
  normalizePageId,
  olderSide,
  pendingMigrationOps,
  planMigration,
  propertiesEqualExcept,
  relationPatchBytes,
  replaceRelationId,
  selectKeepId,
  sha256HexBytes,
  sha256HexUtf8,
  stableStringify,
  verifyIntermediateUnion,
  verifyOpResult,
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
      ["逆 relation 件数のずれ", { relations: { ...view3681Keep().relations, [REVERSE_PROP_DISCLOSURES]: rel(["x"]) } }],
      ["has_more", { relations: { ...view3681Keep().relations, [REVERSE_PROP_FINANCIALS]: { ids: [], has_more: true } } }],
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

  describe("propertiesEqualExcept / 正準化・ハッシュ", () => {
    it("除外プロパティ以外が等しければ真", () => {
      const a = { a: { number: 1 }, [REL_PROP_MASTER]: { relation: [{ id: "x" }] } };
      const b = { a: { number: 1 }, [REL_PROP_MASTER]: { relation: [{ id: "y" }] } };
      expect(propertiesEqualExcept(REL_PROP_MASTER, a, b)).toBe(true);
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
      receipt.retired[RETIRE_3681] = { trashPageId: "trash-1", verifiedAt: "2026-09-28T00:00:00.000Z" };
      expect(receipt.retired[RETIRE_3681]?.trashPageId).toBe("trash-1");
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

  describe("decideRetireAction / decideSnapshotAction (0/1/複数 + marker)", () => {
    it("退避: 複数は停止・1 件は complete・0+marker は停止・0 のみ create", () => {
      expect(decideRetireAction({ trashHits: 2, hasMarker: false })).toBe("stop");
      expect(decideRetireAction({ trashHits: 1, hasMarker: false })).toBe("complete");
      expect(decideRetireAction({ trashHits: 1, hasMarker: true })).toBe("complete");
      expect(decideRetireAction({ trashHits: 0, hasMarker: true })).toBe("stop");
      expect(decideRetireAction({ trashHits: 0, hasMarker: false })).toBe("create");
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
