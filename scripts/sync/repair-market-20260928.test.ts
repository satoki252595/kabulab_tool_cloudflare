import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  readdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import * as core from "../../src/shared/db/core-schema.js";
import { stockIndicators } from "../../services/swing-trading/src/db/schema.js";
import { stockRsiPercentile } from "../../services/rsi-screening/src/db/schema.js";
import { momentumProjection } from "../../src/shared/db/projection-schema.js";
import {
  applyRows,
  archiveOriginals,
  repairObject,
  sha,
  rowCas,
  type Plan,
} from "./repair-market-20260928.js";
import {
  listPageFiles,
  moveToTrash,
  recordPrimaryData,
} from "../../src/shared/notion-archive/index.js";
import {
  findByKey,
  findChildDatabase,
} from "../../src/shared/notion-archive/archive.js";

vi.mock("../../src/shared/notion-archive/index.js", () => ({
  listPageFiles: vi.fn(),
  moveToTrash: vi.fn(),
  recordPrimaryData: vi.fn(),
}));
vi.mock("../../src/shared/notion-archive/archive.js", () => ({
  findByKey: vi.fn(),
  findChildDatabase: vi.fn(),
}));
vi.mock("../../src/shared/notion-archive/env.js", () => ({
  notionEnv: { NOTION_ARCHIVE_PAGE_ID: () => "local-archive-parent" },
}));

afterEach(() => vi.unstubAllGlobals());

describe("one-off market quarantine native SQLite", () => {
  it("CAS refuses an intervening change; a partial deletion resumes without touching normal fields/history/outside targets", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const dir = new URL("../../drizzle/d1/", import.meta.url);
    for (const file of readdirSync(dir)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    const db = drizzle(
      async (sql, params, method) => {
        const stmt = sqlite.prepare(sql);
        const bind = params as (null | number | bigint | string | Uint8Array)[];
        if (method === "run") {
          stmt.run(...bind);
          return { rows: [] };
        }
        const rows = (stmt.all(...bind) as Record<string, unknown>[]).map(
          Object.values,
        );
        return { rows: method === "get" ? rows[0] : rows };
      },
      {
        schema: {
          ...core,
          stockIndicators,
          stockRsiPercentile,
          momentumProjection,
        },
      },
    );
    const plan: Plan = {
      databaseId: "local",
      bucket: "local",
      rows: [],
      objects: [],
    };
    const codes = ["1909", "2180", "7426", "3853"];
    for (let i = 0; i < codes.length; i++) {
      sqlite
        .prepare("INSERT INTO core_stocks(id,code,name,market) VALUES(?,?,?,?)")
        .run(i + 1, codes[i], codes[i], "test");
      sqlite
        .prepare(
          "INSERT INTO core_stock_financials(stock_id,price,per,eps,market_cap,pbr,bps,roe,roa,dividend_yield,operating_margin,data_date) VALUES(?,3700,0.0000043706295,846560000,22200,3.073271,1203.929,0.16937,0.10295,0.61,0.15317,'2026-09-25')",
        )
        .run(i + 1);
      sqlite
        .prepare(
          "INSERT INTO swing_stock_indicators(stock_id,sma_5,latest_date) VALUES(?,16278437478.4,'2026-09-25')",
        )
        .run(i + 1);
      sqlite
        .prepare(
          "INSERT INTO rsi_percentile(stock_id,rsi_10,percentile_sample_bars) VALUES(?,54.933,40)",
        )
        .run(i + 1);
      sqlite
        .prepare(
          "INSERT INTO p_momentum(stock_id,as_of,source_max_date,bars,closes) VALUES(?,'2026-09-14','2026-09-25',40,'16278046720')",
        )
        .run(i + 1);
      sqlite
        .prepare(
          "INSERT INTO swing_daily_ohlcv(stock_id,date,close) VALUES(?,'2026-08-13',3705)",
        )
        .run(i + 1);
      if (i === 3)
        sqlite.exec(
          "UPDATE core_stock_financials SET price=1094,per=22.739555,eps=48.11,market_cap=18582622208,pbr=1.9635857,bps=557.144 WHERE stock_id=4",
        );
      if (i === 3) continue;
      const financials = await db
        .select()
        .from(core.stockFinancials)
        .where(eq(core.stockFinancials.stockId, i + 1));
      plan.rows.push({
        code: codes[i],
        kind: "financials",
        before: financials[0],
      });
      if (i === 2) continue;
      for (const [kind, table] of [
        ["indicators", stockIndicators],
        ["rsi", stockRsiPercentile],
        ["momentum", momentumProjection],
      ] as const) {
        const rows = await db
          .select()
          .from(table)
          .where(eq(table.stockId, i + 1));
        plan.rows.push({ code: codes[i], kind, before: rows[0] });
      }
    }
    const normal = sqlite
      .prepare("SELECT * FROM core_stock_financials WHERE stock_id=4")
      .get();
    const histories = sqlite
      .prepare("SELECT * FROM swing_daily_ohlcv ORDER BY id")
      .all();
    const beforeFinancials = sqlite
      .prepare(
        "SELECT * FROM core_stock_financials WHERE stock_id<>4 ORDER BY stock_id",
      )
      .all() as Record<string, unknown>[];
    const rsiOriginal = plan.rows.find(
      (r) => r.code === "1909" && r.kind === "rsi",
    )!;
    // Native SQL predicate evaluated after snapshot: the altered row cannot be deleted.
    sqlite.exec("UPDATE rsi_percentile SET rsi_10=55 WHERE stock_id=1");
    const cas = await db
      .delete(stockRsiPercentile)
      .where(rowCas(stockRsiPercentile, rsiOriginal.before))
      .returning({ id: stockRsiPercentile.stockId });
    expect(cas).toEqual([]);
    await expect(applyRows(db, plan)).rejects.toThrow(
      "repair row CAS changed: 1909/rsi",
    );
    expect(
      sqlite
        .prepare(
          "SELECT count(*) n FROM swing_stock_indicators WHERE stock_id=1",
        )
        .get(),
    ).toEqual({ n: 0 });
    sqlite.exec("UPDATE rsi_percentile SET rsi_10=54.933 WHERE stock_id=1");
    await applyRows(db, JSON.parse(JSON.stringify(plan)));
    await applyRows(db, JSON.parse(JSON.stringify(plan)));
    for (const table of [
      "swing_stock_indicators",
      "rsi_percentile",
      "p_momentum",
    ]) {
      expect(
        sqlite
          .prepare(`SELECT count(*) n FROM ${table} WHERE stock_id IN(1,2)`)
          .get(),
      ).toEqual({ n: 0 });
      expect(
        sqlite
          .prepare(`SELECT count(*) n FROM ${table} WHERE stock_id IN(3,4)`)
          .get(),
      ).toEqual({ n: 2 });
    }
    for (const original of beforeFinancials) {
      const fresh = sqlite
        .prepare("SELECT * FROM core_stock_financials WHERE stock_id=?")
        .get(original.stock_id as number);
      expect(fresh).toEqual({
        ...original,
        per: null,
        eps: null,
        market_cap: null,
      });
    }
    expect(
      sqlite
        .prepare("SELECT * FROM core_stock_financials WHERE stock_id=4")
        .get(),
    ).toEqual(normal);
    expect(
      sqlite.prepare("SELECT * FROM swing_daily_ohlcv ORDER BY id").all(),
    ).toEqual(histories);
    sqlite.close();
  });

  it("changed/unowned R2 bytes cannot generate a repair", () => {
    expect(() => repairObject("1909", "{}")).toThrow(
      "repair original changed: 1909",
    );
  });

  it("archive byte failure stops; lost receipt after trash success resumes from exact key and fresh physical SHA", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "market-repair-archive-test-"),
    );
    const receipt = join(directory, "receipt.json");
    const bytes = JSON.stringify({
      rows: "private-originals",
      objects: "private-original-bytes",
    });
    const filename = "market-repair-originals-20260928.json";
    vi.mocked(recordPrimaryData).mockResolvedValue({
      pageId: "origin",
      outcome: "recorded",
      fileTooLarge: false,
    });
    vi.mocked(moveToTrash).mockResolvedValue({ trashPageId: "trash" });
    vi.mocked(findChildDatabase).mockResolvedValue(null);
    vi.mocked(listPageFiles).mockImplementation(async (id) => [
      { name: filename, url: `https://files.example.test/${id}` },
    ]);
    let phase = "origin-bad";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (url: string) =>
          new Response(
            phase === "origin-bad" ||
              (phase === "trash-bad" && url.endsWith("/trash"))
              ? "different bytes"
              : bytes,
          ),
      ),
    );
    try {
      await expect(archiveOriginals(bytes, receipt)).rejects.toThrow(
        "repair archive bytes mismatch",
      );
      expect(moveToTrash).not.toHaveBeenCalled();
      phase = "trash-bad";
      await expect(archiveOriginals(bytes, receipt)).rejects.toThrow(
        "repair archive bytes mismatch",
      );
      expect(moveToTrash).toHaveBeenCalledTimes(1);
      // Simulate trash operation committed, but the local success receipt was lost.
      writeFileSync(
        receipt,
        JSON.stringify({ planHash: sha(bytes), originPageId: "origin" }),
        { mode: 0o600 },
      );
      vi.mocked(findChildDatabase).mockResolvedValue("trash-db");
      vi.mocked(findByKey).mockResolvedValue("trash");
      vi.mocked(listPageFiles).mockClear();
      phase = "good";
      await archiveOriginals(bytes, receipt);
      expect(findByKey).toHaveBeenLastCalledWith(
        "trash-db",
        `repair-20260928-${sha(bytes)}`,
      );
      expect(listPageFiles).toHaveBeenCalledExactlyOnceWith("trash", "Files");
      expect(recordPrimaryData).toHaveBeenCalledTimes(1);
      expect(moveToTrash).toHaveBeenCalledTimes(1);
      vi.mocked(listPageFiles).mockClear();
      await archiveOriginals(bytes, receipt);
      expect(listPageFiles).toHaveBeenCalledExactlyOnceWith("trash", "Files");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
