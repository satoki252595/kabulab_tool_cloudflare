/**
 * `fetchGoldenTexts` (pipeline.ts) のテスト。
 *
 * レビュー指摘の回帰: docIds を1つの `inArray` にまとめて材料化すると、
 * ゴールデンセットの docId 数が D1 の 1 クエリ 100 bind 上限 (memory: D1
 * bound param limit) に近づく/超えると 500 になる (source.ts が既に対処して
 * いる制約と同じ)。ここでは docIds をチャンク分割して複数回に分けて
 * クエリすること・結果を正しくマージすることを確かめる。
 *
 * `pipeline.test.ts` は `../db/schema.js` をまるごとモックしているため
 * (他のテストが D1 に触れないようにするため)、実スキーマの列オブジェクトが
 * 必要な本テストはファイルを分ける。
 */
import { describe, expect, it, vi } from "vitest";
import type { GoldenItem } from "./golden.js";
import type { BiztagSourceDb } from "./source.js";

const notionMocks = vi.hoisted(() => ({
  readStockTextRow: vi.fn(async (pageId: string) => [
    { itemName: "事業の内容", sectionKey: "business" as const, text: `本文(${pageId})` },
  ]),
}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => notionMocks);

const { fetchGoldenTexts } = await import("./pipeline.js");

function goldenItem(docId: string): GoldenItem {
  return {
    code: "1301",
    docId,
    docTypeCode: "120",
    periodEnd: "2026-03-31",
    companyName: "テスト",
    expect: [{ termId: "B.TEST.DUMMY", sectionKey: "business", label: true, quote: "テスト用の引用" }],
  };
}

describe("fetchGoldenTexts", () => {
  it("docIds が95件 (チャンクサイズ90を超える) でも複数回に分けてクエリし、全件をマージする", async () => {
    const docIds = Array.from({ length: 95 }, (_, i) => `DOC${String(i).padStart(3, "0")}`);
    const items = docIds.map((id) => goldenItem(id));

    const remaining = new Map(docIds.map((id) => [id, { docId: id, notionDocPageId: `page-${id}` }]));
    let queryCount = 0;
    const db = {
      // `.select({...})` の引数 (列オブジェクト) はこのフェイクでは使わない。
      select: () => ({
        from: () => ({
          where: () => {
            queryCount++;
            // このフェイクの where は実 SQL 条件を解釈せず、「1クエリぶんは
            // 残りの先頭からチャンクサイズ (90) 件」という前提で切り出す
            // (実装側が本当にその粒度で分割していなければ、2回目のクエリで
            // 想定より多い/少ない件数が返り、下の合計件数アサーションが崩れる)。
            const batch = [...remaining.values()].slice(0, 90);
            for (const r of batch) remaining.delete(r.docId);
            return Promise.resolve(batch);
          },
        }),
      }),
    } as unknown as BiztagSourceDb;

    const texts = await fetchGoldenTexts(db, items);

    // 95件 / チャンクサイズ90 → 2回に分けてクエリされる (1回にまとめない)。
    expect(queryCount).toBe(2);
    // 全 95 件ぶんの本文が (チャンクをまたいでも) 漏れなく読める。
    expect(texts.size).toBe(95);
    for (const id of docIds) {
      expect(texts.get(`1301:${id}`)).toEqual({ business: `本文(page-${id})` });
    }
  });

  it("docIds が90件以下なら1回のクエリで済む (既存の挙動を壊さない)", async () => {
    const docIds = Array.from({ length: 10 }, (_, i) => `DOC${String(i).padStart(3, "0")}`);
    const items = docIds.map((id) => goldenItem(id));
    let queryCount = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => {
            queryCount++;
            return Promise.resolve(docIds.map((id) => ({ docId: id, notionDocPageId: `page-${id}` })));
          },
        }),
      }),
    } as unknown as BiztagSourceDb;

    const texts = await fetchGoldenTexts(db, items);
    expect(queryCount).toBe(1);
    expect(texts.size).toBe(10);
  });
});
