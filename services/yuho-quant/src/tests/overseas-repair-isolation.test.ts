/**
 * 海外59修復の隔離検証: 実原本HTML → parse → 取込save path等価の保存 →
 * 隔離D1 (node:sqlite + D1 migrations) → 画面query読み、の全経路を
 * 本番に触れずに通す (Lane A Done 条件の isolated 原本→保存→表示)。
 *
 * seed の不一致行は本番D1の実保存行そのもの (S100OE0P/S100J2E7。架空値なし)。
 * save ステップは data-scripts/backfill-overseas.ts の保存部
 * (overseas列update + facts delete→insert、(会計期末, 地域名) 先頭採用dedup)
 * と同一手順の mirror である (当該CLIはtop-levelで実接続するためimportしない)。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Database } from "../db/client.js";
import {
  yuhoDocuments,
  overseasSalesFacts,
} from "../db/schema.js";
import {
  parseOverseasHtml,
  type OverseasFact,
  type OverseasParseStatus,
} from "../services/overseas-parser.js";
import { getOverseasTrendByCode } from "../services/overseas-query.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split(
      "--> statement-breakpoint"
    )) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。 */
function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      first: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...(params as any[]));
        return row ?? null;
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare };
}

let sqlite: DatabaseSync;
let db: Database;

function seedStock(id: number, code: string): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (?, ?, ?, 'プライム', 1, '普通株', '化学')"
    )
    .run(id, code, `テスト${code}`);
}

function seedDoc(
  id: number,
  stockId: number,
  docId: string,
  periodEnd: string,
  status: string
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status, overseas_parse_status) VALUES (?, ?, 'E00000', ?, '120', ?, ?, 1750000000, 'ok_pattern_a', ?)"
    )
    .run(id, stockId, docId, `テスト${docId}`, periodEnd, status);
}

/** 本番D1の実保存行をそのまま seed する (sales_raw/yen・ratio・連結フラグまで一致)。 */
function seedSavedFact(
  docId: number,
  stockId: number,
  fy: string,
  regionName: string,
  regionKind: string,
  salesRaw: number | null,
  salesYen: number | null,
  ratioPct: number | null,
  isConsolidated: number | null,
  pattern: string,
  unitLabel = "百万円"
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, is_consolidated, unit_label, sales_raw, sales_yen, ratio_pct, pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(docId, stockId, fy, regionName, regionKind, isConsolidated, unitLabel, salesRaw, salesYen, ratioPct, pattern);
}

function toYen(raw: number | null, factor: number): number | null {
  return raw === null ? null : Math.round(raw * factor);
}

/**
 * backfill-overseas.ts の保存部と同一手順: (会計期末, 地域名) 先頭採用dedup →
 * overseas列update → facts delete→insert。引数は parse の出力そのもの。
 */
async function repairSave(
  docRowId: number,
  stockId: number,
  status: OverseasParseStatus,
  honbunFile: string | null,
  facts: OverseasFact[]
): Promise<void> {
  const seen = new Set<string>();
  const deduped = facts.filter((f) => {
    const k = `${f.fiscalYearEnd} ${f.regionName}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await db
    .update(yuhoDocuments)
    .set({ overseasParseStatus: status, overseasHonbunFile: honbunFile })
    .where(eq(yuhoDocuments.id, docRowId));
  await db
    .delete(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, docRowId));
  const pattern = status.startsWith("ok_") ? status.replace("ok_", "") : "none";
  for (const f of deduped) {
    await db.insert(overseasSalesFacts).values({
      documentId: docRowId,
      stockId,
      fiscalYearEnd: f.fiscalYearEnd,
      regionName: f.regionName,
      regionKind: f.regionKind,
      isConsolidated: f.isConsolidated,
      unitLabel: f.unitLabel,
      salesRaw: f.salesAmount,
      salesYen: toYen(f.salesAmount, f.unitYenFactor),
      ratioPct: f.ratioPct,
      pattern,
    });
  }
}

async function readFacts(docRowId: number): Promise<string[]> {
  const rows = await db
    .select({
      fy: overseasSalesFacts.fiscalYearEnd,
      name: overseasSalesFacts.regionName,
      kind: overseasSalesFacts.regionKind,
      yen: overseasSalesFacts.salesYen,
      ratio: overseasSalesFacts.ratioPct,
    })
    .from(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, docRowId));
  return rows
    .map((r) => `${r.fy}|${r.name}|${r.kind}|${r.yen}|${r.ratio}`)
    .sort();
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  db = createDb(createD1(sqlite) as D1Database);
});

describe("隔離修復 S100OE0P: 不一致保存行 → 販売実績の正しい行へ", () => {
  it("原本→保存→表示の全経路が販売値を運び、再実行で不変", async () => {
    // 本番の不一致保存行を seed (SUM(overseas)=49500 ≠ overseas_total=80728)
    seedStock(1, "5013");
    seedDoc(100, 1, "S100OE0P", "2022-03-31", "ok_geo_rows");
    seedSavedFact(100, 1, "2022-03-31", "日本", "domestic", 16163, 16163000000, null, 1, "geo_rows");
    seedSavedFact(100, 1, "2022-03-31", "日本＋海外合計", "overseas", 37686, 37686000000, null, 1, "geo_rows");
    seedSavedFact(100, 1, "2022-03-31", "海外", "overseas", 11814, 11814000000, null, 1, "geo_rows");
    seedSavedFact(100, 1, "2022-03-31", "海外売上高", "overseas_total", 80728, 80728000000, 83.3, 1, "geo_rows");
    seedSavedFact(100, 1, "2022-03-31", "連結売上高", "total", 96891, 96891000000, null, 1, "geo_rows");

    // 原本 (生産→販売の文書順) を修復parserで読む → 販売実績表が選ばれる
    const html =
      fx("georows-production-results-excluded-S100OE0P.html") +
      "\n" +
      fx("georows-sales-results-preferred-S100OE0P.html");
    const r = parseOverseasHtml(html, "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");

    // 保存: 取込save path等価の置換
    await repairSave(100, 1, r.status, "test-honbun.htm", r.facts);
    const after = await readFacts(100);
    expect(after).toEqual([
      "2022-03-31|中国|overseas|5209000000|null",
      "2022-03-31|南北アメリカ|overseas|11814000000|null",
      "2022-03-31|日本|domestic|16163000000|null",
      "2022-03-31|東南アジア／インド|overseas|4497000000|null",
      "2022-03-31|海外売上高|overseas_total|21520000000|57.1",
      "2022-03-31|連結売上高|total|37686000000|null",
    ]);
    // 本番で破れていた不変条件 (地域計 = 海外売上高) が成り立つ
    const [doc] = await db
      .select({ s: yuhoDocuments.overseasParseStatus })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.id, 100));
    expect(doc.s).toBe("ok_geo_rows");

    // 表示: 画面queryが販売実績の値を読む (生産高 21830 ではない)
    const trend = await getOverseasTrendByCode(db, "5013");
    expect(trend).not.toBeNull();
    expect(trend!.hasStructuredData).toBe(true);
    expect(trend!.points).toHaveLength(1);
    const p = trend!.points[0];
    expect(p.fiscalYearEnd).toBe("2022-03-31");
    expect(p.overseasYen).toBe(21520000000);
    expect(p.totalYen).toBe(37686000000);
    expect(p.domesticYen).toBe(16163000000);
    expect(p.ratioPct).toBe(57.1);
    expect(p.regions.map((x) => `${x.name}:${x.yen}`)).toEqual([
      "南北アメリカ:11814000000",
      "中国:5209000000",
      "東南アジア／インド:4497000000",
    ]);

    // 再実行で不変 (2nd run 0 changes)
    await repairSave(100, 1, r.status, "test-honbun.htm", r.facts);
    expect(await readFacts(100)).toEqual(after);
    const [doc2] = await db
      .select({ s: yuhoDocuments.overseasParseStatus })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.id, 100));
    expect(doc2.s).toBe("ok_geo_rows");
  });
});

describe("隔離修復 S100J2E7: 不一致保存行 → 品目合算の正しい行へ", () => {
  it("原本→保存→表示の全経路が回復値を運び、再実行で不変", async () => {
    // 本番の不一致保存行を seed (SUM(overseas)=8303 ≠ overseas_total=19827)。
    // per-column provenance: ot/total は源泉正で保持し、欠落した地域行だけ直す。
    seedStock(2, "7277");
    seedDoc(200, 2, "S100J2E7", "2020-03-31", "ok_geo_rows");
    seedSavedFact(200, 2, "2020-03-31", "日本", "domestic", 16698, 16698000000, null, 1, "geo_rows");
    seedSavedFact(200, 2, "2020-03-31", "アジア", "overseas", 5439, 5439000000, null, 1, "geo_rows");
    seedSavedFact(200, 2, "2020-03-31", "北米", "overseas", 2864, 2864000000, null, 1, "geo_rows");
    seedSavedFact(200, 2, "2020-03-31", "海外売上高", "overseas_total", 19827, 19827000000, 38.6, 1, "geo_rows");
    seedSavedFact(200, 2, "2020-03-31", "連結売上高", "total", 51340, 51340000000, null, 1, "geo_rows");

    // 原本 (地域×品目の2次元表) は品目合算で回復する
    const r = parseOverseasHtml(fx("georows-dup-region-ambiguous-S100J2E7.html"), "2020-03-31");
    expect(r.status).toBe("ok_geo_rows");

    // 保存: 取込save path等価の置換。地域行は合算値、ot/total は源泉値を保持。
    await repairSave(200, 2, r.status, "test-honbun.htm", r.facts);
    const after = await readFacts(200);
    expect(after).toEqual([
      "2020-03-31|アジア|overseas|16963000000|null",
      "2020-03-31|北米|overseas|2864000000|null",
      "2020-03-31|日本|domestic|31512000000|null",
      "2020-03-31|海外売上高|overseas_total|19827000000|38.6",
      "2020-03-31|連結売上高|total|51340000000|null",
    ]);
    const [doc] = await db
      .select({ s: yuhoDocuments.overseasParseStatus })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.id, 200));
    expect(doc.s).toBe("ok_geo_rows");

    // 表示: 画面queryが回復値を読む
    const trend = await getOverseasTrendByCode(db, "7277");
    expect(trend).not.toBeNull();
    expect(trend!.hasStructuredData).toBe(true);
    expect(trend!.points).toHaveLength(1);
    const p = trend!.points[0];
    expect(p.overseasYen).toBe(19827000000);
    expect(p.totalYen).toBe(51340000000);
    expect(p.domesticYen).toBe(31512000000);
    expect(p.ratioPct).toBe(38.6);
    expect(p.regions.map((x) => `${x.name}:${x.yen}`)).toEqual([
      "アジア:16963000000",
      "北米:2864000000",
    ]);

    // 再実行で不変 (2nd run 0 changes)
    await repairSave(200, 2, r.status, "test-honbun.htm", r.facts);
    expect(await readFacts(200)).toEqual(after);
  });
});

describe("隔離修復 S100T6Q9: 誤保存行 → 未構造化へ (真 unsupported)", () => {
  it("原本→保存→表示の全経路が正直な未対応になり、再実行で不変", async () => {
    // 本番の誤保存行を seed (減損損失表を売上として誤読した集合)
    seedStock(3, "3681");
    seedDoc(300, 3, "S100T6Q9", "2023-12-31", "ok_geo_rows");
    seedSavedFact(300, 3, "2023-12-31", "日本", "domestic", 422667, 422667000, null, null, "geo_rows", "千円");
    seedSavedFact(300, 3, "2023-12-31", "米国", "overseas", 2115, 2115000, null, null, "geo_rows", "千円");
    seedSavedFact(300, 3, "2023-12-31", "シンガポール", "overseas", 16462, 16462000, null, null, "geo_rows", "千円");
    seedSavedFact(300, 3, "2023-12-31", "海外売上高", "overseas_total", 3248331, 3248331000, 85.9, null, "geo_rows", "千円");
    seedSavedFact(300, 3, "2023-12-31", "連結売上高", "total", 3779758, 3779758000, null, null, "geo_rows", "千円");

    // 原本 (非売上の減損損失表) は未構造化として却下される
    const r = parseOverseasHtml(fx("georows-impairment-unresolved-S100T6Q9.html"), "2023-12-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);

    // 保存: status更新 + facts削除 (0 inserts)
    await repairSave(300, 3, r.status, "test-honbun.htm", r.facts);
    expect(await readFacts(300)).toEqual([]);
    const [doc] = await db
      .select({ s: yuhoDocuments.overseasParseStatus })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.id, 300));
    expect(doc.s).toBe("geo_present_unstructured");

    // 表示: 未対応として正直に出る (捏造値なし)
    const trend = await getOverseasTrendByCode(db, "3681");
    expect(trend).not.toBeNull();
    expect(trend!.hasStructuredData).toBe(false);
    expect(trend!.points).toHaveLength(0);
    expect(trend!.documents).toHaveLength(1);
    expect(trend!.documents[0].overseasParseStatus).toBe("geo_present_unstructured");

    // 再実行で不変
    await repairSave(300, 3, r.status, "test-honbun.htm", r.facts);
    expect(await readFacts(300)).toEqual([]);
  });
});
