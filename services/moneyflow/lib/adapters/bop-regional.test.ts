/**
 * 国際収支統計 地域別アダプタ (`./bop-regional.ts`) のテスト。
 *
 * - 実ファイルは `../sources/fixtures/private/bop-regional/` にあり commit しない
 *   (無い環境 = CI では `describe.skipIf` で skip する)。
 *   - `regbp-q-jp-sample.zip` … 2026-09-27 に日本銀行から取得した regbp_q_jp.zip の実データを、
 *     取得元モジュールの実装者が 19 区分 × 直接投資・証券投資の 10 項目 × 直近 9 四半期に
 *     絞って ZIP に詰め直したもの (セルの値は原本のまま。原本とバイト一致はしない)。
 *   - `boj-dload-excerpt.html` … 同日の一括ダウンロードページ (Shift_JIS) の一部抜粋。
 *   値の期待値は Python (zipfile + csv, cp932) で同じファイルから独立に読み出したもの。
 *   うち 6 件は検証証跡 (claude-mf-sources.json の bop-regional.build.verified_values) の
 *   原本 CSV からの読み取り値とも一致する。
 * - CI でも走る部分は、原本と同じ形 (Shift_JIS の CSV を ZIP に詰めたもの・Shift_JIS の HTML) の
 *   **合成テストデータ** (実データではない。期間は 2030〜2031 年、値は作り物) で対応付けの
 *   規則を確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { BOP_REGIONAL_INDICATORS, BOP_REGIONS } from "../sources/bop-regional.js";
import {
  BOP_REGIONAL_DLOAD_FILENAME,
  BOP_REGIONAL_DLOAD_PAGE_URL,
  BOP_REGIONAL_MAX_ROWS,
  BOP_REGIONAL_ZIP_FILENAME,
  bopRegionalBatchKey,
  bopRegionalRequiredLatestQuarter,
  bopRegionalSpec,
  readBopRegionalDloadEntry,
} from "./bop-regional.js";

const ROW_BUDGET = 600;

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/bop-regional/", import.meta.url));
const ZIP_FIXTURE = `${FIXTURE_DIR}regbp-q-jp-sample.zip`;
const HTML_FIXTURE = `${FIXTURE_DIR}boj-dload-excerpt.html`;
const hasFixtures = existsSync(ZIP_FIXTURE) && existsSync(HTML_FIXTURE);
const FIXTURE_KEY = "bop-regional-2026-Q1-updated-2026-08-10";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

function byteRange(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * 合成テストデータを Shift_JIS のバイト列にする簡易エンコーダ (テスト専用)。
 * Node の TextDecoder("shift_jis") で 2 バイト文字の全組み合わせを復号して逆引き表を作る。
 */
const encodeShiftJis: (text: string) => Uint8Array = (() => {
  const decoder = new TextDecoder("shift_jis");
  const table = new Map<string, number[]>();
  for (const lead of [...byteRange(0x81, 0x9f), ...byteRange(0xe0, 0xfc)]) {
    for (const trail of byteRange(0x40, 0xfc)) {
      if (trail === 0x7f) continue;
      const ch = decoder.decode(new Uint8Array([lead, trail]));
      if (ch.length === 1 && ch !== "�" && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  return (text: string) => {
    const out: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) as number;
      if (cp < 0x80) {
        out.push(cp);
        continue;
      }
      const bytes = table.get(ch);
      if (!bytes) throw new Error(`合成テストデータ: Shift_JIS に無い文字です: ${ch}`);
      out.push(...bytes);
    }
    return new Uint8Array(out);
  };
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 合成テストデータ: 1 エントリだけの無圧縮 (stored) ZIP。 */
function storedZip(entryName: string, data: Uint8Array): Uint8Array {
  const name = Buffer.from(entryName, "utf8");
  const crc = crc32(data);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = lfh.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([lfh, name, Buffer.from(data), cd, name, eocd]));
}

const SYN_CATEGORY = "地域別国際収支（四半期）（6版基準）";

/** 合成テストデータの CSV 1 行 (値は億円の作り物)。 */
function synRow(code: string, label: string, values: string[]): string {
  return [code, `"${SYN_CATEGORY}"`, `"${label}"`, `"億円"`, ...values].join(",");
}

const WORLD_ITEMS: ReadonlyArray<{ label: string; key: string }> = [
  { label: "金融/直接投資/地域別合計/ネット", key: "bop_regional_direct_investment_net" },
  { label: "金融/直接投資/地域別合計/資産", key: "bop_regional_direct_investment_asset" },
  { label: "金融/直接投資/地域別合計/負債", key: "bop_regional_direct_investment_liability" },
  { label: "金融/証券投資/地域別合計/ネット", key: "bop_regional_portfolio_investment_net" },
  { label: "金融/証券投資/地域別合計/資産", key: "bop_regional_portfolio_investment_asset" },
  { label: "金融/証券投資/地域別合計/負債", key: "bop_regional_portfolio_investment_liability" },
  { label: "金融/証券投資/株式・投資ファンド持分/地域別合計/資産", key: "bop_regional_portfolio_investment_equity_asset" },
  { label: "金融/証券投資/株式・投資ファンド持分/地域別合計/負債", key: "bop_regional_portfolio_investment_equity_liability" },
  { label: "金融/証券投資/債券/地域別合計/資産", key: "bop_regional_portfolio_investment_debt_asset" },
  { label: "金融/証券投資/債券/地域別合計/負債", key: "bop_regional_portfolio_investment_debt_liability" },
];

interface SynOptions {
  header?: string;
  /** 世界計の行を何行目まで入れるか (欠落の検知用)。 */
  worldItems?: number;
  extraRows?: string[];
}

/** 合成テストデータ: regbp_q_jp.csv と同じ形の CSV テキスト (期間 2030Q4・2031Q1)。 */
function synCsv({ header = ",,,,203004,203101", worldItems = WORLD_ITEMS.length, extraRows = [] }: SynOptions = {}): string {
  const lines = [header];
  WORLD_ITEMS.slice(0, worldItems).forEach((it, i) => {
    // 2031Q1 の値は 1000 + i + 0.25 億円 (作り物)
    lines.push(synRow(`SYNW${i}`, it.label, [`${900 + i}`, `${1000 + i}.25`]));
  });
  lines.push(synRow("SYNUS1", "金融/直接投資/アメリカ合衆国/ネット", ["-10", "-12.34567891"]));
  lines.push(synRow("SYNUS21", "金融/証券投資/株式・投資ファンド持分/アメリカ合衆国/資産", ["5", "NA"]));
  lines.push(synRow("SYNCN22", "金融/証券投資/債券/中華人民共和国/負債", ["7", ""]));
  lines.push(synRow("SYNAS1", "金融/直接投資/アジア計/ネット", ["3", "-0.000000001"]));
  lines.push(synRow("SYNEU2", "金融/証券投資/EU/負債", ["1", "2"]));
  // 直接投資・証券投資以外の項目はモジュールが対象外として読み飛ばす
  lines.push(synRow("SYNCA", "経常収支/地域別合計", ["111", "222"]));
  lines.push(...extraRows);
  return `${lines.join("\r\n")}\r\n`;
}

/** 合成テストデータ: 一括ダウンロードページの該当部分 (Shift_JIS)。 */
function synHtml(dateCell = "2031年8月10日"): string {
  return [
    "<table><tbody>",
    '<tr><td><a href="bp_m_jp.zip">国際収支統計</a></td><td style="text-align: center;">2031年9月8日</td></tr>',
    '<tr><td><a href="regbp_q_jp.zip">地域別国際収支（四半期）</a></td>',
    `<td style="text-align: center;">${dateCell}</td></tr>`,
    "</tbody></table>",
  ].join("\n");
}

const SYN_KEY = "bop-regional-2031-Q1-updated-2031-08-10";

function synZipBytes(opts: SynOptions = {}): Uint8Array {
  return storedZip("regbp_q_jp.csv", encodeShiftJis(synCsv(opts)));
}

function synFiles(opts: SynOptions = {}, html = synHtml()): SpecFile[] {
  return [
    { filename: BOP_REGIONAL_ZIP_FILENAME, bytes: synZipBytes(opts) },
    { filename: BOP_REGIONAL_DLOAD_FILENAME, bytes: encodeShiftJis(html) },
  ];
}

function find(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

function requestUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function stubFetch(routes: Record<string, Uint8Array | number>) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = requestUrl(input);
    const hit = routes[url];
    if (hit === undefined) throw new Error(`テストの fetch スタブに無い URL です: ${url}`);
    if (typeof hit === "number") return new Response("error", { status: hit });
    // Uint8Array<ArrayBuffer> に写してから渡す (BodyInit の型に合わせる。中身は同じ)
    return new Response(new Uint8Array(hit), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ZIP_URL = "https://www.stat-search.boj.or.jp/info/regbp_q_jp.zip";

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("bopRegionalSpec.indicators (指標定義)", () => {
  const JA = /[ぁ-んァ-ヶ一-龠]/;

  it("モジュールの 10 指標をそのままのキーで持ち、列挙値のガードをすべて通る", () => {
    expect(bopRegionalSpec.name).toBe("bop-regional");
    expect(bopRegionalSpec.indicators.map((i) => i.key)).toEqual(BOP_REGIONAL_INDICATORS.map((d) => d.key));
    expect(new Set(bopRegionalSpec.indicators.map((i) => i.key)).size).toBe(10);
    for (const ind of bopRegionalSpec.indicators) {
      expect(isMoneyflowFlowType(ind.flowType)).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency)).toBe(true);
      expect(isMoneyflowLicense(ind.license)).toBe(true);
      expect(isMoneyflowRequirement(ind.requirement)).toBe(true);
      expect(ind.flowType).toBe("純買い越し");
      expect(ind.frequency).toBe("四半期");
      expect(ind.requirement).toBe("R4");
      expect(ind.license).toBe("attribution-required");
      expect(ind.sourceUrl).toMatch(/^https:\/\//);
      expect(ind.sourceUrl).toBe(BOP_REGIONAL_DLOAD_PAGE_URL);
      expect(ind.displayName).toMatch(JA);
      expect(ind.description).toMatch(JA);
      expect(ind.limitations).toMatch(JA);
      // フロー/ストック・単位・符号の向き・区分の重なりを必ず書く
      expect(ind.description).toMatch(/フロー/);
      expect(ind.description).toMatch(/ストック/);
      expect(ind.description).toMatch(/単位は円/);
      expect(ind.description).toMatch(/【符号】/);
      expect(ind.description).toMatch(/二重に数える/);
      // 取込の範囲 (最新四半期のみ)・公表の遅れ・欠損・利用条件の詳細を必ず書く
      expect(ind.limitations).toMatch(/最新の四半期1期分だけ/);
      expect(ind.limitations).toMatch(/約5か月後/);
      expect(ind.limitations).toMatch(/0 で埋めない/);
      expect(ind.limitations).toMatch(/商用目的/);
      expect(ind.limitations).toMatch(/改変はできない/);
    }
  });

  it("ネットの指標は直接投資・証券投資それぞれに合った符号の例を載せる", () => {
    const di = bopRegionalSpec.indicators.find((i) => i.key === "bop_regional_direct_investment_net");
    const pi = bopRegionalSpec.indicators.find((i) => i.key === "bop_regional_portfolio_investment_net");
    expect(di?.description).toMatch(/直接投資のネットが −1,000億円/);
    expect(di?.description).not.toMatch(/証券投資のネットが −1,000億円/);
    expect(pi?.description).toMatch(/証券投資のネットが −1,000億円/);
  });

  it("直接投資の 3 指標だけに再投資収益 (送金を伴わない分) の注意を載せる", () => {
    for (const ind of bopRegionalSpec.indicators) {
      if (ind.key.startsWith("bop_regional_direct_investment_")) {
        expect(ind.description).toMatch(/再投資収益/);
        expect(ind.description).toMatch(/実際にはお金が国境を越えていない/);
      } else {
        expect(ind.description).not.toMatch(/再投資収益/);
      }
    }
  });

  it("1 バッチの最大行数 (全区分 × 全指標) が行数の目安以内", () => {
    expect(BOP_REGIONS).toHaveLength(47);
    expect(BOP_REGIONAL_MAX_ROWS).toBe(470);
    expect(BOP_REGIONAL_MAX_ROWS).toBeLessThanOrEqual(ROW_BUDGET);
  });
});

// ---------------------------------------------------------------------------
// 2. 合成テストデータでの対応付け (CI でも走る)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  it("最新の四半期だけを、億円→円・区分種別・固定の並び順で観測行にする", () => {
    const drafts = bopRegionalSpec.toObservations({ key: SYN_KEY, files: synFiles() });
    expect(() => validateDrafts(bopRegionalSpec.name, drafts, bopRegionalSpec.indicators)).not.toThrow();
    // 世界計 10 + 米国 DI ネット + アジア計 DI ネット + EU PI 負債 (NA・空欄・経常収支は行を作らない)
    expect(drafts).toHaveLength(13);
    for (const d of drafts) {
      expect(d.period).toBe("2031-Q1");
      expect(d.periodStart).toBe("2031-01-01");
      expect(d.periodEnd).toBe("2031-03-31");
      expect(d.unit).toBe("円");
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(false);
      expect(d.measureKind).toBe("実測");
    }
    const world = find(drafts, "bop_regional_direct_investment_net", "地域別合計");
    expect(world.value).toBe(100_025_000_000); // 1000.25 億円
    expect(world.categoryKind).toBe("全体");
    expect(find(drafts, "bop_regional_portfolio_investment_debt_liability", "地域別合計").value).toBe(100_925_000_000);
    const us = find(drafts, "bop_regional_direct_investment_net", "アメリカ合衆国");
    expect(us.value).toBe(-1_234_567_891); // -12.34567891 億円
    expect(us.categoryKind).toBe("国地域");
    // 1 円未満は四捨五入 (-0 にはしない)
    const asia = find(drafts, "bop_regional_direct_investment_net", "アジア計");
    expect(Object.is(asia.value, 0)).toBe(true);
    expect(asia.categoryKind).toBe("国地域");
    expect(find(drafts, "bop_regional_portfolio_investment_liability", "EU").value).toBe(200_000_000);
    // NA / 空欄は行を作らない
    expect(drafts.some((d) => d.indicatorKey === "bop_regional_portfolio_investment_equity_asset" && d.category === "アメリカ合衆国")).toBe(false);
    expect(drafts.some((d) => d.category === "中華人民共和国")).toBe(false);
    // 並び順: 指標の定義順 → 区分の定義順。最後の行が取込完了の印になる
    expect(drafts.slice(0, 4).map((d) => `${d.indicatorKey}|${d.category}`)).toEqual([
      "bop_regional_direct_investment_net|地域別合計",
      "bop_regional_direct_investment_net|アジア計",
      "bop_regional_direct_investment_net|アメリカ合衆国",
      "bop_regional_direct_investment_asset|地域別合計",
    ]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(`${last.indicatorKey}|${last.category}`).toBe("bop_regional_portfolio_investment_debt_liability|地域別合計");
    // 同じ入力なら同じ結果 (純関数)
    expect(bopRegionalSpec.toObservations({ key: SYN_KEY, files: synFiles() })).toEqual(drafts);
  });

  it("ファイルの並び順に依らず同じ結果になる", () => {
    const files = synFiles();
    const reversed = [...files].reverse();
    expect(bopRegionalSpec.toObservations({ key: SYN_KEY, files: reversed })).toEqual(
      bopRegionalSpec.toObservations({ key: SYN_KEY, files })
    );
  });

  it("キーの形式違い・ファイルの中身と合わないキーは throw", () => {
    expect(() => bopRegionalSpec.toObservations({ key: "bop-regional-2031-Q1", files: synFiles() })).toThrow(/形式が不正/);
    expect(() =>
      bopRegionalSpec.toObservations({ key: "bop-regional-2030-Q4-updated-2031-08-10", files: synFiles() })
    ).toThrow(/一致しません/);
    expect(() =>
      bopRegionalSpec.toObservations({ key: "bop-regional-2031-Q1-updated-2031-08-11", files: synFiles() })
    ).toThrow(/一致しません/);
  });

  it("ファイルの欠落・重複・想定外のファイル名は throw", () => {
    const [zip, page] = synFiles() as [SpecFile, SpecFile];
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: [zip] })).toThrow(/0 件/);
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: [page] })).toThrow(/0 件/);
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: [zip, page, zip] })).toThrow(/2 件/);
    expect(() =>
      bopRegionalSpec.toObservations({ key: SYN_KEY, files: [zip, page, { filename: "other.csv", bytes: zip.bytes }] })
    ).toThrow(/想定外のファイル名/);
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: [] })).toThrow(/0 件/);
  });

  it("未知の地域名・未知の単位は throw (モジュールの検知をそのまま通す)", () => {
    const unknownRegion = synFiles({ extraRows: [synRow("SYNXX1", "金融/直接投資/架空の国/ネット", ["1", "2"])] });
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: unknownRegion })).toThrow(/未知の地域名/);
    const badUnit = synFiles({
      extraRows: [["SYNU", `"${SYN_CATEGORY}"`, `"金融/直接投資/英国/ネット"`, `"百万円"`, "1", "2"].join(",")],
    });
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: badUnit })).toThrow(/単位が想定外/);
  });

  it("世界計 (地域別合計) の指標が欠けていたら様式変更として throw", () => {
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: synFiles({ worldItems: 9 }) })).toThrow(
      /地域別合計」に値の無い指標/
    );
  });

  it("ヘッダと列数が合わない・期間が古い順でないときは throw", () => {
    const blankLatest = synFiles({ header: ",,,,203004,203101,203102" });
    // 各行の列数がヘッダと合わない → モジュールが throw
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: blankLatest })).toThrow(/列数/);
    const reversed = synFiles({ header: ",,,,203101,203004" });
    expect(() => bopRegionalSpec.toObservations({ key: SYN_KEY, files: reversed })).toThrow(/古い順/);
  });

  it("最新列が空欄だけ (公表途中など) なら throw", () => {
    const csv = synCsv()
      .split("\r\n")
      .map((line, i) => (i === 0 ? `${line},203102` : line === "" ? line : `${line},`))
      .join("\r\n");
    const files: SpecFile[] = [
      { filename: BOP_REGIONAL_ZIP_FILENAME, bytes: storedZip("regbp_q_jp.csv", encodeShiftJis(csv)) },
      { filename: BOP_REGIONAL_DLOAD_FILENAME, bytes: encodeShiftJis(synHtml()) },
    ];
    expect(() =>
      bopRegionalSpec.toObservations({ key: "bop-regional-2031-Q2-updated-2031-08-10", files })
    ).toThrow(/値がありません/);
  });
});

// ---------------------------------------------------------------------------
// 3. 一括ダウンロードページ・キー・更新停止の検知 (CI でも走る)
// ---------------------------------------------------------------------------

describe("readBopRegionalDloadEntry / bopRegionalBatchKey / bopRegionalRequiredLatestQuarter", () => {
  it("ZIP のリンクと同じ行の最終更新日付を読む", () => {
    expect(readBopRegionalDloadEntry(synHtml())).toEqual({ href: "regbp_q_jp.zip", updatedOn: "2031-08-10" });
    expect(readBopRegionalDloadEntry(synHtml("2031年11月2日"))).toEqual({
      href: "regbp_q_jp.zip",
      updatedOn: "2031-11-02",
    });
  });

  it("同じ ZIP への別のリンク (表示名違い) が先にあっても、表示名の合う行の日付を読む", () => {
    const html = [
      "<ul>",
      '<li>2031年9月1日 お知らせ: <a href="regbp_q_jp.zip">ファイル</a> を差し替えました</li>',
      "</ul>",
      "<table><tr><td>x</td><td>2031年9月1日</td></tr></table>",
      synHtml(),
    ].join("\n");
    expect(readBopRegionalDloadEntry(html)).toEqual({ href: "regbp_q_jp.zip", updatedOn: "2031-08-10" });
    // 表示名まで同じリンクが 2 つあれば、どちらの行か決められないので throw
    expect(() => readBopRegionalDloadEntry(`${synHtml()}\n${synHtml("2031年9月1日")}`)).toThrow(/1 件ではありません \(2 件\)/);
  });

  it("日付が無い・2 件ある・暦に無い・リンクが無い場合は throw", () => {
    expect(() => readBopRegionalDloadEntry(synHtml("未定"))).toThrow(/1 件ではありません \(0 件\)/);
    expect(() => readBopRegionalDloadEntry(synHtml("2031年8月10日 (2031年8月9日)"))).toThrow(/2 件/);
    expect(() => readBopRegionalDloadEntry(synHtml("2031年2月30日"))).toThrow(/暦にありません/);
    expect(() => readBopRegionalDloadEntry("<table></table>")).toThrow(/リンクが見つかりません/);
  });

  it("キーは spec 名・四半期・最終更新日付から決まる", () => {
    expect(bopRegionalBatchKey({ year: 2026, quarter: 1 }, "2026-08-10")).toBe(FIXTURE_KEY);
    expect(() => bopRegionalBatchKey({ year: 2026, quarter: 1 }, "2026/08/10")).toThrow(/YYYY-MM-DD/);
  });

  it("公表予定月 (四半期末の 5 か月後) の翌月を過ぎた四半期を必須とする (日本時間)", () => {
    // 2026-09-27: 1〜3月期 (公表予定 8 月) はまだ猶予内 → 必須は前年 10〜12 月期
    expect(bopRegionalRequiredLatestQuarter(new Date("2026-09-27T09:00:00Z"))).toEqual({ year: 2025, quarter: 4 });
    // 日本時間 2026-09-30 23:59 まではまだ猶予内
    expect(bopRegionalRequiredLatestQuarter(new Date("2026-09-30T14:59:00Z"))).toEqual({ year: 2025, quarter: 4 });
    // 日本時間 2026-10-01 からは 1〜3月期が必須
    expect(bopRegionalRequiredLatestQuarter(new Date("2026-09-30T15:00:00Z"))).toEqual({ year: 2026, quarter: 1 });
    // 年をまたぐ: 2027-01-05 → 7〜9月期 (公表予定 2026-12) はまだ猶予内、4〜6月期 (2026-11) が必須
    expect(bopRegionalRequiredLatestQuarter(new Date("2027-01-05T00:00:00Z"))).toEqual({ year: 2026, quarter: 2 });
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() / fetch() (合成テストデータを返す fetch スタブ。CI でも走る)
// ---------------------------------------------------------------------------

describe("resolve() / fetch() (合成テストデータ)", () => {
  it("ページと ZIP を 1 回ずつ取り、そのバイト列を保管して同じキーで toObservations できる", async () => {
    const zip = synZipBytes();
    const html = encodeShiftJis(synHtml());
    const fetchMock = stubFetch({ [BOP_REGIONAL_DLOAD_PAGE_URL]: html, [ZIP_URL]: zip });

    const resolved = await bopRegionalSpec.resolve(new Date("2031-09-15T09:00:00Z"));
    expect(resolved.key).toBe(SYN_KEY);
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect((call[1]?.headers as Record<string, string>)["User-Agent"]).toMatch(/^kabulab-cf-moneyflow\//);
    }
    expect(batch.key).toBe(SYN_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual([BOP_REGIONAL_ZIP_FILENAME, BOP_REGIONAL_DLOAD_FILENAME]);
    expect(batch.files.map((f) => f.contentType)).toEqual(["application/zip", "text/html"]);
    expect(Buffer.from(batch.files[0]?.bytes as Uint8Array).equals(Buffer.from(zip))).toBe(true);
    expect(Buffer.from(batch.files[1]?.bytes as Uint8Array).equals(Buffer.from(html))).toBe(true);
    expect(batch.source).toContain(ZIP_URL);
    expect(batch.metadata).toMatchObject({
      zipUrl: ZIP_URL,
      lastUpdatedOnPage: "2031-08-10",
      targetQuarter: "2031-Q1",
      csvHeaderPeriods: { first: "2030Q4", last: "2031Q1", count: 2 },
      csvRows: 16,
      observationRows: 13,
    });
    const without = (batch.metadata as { seriesWithoutValue: string[] }).seriesWithoutValue;
    expect(without).toHaveLength(BOP_REGIONAL_MAX_ROWS - 13);
    expect(without).toContain("bop_regional_portfolio_investment_equity_asset|アメリカ合衆国");

    const drafts = bopRegionalSpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(13);
    expect((await resolved.fetch()).files).toBe(batch.files); // 二重に取りに行かない
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("HTTP エラーは throw", async () => {
    stubFetch({ [BOP_REGIONAL_DLOAD_PAGE_URL]: 503 });
    await expect(bopRegionalSpec.resolve(new Date("2031-09-15T09:00:00Z"))).rejects.toThrow(/HTTP 503/);
    stubFetch({ [BOP_REGIONAL_DLOAD_PAGE_URL]: encodeShiftJis(synHtml()), [ZIP_URL]: 404 });
    await expect(bopRegionalSpec.resolve(new Date("2031-09-15T09:00:00Z"))).rejects.toThrow(/HTTP 404/);
  });

  it("公表予定を過ぎても最新の四半期が進んでいない・まだ終わっていない四半期は throw", async () => {
    stubFetch({ [BOP_REGIONAL_DLOAD_PAGE_URL]: encodeShiftJis(synHtml()), [ZIP_URL]: synZipBytes() });
    // 2032-01-05 には 4〜6月期 (公表予定 2031-11) まで公表済みのはず
    await expect(bopRegionalSpec.resolve(new Date("2032-01-05T00:00:00Z"))).rejects.toThrow(/更新されていない/);
    // 2031-03-15 時点で 2031 年 1〜3月期はまだ終わっていない
    await expect(bopRegionalSpec.resolve(new Date("2031-03-15T00:00:00Z"))).rejects.toThrow(/終わっていません/);
  });
});

// ---------------------------------------------------------------------------
// 5. 実ファイル (2026-09-27 取得。private フィクスチャが無い環境では skip)
// ---------------------------------------------------------------------------

function fixtureFiles(): SpecFile[] {
  return [
    { filename: BOP_REGIONAL_ZIP_FILENAME, bytes: new Uint8Array(readFileSync(ZIP_FIXTURE)) },
    { filename: BOP_REGIONAL_DLOAD_FILENAME, bytes: new Uint8Array(readFileSync(HTML_FIXTURE)) },
  ];
}

describe.skipIf(!hasFixtures)("toObservations (実ファイル: 2026-09-27 取得の regbp_q_jp 抜粋)", () => {
  it("検証を通り、行数が目安以内で、値が Python で独立に読んだ値 (億円×1億) と一致する", () => {
    const drafts = bopRegionalSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    expect(() => validateDrafts(bopRegionalSpec.name, drafts, bopRegionalSpec.indicators)).not.toThrow();
    // 19 区分 × 10 項目 = 190 系列のうち 2026Q1 が NA の 16 系列を除く
    expect(drafts).toHaveLength(174);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(new Set(drafts.map((d) => d.period))).toEqual(new Set(["2026-Q1"]));
    expect(new Set(drafts.map((d) => d.indicatorKey)).size).toBe(10);

    // 検証証跡 verified_values と同じ 6 件 (原本 CSV の 2026Q1 列)
    expect(find(drafts, "bop_regional_direct_investment_net", "中華人民共和国").value).toBe(-163_138_201_514);
    expect(find(drafts, "bop_regional_portfolio_investment_net", "アメリカ合衆国").value).toBe(-321_485_204_568);
    expect(find(drafts, "bop_regional_portfolio_investment_equity_asset", "アメリカ合衆国").value).toBe(1_892_553_442_000);
    expect(find(drafts, "bop_regional_portfolio_investment_debt_asset", "ドイツ").value).toBe(-298_381_395_215);
    expect(find(drafts, "bop_regional_direct_investment_net", "アジア計").value).toBe(723_099_152_397);
    const world = find(drafts, "bop_regional_direct_investment_net", "地域別合計");
    expect(world.value).toBe(4_067_364_563_458);
    expect(world.categoryKind).toBe("全体");
    // Python で独立に読んだ追加の 4 件
    expect(find(drafts, "bop_regional_portfolio_investment_liability", "英国").value).toBe(21_425_509_099_407);
    expect(find(drafts, "bop_regional_portfolio_investment_net", "地域別合計").value).toBe(-12_360_079_306_405);
    expect(find(drafts, "bop_regional_portfolio_investment_debt_liability", "大韓民国").value).toBe(-86_076_222_000);
    expect(find(drafts, "bop_regional_portfolio_investment_equity_liability", "EU").value).toBe(-65_232_757_940);

    // 2026Q1 が NA の組み合わせ (例: 非分類の全項目・国際機関の直接投資) は行を作らない
    expect(drafts.some((d) => d.category === "非分類")).toBe(false);
    expect(drafts.some((d) => d.category === "国際機関" && d.indicatorKey.includes("direct_investment"))).toBe(false);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(`${last.indicatorKey}|${last.category}`).toBe("bop_regional_portfolio_investment_debt_liability|東欧・ロシア等");
  });

  it("中身と合わないキー (四半期・最終更新日付の違い) は throw", () => {
    expect(() =>
      bopRegionalSpec.toObservations({ key: "bop-regional-2025-Q4-updated-2026-08-10", files: fixtureFiles() })
    ).toThrow(/一致しません/);
    expect(() =>
      bopRegionalSpec.toObservations({ key: "bop-regional-2026-Q1-updated-2026-09-08", files: fixtureFiles() })
    ).toThrow(/一致しません/);
  });
});

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("実ファイルのバイト列をそのまま保管し、同じキーで toObservations できる", async () => {
    const [zip, page] = fixtureFiles() as [SpecFile, SpecFile];
    stubFetch({ [BOP_REGIONAL_DLOAD_PAGE_URL]: page.bytes, [ZIP_URL]: zip.bytes });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resolved = await bopRegionalSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe(FIXTURE_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(FIXTURE_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual([BOP_REGIONAL_ZIP_FILENAME, BOP_REGIONAL_DLOAD_FILENAME]);
    expect(Buffer.from(batch.files[0]?.bytes as Uint8Array).equals(Buffer.from(zip.bytes))).toBe(true);
    expect(Buffer.from(batch.files[1]?.bytes as Uint8Array).equals(Buffer.from(page.bytes))).toBe(true);
    expect(batch.metadata).toMatchObject({
      lastUpdatedOnPage: "2026-08-10",
      targetQuarter: "2026-Q1",
      csvHeaderPeriods: { first: "2024Q1", last: "2026Q1", count: 9 },
      csvRows: 190,
      observationRows: 174,
    });
    // この抜粋に無い 28 区分と、2026Q1 が全項目 NA の「非分類」は値の無い区分として知らせる
    const regions = (batch.metadata as { regionsWithoutAnyValue: string[] }).regionsWithoutAnyValue;
    expect(regions).toHaveLength(29);
    expect(regions).toContain("非分類");
    expect(regions).toContain("ケイマン諸島");
    expect(warn).toHaveBeenCalledTimes(1);

    const drafts = bopRegionalSpec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(bopRegionalSpec.name, drafts, bopRegionalSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(174);
  });
});
