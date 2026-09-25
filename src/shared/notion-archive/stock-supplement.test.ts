/**
 * 「銘柄マスタ（補足）」Notion 保管のテスト。
 *
 * 純粋関数 (buildSupplementProperties / chunkPropertiesByBytes /
 * buildEvidenceBlock) はネットワークなしで検証する。fetch を差し替える網羅は
 * stock-text.test.ts と同じ router+queue+Date.now fast-forward の方式。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvidenceBlock,
  buildSupplementProperties,
  chunkPropertiesByBytes,
} from "./stock-supplement.js";

describe("stock-supplement (純粋関数)", () => {
  describe("buildSupplementProperties", () => {
    it("undefined のフィールドはペイロードから省略する", () => {
      const props = buildSupplementProperties({ companyName: "トヨタ自動車" });
      expect(Object.keys(props)).toEqual(["銘柄名"]);
      expect(props["銘柄名"]).toEqual({ title: [{ type: "text", text: { content: "トヨタ自動車" } }] });
    });

    it("null は明示的にクリアする (rich_text/select/date/number/relation)", () => {
      const props = buildSupplementProperties({
        docId: null,
        sector33: null,
        periodEnd: null,
        candidateCount: null,
        masterPageId: null,
      });
      expect(props["有報書類ID"]).toEqual({ rich_text: [] });
      expect(props["33業種"]).toEqual({ select: null });
      expect(props["会計期末"]).toEqual({ date: null });
      expect(props["候補語数"]).toEqual({ number: null });
      expect(props["銘柄マスタ"]).toEqual({ relation: [] });
    });

    it("masterPageId 指定時は 1 件の relation", () => {
      const props = buildSupplementProperties({ masterPageId: "page-abc" });
      expect(props["銘柄マスタ"]).toEqual({ relation: [{ id: "page-abc" }] });
    });

    it("texts は列ごとに rich_text へ変換し、null/空文字はクリアする", () => {
      const props = buildSupplementProperties({
        texts: { 事業の内容: "半導体を製造する。", 対処すべき課題: null, 研究開発活動: "" },
      });
      expect(props["事業の内容"]).toEqual({
        rich_text: [{ type: "text", text: { content: "半導体を製造する。" } }],
      });
      expect(props["対処すべき課題"]).toEqual({ rich_text: [] });
      expect(props["研究開発活動"]).toEqual({ rich_text: [] });
    });

    it("multi_select は名前配列に変換する", () => {
      const props = buildSupplementProperties({
        upstream: ["半導体パッケージ・基板材料"],
        themes: [],
      });
      expect(props["事業タグ（素材・部品・装置）"]).toEqual({
        multi_select: [{ name: "半導体パッケージ・基板材料" }],
      });
      expect(props["投資テーマ"]).toEqual({ multi_select: [] });
    });

    it("事業タグ（流通・サービス）列も multi_select として書ける (第3列)", () => {
      const props = buildSupplementProperties({ distribution: ["人材紹介・派遣"] });
      expect(props["事業タグ（流通・サービス）"]).toEqual({
        multi_select: [{ name: "人材紹介・派遣" }],
      });
    });

    it("事業タグの根拠文は rich_text。null は明示的にクリアする(タグ再判定時)", () => {
      const withText = buildSupplementProperties({
        evidenceText: "核酸医薬（はい 0.93）：「テスト引用文」— 事業の内容",
      });
      expect(withText["事業タグの根拠文"]).toEqual({
        rich_text: [{ type: "text", text: { content: "核酸医薬（はい 0.93）：「テスト引用文」— 事業の内容" } }],
      });
      const cleared = buildSupplementProperties({ evidenceText: null });
      expect(cleared["事業タグの根拠文"]).toEqual({ rich_text: [] });
    });

    it("multi_select が 100 件を超えると throw", () => {
      const many = Array.from({ length: 101 }, (_, i) => `語${i}`);
      expect(() => buildSupplementProperties({ upstream: many })).toThrow("100 件");
    });

    it("選択肢名にカンマがあると throw (select)", () => {
      expect(() => buildSupplementProperties({ sector33: "電気機器,精密機器" })).toThrow(
        "カンマ"
      );
    });

    it("読点「、」はカンマではないので通す (33業種「証券、商品先物取引業」の実例)", () => {
      const props = buildSupplementProperties({ sector33: "証券、商品先物取引業" });
      expect(props["33業種"]).toEqual({ select: { name: "証券、商品先物取引業" } });
    });

    it("全角カンマ「，」は throw", () => {
      expect(() => buildSupplementProperties({ sector33: "電気機器，精密機器" })).toThrow("カンマ");
    });

    it("選択肢名にカンマがあると throw (multi_select)", () => {
      expect(() => buildSupplementProperties({ upstream: ["A,B"] })).toThrow("カンマ");
    });

    it("rich_text が 100 要素を超える (200,000字超) と throw", () => {
      const huge = "あ".repeat(2000 * 101);
      expect(() => buildSupplementProperties({ error: huge })).toThrow("100");
    });

    it("docId/tagStatus/tagDoc/vocabVersion (書類の同定+判定結果) は他の列より後ろに置かれ、同じ最終チャンクにまとまる", () => {
      // 中断安全性の回帰テスト: 本文列 (39列・最大 30,000字/列) が大きいときに
      // 複数 PATCH へ分割されても、「有報書類ID」が確定するのと同じチャンクで
      // 「事業タグの状態」「事業タグの根拠書類」「単語帳の版」も確定しないと、
      // 中断時に「docId は新しいのにタグは古い」という不変条件違反が起きうる
      // (docs §3.1)。
      // 実測 (docs §3.1): 本文列 1 項目の最大は 30,000字。5 列分足すと
      // 既定の 400,000B 上限を超える (複数チャンクに分割される)。
      const bigText = "あ".repeat(30_000);
      const props = buildSupplementProperties({
        companyName: "テスト株式会社",
        stockCode: "0000",
        texts: {
          事業の内容: bigText,
          "セグメント情報等、財務諸表": bigText,
          対処すべき課題: bigText,
          事業等のリスク: bigText,
          研究開発活動: bigText,
        },
        upstream: ["半導体パッケージ・基板材料"],
        docId: "S100NEW",
        docType: "有報",
        periodEnd: "2026-03-31",
        submittedAt: "2026-06-25",
        tagStatus: "判定済",
        tagDoc: "S100NEW 2026年3月期",
        vocabVersion: "v1",
      });
      const chunks = chunkPropertiesByBytes(props);
      expect(chunks.length).toBeGreaterThan(1);

      const completionKeys = ["有報書類ID", "書類種別", "会計期末", "提出日", "事業タグの状態", "事業タグの根拠書類", "単語帳の版"];
      const lastChunk = chunks[chunks.length - 1];
      for (const key of completionKeys) {
        expect(lastChunk).toHaveProperty(key);
      }
      // どの列も最終チャンクより前には現れない (中断されたらこのグループは
      // まるごと未送信のまま = 前回の値がそのまま残る)。
      for (const chunk of chunks.slice(0, -1)) {
        for (const key of completionKeys) {
          expect(chunk).not.toHaveProperty(key);
        }
      }
    });
  });

  describe("chunkPropertiesByBytes", () => {
    it("空オブジェクトは空配列", () => {
      expect(chunkPropertiesByBytes({})).toEqual([]);
    });

    it("小さいプロパティは 1 チャンクにまとまる", () => {
      const props = { a: 1, b: "x", c: { rich_text: [] } };
      const chunks = chunkPropertiesByBytes(props, 400_000);
      expect(chunks).toEqual([props]);
    });

    it("上限を超えたら複数チャンクに分け、全プロパティが欠落なく含まれる", () => {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < 5; i++) props[`col${i}`] = "x".repeat(100_000);
      const chunks = chunkPropertiesByBytes(props, 150_000);
      expect(chunks.length).toBeGreaterThan(1);
      const merged = Object.assign({}, ...chunks);
      expect(merged).toEqual(props);
      for (const c of chunks) {
        const bytes = new TextEncoder().encode(JSON.stringify(c)).length;
        expect(bytes).toBeLessThanOrEqual(150_000 + 1); // 単一プロパティ由来の丸め誤差のみ許容
      }
    });

    it("単一プロパティが上限を超えると throw", () => {
      const props = { huge: "x".repeat(1_000_000) };
      expect(() => chunkPropertiesByBytes(props, 400_000)).toThrow("上限");
    });
  });

  describe("buildEvidenceBlock", () => {
    it("見出し文言・quote 子ブロックを組み立てる", () => {
      const block = buildEvidenceBlock({
        vocabVersion: "v1",
        docId: "S100W6XE",
        periodLabel: "2025年3月期",
        items: [
          {
            labelJa: "半導体パッケージ・基板材料",
            band: "yes",
            probability: 0.93,
            sentences: [{ text: "ABFは…", sectionTitle: "事業の内容" }],
          },
          {
            labelJa: "〇〇",
            band: "uncertain",
            probability: 0.55,
            sentences: [],
          },
        ],
      }) as {
        type: string;
        heading_3: {
          rich_text: Array<{ text: { content: string } }>;
          is_toggleable: boolean;
          children: Array<{ type: string; quote: { rich_text: Array<{ text: { content: string } }> } }>;
        };
      };
      expect(block.type).toBe("heading_3");
      expect(block.heading_3.is_toggleable).toBe(true);
      expect(block.heading_3.rich_text[0]?.text.content).toBe(
        "事業タグの根拠（単語帳 v1・有報 S100W6XE 2025年3月期）"
      );
      expect(block.heading_3.children).toHaveLength(2);
      const first = block.heading_3.children[0]?.quote.rich_text[0]?.text.content ?? "";
      expect(first).toContain("半導体パッケージ・基板材料（はい 0.93）");
      expect(first).toContain("「ABFは…」 — 有報 S100W6XE 2025年3月期「事業の内容」");
      const second = block.heading_3.children[1]?.quote.rich_text[0]?.text.content ?? "";
      expect(second).toBe("要確認: 〇〇（確認不能 0.55）");
    });

    it("101 件を超えると throw", () => {
      const items = Array.from({ length: 101 }, (_, i) => ({
        labelJa: `語${i}`,
        band: "yes" as const,
        probability: 0.9,
        sentences: [],
      }));
      expect(() =>
        buildEvidenceBlock({ vocabVersion: "v1", docId: "S1", periodLabel: "2025年3月期", items })
      ).toThrow("100");
    });
  });
});

describe("stock-supplement (Notion 通信)", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;
  type FetchCalls = Array<{ url: string; init: RequestInit }>;
  let calls: FetchCalls;
  let routes: Map<string, unknown[]>;

  const route = (method: string, path: string, bodies: unknown[]) => {
    routes.set(`${method} ${path}`, [...bodies]);
  };
  const jsonResponse = (body: unknown): Response =>
    ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as Response;

  const STOCK_INFO = "e".repeat(32);
  const MASTER_DB = "f".repeat(32);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNow = Date.now;
    calls = [];
    routes = new Map();
    process.env.NOTION_TOKEN = "dummy-token";
    process.env.NOTION_STOCK_INFO_PAGE_ID = STOCK_INFO;
    process.env.NOTION_DB_STOCK_MASTER = MASTER_DB;
    delete process.env.NOTION_STOCK_SUPPLEMENT_DB_ID;
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      const q = routes.get(key);
      if (!q || q.length === 0) throw new Error(`テスト: 未定義ルートへの fetch: ${key}`);
      return jsonResponse(q.shift());
    }) as typeof fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    process.env = { ...ORIG_ENV };
    vi.clearAllMocks();
    vi.resetModules();
  });

  const load = () => import("./stock-supplement.js");

  const spec = {
    textColumns: ["事業の内容", "対処すべき課題"],
    upstreamOptions: ["半導体パッケージ・基板材料"],
    downstreamOptions: ["自動車"],
    distributionOptions: ["人材紹介・派遣"],
    themeOptions: ["半導体サプライチェーン"],
    versionOptions: ["v1"],
    sector33Options: ["輸送用機器"],
  };

  describe("ensureSupplementDb", () => {
    it("Search 未ヒットなら新規作成し、propertyIds を返す", async () => {
      const searchPage = { results: [], has_more: false, next_cursor: null };
      route("POST", "/v1/search", [searchPage]);
      // Search 未ヒット時の保険走査 (findBackupChildByTitle の仕様)
      route("GET", `/v1/blocks/${STOCK_INFO}/children`, [
        { results: [], has_more: false, next_cursor: null },
      ]);
      route("POST", "/v1/databases", [
        {
          id: "db-new",
          properties: { 銘柄名: { id: "title-id", type: "title" }, 銘柄コード: { id: "code-id", type: "rich_text" } },
        },
      ]);
      const { ensureSupplementDb } = await load();
      const got = await ensureSupplementDb(spec);
      expect(got).toEqual({
        dbId: "db-new",
        created: true,
        propertyIds: { 銘柄名: "title-id", 銘柄コード: "code-id" },
      });
      const createBody = JSON.parse(String(calls[2]?.init.body)) as {
        parent: { page_id: string };
        properties: Record<string, unknown>;
      };
      expect(createBody.parent.page_id).toBe(STOCK_INFO);
      expect(createBody.properties["事業の内容"]).toEqual({ rich_text: {} });
      expect(createBody.properties["銘柄マスタ"]).toEqual({
        relation: { database_id: MASTER_DB, type: "single_property", single_property: {} },
      });
    });

    it("固定 DB ID があれば Search をスキップする", async () => {
      process.env.NOTION_STOCK_SUPPLEMENT_DB_ID = "d".repeat(32);
      route("GET", `/v1/databases/${"d".repeat(32)}`, [
        { id: "d".repeat(32), properties: buildFullSchema(spec.textColumns) },
      ]);
      const { ensureSupplementDb } = await load();
      const got = await ensureSupplementDb(spec);
      expect(got.dbId).toBe("d".repeat(32));
      expect(got.created).toBe(false);
      expect(
        calls.filter((c) => new URL(c.url).pathname === "/v1/search")
      ).toHaveLength(0);
    });

    it("既存 DB は不足プロパティだけ PATCH し、既存の選択肢は消さず追加する", async () => {
      const searchHit = {
        id: "db-exist",
        archived: false,
        in_trash: false,
        created_time: "2026-01-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: STOCK_INFO },
        title: [{ plain_text: "銘柄マスタ（補足）" }],
      };
      route("POST", "/v1/search", [{ results: [searchHit], has_more: false, next_cursor: null }]);
      const existingSchema = buildFullSchema();
      // 33業種 は既存の選択肢「情報・通信業」を持つが spec の「輸送用機器」は無い
      existingSchema["33業種"] = {
        id: "sector-id",
        type: "select",
        select: { options: [{ id: "opt-1", name: "情報・通信業", color: "blue" }] },
      };
      route("GET", "/v1/databases/db-exist", [{ id: "db-exist", properties: existingSchema }]);
      route("PATCH", "/v1/databases/db-exist", [
        {
          id: "db-exist",
          properties: {
            ...existingSchema,
            "33業種": {
              id: "sector-id",
              type: "select",
              select: {
                options: [
                  { id: "opt-1", name: "情報・通信業", color: "blue" },
                  { name: "輸送用機器" },
                ],
              },
            },
          },
        },
      ]);
      const { ensureSupplementDb } = await load();
      const got = await ensureSupplementDb(spec);
      expect(got).toEqual({ dbId: "db-exist", created: false, propertyIds: expect.any(Object) });
      const patchBody = JSON.parse(String(calls[2]?.init.body)) as {
        properties: Record<string, { select?: { options: Array<{ name: string }> } }>;
      };
      // 既存の選択肢「情報・通信業」を含んだまま「輸送用機器」を追加している
      const names = patchBody.properties["33業種"]?.select?.options.map((o) => o.name);
      expect(names).toEqual(["情報・通信業", "輸送用機器"]);
    });

    it("累積選択肢数が上限(100)を超えるパッチは送らず throw する (廃止済み語の選択肢が Notion 側に残り続けて肥大化する対策)", async () => {
      const searchHit = {
        id: "db-exist",
        archived: false,
        in_trash: false,
        created_time: "2026-01-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: STOCK_INFO },
        title: [{ plain_text: "銘柄マスタ（補足）" }],
      };
      route("POST", "/v1/search", [{ results: [searchHit], has_more: false, next_cursor: null }]);
      const existingSchema = buildFullSchema();
      // 33業種 に既に99件の選択肢がある想定 (廃止済み語の分も含め蓄積した状態)。
      const existingOptions = Array.from({ length: 99 }, (_, i) => ({ id: `opt-${i}`, name: `業種${i}` }));
      existingSchema["33業種"] = {
        id: "sector-id",
        type: "select",
        select: { options: existingOptions },
      };
      route("GET", "/v1/databases/db-exist", [{ id: "db-exist", properties: existingSchema }]);
      const { ensureSupplementDb } = await load();
      // spec の sector33Options には既存に無い「輸送用機器」が1件あるだけだが、
      // 99 (既存) + 1 (追加) = 100 なのでまだ収まる。「業種X」「業種Y」の2件を
      // 追加する spec に変えると 99+2=101 で上限超過になる。
      await expect(
        ensureSupplementDb({ ...spec, sector33Options: ["輸送用機器", "新業種A"] })
      ).rejects.toThrow(/累積選択肢数が上限/);
      // 上限超過を検知したら PATCH 自体を送らない (Notion 側のスキーマを
      // 汚さない)。
      expect(calls.filter((c) => c.init.method === "PATCH")).toHaveLength(0);
    });

    it("スキーマが既に全て揃っていれば PATCH しない", async () => {
      process.env.NOTION_STOCK_SUPPLEMENT_DB_ID = "d".repeat(32);
      const fullSchema = buildFullSchema();
      fullSchema["33業種"] = {
        id: "sector-id",
        type: "select",
        select: { options: [{ name: "輸送用機器" }] },
      };
      fullSchema["事業タグ（素材・部品・装置）"] = {
        id: "up-id",
        type: "multi_select",
        multi_select: { options: [{ name: "半導体パッケージ・基板材料" }] },
      };
      fullSchema["事業タグ（製品・サービス）"] = {
        id: "down-id",
        type: "multi_select",
        multi_select: { options: [{ name: "自動車" }] },
      };
      fullSchema["投資テーマ"] = {
        id: "theme-id",
        type: "multi_select",
        multi_select: { options: [{ name: "半導体サプライチェーン" }] },
      };
      fullSchema["単語帳の版"] = { id: "ver-id", type: "select", select: { options: [{ name: "v1" }] } };
      for (const col of spec.textColumns) fullSchema[col] = { id: `${col}-id`, type: "rich_text" };
      route("GET", `/v1/databases/${"d".repeat(32)}`, [{ id: "d".repeat(32), properties: fullSchema }]);
      const { ensureSupplementDb } = await load();
      await ensureSupplementDb(spec);
      expect(calls.filter((c) => c.init.method === "PATCH")).toHaveLength(0);
    });
  });

  describe("loadSupplementRows / loadStockMasterIndex", () => {
    const propertyIds = [...allColumnNames(), ...spec.textColumns].reduce<Record<string, string>>(
      (acc, name) => {
        acc[name] = `${name}-id`;
        return acc;
      },
      {}
    );

    it("プロパティを読み取り、要求した texts 列だけ返す", async () => {
      const page = {
        id: "row-1",
        properties: {
          銘柄名: { title: [{ plain_text: "テスト株式会社" }] },
          銘柄コード: { rich_text: [{ plain_text: "1234" }] },
          "33業種": { select: { name: "輸送用機器" } },
          有報書類ID: { rich_text: [{ plain_text: "S100TEST" }] },
          書類種別: { select: { name: "有報" } },
          会計期末: { date: { start: "2025-03-31" } },
          提出日: { date: { start: "2025-06-27" } },
          本文の状態: { select: { name: "取得済" } },
          "事業タグ（素材・部品・装置）": { multi_select: [{ name: "半導体パッケージ・基板材料" }] },
          "事業タグ（製品・サービス）": { multi_select: [] },
          "事業タグ（流通・サービス）": { multi_select: [{ name: "人材紹介・派遣" }] },
          投資テーマ: { multi_select: [] },
          要確認タグ: { rich_text: [] },
          事業タグの根拠文: { rich_text: [{ plain_text: "核酸医薬（はい 0.93）：「テスト引用文」— 事業の内容" }] },
          事業タグの状態: { select: { name: "判定済" } },
          事業タグの根拠書類: { rich_text: [{ plain_text: "S100TEST 2025年3月期" }] },
          単語帳の版: { select: { name: "v1" } },
          事業タグ判定日: { date: { start: "2026-09-25" } },
          候補語数: { number: 3 },
          判定入力: { rich_text: [] },
          判定エラー: { rich_text: [] },
          再試行回数: { number: 0 },
          次回再試行日: { date: null },
          銘柄マスタ: { relation: [{ id: "master-page-1" }] },
          事業の内容: { rich_text: [{ plain_text: "自動車を製造する。" }] },
          対処すべき課題: { rich_text: [{ plain_text: "課題本文" }] },
        },
      };
      route("POST", "/v1/databases/db-1/query", [
        { results: [page], has_more: false, next_cursor: null },
      ]);
      const { loadSupplementRows } = await load();
      const rows = await loadSupplementRows("db-1", propertyIds, {
        textColumns: ["事業の内容"],
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pageId: "row-1",
        stockCode: "1234",
        companyName: "テスト株式会社",
        sector33: "輸送用機器",
        docId: "S100TEST",
        docType: "有報",
        periodEnd: "2025-03-31",
        tagStatus: "判定済",
        candidateCount: 3,
        attempts: 0,
        nextRetryAt: null,
        masterLinked: true,
        upstream: ["半導体パッケージ・基板材料"],
        distribution: ["人材紹介・派遣"],
        evidenceText: "核酸医薬（はい 0.93）：「テスト引用文」— 事業の内容",
        texts: { 事業の内容: "自動車を製造する。" },
      });
      expect(rows[0]?.texts).not.toHaveProperty("対処すべき課題");
    });

    it("想定外の select 値は throw する (書類種別)", async () => {
      const page = {
        id: "row-1",
        properties: {
          銘柄名: { title: [{ plain_text: "テスト" }] },
          銘柄コード: { rich_text: [{ plain_text: "1234" }] },
          書類種別: { select: { name: "第四種" } },
        },
      };
      route("POST", "/v1/databases/db-1/query", [
        { results: [page], has_more: false, next_cursor: null },
      ]);
      const { loadSupplementRows } = await load();
      await expect(loadSupplementRows("db-1", propertyIds)).rejects.toThrow("書類種別");
    });

    it("銘柄コードが重複していれば throw する", async () => {
      const mk = (id: string) => ({
        id,
        properties: {
          銘柄名: { title: [{ plain_text: "A" }] },
          銘柄コード: { rich_text: [{ plain_text: "9999" }] },
        },
      });
      route("POST", "/v1/databases/db-1/query", [
        { results: [mk("row-a"), mk("row-b")], has_more: false, next_cursor: null },
      ]);
      const { loadSupplementRows } = await load();
      await expect(loadSupplementRows("db-1", propertyIds)).rejects.toThrow("9999");
    });

    it("loadStockMasterIndex: 銘柄コード → ページ ID の索引を作る", async () => {
      route("GET", `/v1/databases/${MASTER_DB}`, [
        { id: MASTER_DB, properties: { 銘柄コード: { id: "code-prop-id", type: "title" } } },
      ]);
      route("POST", `/v1/databases/${MASTER_DB}/query`, [
        {
          results: [
            { id: "p-7203", properties: { 銘柄コード: { title: [{ plain_text: "7203" }] } } },
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { loadStockMasterIndex } = await load();
      const { index, duplicates } = await loadStockMasterIndex();
      expect(index.get("7203")).toBe("p-7203");
      expect(duplicates.size).toBe(0);
    });

    it("loadStockMasterIndex: 重複コードはどれも選ばず duplicates に分ける", async () => {
      route("GET", `/v1/databases/${MASTER_DB}`, [
        { id: MASTER_DB, properties: { 銘柄コード: { id: "code-prop-id", type: "title" } } },
      ]);
      route("POST", `/v1/databases/${MASTER_DB}/query`, [
        {
          results: [
            { id: "p-1", properties: { 銘柄コード: { title: [{ plain_text: "7203" }] } } },
            { id: "p-2", properties: { 銘柄コード: { title: [{ plain_text: "7203" }] } } },
            { id: "p-3", properties: { 銘柄コード: { title: [{ plain_text: "6758" }] } } },
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      const { loadStockMasterIndex } = await load();
      const { index, duplicates } = await loadStockMasterIndex();
      expect(index.has("7203")).toBe(false);
      expect(duplicates.get("7203")).toEqual(["p-1", "p-2"]);
      expect(index.get("6758")).toBe("p-3");
    });
  });

  describe("createSupplementRow / updateSupplementRow", () => {
    it("小さい入力は POST 1 回だけで作成する", async () => {
      route("POST", "/v1/pages", [{ id: "row-new" }]);
      const { createSupplementRow } = await load();
      const id = await createSupplementRow("db-1", { companyName: "テスト" });
      expect(id).toBe("row-new");
      expect(calls).toHaveLength(1);
    });

    it("根拠 (evidence) は children として同時に作る", async () => {
      route("POST", "/v1/pages", [{ id: "row-new" }]);
      const { createSupplementRow } = await load();
      const evidence = { object: "block", type: "heading_3" };
      await createSupplementRow("db-1", { companyName: "テスト" }, evidence);
      const body = JSON.parse(String(calls[0]?.init.body)) as { children?: unknown[] };
      expect(body.children).toEqual([evidence]);
    });

    it("大きい入力は複数チャンクに分けて PATCH で追い足す", async () => {
      route("POST", "/v1/pages", [{ id: "row-big" }]);
      route("PATCH", "/v1/pages/row-big", [{}, {}, {}, {}, {}, {}, {}, {}]);
      const { createSupplementRow } = await load();
      const texts: Record<string, string> = {};
      // 8 列 × 150,000字 (75 rich_text 要素/列。上限100以内) ≈ 1.2MB。
      // 既定 maxBytes=400,000 では確実に複数チャンクへ分かれる。
      for (let i = 0; i < 8; i++) texts[`col${i}`] = "x".repeat(150_000);
      const id = await createSupplementRow("db-1", { texts });
      expect(id).toBe("row-big");
      expect(calls.length).toBeGreaterThan(1);
      expect(calls[0]?.init.method).toBe("POST");
      expect(calls.slice(1).every((c) => c.init.method === "PATCH")).toBe(true);
    });

    it("updateSupplementRow: フィールドが無ければ PATCH しない", async () => {
      const { updateSupplementRow } = await load();
      await updateSupplementRow("row-1", {});
      expect(calls).toHaveLength(0);
    });

    it("updateSupplementRow: PATCH する", async () => {
      route("PATCH", "/v1/pages/row-1", [{}]);
      const { updateSupplementRow } = await load();
      await updateSupplementRow("row-1", { tagStatus: "判定済" });
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]?.init.body)) as { properties: Record<string, unknown> };
      expect(body.properties["事業タグの状態"]).toEqual({ select: { name: "判定済" } });
    });
  });

  describe("replaceEvidenceBlock", () => {
    const heading = (id: string, text: string) => ({
      id,
      type: "heading_3",
      heading_3: { rich_text: [{ plain_text: text }] },
    });
    const other = (id: string) => ({ id, type: "paragraph" });

    it("目印で始まる heading_3 だけ削除し、新しいブロックを追記する", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        {
          results: [
            other("b0"),
            heading("b1", "事業タグの根拠（単語帳 v1・有報 S1 2025年3月期）"),
            heading("b2", "関係ない見出し"),
          ],
          has_more: false,
          next_cursor: null,
        },
      ]);
      route("DELETE", "/v1/blocks/b1", [{}]);
      route("PATCH", "/v1/blocks/row-1/children", [{}]);
      const { replaceEvidenceBlock } = await load();
      const newBlock = { object: "block", type: "heading_3" };
      await replaceEvidenceBlock("row-1", newBlock);
      expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
        "GET /v1/blocks/row-1/children",
        "DELETE /v1/blocks/b1",
        "PATCH /v1/blocks/row-1/children",
      ]);
      const patchBody = JSON.parse(String(calls[2]?.init.body)) as { children: unknown[] };
      expect(patchBody.children).toEqual([newBlock]);
    });

    it("block が null なら削除のみ (追記しない)", async () => {
      route("GET", "/v1/blocks/row-1/children", [
        { results: [heading("b1", "事業タグの根拠…")], has_more: false, next_cursor: null },
      ]);
      route("DELETE", "/v1/blocks/b1", [{}]);
      const { replaceEvidenceBlock } = await load();
      await replaceEvidenceBlock("row-1", null);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.init.method).toBe("DELETE");
    });
  });
});

interface TestPropertyDef {
  id: string;
  type: string;
  select?: { options: Array<{ id?: string; name: string; color?: string }> };
  multi_select?: { options: Array<{ id?: string; name: string; color?: string }> };
}

function buildFullSchema(extraTextColumns: string[] = []): Record<string, TestPropertyDef> {
  const cols = [...allColumnNames(), ...extraTextColumns];
  const out: Record<string, TestPropertyDef> = {};
  for (const c of cols) out[c] = { id: `${c}-id`, type: "rich_text" };
  out["銘柄名"] = { id: "name-id", type: "title" };
  out["銘柄マスタ"] = { id: "master-id", type: "relation" };
  out["会計期末"] = { id: "period-id", type: "date" };
  out["提出日"] = { id: "submitted-id", type: "date" };
  out["候補語数"] = { id: "cand-id", type: "number" };
  out["再試行回数"] = { id: "attempts-id", type: "number" };
  out["次回再試行日"] = { id: "retry-id", type: "date" };
  out["事業タグ判定日"] = { id: "judged-id", type: "date" };
  return out;
}

function allColumnNames(): string[] {
  return [
    "銘柄名",
    "銘柄コード",
    "銘柄マスタ",
    "33業種",
    "有報書類ID",
    "書類種別",
    "会計期末",
    "提出日",
    "本文の状態",
    "事業タグ（素材・部品・装置）",
    "事業タグ（製品・サービス）",
    "事業タグ（流通・サービス）",
    "投資テーマ",
    "要確認タグ",
    "事業タグの根拠文",
    "事業タグの状態",
    "事業タグの根拠書類",
    "単語帳の版",
    "事業タグ判定日",
    "候補語数",
    "判定入力",
    "判定エラー",
    "再試行回数",
    "次回再試行日",
  ];
}
