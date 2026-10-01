/** 既存の実開示 fixture を test-only ZIP に包装する。実 filing の代用品ではない。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseOverseasData,
  parseOverseasHtml,
  type OverseasCapture,
} from "../services/overseas-parser.js";

const fx = (name: string): string => readFileSync(
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"
);
const first = "XBRL/PublicDoc/0102010_honbun_jpcrp030000-asr.htm";
const second = "XBRL/PublicDoc/0105010_honbun_jpcrp030000-asr.htm";

/** stored ZIP。値は fixture 原文のままで、ZIP container だけを組み立てる。 */
function zip(bodies: Array<[string, string]>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, html] of bodies) {
    const path = Buffer.from(name), bytes = Buffer.from(html);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, path, bytes); central.push(entry, path);
    offset += header.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(bodies.length, 8);
  end.writeUInt16LE(bodies.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const capture = (): OverseasCapture => ({ status: null, stopReason: null, candidates: [] });

describe("ZIP 分割本文を1つの候補集合で判定", () => {
  it.each([
    "georows-america-othernorth-europe-S100W1LQ.html",
    "georows-uchi-subrow-murata-S100W2ZR.html",
  ])("前半の地域語で打ち切らず後半の実 fixture を採る: %s", (fixture) => {
    const html = fx(fixture), cap = capture();
    const ex = parseOverseasData(zip([
      [first, fx("georows-noncurrent-assets-excluded-S100G2DL.html")],
      [second, html],
    ]), "2025-03-31", { capture: cap });
    expect(ex.facts).toEqual(parseOverseasHtml(html, "2025-03-31").facts);
    expect(ex.facts.length).toBeGreaterThan(0);
    expect(ex.honbunFile).toBe(second);
    const selected = cap.candidates.find((c) => c.selected)!;
    expect(selected.honbunFile).toBe(second);
    expect(html.slice(selected.start)).toMatch(/^<table\b/i);
  });

  it("別本文の当期候補を先頭採用せず全候補の競合でHOLD", () => {
    const cap = capture();
    const ex = parseOverseasData(zip([
      [first, fx("georows-uchi-subrow-murata-S100W2ZR.html")],
      [second, fx("georows-uchi-subrow-murata-S100W2ZR.html")],
    ]), "2025-03-31", { capture: cap });
    expect(ex.status).toBe("geo_present_unstructured");
    expect(ex.facts).toHaveLength(0);
    expect(ex.honbunFile).toBeNull();
    expect(cap.stopReason).not.toBeNull();
    expect(new Set(cap.candidates.map((c) => c.honbunFile))).toEqual(new Set([first, second]));
    expect(cap.candidates.every((c) => !c.selected)).toBe(true);
  });

  it("本文外の年度題名を借りて単一行の期不明を救済しない", () => {
    const cap = capture();
    const ex = parseOverseasData(zip([
      [first, fx("georows-america-othernorth-europe-S100W1LQ.html")],
      [second, fx("context-geography-S100YJVF.html")],
    ]), "2025-03-31", { capture: cap });
    expect(ex.facts).toHaveLength(0);
    expect(ex.honbunFile).toBeNull();
    expect(cap.stopReason).toBe("single-row-fiscal-unknown");
  });
});
