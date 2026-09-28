/**
 * run-spec.ts (取得元 spec の共通取込フロー) のテスト。
 * Notion 側 (notion-archive / archived-files) はモックし、分岐ごとに
 * 「取得元へ取りに行くか」「何を保管し何を書いたか」を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MoneyflowSourceSpec, ObservationDraft } from "../../../services/moneyflow/lib/source-spec.js";

const notion = {
  ensureObservationsDb: vi.fn(async () => ({ dbId: "obs-db" })),
  isArchived: vi.fn(async (_s: string, _k: string, _p?: string) => false),
  recordPrimaryData: vi.fn(async (_i: unknown) => ({ pageId: "primary-1", outcome: "recorded", fileTooLarge: false })),
  upsertObservation: vi.fn(
    async (_db: string, _i: unknown): Promise<{ pageId: string; outcome: "created" | "updated" | "unchanged" }> => ({
      pageId: "row",
      outcome: "created",
    })
  ),
};
const archived = {
  requirePrimaryDataDbId: vi.fn(async () => "primary-db"),
  findArchivedRecordByKey: vi.fn(async (_db: string, key: string) => ({
    pageId: "primary-old",
    key,
    files: [{ name: "data.csv", url: "https://files.notion.test/data.csv" }],
  })),
  downloadArchivedFile: vi.fn(async () => new TextEncoder().encode("archived")),
  listArchivedRecordsByPrefix: vi.fn(),
};

vi.mock("../../../src/shared/notion-archive/index.js", () => notion);
vi.mock("./archived-files.js", () => archived);

const rows = (source: string): ObservationDraft[] => [
  {
    period: "2026-08",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    indicatorKey: "k1",
    category: `${source}-A`,
    categoryKind: "投資部門",
    value: 1,
    unit: "円",
    changeFromPrev: null,
    approximate: false,
    measureKind: "実測",
  },
  {
    period: "2026-08",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    indicatorKey: "k1",
    category: `${source}-B`,
    categoryKind: "投資部門",
    value: 2,
    unit: "円",
    changeFromPrev: null,
    approximate: false,
    measureKind: "実測",
  },
];

function makeSpec(overrides: { fetchKey?: string } = {}) {
  const fetchImpl = vi.fn(async () => ({
    key: overrides.fetchKey ?? "src-2026-08",
    source: "https://example.jp/data.csv",
    metadata: { publishedOn: "2026-09-10" },
    files: [{ filename: "data.csv", bytes: new TextEncoder().encode("fresh"), contentType: "text/csv" }],
  }));
  const spec: MoneyflowSourceSpec = {
    name: "test-src",
    indicators: [
      {
        key: "k1",
        displayName: "指標",
        requirement: "R2",
        flowType: "純買い越し",
        description: "d",
        sourceUrl: "https://example.jp/",
        license: "personal-only",
        frequency: "月次",
        limitations: "l",
      },
    ],
    resolve: async () => ({ key: "src-2026-08", fetch: fetchImpl }),
    toObservations: ({ files }) => rows(new TextDecoder().decode(files[0]?.bytes)),
  };
  return { spec, fetchImpl };
}

const ctx = (dryRun = false) => ({ dryRun, now: new Date("2026-09-27T00:00:00Z"), indicatorPageId: () => "def-page" });

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSpec", () => {
  it("未保管のキー: 取得 → 先に一次データを実体保管 → 観測ログへ配列順に upsert", async () => {
    const { runSpec } = await import("./run-spec.js");
    const { spec, fetchImpl } = makeSpec();
    const detail = await runSpec(spec, ctx());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // 一次データは他サービスと同じ既定の「一次データ保管」配下 (parentPageId を渡さない)
    expect(notion.recordPrimaryData).toHaveBeenCalledWith(
      expect.objectContaining({ service: "moneyflow", key: "src-2026-08" })
    );
    expect(notion.recordPrimaryData.mock.calls[0]?.[0]).not.toHaveProperty("parentPageId");
    const written = notion.upsertObservation.mock.calls.map((c) => (c[1] as { category: string; primaryDataPageId: string }));
    expect(written.map((w) => w.category)).toEqual(["fresh-A", "fresh-B"]);
    expect(written.every((w) => w.primaryDataPageId === "primary-1")).toBe(true);
    expect(detail).toMatch(/src-2026-08 を記録 2行 \(新規2\/更新0\/同値0\)/);
  });

  it("保管済み・全行同値: 全 draft を upsert して書かず「未更新」(最後の1行で skip しない)", async () => {
    notion.isArchived.mockResolvedValueOnce(true);
    notion.upsertObservation
      .mockResolvedValueOnce({ pageId: "row-a", outcome: "unchanged" as const })
      .mockResolvedValueOnce({ pageId: "row-b", outcome: "unchanged" as const });
    const { runSpec } = await import("./run-spec.js");
    const { spec, fetchImpl } = makeSpec();
    const detail = await runSpec(spec, ctx());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notion.recordPrimaryData).not.toHaveBeenCalled();
    // 全 draft を upsert にかける (同値確認のため照会はする)。
    expect(notion.upsertObservation).toHaveBeenCalledTimes(2);
    expect(detail).toMatch(/未更新.*2行同値確認/);
  });

  it("保管済み・途中欠落あり: 全 draft を upsert して欠落だけ修復する", async () => {
    notion.isArchived.mockResolvedValueOnce(true);
    // 最後の行は同値だが最初の行が欠落 → 最終行 skip では見落とす形。
    notion.upsertObservation
      .mockResolvedValueOnce({ pageId: "row-a", outcome: "created" as const })
      .mockResolvedValueOnce({ pageId: "row-b", outcome: "unchanged" as const });
    const { runSpec } = await import("./run-spec.js");
    const { spec, fetchImpl } = makeSpec();
    const detail = await runSpec(spec, ctx());
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(archived.downloadArchivedFile).toHaveBeenCalledTimes(1);
    const written = notion.upsertObservation.mock.calls.map((c) => c[1] as { category: string; primaryDataPageId: string });
    expect(written.map((w) => w.category)).toEqual(["archived-A", "archived-B"]);
    expect(written.every((w) => w.primaryDataPageId === "primary-old")).toBe(true);
    expect(detail).toMatch(/保管済み src-2026-08 から観測ログを再送 2行 \(新規1\/更新0\/同値1\)/);
  });

  it("保管済みなのにレコードが見つからない・ファイルが無いなら throw (整合性エラーを隠さない)", async () => {
    const { runSpec } = await import("./run-spec.js");
    notion.isArchived.mockResolvedValueOnce(true);
    archived.findArchivedRecordByKey.mockResolvedValueOnce(null as never);
    await expect(runSpec(makeSpec().spec, ctx())).rejects.toThrow(/整合性エラー/);
    notion.isArchived.mockResolvedValueOnce(true);
    archived.findArchivedRecordByKey.mockResolvedValueOnce({ pageId: "p", key: "src-2026-08", files: [] });
    await expect(runSpec(makeSpec().spec, ctx())).rejects.toThrow(/ファイルがありません/);
  });

  it("resolve と取得結果のキーが食い違えば保管も書込もせず throw", async () => {
    const { runSpec } = await import("./run-spec.js");
    const { spec } = makeSpec({ fetchKey: "src-2026-07" });
    await expect(runSpec(spec, ctx())).rejects.toThrow(/一致しません/);
    expect(notion.recordPrimaryData).not.toHaveBeenCalled();
    expect(notion.upsertObservation).not.toHaveBeenCalled();
  });

  it("dry-run は Notion を一切呼ばない (取得と解析・検証だけ)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { runSpec } = await import("./run-spec.js");
    const { spec, fetchImpl } = makeSpec();
    const detail = await runSpec(spec, ctx(true));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const fn of [notion.isArchived, notion.recordPrimaryData, notion.upsertObservation, notion.ensureObservationsDb]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(detail).toBe("dry-run key=src-2026-08 2行");
    info.mockRestore();
  });

  it("解析にはバイト列のコピーを渡す (解析側が detach しても保管用のバイト列は壊れない)", async () => {
    const { runSpec } = await import("./run-spec.js");
    const { spec, fetchImpl } = makeSpec();
    let seen: Uint8Array | undefined;
    const detaching: MoneyflowSourceSpec = {
      ...spec,
      toObservations: (input) => {
        seen = input.files[0]?.bytes;
        return spec.toObservations(input);
      },
    };
    await runSpec(detaching, ctx());
    const fetched = (await fetchImpl.mock.results[0]?.value) as { files: Array<{ bytes: Uint8Array }> };
    expect(seen).toBeDefined();
    expect(seen).not.toBe(fetched.files[0]?.bytes);
    expect(Array.from(seen ?? [])).toEqual(Array.from(fetched.files[0]?.bytes ?? []));
  });

  it("解析結果が検証に通らなければ (0 行等) 観測ログへ書かない", async () => {
    const { runSpec } = await import("./run-spec.js");
    const { spec } = makeSpec();
    const broken: MoneyflowSourceSpec = { ...spec, toObservations: () => [] };
    await expect(runSpec(broken, ctx())).rejects.toThrow(/0 件/);
    // 一次データは解析前に保管済み (様式変更でも原本は残す — ルール6)
    expect(notion.recordPrimaryData).toHaveBeenCalledTimes(1);
    expect(notion.upsertObservation).not.toHaveBeenCalled();
  });
});
