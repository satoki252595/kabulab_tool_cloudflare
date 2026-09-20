import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../db/client.js";
import type { EdinetCsvRow } from "../services/edinet/csv.js";
import {
  extractTextSections,
  normalizeTitle,
  stripHtml,
  TEXT_SECTIONS,
} from "../services/edinet/text-sections.js";
import {
  getLatestTextSections,
  getTextSection,
} from "../services/text-sections-query.js";

/**
 * 定性セクション (事業の内容・リスク等) の抽出と読み取り。
 * CSV 行はテスト用の最小構造データ (本番経路のダミーではない)。
 * コードは合成 (1001〜)。銘柄名は「テスト〜」で固定。
 */

function row(partial: Partial<EdinetCsvRow> & { value: string }): EdinetCsvRow {
  return {
    elementId: "jpcrp_cor:BusinessRisksTextBlock",
    itemName: "事業等のリスク",
    contextId: "CurrentYearDuration",
    relativeYear: "CurrentYearDuration",
    consolidatedOrNonConsolidated: "連結",
    periodOrInstant: "期間",
    unitId: "",
    unit: "",
    ...partial,
  };
}

describe("stripHtml", () => {
  it("タグ除去・実体参照復号・空白畳み込みのみで語句は変えない", () => {
    expect(
      stripHtml("<p>為替 &amp; 金利の変動<br/>により&nbsp;損益が変動する。</p>")
    ).toBe("為替 & 金利の変動 により 損益が変動する。");
  });
  it("数値参照を復号し、不正な参照は原文のまま残す", () => {
    expect(stripHtml("A&#65;B&#x42;C&#99999999;")).toBe("AABBC&#99999999;");
  });
});

describe("normalizeTitle", () => {
  it("空白・句読点の有無を吸収する", () => {
    expect(normalizeTitle("経営方針、経営環境及び対処すべき課題等")).toBe(
      normalizeTitle("経営方針 経営環境及び対処すべき課題等")
    );
  });
  it("「等」の有無を吸収する (セグメント情報系の表記ゆれ)", () => {
    expect(normalizeTitle("セグメント情報等")).toBe(
      normalizeTitle("セグメント情報")
    );
  });
});

describe("TEXT_SECTIONS", () => {
  it("キー重複なし・正規化タイトル衝突なし", () => {
    const keys = TEXT_SECTIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    const titles = TEXT_SECTIONS.map((d) => normalizeTitle(d.title));
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("extractTextSections", () => {
  it("allowlist 全項目を各 1 行で抜く", () => {
    const rows = TEXT_SECTIONS.map((d, i) =>
      row({
        elementId: `jpcrp_cor:Section${i}TextBlock`,
        itemName: d.title,
        value: `<p>${d.title}の本文${i}</p>`,
      })
    );
    const got = extractTextSections(rows);
    expect(got.map((g) => g.sectionKey)).toEqual(
      TEXT_SECTIONS.map((d) => d.key)
    );
    expect(got[0]!.text).toBe("事業の内容の本文0");
    expect(got[0]!.charCount).toBe("事業の内容の本文0".length);
    expect(got[0]!.contextId).toBe("CurrentYearDuration");
  });

  it("TextBlock でない要素は同名でも拾わない", () => {
    const got = extractTextSections([
      row({
        elementId: "jpcrp_cor:NetSales",
        itemName: "事業等のリスク",
        value: "999",
      }),
    ]);
    expect(got).toEqual([]);
  });

  it("当期・連結を優先し、同点は先勝ち (決定的)", () => {
    const got = extractTextSections([
      row({
        itemName: "配当政策",
        relativeYear: "Prior1YearDuration",
        consolidatedOrNonConsolidated: "個別",
        contextId: "Prior1YearDuration",
        value: "<p>前期個別</p>",
      }),
      row({
        itemName: "配当政策",
        relativeYear: "CurrentYearDuration",
        consolidatedOrNonConsolidated: "連結",
        contextId: "CurrentYearDuration",
        value: "<p>当期連結</p>",
      }),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toBe("当期連結");
    expect(got[0]!.sectionKey).toBe("dividend_policy");
  });

  it("剥がして空になる値は行を作らない", () => {
    const got = extractTextSections([
      row({ itemName: "研究開発活動", value: "<p> <br/></p>" }),
    ]);
    expect(got).toEqual([]);
  });
});

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  // 番号付きマイグレーションのみ適用する。_cutover*.sql 等の git 管理外の
  // ローカルダンプを拾うと順序・表有無が崩れて落ちる (本番適用手順と同じ)。
  const files = readdirSync(dir)
    .filter((n) => /^\d{4}_.*\.sql$/.test(n))
    .sort();
  for (const f of files) {
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
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (?, ?, ?, 'プライム', 1, 'equity', '輸送用機器')"
    )
    .run(id, code, `テスト${code}`);
}

function seedDoc(
  id: number,
  stockId: number,
  fy: string,
  submittedAt: number
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status) VALUES (?, ?, ?, ?, '120', ?, ?, ?, 'ok_pattern_a')"
    )
    .run(id, stockId, `E${id}`, `S100T${id}`, `テスト${stockId}`, fy, submittedAt);
}

function seedSection(
  docId: number,
  stockId: number,
  fy: string,
  key: string,
  text: string
): void {
  sqlite
    .prepare(
      "INSERT INTO yuho_text_sections (document_id, stock_id, fiscal_year_end, section_key, text, element_id, item_name, context_id, char_count) VALUES (?, ?, ?, ?, ?, 'jpcrp_cor:XTextBlock', '項目名', 'CurrentYearDuration', ?)"
    )
    .run(docId, stockId, fy, key, text, text.length);
}

describe("text-sections-query", () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    applyD1Migrations(sqlite);
    seedStock(1, "1001");
    seedStock(2, "1002");
  });

  it("セクションごとに最新期を返し、重複期は提出が新しい書類を採る", async () => {
    seedDoc(1, 1, "2024-03-31", 1750000000);
    seedDoc(2, 1, "2025-03-31", 1760000000);
    seedDoc(3, 1, "2025-03-31", 1770000000); // 同一期末の訂正 (後発)
    seedSection(1, 1, "2024-03-31", "business", "旧期の事業");
    seedSection(2, 1, "2025-03-31", "business", "当期の事業");
    seedSection(3, 1, "2025-03-31", "business", "訂正後の事業");
    seedSection(2, 1, "2025-03-31", "risks", "当期のリスク");
    db = createDb(createD1(sqlite) as unknown as D1Database);

    const got = await getLatestTextSections(db, 1);
    const byKey = new Map(got.map((g) => [g.sectionKey, g]));
    expect(byKey.get("business")!.text).toBe("訂正後の事業");
    expect(byKey.get("business")!.fiscalYearEnd).toBe("2025-03-31");
    expect(byKey.get("risks")!.text).toBe("当期のリスク");
    expect(byKey.has("mda")).toBe(false);
  });

  it("getTextSection は 1 件または null", async () => {
    seedDoc(4, 2, "2025-03-31", 1760000000);
    seedSection(4, 2, "2025-03-31", "dividend_policy", "配当方針文");
    db = createDb(createD1(sqlite) as unknown as D1Database);

    const hit = await getTextSection(db, 2, "dividend_policy");
    expect(hit!.text).toBe("配当方針文");
    expect(hit!.docId).toBe("S100T4");
    expect(await getTextSection(db, 2, "risks")).toBeNull();
    expect(await getLatestTextSections(db, 9999)).toEqual([]);
  });
});
