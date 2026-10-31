/**
 * INC-20261008-kabulab_tool_cloudflare-ir-pdf-502
 *
 * ログの40件分割と、同じ公開時刻の並べ方。どちらも既存テストは
 * 40件以下・公開時刻が違う行しか通していない。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  IR_PDF_ARCHIVE_INCIDENT_TAG,
  compareDisclosuresForArchive,
  logIrPdfIncident,
} from "./ir-pdf-incident.js";

const ID_CHUNK = 40;

type ChunkLine = { count: number; offset: number; ids: string[] };

function sampleIds(total: number): string[] {
  return Array.from({ length: total }, (_, index) => {
    const n = total - index;
    return `id-${String(n).padStart(4, "0")}`;
  });
}

function expectedChunks(ids: readonly string[]): ChunkLine[] {
  const lines: ChunkLine[] = [];
  for (let offset = 0; offset < ids.length; offset += ID_CHUNK) {
    lines.push({
      count: ids.length,
      offset,
      ids: ids.slice(offset, offset + ID_CHUNK),
    });
  }
  return lines;
}

function captureChunks(ids: readonly string[]): ChunkLine[] {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    logIrPdfIncident("archive-chunk", ids);
    return warn.mock.calls.map((call) => parseChunkLine(call));
  } finally {
    warn.mockRestore();
  }
}

function parseChunkLine(call: readonly unknown[]): ChunkLine {
  if (call.length !== 1 || typeof call[0] !== "string") {
    throw new Error(`ログの形が違います: ${JSON.stringify(call)}`);
  }
  const line = call[0];
  const head = `${IR_PDF_ARCHIVE_INCIDENT_TAG} archive-chunk `;
  if (!line.startsWith(head)) throw new Error(`想定外のログ: ${line}`);
  const matched = /^count=(\d+) offset=(\d+) tdnetIds=(.*)$/.exec(line.slice(head.length));
  if (matched === null) throw new Error(`ログを分解できない: ${line}`);
  const listed = matched[3] === "" ? [] : matched[3].split(",");
  return { count: Number(matched[1]), offset: Number(matched[2]), ids: listed };
}

describe("logIrPdfIncident", () => {
  it("0・40・41・81件は40件ごとに分かれ、offset と tdnetId に欠落も重複も無い", () => {
    const actual: Record<string, ChunkLine[]> = {};
    const expected: Record<string, ChunkLine[]> = {};
    for (const total of [0, 40, 41, 81]) {
      const ids = sampleIds(total);
      actual[String(total)] = captureChunks(ids);
      expected[String(total)] = expectedChunks(ids);
    }
    expect(actual).toEqual(expected);
  });
});

const SAME_PUBDATE = "2026-10-01T00:00:00.000Z";
const OLDER_PUBDATE = "2026-09-01T00:00:00.000Z";

function disclosure(key: string, pubdate: string, ticker = "1001") {
  return { pubdate, ticker, key };
}

describe("compareDisclosuresForArchive", () => {
  it("同じ公開時刻は銘柄コードの次に tdnetId 昇順", () => {
    // 銘柄を揃えると差は key（tdnetId）の辞書順。n-10 は n-2 より前（'1' < '2'）。
    const tied = [
      disclosure("n-2", SAME_PUBDATE),
      disclosure("n-9", OLDER_PUBDATE),
      disclosure("n-10", SAME_PUBDATE),
    ].sort(compareDisclosuresForArchive);
    expect(tied.map((row) => row.key)).toEqual(["n-9", "n-10", "n-2"]);

    // 銘柄が違うと同じ公開時刻でも銘柄コードが先。tdnetId だけでは並べない。
    const byTicker = [
      disclosure("a", SAME_PUBDATE, "2000"),
      disclosure("z", SAME_PUBDATE, "1000"),
    ].sort(compareDisclosuresForArchive);
    expect(byTicker.map((row) => [row.ticker, row.key])).toEqual([
      ["1000", "z"],
      ["2000", "a"],
    ]);
  });
});

describe("IR PDF の取得順", () => {
  it("未保存取得と SLO サンプルは pubdate の次が tdnetId 昇順で一致する", () => {
    const ingest = readFileSync(
      new URL("../../../services/ir-catalog/src/services/ingest.ts", import.meta.url),
      "utf8",
    );
    const ops = readFileSync(
      new URL("../../../pipeline/src/jp_stock_pipeline/jobs/ops_check.py", import.meta.url),
      "utf8",
    );
    const ingestOrder = /orderBy\(\s*asc\(disclosures\.pubdate\)\s*,\s*asc\(disclosures\.tdnetId\)\s*\)/;
    const sloOrder = /ORDER BY\s+pubdate\s+ASC\s*,\s*tdnet_id\s+ASC\b/;
    expect(ingestOrder.test(ingest)).toBe(true);
    expect(sloOrder.test(ops)).toBe(true);
  });
});
