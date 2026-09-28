/**
 * Issue #102 単発解消の実 flow 回帰 (オフライン・I/O モジュール直結)。
 *
 * `master-dedup.test.ts` (純粋関数) だけでは守れない実 flow の分岐を、
 * 実コード (`master-dedup-3681-7129.ts` の export 関数) そのもので回帰する。
 * Notion/D1 への live I/O は持たない。ダウンロード検証のみ fetch を mock する。
 * テストが参照する 4 ページ ID は `TARGETS` 定数と同じ運用 ID のみ。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentDiskName,
  blockFileRefOf,
  blockTextOf,
  collectAttachmentInventory,
  expectedArchiveFileNames,
  extractMasterHits,
  guardIntermediateState,
  isAlreadyAppliedViews,
  isSearchSchemaUsable,
  loadSnapshotForResume,
  mapAttachmentArchiveNames,
  normalizedBlockForDigest,
  pageFilesRefsOf,
  pageProofsEqual,
  queryDbAll,
  readRelationFull,
  requireCompleteSnapshotProof,
  saveFreshEvidence,
  v2SnapshotArchiveName,
  verifyArchiveDownload,
  verifyArchivePage,
  verifyArchivedPage,
  verifyRetirePreimage,
  type BodyCapture,
  type FilesCapture,
  type FreshState,
  type NotionPage,
  type RawBlock,
  type SnapshotDoc,
} from "./master-dedup-3681-7129.js";
import {
  FWD_PROP_RAW,
  LIFECYCLE_PATCH_3681_STATUS,
  REL_PROP_MASTER,
  REVERSE_PROP_DISCLOSURES,
  REVERSE_PROP_FINANCIALS,
  REVERSE_PROP_JUKYU,
  REVERSE_PROP_YUTAI,
  SUPPLEMENT_7129_PAGE_ID,
  TARGETS,
  emptyReceipt,
  sha256HexBytes,
  sha256HexUtf8,
  stableStringify,
  type MasterPageView,
} from "./master-dedup.js";

vi.mock("../../src/shared/notion-archive/page-file.js", () => ({
  listPageFiles: vi.fn(),
  fetchPageFileUrl: vi.fn(),
}));

vi.mock("../../src/shared/notion-archive/client.js", () => ({
  notionRequest: vi.fn(),
  NotionUnknownResultError: class NotionUnknownResultError extends Error {},
  notionStats: vi.fn(),
  resetNotionStats: vi.fn(),
}));

import { listPageFiles } from "../../src/shared/notion-archive/page-file.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";

const KEEP_3681 = TARGETS[0].keepId;
const RETIRE_3681 = TARGETS[0].retireId;
const KEEP_7129 = TARGETS[1].keepId;
const RETIRE_7129 = TARGETS[1].retireId;

function rel(ids: string[]): { ids: string[]; has_more: boolean } {
  return { ids, has_more: false };
}

function baseViews(): Record<string, MasterPageView> {
  return {
    "3681:keep": {
      id: KEEP_3681,
      code: "3681",
      created_time: TARGETS[0].keepCreated,
      last_edited_time: TARGETS[0].keepEdited,
      archived: false,
      in_trash: false,
      listed: false,
      status: null,
      relations: {
        [REVERSE_PROP_DISCLOSURES]: rel([]),
        [REVERSE_PROP_FINANCIALS]: rel([]),
        [REVERSE_PROP_JUKYU]: rel([]),
        [REVERSE_PROP_YUTAI]: rel([]),
      },
      rawIds: ["raw-keep-3681"],
      blockCount: 0,
      childDatabases: [],
    },
    "3681:retire": {
      id: RETIRE_3681,
      code: "3681",
      created_time: TARGETS[0].retireCreated,
      last_edited_time: TARGETS[0].retireEdited,
      archived: false,
      in_trash: false,
      listed: true,
      status: "上場廃止",
      relations: {
        [REVERSE_PROP_DISCLOSURES]: rel(["d0", "d1"]),
        [REVERSE_PROP_FINANCIALS]: rel(["f0"]),
        [REVERSE_PROP_JUKYU]: rel([]),
        [REVERSE_PROP_YUTAI]: rel([]),
      },
      rawIds: ["raw-retire-3681"],
      blockCount: 0,
      childDatabases: [],
    },
    "7129:keep": {
      id: KEEP_7129,
      code: "7129",
      created_time: TARGETS[1].keepCreated,
      last_edited_time: TARGETS[1].keepEdited,
      archived: false,
      in_trash: false,
      listed: true,
      status: null,
      relations: {
        [REVERSE_PROP_DISCLOSURES]: rel(["kd0"]),
        [REVERSE_PROP_FINANCIALS]: rel(["kf0"]),
        [REVERSE_PROP_JUKYU]: rel([]),
        [REVERSE_PROP_YUTAI]: rel([]),
      },
      rawIds: ["raw-keep-7129"],
      blockCount: 1,
      childDatabases: ["株価テクニカル履歴"],
    },
    "7129:retire": {
      id: RETIRE_7129,
      code: "7129",
      created_time: TARGETS[1].retireCreated,
      last_edited_time: TARGETS[1].retireEdited,
      archived: false,
      in_trash: false,
      listed: true,
      status: null,
      relations: {
        [REVERSE_PROP_DISCLOSURES]: rel([]),
        [REVERSE_PROP_FINANCIALS]: rel([]),
        [REVERSE_PROP_JUKYU]: rel([]),
        [REVERSE_PROP_YUTAI]: rel([]),
      },
      rawIds: ["raw-retire-7129"],
      blockCount: 0,
      childDatabases: [],
    },
  };
}

/** MasterPageView から toMasterView が復元できる NotionPage を作る。 */
function pageFromView(v: MasterPageView): NotionPage {
  const relProp = (ids: string[]) => ({
    type: "relation",
    relation: ids.map((id) => ({ id })),
    has_more: false,
    id: `prop-${Math.random().toString(36).slice(2)}`,
  });
  return {
    id: v.id,
    created_time: v.created_time,
    last_edited_time: v.last_edited_time,
    archived: v.archived,
    in_trash: v.in_trash,
    properties: {
      "銘柄コード": { type: "title", title: [{ plain_text: v.code }] },
      "上場状態": { type: "checkbox", checkbox: v.listed },
      "状態": { type: "select", select: v.status ? { name: v.status } : null },
      [REVERSE_PROP_DISCLOSURES]: relProp(v.relations[REVERSE_PROP_DISCLOSURES]?.ids ?? []),
      [REVERSE_PROP_FINANCIALS]: relProp(v.relations[REVERSE_PROP_FINANCIALS]?.ids ?? []),
      [REVERSE_PROP_JUKYU]: relProp([]),
      [REVERSE_PROP_YUTAI]: relProp([]),
      [FWD_PROP_RAW]: relProp(v.rawIds),
    },
  };
}

function childrenFromView(v: MasterPageView): { results: Array<{ id: string; type: string; child_database?: { title?: string } }>; has_more: boolean; next_cursor: string | null } {
  const results: Array<{ id: string; type: string; child_database?: { title?: string } }> = [];
  for (const title of v.childDatabases) {
    results.push({ id: `child-${title}`, type: "child_database", child_database: { title } });
  }
  // blockCount と childDatabases の辻褄 (7129 keep は block 1 = 子 DB 1)。
  while (results.length < v.blockCount) {
    results.push({ id: `block-${results.length}`, type: "paragraph" });
  }
  return { results, has_more: false, next_cursor: null };
}

function knownSchemaHits() {
  return [
    { dbId: "d1", dbTitle: "③ 財務サマリ", propName: REL_PROP_MASTER, relType: "dual_property" as const },
    { dbId: "d2", dbTitle: "④ 開示書類", propName: REL_PROP_MASTER, relType: "dual_property" as const },
    { dbId: "d3", dbTitle: "⑤ 原本ファイル", propName: "関連銘柄", relType: "dual_property" as const },
    { dbId: "d4", dbTitle: "⑧ 需給", propName: REL_PROP_MASTER, relType: "dual_property" as const },
    { dbId: "d5", dbTitle: "⑨ 株主優待", propName: REL_PROP_MASTER, relType: "dual_property" as const },
    { dbId: "d6", dbTitle: "銘柄マスタ（補足）", propName: "銘柄マスタ", relType: "single_property" as const },
  ];
}

function baseEvidence() {
  return {
    edinet: {
      fetchedAt: "2026-09-28T00:00:00.000Z",
      sha256: "e".repeat(64),
      bytes: 100,
      listedCount: 3817,
      has3681: false,
      has7129: true,
    },
    jpx: {
      fetchedAt: "2026-09-28T00:00:00.000Z",
      sha256: "j".repeat(64),
      bytes: 200,
      rowFound: true,
    },
  };
}

function baseSnapshot(views: Record<string, MasterPageView>): SnapshotDoc {
  const masters: SnapshotDoc["masters"] = {};
  const idToRole: Record<string, { code: string; role: "keep" | "retire" }> = {
    [KEEP_3681]: { code: "3681", role: "keep" },
    [RETIRE_3681]: { code: "3681", role: "retire" },
    [KEEP_7129]: { code: "7129", role: "keep" },
    [RETIRE_7129]: { code: "7129", role: "retire" },
  };
  for (const [id, meta] of Object.entries(idToRole)) {
    const v = views[`${meta.code}:${meta.role}`];
    masters[id] = {
      code: meta.code,
      role: meta.role,
      page: pageFromView(v),
      children: childrenFromView(v),
    };
  }
  return {
    version: 1,
    takenAt: "2026-09-28T00:00:00.000Z",
    masters,
    incoming: {},
    supplement: {},
    d1: { "3681": KEEP_3681, "7129": KEEP_7129 },
    evidence: baseEvidence(),
    incomingSchema: { enumeratedAt: "2026-09-28T00:00:00.000Z", dbCount: 12, hits: knownSchemaHits() },
    sha256: "s".repeat(64),
  };
}

function baseState(views: Record<string, MasterPageView>): FreshState {
  return {
    views,
    pages: {},
    supplement: {
      byCode: {
        "3681": [],
        "7129": [{ pageId: SUPPLEMENT_7129_PAGE_ID, masterIds: [] }],
      },
      rowsReferencingTargets: [],
    },
    supplementPages: {},
    d1: { "3681": KEEP_3681, "7129": KEEP_7129 },
    evidence: baseEvidence(),
    incomingSchema: { enumeratedAt: "2026-09-28T00:00:00.000Z", dbCount: 12, hits: knownSchemaHits() },
  };
}

describe("master-dedup 実 flow 回帰", () => {
  describe("isAlreadyAppliedViews", () => {
    it("両 retire archived で真・それ以外は偽", () => {
      const views = baseViews();
      expect(isAlreadyAppliedViews(views)).toBe(false);
      views["3681:retire"].archived = true;
      expect(isAlreadyAppliedViews(views)).toBe(false);
      views["7129:retire"].archived = true;
      expect(isAlreadyAppliedViews(views)).toBe(true);
      views["3681:keep"].archived = true;
      expect(isAlreadyAppliedViews(views)).toBe(false);
    });
  });

  describe("guardIntermediateState (中間ガード分離)", () => {
    const ops = [
      { rowPageId: "d0", db: "disclosures" as const, prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
      { rowPageId: "d1", db: "disclosures" as const, prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
      { rowPageId: "f0", db: "financials" as const, prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681] },
    ];

    it("lifecycle-only 後も再開可能 (3681 keep の状態変化を許す)", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      receipt.lifecycle3681 = { patchedAt: "2026-09-28T01:00:00.000Z", verifiedAt: "2026-09-28T01:00:00.000Z" };
      views["3681:keep"].status = LIFECYCLE_PATCH_3681_STATUS;
      views["3681:keep"].last_edited_time = "2026-09-28T01:00:00.000Z";
      const state = baseState(views);
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems).toEqual([]);
    });

    it("lifecycle 未実施で 3681 keep が変わっていれば停止", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      views["3681:keep"].status = LIFECYCLE_PATCH_3681_STATUS;
      const state = baseState(views);
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems.length).toBeGreaterThan(0);
    });

    it("部分 relation 移行後も再開可能 (和の保存 + 記録一致)", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      receipt.migrated["d0"] = { db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681], verifiedAt: "2026-09-28T01:00:00.000Z" };
      // d0 が keep 側へ移動 (部分)。
      views["3681:keep"].relations[REVERSE_PROP_DISCLOSURES] = rel(["d0"]);
      views["3681:retire"].relations[REVERSE_PROP_DISCLOSURES] = rel(["d1"]);
      const state = baseState(views);
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems).toEqual([]);
    });

    it("記録と逆向きが食い違えば停止 (移行済みが retire 側)", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      receipt.migrated["d0"] = { db: "disclosures", prop: REL_PROP_MASTER, before: [RETIRE_3681], after: [KEEP_3681], verifiedAt: "2026-09-28T01:00:00.000Z" };
      // fresh は未移行のまま (d0 が retire 側) → 記録不一致で停止。
      const state = baseState(views);
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems.length).toBeGreaterThan(0);
    });

    it("片方退避後も再開可能 (retired は archived 必須)", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      receipt.retired[RETIRE_3681] = { archivedAt: "2026-09-28T02:00:00.000Z", verifiedAt: "2026-09-28T02:00:00.000Z" };
      views["3681:retire"].archived = true;
      views["3681:retire"].last_edited_time = "2026-09-28T02:00:00.000Z";
      const state = baseState(views);
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems).toEqual([]);
    });

    it("D1 candidate は未 fixed なら pendingFix として許可する", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      const state = baseState(views);
      state.d1 = { "3681": RETIRE_3681, "7129": KEEP_7129 };
      const { problems, d1PendingFix } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems).toEqual([]);
      expect(d1PendingFix).toEqual(["3681"]);
    });

    it("D1 fixed 済みで keep を指さなければ停止", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      receipt.d1 = { checkedAt: "2026-09-28T00:00:00.000Z", fixed: ["3681"], verifiedAt: "2026-09-28T00:00:00.000Z" };
      const state = baseState(views);
      state.d1 = { "3681": RETIRE_3681, "7129": KEEP_7129 };
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems.length).toBeGreaterThan(0);
    });

    it("incoming schema が snapshot と変化すれば停止", () => {
      const views = baseViews();
      const snapshot = baseSnapshot(baseViews());
      const receipt = emptyReceipt();
      receipt.snapshot = { file: "s.json", sha256: snapshot.sha256, archivePageId: "a1", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
      const state = baseState(views);
      state.incomingSchema = {
        enumeratedAt: "2026-09-28T01:00:00.000Z",
        dbCount: 13,
        hits: [...knownSchemaHits(), { dbId: "dx", dbTitle: "新規DB", propName: "銘柄マスタ", relType: "single_property" as const }],
      };
      const { problems } = guardIntermediateState({ state, snapshot, receipt, ops });
      expect(problems.length).toBeGreaterThan(0);
    });
  });

  describe("verifyArchivePage / expectedArchiveFileNames", () => {
    it("Status recorded + Files 3 + Metadata sha で合格", () => {
      const sha = "a".repeat(64);
      const page = {
        id: "archive-1",
        created_time: "2026-09-28T00:00:00.000Z",
        last_edited_time: "2026-09-28T00:00:00.000Z",
        properties: {
          Status: { select: { name: "recorded" } },
          Files: { files: [{ name: "a" }, { name: "b" }, { name: "c" }] },
          Metadata: { rich_text: [{ plain_text: `sha=${sha}` }] },
        },
      } as unknown as NotionPage;
      expect(() => verifyArchivePage(page, sha)).not.toThrow();
    });

    it("Files 2 件・sha 欠落は throw", () => {
      const sha = "a".repeat(64);
      const badFiles = {
        id: "archive-1",
        created_time: "2026-09-28T00:00:00.000Z",
        last_edited_time: "2026-09-28T00:00:00.000Z",
        properties: {
          Status: { select: { name: "recorded" } },
          Files: { files: [{ name: "a" }, { name: "b" }] },
          Metadata: { rich_text: [{ plain_text: `sha=${sha}` }] },
        },
      } as unknown as NotionPage;
      expect(() => verifyArchivePage(badFiles, sha)).toThrow();
    });

    it("ファイル名は日付タグから決定論的", () => {
      expect(expectedArchiveFileNames("2026-09-28")).toEqual([
        "master-dedup-snapshot-2026-09-28.json",
        "Edinetcode-2026-09-28.zip",
        "jpx-delisted-2026-09-28.html",
      ]);
    });
  });

  describe("verifyArchiveDownload (実バイト列 SHA)", () => {
    const ORIG_FETCH = globalThis.fetch;
    beforeEach(() => {
      vi.mocked(listPageFiles).mockReset();
    });
    afterEach(() => {
      globalThis.fetch = ORIG_FETCH;
    });

    it("3 件の SHA が一致すれば合格", async () => {
      const names = expectedArchiveFileNames("2026-09-28");
      const bodies: Record<string, Uint8Array> = {
        [names[0]]: new Uint8Array([1, 2, 3]),
        [names[1]]: new Uint8Array([4, 5]),
        [names[2]]: new Uint8Array([6]),
      };
      const shas: Record<string, string> = Object.fromEntries(
        Object.entries(bodies).map(([k, v]) => [k, sha256HexBytes(v)])
      );
      vi.mocked(listPageFiles).mockResolvedValue(
        names.map((name) => ({ name, url: `https://example.invalid/${name}` }))
      );
      globalThis.fetch = (async (url: unknown) => {
        const name = String(url).split("/").pop() as string;
        const bytes = bodies[name];
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer as ArrayBuffer } as Response;
      }) as typeof fetch;
      await expect(verifyArchiveDownload("archive-1", { names: [names[0], names[1], names[2]], shas })).resolves.toBeUndefined();
    });

    it("SHA 不一致は throw (すり替え検出)", async () => {
      const names = expectedArchiveFileNames("2026-09-28");
      vi.mocked(listPageFiles).mockResolvedValue(
        names.map((name) => ({ name, url: `https://example.invalid/${name}` }))
      );
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([9, 9]).buffer as ArrayBuffer,
      })) as unknown as typeof fetch;
      const shas: Record<string, string> = {
        [names[0]]: sha256HexBytes(new Uint8Array([1])),
        [names[1]]: sha256HexBytes(new Uint8Array([2])),
        [names[2]]: sha256HexBytes(new Uint8Array([3])),
      };
      await expect(verifyArchiveDownload("archive-1", { names: [names[0], names[1], names[2]], shas })).rejects.toThrow("SHA 不一致");
    });
  });

  describe("verifyArchivedPage / verifyRetirePreimage", () => {
    const retireId = RETIRE_3681;

    function archivedPage(overrides: Record<string, unknown> = {}): NotionPage {
      return {
        id: retireId,
        created_time: "2026-06-28T02:34:00.000Z",
        last_edited_time: "2026-09-28T02:00:00.000Z",
        archived: true,
        in_trash: false,
        properties: {},
        ...overrides,
      } as unknown as NotionPage;
    }

    it("対象 ID 一致 + archived なら合格", () => {
      expect(() => verifyArchivedPage(archivedPage(), retireId)).not.toThrow();
    });

    it("ID 不一致・未 archive は throw", () => {
      expect(() => verifyArchivedPage(archivedPage({ id: KEEP_3681 }), retireId)).toThrow(/対象 ID/);
      expect(() => verifyArchivedPage(archivedPage({ archived: false }), retireId)).toThrow(/archived/);
    });

    it("非 relation・body が一致すれば合格、不一致は throw", () => {
      const snapProps = {
        "上場状態": { type: "checkbox", checkbox: true },
        "状態": { type: "select", select: { name: "上場廃止" } },
        [REVERSE_PROP_DISCLOSURES]: { type: "relation", relation: [{ id: "d0" }] },
      };
      const freshSame = {
        "上場状態": { type: "checkbox", checkbox: true },
        "状態": { type: "select", select: { name: "上場廃止" } },
        [REVERSE_PROP_DISCLOSURES]: { type: "relation", relation: [] },
      };
      const freshDiff = {
        "上場状態": { type: "checkbox", checkbox: false },
        "状態": { type: "select", select: { name: "上場廃止" } },
        [REVERSE_PROP_DISCLOSURES]: { type: "relation", relation: [] },
      };
      expect(() =>
        verifyRetirePreimage({
          retireId,
          snapProps,
          snapBlockCount: 0,
          snapChildDbs: [],
          freshProps: freshSame,
          freshBlockCount: 0,
          freshChildDbs: [],
        })
      ).not.toThrow();
      expect(() =>
        verifyRetirePreimage({
          retireId,
          snapProps,
          snapBlockCount: 0,
          snapChildDbs: [],
          freshProps: freshDiff,
          freshBlockCount: 0,
          freshChildDbs: [],
        })
      ).toThrow();
      expect(() =>
        verifyRetirePreimage({
          retireId,
          snapProps,
          snapBlockCount: 0,
          snapChildDbs: [],
          freshProps: freshSame,
          freshBlockCount: 1,
          freshChildDbs: [],
        })
      ).toThrow();
    });
  });

  describe("loadSnapshotForResume / saveFreshEvidence (再開固定・原本保持)", () => {
    function writeSnapshotFile(dir: string, name: string, takenAt: string): string {
      const doc = {
        version: 1,
        takenAt,
        masters: {},
        incoming: {},
        supplement: {},
        d1: {},
        evidence: baseEvidence(),
        incomingSchema: { enumeratedAt: takenAt, dbCount: 0, hits: [] },
        sha256: "",
      };
      const { sha256: _drop, ...rest } = doc;
      void _drop;
      doc.sha256 = sha256HexUtf8(stableStringify(rest));
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      return doc.sha256;
    }

    it("marker hash の既存 snapshot を再利用する (最新でなくても固定)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-resume-"));
      try {
        const shaOld = writeSnapshotFile(dir, "snapshot-2026-09-28T00-00-00-000Z.json", "2026-09-28T00:00:00.000Z");
        writeSnapshotFile(dir, "snapshot-2026-09-28T01-00-00-000Z.json", "2026-09-28T01:00:00.000Z");
        const receipt = emptyReceipt();
        receipt.snapshotIssued = { key: "k", snapshotHash: shaOld, issuedAt: "2026-09-28T00:00:00.000Z" };
        const loaded = loadSnapshotForResume(dir, receipt);
        expect(loaded.snapshot.sha256).toBe(shaOld);
        expect(loaded.file).toContain("snapshot-2026-09-28T00-00-00-000Z.json");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("hash 混在・対応なしは throw (手動確認)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-resume-"));
      try {
        const sha = writeSnapshotFile(dir, "snapshot-2026-09-28T00-00-00-000Z.json", "2026-09-28T00:00:00.000Z");
        const mixed = emptyReceipt();
        mixed.snapshot = { file: "s.json", sha256: sha, archivePageId: "a", archiveVerifiedAt: "2026-09-28T00:00:00.000Z" };
        mixed.snapshotIssued = { key: "k", snapshotHash: "0".repeat(64), issuedAt: "2026-09-28T00:00:00.000Z" };
        expect(() => loadSnapshotForResume(dir, mixed)).toThrow();
        const missing = emptyReceipt();
        missing.snapshotIssued = { key: "k", snapshotHash: "f".repeat(64), issuedAt: "2026-09-28T00:00:00.000Z" };
        expect(() => loadSnapshotForResume(dir, missing)).toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("初回のみ fresh 証拠を保存する (bytes なしは throw)", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-evidence-"));
      try {
        saveFreshEvidence(dir, { zipBytes: new Uint8Array([1, 2]), htmlBytes: new Uint8Array([3]) });
        expect(new Uint8Array(fs.readFileSync(path.join(dir, "Edinetcode.zip")))).toEqual(new Uint8Array([1, 2]));
        expect(new Uint8Array(fs.readFileSync(path.join(dir, "jpx-delisted.html")))).toEqual(new Uint8Array([3]));
        expect(() => saveFreshEvidence(dir, undefined)).toThrow();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("requireCompleteSnapshotProof (完全 proof/CAS gate)", () => {
    function bodyProof(): BodyCapture {
      return { fullCapture: true, blocks: [], sha256: "b".repeat(64) };
    }
    function filesProof(): FilesCapture {
      return { complete: true, files: [], sha256: "f".repeat(64) };
    }
    /** gate の CAS 自己検証を通すため sha を再計算した v2 snapshot。 */
    function validV2Snapshot(): SnapshotDoc {
      const s = baseSnapshot(baseViews());
      s.version = 2;
      for (const m of Object.values(s.masters)) {
        m.body = bodyProof();
        m.files = filesProof();
      }
      s.incoming["d0"] = {
        db: "disclosures",
        prop: REL_PROP_MASTER,
        page: pageFromView(baseViews()["3681:retire"]),
        relationFull: [RETIRE_3681],
        blockCount: 0,
        childDatabases: [],
        body: bodyProof(),
        files: filesProof(),
      };
      s.supplement["supp1"] = pageFromView(baseViews()["7129:keep"]);
      s.supplementProof = { supp1: { body: bodyProof(), files: filesProof() } };
      s.incomingSchema = {
        enumeratedAt: "2026-09-28T00:00:00.000Z",
        dbCount: 12,
        hits: knownSchemaHits(),
        schemaProvenance: { searchSchemaUsed: 12, getSchemaUsed: 0 },
      };
      const { sha256: _drop, ...rest } = s;
      void _drop;
      s.sha256 = sha256HexUtf8(stableStringify(rest));
      return s;
    }

    it("完全 proof の v2 は許可する", () => {
      expect(() => requireCompleteSnapshotProof(validV2Snapshot(), emptyReceipt())).not.toThrow();
    });

    it("v1 は proof 不完全として STOP する", () => {
      const s = validV2Snapshot();
      s.version = 1;
      const { sha256: _drop, ...rest } = s;
      void _drop;
      s.sha256 = sha256HexUtf8(stableStringify(rest));
      expect(() => requireCompleteSnapshotProof(s, emptyReceipt())).toThrow(/旧 v1 snapshot/);
    });

    it("body/files proof の欠落は STOP する", () => {
      const noBody = validV2Snapshot();
      delete noBody.masters[KEEP_3681].body;
      const { sha256: _d1, ...r1 } = noBody;
      void _d1;
      noBody.sha256 = sha256HexUtf8(stableStringify(r1));
      expect(() => requireCompleteSnapshotProof(noBody, emptyReceipt())).toThrow(/body proof が不完全/);

      const noFiles = validV2Snapshot();
      delete noFiles.incoming["d0"].files;
      const { sha256: _d2, ...r2 } = noFiles;
      void _d2;
      noFiles.sha256 = sha256HexUtf8(stableStringify(r2));
      expect(() => requireCompleteSnapshotProof(noFiles, emptyReceipt())).toThrow(/attachment proof が不完全/);

      const noSupp = validV2Snapshot();
      delete noSupp.supplementProof;
      const { sha256: _d3, ...r3 } = noSupp;
      void _d3;
      noSupp.sha256 = sha256HexUtf8(stableStringify(r3));
      expect(() => requireCompleteSnapshotProof(noSupp, emptyReceipt())).toThrow(/body proof が不完全/);
    });

    it("実バイト列 SHA の欠落は STOP する", () => {
      const s = validV2Snapshot();
      s.masters[KEEP_3681].files = {
        complete: true,
        files: [{ where: "Files", name: "a.pdf", origin: "hosted", bytesSha256: "" }],
        sha256: "f".repeat(64),
      };
      const { sha256: _drop, ...rest } = s;
      void _drop;
      s.sha256 = sha256HexUtf8(stableStringify(rest));
      expect(() => requireCompleteSnapshotProof(s, emptyReceipt())).toThrow(/実バイト列 SHA/);
    });

    it("CAS drift (receipt/snapshot hash 不一致・v1 混在) は STOP する", () => {
      const s = validV2Snapshot();
      const drifted = emptyReceipt();
      drifted.snapshotV2 = {
        file: "s.json",
        sha256: "0".repeat(64),
        archivePageId: "a1",
        archiveVerifiedAt: "2026-09-28T00:00:00.000Z",
      };
      expect(() => requireCompleteSnapshotProof(s, drifted)).toThrow(/CAS drift/);

      const mixed = emptyReceipt();
      mixed.snapshot = {
        file: "s.json",
        sha256: s.sha256,
        archivePageId: "a1",
        archiveVerifiedAt: "2026-09-28T00:00:00.000Z",
      };
      expect(() => requireCompleteSnapshotProof(s, mixed)).toThrow(/v1 系/);
    });

    it("未知 incoming・provenance 不完全は STOP する", () => {
      const unknownHit = validV2Snapshot();
      unknownHit.incomingSchema = {
        ...unknownHit.incomingSchema,
        hits: [...knownSchemaHits(), { dbId: "dx", dbTitle: "新規DB", propName: "銘柄マスタ", relType: "single_property" as const }],
      };
      const { sha256: _d1, ...r1 } = unknownHit;
      void _d1;
      unknownHit.sha256 = sha256HexUtf8(stableStringify(r1));
      expect(() => requireCompleteSnapshotProof(unknownHit, emptyReceipt())).toThrow(/未知 incoming/);

      const noProv = validV2Snapshot();
      delete noProv.incomingSchema.schemaProvenance;
      const { sha256: _d2, ...r2 } = noProv;
      void _d2;
      noProv.sha256 = sha256HexUtf8(stableStringify(r2));
      expect(() => requireCompleteSnapshotProof(noProv, emptyReceipt())).toThrow(/取得経路が不完全/);
    });
  });

  describe("incoming schema 抽出 (search 再利用・省略禁止)", () => {
    const MASTER = "aa".repeat(16);

    it("完全 schema は usable・不完全は unusable", () => {
      expect(
        isSearchSchemaUsable({
          "銘柄マスタ": { id: "p1", type: "relation", relation: { database_id: MASTER, type: "dual_property" } },
          "名前": { id: "p2", type: "title" },
        })
      ).toBe(true);
      expect(isSearchSchemaUsable(undefined)).toBe(false);
      expect(isSearchSchemaUsable({})).toBe(false);
      expect(isSearchSchemaUsable({ "x": { id: "p1", type: "relation", relation: {} } })).toBe(false);
      expect(isSearchSchemaUsable({ "x": { id: "", type: "title" } })).toBe(false);
    });

    it("master 向け relation を抽出し、非向けは無視する", () => {
      const hits = extractMasterHits(
        "db1",
        "④ 開示書類",
        {
          "銘柄マスタ": { id: "p1", type: "relation", relation: { database_id: MASTER, type: "dual_property" } },
          "他": { id: "p2", type: "relation", relation: { database_id: "bb".repeat(16), type: "dual_property" } },
          "名前": { id: "p3", type: "title" },
        },
        MASTER
      );
      expect(hits).toEqual([{ dbId: "db1", dbTitle: "④ 開示書類", propName: "銘柄マスタ", relType: "dual_property" }]);
    });

    it("target 不明の relation は黙殺せず STOP する", () => {
      expect(() =>
        extractMasterHits("db1", "怪しいDB", { "r": { id: "p1", type: "relation" } }, MASTER)
      ).toThrow(/判定不能/);
    });
  });

  describe("添付 inventory・保管名 (v2)", () => {
    it("v2 保管名と disk 名は決定論的", () => {
      expect(v2SnapshotArchiveName("2026-09-28")).toBe("master-dedup-snapshot-v2-2026-09-28.json");
      expect(attachmentDiskName("a".repeat(64))).toBe(`attachment-${"a".repeat(64)}.bin`);
    });

    it("同名同 SHA は畳み、同名異 SHA・base 衝突は STOP する", () => {
      expect(
        mapAttachmentArchiveNames(["base.json"], [
          { name: "a.pdf", bytesSha256: "1".repeat(64) },
          { name: "a.pdf", bytesSha256: "1".repeat(64) },
          { name: "b.pdf", bytesSha256: "2".repeat(64) },
        ])
      ).toEqual([
        { archiveName: "a.pdf", sha256: "1".repeat(64) },
        { archiveName: "b.pdf", sha256: "2".repeat(64) },
      ]);
      expect(() =>
        mapAttachmentArchiveNames(["base.json"], [
          { name: "a.pdf", bytesSha256: "1".repeat(64) },
          { name: "a.pdf", bytesSha256: "2".repeat(64) },
        ])
      ).toThrow(/同名異 SHA/);
      expect(() =>
        mapAttachmentArchiveNames(["a.pdf"], [{ name: "a.pdf", bytesSha256: "1".repeat(64) }])
      ).toThrow(/衝突/);
    });

    it("snapshot 全体から添付を集める (props+本文再帰)", () => {
      const s = baseSnapshot(baseViews());
      s.masters[KEEP_3681].files = {
        complete: true,
        files: [{ where: "Files", name: "p.pdf", origin: "hosted", bytesSha256: "1".repeat(64) }],
        sha256: "f".repeat(64),
      };
      s.masters[KEEP_3681].body = {
        fullCapture: true,
        blocks: [
          {
            id: "b1",
            type: "image",
            hasChildren: false,
            text: "",
            raw: { id: "b1", type: "image" },
            file: { name: "i.png", origin: "hosted", bytesSha256: "2".repeat(64) },
            digest: "d".repeat(64),
          },
        ],
        sha256: "b".repeat(64),
      };
      expect(collectAttachmentInventory(s)).toEqual([
        { name: "p.pdf", origin: "hosted", bytesSha256: "1".repeat(64) },
        { name: "i.png", origin: "hosted", bytesSha256: "2".repeat(64) },
      ]);
    });

    it("v2 件数の verifyArchivePage (3 以外も検証)", () => {
      const sha = "a".repeat(64);
      const page = {
        id: "archive-v2",
        created_time: "2026-09-28T00:00:00.000Z",
        last_edited_time: "2026-09-28T00:00:00.000Z",
        properties: {
          Status: { select: { name: "recorded" } },
          Files: { files: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] },
          Metadata: { rich_text: [{ plain_text: `sha=${sha}` }] },
        },
      } as unknown as NotionPage;
      expect(() => verifyArchivePage(page, sha, 4)).not.toThrow();
      expect(() => verifyArchivePage(page, sha, 3)).toThrow();
    });
  });

  describe("block/files 抽出 (text・ref・digest)", () => {
    it("rich_text/caption/子 DB title を平文にする", () => {
      expect(
        blockTextOf({
          id: "b1",
          type: "paragraph",
          paragraph: { rich_text: [{ plain_text: "あ" }, { plain_text: "い" }] },
        } as unknown as RawBlock)
      ).toBe("あい");
      expect(
        blockTextOf({
          id: "b2",
          type: "child_database",
          child_database: { title: "株価テクニカル履歴" },
        } as unknown as RawBlock)
      ).toBe("株価テクニカル履歴");
      expect(blockTextOf({ id: "b3", type: "divider", divider: {} } as unknown as RawBlock)).toBe("");
    });

    it("file 系の参照 (hosted/外部) と URL 欠落 STOP", () => {
      expect(
        blockFileRefOf({
          id: "b1",
          type: "image",
          image: { type: "file", name: "i.png", file: { url: "https://signed.invalid/x", expiry_time: "t" } },
        } as unknown as RawBlock)
      ).toEqual({ name: "i.png", origin: "hosted", url: "https://signed.invalid/x" });
      expect(
        blockFileRefOf({
          id: "b2",
          type: "paragraph",
          paragraph: { rich_text: [] },
        } as unknown as RawBlock)
      ).toBeNull();
      expect(() =>
        blockFileRefOf({ id: "b3", type: "file", file: { type: "file", file: {} } } as unknown as RawBlock)
      ).toThrow(/実体 URL が無い/);
    });

    it("files プロパティの全エントリを抽出し、URL 欠落は STOP する", () => {
      const page = {
        id: "p1",
        properties: {
          Files: {
            type: "files",
            files: [
              { name: "h.pdf", type: "file", file: { url: "https://signed.invalid/h" } },
              { name: "e.pdf", type: "external", external: { url: "https://example.invalid/e.pdf" } },
            ],
          },
          名前: { type: "title", title: [] },
        },
      } as unknown as NotionPage;
      expect(pageFilesRefsOf(page)).toEqual([
        { prop: "Files", name: "h.pdf", origin: "hosted", url: "https://signed.invalid/h" },
        { prop: "Files", name: "e.pdf", origin: "https://example.invalid/e.pdf", url: "https://example.invalid/e.pdf" },
      ]);
      const bad = {
        id: "p2",
        properties: { Files: { type: "files", files: [{ name: "x.pdf", type: "file", file: {} }] } },
      } as unknown as NotionPage;
      expect(() => pageFilesRefsOf(bad)).toThrow(/実体 URL が無い/);
    });

    it("digest 正規化は署名 URL だけ除き外部 URL は残す", () => {
      const block = {
        id: "b1",
        type: "image",
        image: {
          type: "file",
          file: { url: "https://signed.invalid/x", expiry_time: "t" },
          caption: [{ plain_text: "c" }],
        },
      } as unknown as RawBlock;
      const norm = normalizedBlockForDigest(block) as Record<string, Record<string, Record<string, unknown>>>;
      expect(norm["image"]["file"]).toEqual({});
      expect(norm["image"]["caption"]).toEqual([{ plain_text: "c" }]);
    });

    it("正規化は annotations/link/checked の原構造を保持する", () => {
      const block = {
        id: "b1",
        type: "to_do",
        to_do: {
          rich_text: [
            {
              plain_text: "やる",
              annotations: { bold: true, italic: false, code: false },
              text: { content: "やる", link: { url: "https://example.invalid/todo" } },
            },
          ],
          checked: true,
        },
      } as unknown as RawBlock;
      const norm = normalizedBlockForDigest(block) as {
        to_do: { rich_text: Array<Record<string, unknown>>; checked: boolean };
      };
      expect(norm.to_do.checked).toBe(true);
      expect(norm.to_do.rich_text[0]?.["annotations"]).toEqual({ bold: true, italic: false, code: false });
      expect(norm.to_do.rich_text[0]?.["text"]).toEqual({
        content: "やる",
        link: { url: "https://example.invalid/todo" },
      });
    });
  });

  describe("fresh proof 照合 (更新直前の内容一致)", () => {
    const snap = {
      body: { fullCapture: true as const, blocks: [], sha256: "b".repeat(64) },
      files: { complete: true as const, files: [], sha256: "f".repeat(64) },
    };

    it("両 SHA 一致で真・いずれか不一致/欠落で偽", () => {
      expect(pageProofsEqual(snap, { body: snap.body, files: snap.files })).toBe(true);
      expect(
        pageProofsEqual(snap, {
          body: { ...snap.body, sha256: "c".repeat(64) },
          files: snap.files,
        })
      ).toBe(false);
      expect(
        pageProofsEqual(snap, {
          body: snap.body,
          files: { ...snap.files, sha256: "d".repeat(64) },
        })
      ).toBe(false);
      expect(pageProofsEqual({ body: undefined, files: snap.files }, { body: snap.body, files: snap.files })).toBe(false);
    });

    it("退避原像は proofs 付きで内容一致を要求する", () => {
      const snapProps = { "上場状態": { type: "checkbox", checkbox: true } };
      const base = {
        retireId: RETIRE_3681,
        snapProps,
        snapBlockCount: 0,
        snapChildDbs: [] as string[],
        freshProps: { ...snapProps },
        freshBlockCount: 0,
        freshChildDbs: [] as string[],
      };
      expect(() =>
        verifyRetirePreimage({ ...base, proofs: { snapBody: snap.body, snapFiles: snap.files, freshBody: snap.body, freshFiles: snap.files } })
      ).not.toThrow();
      expect(() =>
        verifyRetirePreimage({
          ...base,
          proofs: {
            snapBody: snap.body,
            snapFiles: snap.files,
            freshBody: { ...snap.body, sha256: "c".repeat(64) },
            freshFiles: snap.files,
          },
        })
      ).toThrow(/本文・添付が変化/);
    });
  });

  describe("ページ送りの has_more/cursor 欠落は STOP する", () => {
    beforeEach(() => {
      vi.mocked(notionRequest).mockReset();
    });

    it("queryDbAll は has_more なのに cursor なしで STOP する", async () => {
      vi.mocked(notionRequest).mockResolvedValueOnce({ results: [], has_more: true, next_cursor: null });
      await expect(queryDbAll(0, "db1", {})).rejects.toThrow(/next_cursor なし/);
    });

    it("queryDbAll の正常ページ送りは全件返す (誤 STOP しない)", async () => {
      vi.mocked(notionRequest)
        .mockResolvedValueOnce({ results: [{ id: "r1" }], has_more: true, next_cursor: "c1" })
        .mockResolvedValueOnce({ results: [{ id: "r2" }], has_more: false, next_cursor: null });
      const out = await queryDbAll(0, "db1", {});
      expect(out.map((r) => (r as unknown as { id: string }).id)).toEqual(["r1", "r2"]);
    });

    it("readRelationFull は has_more なのに cursor なしで STOP する", async () => {
      const page = {
        id: "p1",
        properties: { rel: { type: "relation", id: "prop-1", relation: [], has_more: true } },
      } as unknown as NotionPage;
      vi.mocked(notionRequest).mockResolvedValueOnce({ results: [], has_more: true, next_cursor: null });
      await expect(readRelationFull(0, "p1", page, "rel")).rejects.toThrow(/next_cursor なし/);
    });
  });
});
