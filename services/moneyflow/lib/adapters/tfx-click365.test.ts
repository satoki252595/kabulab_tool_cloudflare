/**
 * tfx-click365 アダプタ (くりっく365 / くりっく株365 の月次・年次) のテスト。
 *
 * 実ファイル (private/ — TFX サイトは無断転用・複製不可のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/tfx-click365/` に置く:
 *   - tfx-click365-fx-2026-09.html       … 2026-09-27 に https://www.tfx.co.jp/historical/fx/transit_fx.html
 *                                           から取得したページそのもの (57,643 バイト)
 *   - tfx-clickkabu365-cfd-2026-09.html  … 同日に https://www.tfx.co.jp/historical/cfd/transit_cfd.html
 *                                           から取得したページそのもの (31,381 バイト)
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は python (標準ライブラリの html.parser。取得元モジュールの正規表現パーサとは独立) で
 * 原本の表を読んだ値と、検証証跡 (claude-mf-sources.json の verified_values) の値。
 *
 * CI でも走るテストは、ページの表の様式 (4 表・見出し 2 行・「( )1日平均」行) だけを真似て
 * テスト内で組み立てた **合成テストデータ** の HTML を使う (値は実データではない)。
 */
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { toNotionUpload } from "../../../../src/shared/notion-archive/file-upload.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotionConfigError } from "../../../../src/shared/notion-archive/env.js";
import { NotionUnknownResultError } from "../../../../src/shared/notion-archive/client.js";

const custody = vi.hoisted(() => ({ record: vi.fn(), verify: vi.fn() }));
vi.mock("../../../../src/shared/notion-archive/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/shared/notion-archive/index.js")>()),
  recordPrimaryData: (...args: unknown[]) => custody.record(...args),
  verifyArchivedAttachments: (...args: unknown[]) => custody.verify(...args),
  notionEnv: { NOTION_TOKEN: vi.fn(), NOTION_ARCHIVE_PAGE_ID: vi.fn() },
}));
beforeEach(() => {
  custody.record.mockReset().mockResolvedValue({ pageId: "raw-page", fileTooLarge: false });
  custody.verify.mockReset().mockResolvedValue(undefined);
});
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type MoneyflowSourceSpec, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { TFX_CLICK365_FX_URL, TFX_CLICKKABU365_CFD_URL } from "../sources/tfx-click365.js";
import {
  TFX_CFD_INSTRUMENTS,
  TFX_CLICK365_CFD_ANNUAL_INDICATORS,
  TFX_CLICK365_CFD_INDICATORS,
  TFX_CLICK365_FX_ANNUAL_INDICATORS,
  TFX_CLICK365_FX_INDICATORS,
  TFX_CLICK365_SPECS,
  TFX_FX_INSTRUMENTS,
  tfxClick365CfdAnnualSpec,
  tfxClick365CfdSpec,
  tfxClick365FxAnnualSpec,
  tfxClick365FxSpec,
  tfxPageFilename,
  resolveTfxClick365Page,
} from "./tfx-click365.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/tfx-click365/", import.meta.url));
const FX_FIXTURE = join(FIXTURE_DIR, "tfx-click365-fx-2026-09.html");
const CFD_FIXTURE = join(FIXTURE_DIR, "tfx-clickkabu365-cfd-2026-09.html");

const ROW_BUDGET = 600;
/** 2026-09-27 12:00 (日本時間) — 実ファイルを取得した日。 */
const NOW_2026_09_27 = new Date("2026-09-27T03:00:00Z");

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

function find(drafts: readonly ObservationDraft[], period: string, indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`テスト: ${period}|${indicatorKey}|${category} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

const has = (drafts: readonly ObservationDraft[], period: string, indicatorKey: string, category: string): boolean =>
  drafts.some((d) => d.period === period && d.indicatorKey === indicatorKey && d.category === category);

const sumOf = (drafts: readonly ObservationDraft[], indicatorKey: string): number =>
  drafts.filter((d) => d.indicatorKey === indicatorKey).reduce((s, d) => s + d.value, 0);

/** fetch をスタブし、URL → バイト列の対応だけ 200 で返す (他は 404)。 */
function stubFetch(routes: Record<string, Uint8Array>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown, _init?: unknown) => {
    const url = String(input);
    const bytes = routes[url];
    if (!bytes) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  const all = [
    ...TFX_CLICK365_FX_INDICATORS,
    ...TFX_CLICK365_FX_ANNUAL_INDICATORS,
    ...TFX_CLICK365_CFD_INDICATORS,
    ...TFX_CLICK365_CFD_ANNUAL_INDICATORS,
  ];

  it("全指標が enum ガードを通り、キーが一意で、出典は https、表示名・説明・限界は日本語で空でない", () => {
    expect(all.map((i) => i.key)).toEqual([
      "tfx_click365_fx_turnover",
      "tfx_click365_fx_open_interest",
      "tfx_click365_fx_turnover_annual",
      "tfx_click365_fx_open_interest_year_end",
      "tfx_clickkabu365_cfd_turnover",
      "tfx_clickkabu365_cfd_open_interest",
      "tfx_clickkabu365_cfd_turnover_annual",
      "tfx_clickkabu365_cfd_open_interest_year_end",
    ]);
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
    for (const i of all) {
      expect(i.key, i.key).toMatch(/^[a-z0-9_]+$/);
      expect(isMoneyflowFlowType(i.flowType), i.key).toBe(true);
      expect(isMoneyflowFrequency(i.frequency), i.key).toBe(true);
      expect(isMoneyflowLicense(i.license), i.key).toBe(true);
      expect(isMoneyflowRequirement(i.requirement), i.key).toBe(true);
      expect(new URL(i.sourceUrl).protocol, i.key).toBe("https:");
      for (const text of [i.displayName, i.description, i.limitations]) {
        expect(text.trim().length, i.key).toBeGreaterThan(0);
        expect(text, i.key).toMatch(/[぀-ヿ一-鿿]/);
      }
    }
  });

  it("フロー/ストックの種別・頻度・利用条件・要件が定義どおりで、取り違えやすい点を明記している", () => {
    for (const i of all) {
      expect(i.requirement, i.key).toBe("R3");
      expect(i.license, i.key).toBe("personal-only");
      expect(i.limitations, i.key).toMatch(/無断で転用・複製することはできません/);
      // 利用条件は「許諾が必要」と断定しない (TFX ヒストリカルデータベースは「自由に活用」とも書く)
      expect(i.limitations, i.key).toMatch(/自由に活用/);
      expect(i.limitations, i.key).toMatch(/可否は[^。]*書かれていない/);
      // 原資料・証跡で確かめていない取引単位の倍率 (例「10倍」) を定義に書かない
      expect(`${i.description}${i.limitations}`, i.key).not.toMatch(/倍の量/);
      expect(i.limitations, i.key).toMatch(/1日平均/);
      if (i.key.includes("open_interest")) {
        expect(i.flowType, i.key).toBe("建玉");
        expect(i.description, i.key).toMatch(/残高\(ストック\)であり/);
      } else {
        expect(i.flowType, i.key).toBe("売買代金");
        expect(i.description, i.key).toMatch(/買い越し\/売り越し/);
        expect(i.description, i.key).toMatch(/枚数は金額ではなく/);
      }
      expect(i.frequency, i.key).toBe(/annual|year_end/.test(i.key) ? "年次" : "月次");
    }
    for (const i of [...TFX_CLICK365_FX_INDICATORS, ...TFX_CLICK365_FX_ANNUAL_INDICATORS]) {
      expect(i.sourceUrl).toBe(TFX_CLICK365_FX_URL);
    }
    for (const i of [...TFX_CLICK365_CFD_INDICATORS, ...TFX_CLICK365_CFD_ANNUAL_INDICATORS]) {
      expect(i.sourceUrl).toBe(TFX_CLICKKABU365_CFD_URL);
      expect(i.limitations).toMatch(/／26・／27/);
      expect(i.limitations).toMatch(/2026-09-14/);
      expect(i.limitations).toMatch(/上書きしない/);
    }
    // くりっく株365 の 2025 年分は年の途中からの値 (年間取引数量÷1日平均 = 74〜78 営業日)
    for (const i of TFX_CLICK365_CFD_ANNUAL_INDICATORS) {
      expect(i.limitations, i.key).toMatch(/2025年の途中から取引が始まった/);
    }
  });

  it("spec 名は規約どおりで、各 spec の指標は重ならない", () => {
    expect(TFX_CLICK365_SPECS.map((s) => s.name)).toEqual([
      "tfx-click365-fx",
      "tfx-click365-fx-annual",
      "tfx-click365-cfd",
      "tfx-click365-cfd-annual",
    ]);
    for (const s of TFX_CLICK365_SPECS) expect(s.name).toMatch(/^tfx-click365(-[a-z0-9]+)*$/);
    expect(tfxClick365FxSpec.indicators).toBe(TFX_CLICK365_FX_INDICATORS);
    expect(tfxClick365FxAnnualSpec.indicators).toBe(TFX_CLICK365_FX_ANNUAL_INDICATORS);
    expect(tfxClick365CfdSpec.indicators).toBe(TFX_CLICK365_CFD_INDICATORS);
    expect(tfxClick365CfdAnnualSpec.indicators).toBe(TFX_CLICK365_CFD_ANNUAL_INDICATORS);
    expect(TFX_FX_INSTRUMENTS).toHaveLength(33);
    expect(TFX_CFD_INSTRUMENTS).toHaveLength(22);
    expect(new Set(TFX_FX_INSTRUMENTS).size).toBe(33);
    expect(new Set(TFX_CFD_INSTRUMENTS).size).toBe(22);
  });
});

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない)。ページの表の様式だけを真似た HTML。
// ---------------------------------------------------------------------------

const FX_LABEL = "取引所為替証拠金取引（くりっく３６５）";
const CFD_LABEL = "取引所株価指数証拠金取引（くりっく株３６５）";

interface SynRow {
  label: string;
  values: ReadonlyArray<number | null | "-">;
}

const fmt = (v: number): string => v.toLocaleString("en-US");

/** 実ページと同じ形の表 1 つ (1 行目: 市場ラベル colspan、2 行目: 期間見出し、以降: 区分行 [+ 1日平均行])。 */
function synTable(marketLabel: string, periodLabels: readonly string[], rows: readonly SynRow[], withAvg: boolean): string {
  const head =
    `<table class="snd_table01b"><tr><th width="123" rowspan="2">&nbsp;</th>` +
    `<th colspan="${periodLabels.length}">${marketLabel}</th></tr>` +
    `<tr>${periodLabels.map((p) => `<th>${p}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) => {
      const main =
        `<tr><th${withAvg ? ' rowspan="2"' : ""}>${r.label}</th>` +
        r.values.map((v) => `<td>${v === null ? "" : v === "-" ? v : fmt(v)}</td>`).join("") +
        `</tr>`;
      const avg = withAvg
        ? `<tr>${r.values.map((v) => `<td>${v === null || v === "-" ? "(-)" : `(${fmt(Math.floor(v / 20))})`}</td>`).join("")}</tr>`
        : "";
      return main + avg;
    })
    .join("");
  return `${head}${body}</table>`;
}

/** "YYYY-MM" から新しい順に count か月分の見出し ("YYYY.MM") と期間 ("YYYY-MM")。 */
function monthsDesc(latest: string, count: number): Array<{ label: string; period: string }> {
  const [y, m] = latest.split("-").map(Number) as [number, number];
  const out: Array<{ label: string; period: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const idx = y * 12 + (m - 1) - i;
    const yy = Math.floor(idx / 12);
    const mm = String((idx % 12) + 1).padStart(2, "0");
    out.push({ label: `${yy}.${mm}`, period: `${yy}-${mm}` });
  }
  return out;
}

/**
 * 合成テストデータのページ (実データではない)。区分 i (掲載順 0 始まり)・期間 j (新しい順 0 始まり) の値 (枚):
 *   月次取引数量 = (i+1)×1,000 + j / 月末建玉 = (i+1)×100 + j /
 *   年次取引数量 = (i+1)×50,000 + j / 年末建玉 = (i+1)×700 + j
 * blank で指定した区分・期間は、取引数量と建玉の両方を空欄 (取扱いが無い期間) にする。
 */
function synPage(opts: {
  marketLabel: string;
  instruments: readonly string[];
  latestMonth?: string;
  monthCount?: number;
  latestYear?: number;
  yearCount?: number;
  blank?: ReadonlyArray<{ instrument: string; period: string }>;
  dash?: ReadonlyArray<{ instrument: string; period: string }>;
}): string {
  const months = monthsDesc(opts.latestMonth ?? "2026-08", opts.monthCount ?? 7);
  const latestYear = opts.latestYear ?? 2025;
  const years = Array.from({ length: opts.yearCount ?? 3 }, (_, j) => String(latestYear - j));
  const isBlank = (instrument: string, period: string): boolean =>
    (opts.blank ?? []).some((b) => b.instrument === instrument && b.period === period);
  const rows = (periods: readonly string[], base: number, step: number): SynRow[] =>
    opts.instruments.map((label, i) => ({
      label,
      values: periods.map((p, j) =>
        (opts.dash ?? []).some((d) => d.instrument === label && d.period === p)
          ? "-" : isBlank(label, p) ? null : (i + 1) * step + base + j),
    }));
  const monthPeriods = months.map((m) => m.period);
  const monthLabels = months.map((m) => m.label);
  // 実ページと同じく、各表の直後に単位の注記を置く (出来高表は「※ ( )1日平均 / 単位：枚」、
  // 建玉表は「単位：枚」。区切りの空白は全角)。取得元モジュールは 4 表ぶんの注記を確かめる。
  const volumeNote = "<p>※　( )1日平均　/　単位：枚</p>";
  const oiNote = "<p>単位：枚</p>";
  const tables = [
    synTable(opts.marketLabel, monthLabels, rows(monthPeriods, 0, 1_000), true) + volumeNote,
    synTable(opts.marketLabel, years, rows(years, 0, 50_000), true) + volumeNote,
    synTable(opts.marketLabel, monthLabels, rows(monthPeriods, 0, 100), false) + oiNote,
    synTable(opts.marketLabel, years, rows(years, 0, 700), false) + oiNote,
  ];
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>合成テストデータ (実データではない)</title></head>` +
    `<body>${tables.join("")}</body></html>`
  );
}

const SYN_FX_INSTRUMENTS = ["ユーロ／円", "米ドル／円", "チェココルナ／円"] as const;
const SYN_CFD_INSTRUMENTS = ["金ETF リセット付証拠金取引／26", "日経 225 リセット付証拠金取引／26"] as const;

const file = (key: string, html: string | Uint8Array): SpecFile => ({
  filename: tfxPageFilename(key),
  bytes: typeof html === "string" ? utf8(html) : html,
});

describe("2027年リセット銘柄の原名と上場前欠測", () => {
  const oldName = "日経 225 リセット付証拠金取引／26";
  const newName = "日経 225 リセット付証拠金取引／27";
  const missing = monthsDesc("2026-09", 7).slice(1).map(({ period }) => ({ instrument: newName, period }));
  const html = () => synPage({ marketLabel: CFD_LABEL, instruments: [oldName, newName], latestMonth: "2026-09", dash: missing,
    blank: ["2025", "2024", "2023"].map((period) => ({ instrument: newName, period })) });

  it("／26の全値を保ち、／27の9月原値だけ別区分で記録し、上場前を0にしない", () => {
    const key = "tfx-click365-cfd-2026-09";
    const drafts = tfxClick365CfdSpec.toObservations({ key, files: [file(key, html())] });
    const original = tfxClick365CfdSpec.toObservations({ key, files: [file(key, synPage({ marketLabel: CFD_LABEL, instruments: [oldName], latestMonth: "2026-09" }))] });
    expect(drafts.filter((d) => d.category === oldName)).toEqual(original);
    expect(drafts.filter((d) => d.category === newName)).toHaveLength(2);
    expect(drafts.filter((d) => d.category === newName).every((d) => d.period === "2026-09" && d.value > 0)).toBe(true);
    const annualKey = "tfx-click365-cfd-annual-2025";
    expect(tfxClick365CfdAnnualSpec.toObservations({ key: annualKey, files: [file(annualKey, html())] }).every((d) => d.category === oldName)).toBe(true);
  });

  it("最新月dash、未知／28、別市場dash、不正数量、欠測なのに数値の平均を拒否する", () => {
    const key = "tfx-click365-cfd-2026-09", parse = (h: string) => tfxClick365CfdSpec.toObservations({ key, files: [file(key, h)] });
    expect(() => parse(synPage({ marketLabel: CFD_LABEL, instruments: [newName], latestMonth: "2026-09", dash: [{ instrument: newName, period: "2026-09" }] }))).toThrow(/数量セル/);
    expect(() => parse(html().replaceAll("／27", "／28").replaceAll("<td>-</td>", "<td></td>"))).toThrow(/未知/);
    expect(() => parse(html().replace("<td></td>", "<td>-</td>"))).toThrow(/数量セル/);
    expect(() => tfxClick365FxSpec.toObservations({ key: "tfx-click365-fx-2026-09", files: [file("tfx-click365-fx-2026-09", synPage({ marketLabel: FX_LABEL, instruments: ["米ドル／円"], latestMonth: "2026-09", dash: [{ instrument: "米ドル／円", period: "2026-08" }] }))] })).toThrow(/数量セル/);
    expect(() => parse(html().replace("<td>-</td>", "<td>N/A</td>"))).toThrow(/数量セル/);
    expect(() => parse(html().replace("<td>(-)</td>", "<td>(1)</td>"))).toThrow(/1日平均/);
  });
});

describe("受信済み原本から正準resolve純部を再用", () => {
  it.each(TFX_CLICK365_SPECS)("$name はHTTPなしで原時計と同bytesを保持する", async (spec) => {
    const market = spec.name.includes("-cfd") ? "clickkabu365_cfd" : "click365_fx";
    const kind = spec.name.endsWith("-annual") ? "year" : "month";
    const bytes = utf8(synPage({ marketLabel: market === "click365_fx" ? FX_LABEL : CFD_LABEL, instruments: market === "click365_fx" ? SYN_FX_INSTRUMENTS : SYN_CFD_INSTRUMENTS }));
    const sourceClock = "2026-09-27T03:00:01.123Z", url = market === "click365_fx" ? TFX_CLICK365_FX_URL : TFX_CLICKKABU365_CFD_URL;
    const fetch = vi.fn(() => { throw new Error("HTTP禁止"); });vi.stubGlobal("fetch", fetch);
    const resolved = resolveTfxClick365Page(market, kind, { url, bytes, fetchedAt: sourceClock }, NOW_2026_09_27);
    const batch = await resolved.fetch();expect(batch.key).toBe(`${spec.name}-${kind === "month" ? "2026-08" : "2025"}`);
    expect(batch.metadata.fetchedAt).toBe(sourceClock);expect(batch.metadata.resolvedAt).toBe(NOW_2026_09_27.toISOString());expect(sameBytes(batch.files[0]?.bytes, bytes)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => resolveTfxClick365Page(market, kind, { url: TFX_CLICK365_FX_URL + "/別URL", bytes, fetchedAt: sourceClock }, NOW_2026_09_27)).toThrow(/URL/);
  });
});

// ---------------------------------------------------------------------------
// 2. toObservations (合成テストデータ・CI で走る)
// ---------------------------------------------------------------------------

describe("tfx-click365-fx toObservations (合成テストデータ)", () => {
  const key = "tfx-click365-fx-2026-08";
  const html = synPage({
    marketLabel: FX_LABEL,
    instruments: SYN_FX_INSTRUMENTS,
    blank: [{ instrument: "チェココルナ／円", period: "2026-02" }],
  });
  const drafts = tfxClick365FxSpec.toObservations({ key, files: [file(key, html)] });

  it("検証を通り、空欄を除く 7 か月 × 3 通貨ペア × 2 指標の行を作る (1日平均の行は作らない)", () => {
    expect(() => validateDrafts(tfxClick365FxSpec.name, drafts, tfxClick365FxSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(7 * 3 * 2 - 2);
    expect(new Set(drafts.map((d) => d.indicatorKey))).toEqual(
      new Set(["tfx_click365_fx_turnover", "tfx_click365_fx_open_interest"])
    );
    expect(new Set(drafts.map((d) => d.period))).toEqual(
      new Set(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"])
    );
  });

  it("月間取引数量は月初〜月末、月末建玉は月末日の 1 点。単位は枚のまま、近似・実測・前期比 null", () => {
    // 米ドル／円 は合成ページの掲載順 1 (i=1)、2026-08 は新しい順 0 (j=0)
    const vol = find(drafts, "2026-08", "tfx_click365_fx_turnover", "米ドル／円");
    expect(vol).toEqual({
      period: "2026-08",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      indicatorKey: "tfx_click365_fx_turnover",
      category: "米ドル／円",
      categoryKind: "通貨",
      value: 2_000,
      unit: "枚",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
    });
    const oi = find(drafts, "2026-02", "tfx_click365_fx_open_interest", "ユーロ／円");
    expect(oi.periodStart).toBe("2026-02-28");
    expect(oi.periodEnd).toBe("2026-02-28");
    expect(oi.value).toBe(100 + 6);
    for (const d of drafts) {
      expect(d.unit).toBe("枚");
      expect(d.categoryKind).toBe("通貨");
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
  });

  it("原資料の空欄 (取扱いが無い期間) は 0 で埋めず行を作らない", () => {
    expect(has(drafts, "2026-02", "tfx_click365_fx_turnover", "チェココルナ／円")).toBe(false);
    expect(has(drafts, "2026-02", "tfx_click365_fx_open_interest", "チェココルナ／円")).toBe(false);
    expect(find(drafts, "2026-03", "tfx_click365_fx_turnover", "チェココルナ／円").value).toBe(3_000 + 5);
  });

  it("行順は 指標 (取引数量→建玉) → 期間の古い順 → 固定の通貨ペア順 (ページの掲載順に依らない)", () => {
    expect(drafts.slice(0, 3).map((d) => [d.period, d.indicatorKey, d.category])).toEqual([
      ["2026-02", "tfx_click365_fx_turnover", "米ドル／円"],
      ["2026-02", "tfx_click365_fx_turnover", "ユーロ／円"],
      ["2026-03", "tfx_click365_fx_turnover", "米ドル／円"],
    ]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category, last.value]).toEqual([
      "2026-08",
      "tfx_click365_fx_open_interest",
      "チェココルナ／円",
      300,
    ]);
    // 同じ入力なら同じ結果 (純関数)
    expect(tfxClick365FxSpec.toObservations({ key, files: [file(key, html)] })).toEqual(drafts);
  });
});

describe("tfx-click365-fx-annual toObservations (合成テストデータ)", () => {
  const key = "tfx-click365-fx-annual-2025";
  const html = synPage({
    marketLabel: FX_LABEL,
    instruments: SYN_FX_INSTRUMENTS,
    blank: [
      { instrument: "チェココルナ／円", period: "2023" },
      { instrument: "チェココルナ／円", period: "2024" },
    ],
  });
  const drafts = tfxClick365FxAnnualSpec.toObservations({ key, files: [file(key, html)] });

  it("検証を通り、年間取引数量は 1/1〜12/31、年末建玉は 12/31 の 1 点。空欄の年は行を作らない", () => {
    expect(() => validateDrafts(tfxClick365FxAnnualSpec.name, drafts, tfxClick365FxAnnualSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(3 * 3 * 2 - 4);
    const vol = find(drafts, "2023", "tfx_click365_fx_turnover_annual", "ユーロ／円");
    expect([vol.periodStart, vol.periodEnd, vol.value, vol.unit]).toEqual(["2023-01-01", "2023-12-31", 50_000 + 2, "枚"]);
    const oi = find(drafts, "2025", "tfx_click365_fx_open_interest_year_end", "米ドル／円");
    expect([oi.periodStart, oi.periodEnd, oi.value]).toEqual(["2025-12-31", "2025-12-31", 1_400]);
    expect(has(drafts, "2024", "tfx_click365_fx_turnover_annual", "チェココルナ／円")).toBe(false);
    expect(has(drafts, "2023", "tfx_click365_fx_open_interest_year_end", "チェココルナ／円")).toBe(false);
    expect(find(drafts, "2025", "tfx_click365_fx_turnover_annual", "チェココルナ／円").value).toBe(150_000);
    for (const d of drafts) {
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
  });
});

describe("tfx-click365-cfd / cfd-annual toObservations (合成テストデータ)", () => {
  it("銘柄は区分種別「商品」、月次・年次とも検証を通る", () => {
    const html = synPage({ marketLabel: CFD_LABEL, instruments: SYN_CFD_INSTRUMENTS });
    const mKey = "tfx-click365-cfd-2026-08";
    const monthly = tfxClick365CfdSpec.toObservations({ key: mKey, files: [file(mKey, html)] });
    expect(() => validateDrafts(tfxClick365CfdSpec.name, monthly, tfxClick365CfdSpec.indicators)).not.toThrow();
    expect(monthly).toHaveLength(7 * 2 * 2);
    // 日経225 は固定の銘柄順で金ETFより前 (合成ページの掲載順は逆)
    expect(monthly[0]?.category).toBe("日経 225 リセット付証拠金取引／26");
    expect(find(monthly, "2026-08", "tfx_clickkabu365_cfd_open_interest", "日経 225 リセット付証拠金取引／26").value).toBe(200);
    for (const d of monthly) expect(d.categoryKind).toBe("商品");

    const aKey = "tfx-click365-cfd-annual-2025";
    const annual = tfxClick365CfdAnnualSpec.toObservations({ key: aKey, files: [file(aKey, html)] });
    expect(() => validateDrafts(tfxClick365CfdAnnualSpec.name, annual, tfxClick365CfdAnnualSpec.indicators)).not.toThrow();
    expect(annual).toHaveLength(3 * 2 * 2);
    expect(find(annual, "2024", "tfx_clickkabu365_cfd_turnover_annual", "金ETF リセット付証拠金取引／26").value).toBe(50_001);
  });
});

// ---------------------------------------------------------------------------
// 3. 想定外の入力で throw する (合成テストデータ・CI で走る)
// ---------------------------------------------------------------------------

describe("想定外の入力で throw する", () => {
  const fxHtml = synPage({ marketLabel: FX_LABEL, instruments: SYN_FX_INSTRUMENTS });
  const fxKey = "tfx-click365-fx-2026-08";

  it("ファイルが無い・名前が違う・同名が 2 件", () => {
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [] })).toThrow(/該当ファイルが 0 件/);
    expect(() =>
      tfxClick365FxSpec.toObservations({ key: fxKey, files: [{ filename: "transit_fx.html", bytes: utf8(fxHtml) }] })
    ).toThrow(/該当ファイルが 0 件/);
    expect(() =>
      tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, fxHtml), file(fxKey, fxHtml)] })
    ).toThrow(/該当ファイルが 2 件/);
  });

  it("キーの形式が不正 (月が 1 桁・13 月・年次キーを月次 spec へ)", () => {
    for (const bad of ["tfx-click365-fx-2026-8", "tfx-click365-fx-2026-13", "tfx-click365-fx-annual-2025"]) {
      expect(() => tfxClick365FxSpec.toObservations({ key: bad, files: [file(bad, fxHtml)] }), bad).toThrow(
        /冪等キーの形式が不正|月が不正/
      );
    }
    expect(() =>
      tfxClick365FxAnnualSpec.toObservations({ key: "tfx-click365-fx-annual-25", files: [file("tfx-click365-fx-annual-25", fxHtml)] })
    ).toThrow(/冪等キーの形式が不正/);
  });

  it("キーの期間とファイルの最新期間が食い違う", () => {
    const key = "tfx-click365-fx-2026-09";
    expect(() => tfxClick365FxSpec.toObservations({ key, files: [file(key, fxHtml)] })).toThrow(/表の期間が想定と違います/);
    const aKey = "tfx-click365-fx-annual-2026";
    expect(() => tfxClick365FxAnnualSpec.toObservations({ key: aKey, files: [file(aKey, fxHtml)] })).toThrow(
      /表の期間が想定と違います/
    );
  });

  it("表示期間が変わった (月次 6 か月・年次 5 年)", () => {
    const six = synPage({ marketLabel: FX_LABEL, instruments: SYN_FX_INSTRUMENTS, monthCount: 6 });
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, six)] })).toThrow(/表の期間が想定と違います/);
    const five = synPage({ marketLabel: FX_LABEL, instruments: SYN_FX_INSTRUMENTS, yearCount: 5 });
    const aKey = "tfx-click365-fx-annual-2025";
    expect(() => tfxClick365FxAnnualSpec.toObservations({ key: aKey, files: [file(aKey, five)] })).toThrow(
      /表の期間が想定と違います/
    );
  });

  it("未知の通貨ペア・銘柄 (新規上場・名称変更・未確認のリセット年)", () => {
    const fx = synPage({ marketLabel: FX_LABEL, instruments: ["米ドル／円", "ビットコイン／円"] });
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, fx)] })).toThrow(/未知の通貨ペア/);
    const cfd = synPage({ marketLabel: CFD_LABEL, instruments: ["日経 225 リセット付証拠金取引／28"] });
    const cKey = "tfx-click365-cfd-2026-08";
    expect(() => tfxClick365CfdSpec.toObservations({ key: cKey, files: [file(cKey, cfd)] })).toThrow(/未知の銘柄/);
  });

  it("FX のページを CFD の spec に渡す (市場ラベルの取り違え)", () => {
    const cKey = "tfx-click365-cfd-2026-08";
    expect(() => tfxClick365CfdSpec.toObservations({ key: cKey, files: [file(cKey, fxHtml)] })).toThrow(/市場ラベル/);
  });

  it("最新期間の列が全区分とも空欄 (未公表の列) なら throw する (完了判定の最後の行が古い期間にならないように)", () => {
    const blankLatestMonth = synPage({
      marketLabel: FX_LABEL,
      instruments: SYN_FX_INSTRUMENTS,
      blank: SYN_FX_INSTRUMENTS.map((instrument) => ({ instrument, period: "2026-08" })),
    });
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, blankLatestMonth)] })).toThrow(
      /最新期間 2026-08 の列に値が 1 つもありません/
    );
    const blankLatestYear = synPage({
      marketLabel: FX_LABEL,
      instruments: SYN_FX_INSTRUMENTS,
      blank: SYN_FX_INSTRUMENTS.map((instrument) => ({ instrument, period: "2025" })),
    });
    const aKey = "tfx-click365-fx-annual-2025";
    expect(() => tfxClick365FxAnnualSpec.toObservations({ key: aKey, files: [file(aKey, blankLatestYear)] })).toThrow(
      /最新期間 2025 の列に値が 1 つもありません/
    );
    // 一部の区分だけ空欄なら通り、最後の行 (完了判定の印) は最新期間の行
    const partial = synPage({
      marketLabel: FX_LABEL,
      instruments: SYN_FX_INSTRUMENTS,
      blank: [{ instrument: "チェココルナ／円", period: "2026-08" }],
    });
    const drafts = tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, partial)] });
    expect((drafts[drafts.length - 1] as ObservationDraft).period).toBe("2026-08");
  });

  it("UTF-8 として不正なバイト列・表の数が違う HTML", () => {
    const broken = new Uint8Array([...utf8(fxHtml.slice(0, 200)), 0xff, 0xfe, 0xfd]);
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, broken)] })).toThrow(/UTF-8/);
    const threeTables = fxHtml.replace(/<table[\s\S]*?<\/table>/, "");
    expect(() => tfxClick365FxSpec.toObservations({ key: fxKey, files: [file(fxKey, threeTables)] })).toThrow(/<table>/);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve()/fetch() (fetch をスタブ・合成テストデータ・CI で走る)
// ---------------------------------------------------------------------------

describe("resolve()/fetch() (fetch をスタブ・合成テストデータ)", () => {
  const fxBytes = utf8(synPage({ marketLabel: FX_LABEL, instruments: SYN_FX_INSTRUMENTS }));

  it("月次: 最新月からキーを決め、fetch() は同じキー・同じバイト列を安定したファイル名で返す (GET は 1 回)", async () => {
    const fn = stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    const resolved = await tfxClick365FxSpec.resolve(NOW_2026_09_27);
    expect(resolved.key).toBe("tfx-click365-fx-2026-08");
    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.source).toBe(TFX_CLICK365_FX_URL);
    expect(batch.files).toHaveLength(1);
    expect(batch.files[0]?.filename).toBe("tfx-click365-fx-2026-08.html");
    expect(batch.files[0]?.contentType).toBe("text/html; charset=utf-8");
    expect(sameBytes(batch.files[0]?.bytes, fxBytes)).toBe(true);
    expect(batch.metadata).toMatchObject({ url: TFX_CLICK365_FX_URL, latestPeriod: "2026-08", spec: "tfx-click365-fx" });
    expect(fn).toHaveBeenCalledTimes(1);
    const init = fn.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(String(fn.mock.calls[0]?.[0])).toBe(TFX_CLICK365_FX_URL);
    expect(init.headers["User-Agent"]).toMatch(/Mozilla\/5\.0/);
    const drafts = tfxClick365FxSpec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(tfxClick365FxSpec.name, drafts, tfxClick365FxSpec.indicators)).not.toThrow();
  });

  it.each([tfxClick365FxSpec, tfxClick365FxAnnualSpec, tfxClick365CfdSpec, tfxClick365CfdAnnualSpec])("$name は期間を解析できない原文も100文字以内の添付名で先に全文保管・照合する", async (spec) => {
    const bytes = utf8("<html>解析不能な原文</html>");
    const url = spec.name.includes("cfd") ? TFX_CLICKKABU365_CFD_URL : TFX_CLICK365_FX_URL;
    const fn = stubFetch({ [url]: bytes });
    await expect(spec.resolve(NOW_2026_09_27)).rejects.toThrow(/<table>/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(custody.record).toHaveBeenCalledTimes(1);
    const input = custody.record.mock.calls[0]![0];
    expect(input).toMatchObject({ service: "moneyflow", source: url, force: false, metadata: { status: 200, bytes: bytes.length } });
    expect(sameBytes(input.files[0].bytes, bytes)).toBe(true);
    expect(input.key).toMatch(/^tfx-(click365_fx|clickkabu365_cfd)-raw-http-200-sha256-[a-f0-9]{64}$/);
    const upload = toNotionUpload(input.files[0].filename, input.files[0].contentType);
    expect(upload.filename.length).toBeLessThanOrEqual(100);
    expect(upload.filename).toContain(input.metadata.sha256);
    expect(custody.verify).toHaveBeenCalledWith("raw-page", input.files, "TFX 原本");
  });

  it.each([new NotionUnknownResultError("unknown"), new NotionConfigError("config")])("原本保管のSTOP型は同一objectで伝播し解析へ進まない", async (error) => {
    stubFetch({ [TFX_CLICK365_FX_URL]: utf8("解析不能な原文") });
    custody.record.mockRejectedValueOnce(error);
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toBe(error);
    expect(custody.verify).not.toHaveBeenCalled();
  });

  it("原本readback不一致は品質エラー扱いで次sourceへ進ませず、元errorをcauseに保持する", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: utf8("解析不能な原文") });
    const original = new Error("bytes mismatch");
    custody.verify.mockRejectedValueOnce(original);
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toMatchObject({ name: "NotionConfigError", cause: original });
  });

  it("非200原bodyはNotion受理gzipの全byte照合後にHTTPエラーを返す", async () => {
    const bytes = utf8("HTTP失敗の原文");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes), { status: 503 })));
    await expect(tfxClick365CfdSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/HTTP 503/);
    const input = custody.record.mock.calls[0]![0];
    const f = input.files[0];
    expect(input.metadata).toMatchObject({ status: 503, bytes: bytes.length, archiveEncoding: "gzip" });
    expect(sameBytes(gunzipSync(f.bytes), bytes)).toBe(true);
    expect(toNotionUpload(f.filename, f.contentType)).toEqual({ filename: f.filename, contentType: "application/gzip" });
    expect(f.filename.length).toBeLessThanOrEqual(100);
    expect(custody.verify).toHaveBeenCalledWith("raw-page", input.files, "TFX 原本");
  });

  it("容量上限はparse不成立に混ぜず後続sourceを停止する", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    custody.record.mockResolvedValueOnce({ pageId: "raw-page", fileTooLarge: true });
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toBeInstanceOf(NotionConfigError);
    expect(custody.verify).not.toHaveBeenCalled();
  });

  it("dry-runは原本保管へ送信しない", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    await tfxClick365FxSpec.resolve(NOW_2026_09_27, true);
    expect(custody.record).not.toHaveBeenCalled();
    expect(custody.verify).not.toHaveBeenCalled();
  });

  it("年次: 最新年からキーを決める", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    const resolved = await tfxClick365FxAnnualSpec.resolve(NOW_2026_09_27);
    expect(resolved.key).toBe("tfx-click365-fx-annual-2025");
    const batch = await resolved.fetch();
    expect(batch.files[0]?.filename).toBe("tfx-click365-fx-annual-2025.html");
    expect(tfxClick365FxAnnualSpec.toObservations({ key: batch.key, files: batch.files })).toHaveLength(3 * 3 * 2);
  });

  it("更新停止の検知: 最新月が実行月 (日本時間) の 2 か月前より古いと throw (境界は日本時間の月替わり)", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    // 日本時間 2026-10-31 23:59:59 → 実行月 2026-10、2026-08 は 2 か月前で許容
    await expect(tfxClick365FxSpec.resolve(new Date("2026-10-31T14:59:59Z"))).resolves.toMatchObject({
      key: "tfx-click365-fx-2026-08",
    });
    // 日本時間 2026-11-01 00:00 → 実行月 2026-11、2026-09 分まで無いので失敗
    await expect(tfxClick365FxSpec.resolve(new Date("2026-10-31T15:00:00Z"))).rejects.toThrow(/更新停止/);
    await expect(tfxClick365FxAnnualSpec.resolve(new Date("2026-10-31T15:00:00Z"))).rejects.toThrow(/更新停止/);
  });

  it("最新月が実行月より後 (時計かページの異常) なら throw", async () => {
    stubFetch({ [TFX_CLICK365_FX_URL]: fxBytes });
    await expect(tfxClick365FxSpec.resolve(new Date("2026-07-31T14:00:00Z"))).rejects.toThrow(/実行月 2026-07/);
    await expect(tfxClick365FxSpec.resolve(new Date("2026-07-31T15:00:00Z"))).resolves.toMatchObject({
      key: "tfx-click365-fx-2026-08",
    });
  });

  it("年次の最新年が月次の最新月と整合しなければ throw (12 月分の掲載時だけ前年・当年の両方を許す)", async () => {
    const page = (latestMonth: string, latestYear: number): Uint8Array =>
      utf8(synPage({ marketLabel: FX_LABEL, instruments: SYN_FX_INSTRUMENTS, latestMonth, latestYear }));
    stubFetch({ [TFX_CLICK365_FX_URL]: page("2027-01", 2025) });
    await expect(tfxClick365FxAnnualSpec.resolve(new Date("2027-02-15T00:00:00Z"))).rejects.toThrow(/整合しません/);
    stubFetch({ [TFX_CLICK365_FX_URL]: page("2026-12", 2025) });
    await expect(tfxClick365FxAnnualSpec.resolve(new Date("2027-01-15T00:00:00Z"))).resolves.toMatchObject({
      key: "tfx-click365-fx-annual-2025",
    });
    stubFetch({ [TFX_CLICK365_FX_URL]: page("2026-12", 2026) });
    await expect(tfxClick365FxAnnualSpec.resolve(new Date("2027-01-15T00:00:00Z"))).resolves.toMatchObject({
      key: "tfx-click365-fx-annual-2026",
    });
    stubFetch({ [TFX_CLICK365_FX_URL]: page("2026-08", 2026) });
    await expect(tfxClick365FxAnnualSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/整合しません/);
  });

  it("最新期間の列が全区分とも空欄なら resolve() が throw する (値の無い列でキーを作って保管しない)", async () => {
    const blankMonth = synPage({
      marketLabel: FX_LABEL,
      instruments: SYN_FX_INSTRUMENTS,
      blank: SYN_FX_INSTRUMENTS.map((instrument) => ({ instrument, period: "2026-08" })),
    });
    stubFetch({ [TFX_CLICK365_FX_URL]: utf8(blankMonth) });
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/最新期間 2026-08 の列に値が 1 つもありません/);
    const blankYear = synPage({
      marketLabel: FX_LABEL,
      instruments: SYN_FX_INSTRUMENTS,
      blank: SYN_FX_INSTRUMENTS.map((instrument) => ({ instrument, period: "2025" })),
    });
    stubFetch({ [TFX_CLICK365_FX_URL]: utf8(blankYear) });
    await expect(tfxClick365FxAnnualSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/最新期間 2025 の列に値が 1 つもありません/);
  });

  it("HTTP エラー・空の本文・別市場のページは throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503, statusText: "Service Unavailable" }))
    );
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/HTTP 503/);
    stubFetch({ [TFX_CLICK365_FX_URL]: new Uint8Array(0) });
    await expect(tfxClick365FxSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/本文が空/);
    stubFetch({ [TFX_CLICKKABU365_CFD_URL]: fxBytes });
    await expect(tfxClick365CfdSpec.resolve(NOW_2026_09_27)).rejects.toThrow(/市場ラベル/);
  });
});

// ---------------------------------------------------------------------------
// 5. 実ファイル (2026-09-27 取得。private/ に置いた環境でのみ走る)
// ---------------------------------------------------------------------------

function runReal(spec: MoneyflowSourceSpec, key: string, path: string): ObservationDraft[] {
  const drafts = spec.toObservations({ key, files: [{ filename: tfxPageFilename(key), bytes: readBytes(path) }] });
  validateDrafts(spec.name, drafts, spec.indicators);
  return drafts;
}

describe.skipIf(!existsSync(FX_FIXTURE))("実ファイル くりっく365 (tfx-click365-fx-2026-09.html)", () => {
  it("月次: 検証を通り、33 通貨ペア × 7 か月 × 2 指標 = 462 行 (行数の目安以内)、値は原本どおり", () => {
    const drafts = runReal(tfxClick365FxSpec, "tfx-click365-fx-2026-08", FX_FIXTURE);
    expect(drafts).toHaveLength(462);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const usdJpy = find(drafts, "2026-08", "tfx_click365_fx_turnover", "米ドル／円");
    expect([usdJpy.value, usdJpy.unit, usdJpy.periodStart, usdJpy.periodEnd, usdJpy.categoryKind]).toEqual([
      376_532,
      "枚",
      "2026-08-01",
      "2026-08-31",
      "通貨",
    ]);
    expect(find(drafts, "2026-02", "tfx_click365_fx_turnover", "ユーロ／米国ドル（ラージ）").value).toBe(39);
    expect(find(drafts, "2026-08", "tfx_click365_fx_turnover", "チェココルナ／円").value).toBe(470);
    const oi = find(drafts, "2026-08", "tfx_click365_fx_open_interest", "米ドル／円");
    expect([oi.value, oi.unit, oi.periodStart, oi.periodEnd]).toEqual([347_485, "枚", "2026-08-31", "2026-08-31"]);
    expect(find(drafts, "2026-02", "tfx_click365_fx_open_interest", "トルコリラ／円").value).toBe(1_080_380);
    // 全セルの合計 (python html.parser で原本から独立に集計した値)
    expect(sumOf(drafts, "tfx_click365_fx_turnover")).toBe(13_663_891);
    expect(sumOf(drafts, "tfx_click365_fx_open_interest")).toBe(16_449_806);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category, last.value]).toEqual([
      "2026-08",
      "tfx_click365_fx_open_interest",
      "ユーロ／米国ドル（ラージ）",
      10,
    ]);
  });

  it("年次: 検証を通り、空欄 (3 通貨ペアの 2023・2024 年) を除く 186 行、値は原本どおり", () => {
    const drafts = runReal(tfxClick365FxAnnualSpec, "tfx-click365-fx-annual-2025", FX_FIXTURE);
    expect(drafts).toHaveLength(186);
    const v2025 = find(drafts, "2025", "tfx_click365_fx_turnover_annual", "米ドル／円");
    expect([v2025.value, v2025.unit, v2025.periodStart, v2025.periodEnd]).toEqual([6_003_872, "枚", "2025-01-01", "2025-12-31"]);
    expect(find(drafts, "2023", "tfx_click365_fx_turnover_annual", "米ドル／円").value).toBe(10_551_523);
    expect(find(drafts, "2025", "tfx_click365_fx_turnover_annual", "中国オフショア人民元／円").value).toBe(161_393);
    expect(has(drafts, "2024", "tfx_click365_fx_turnover_annual", "中国オフショア人民元／円")).toBe(false);
    expect(has(drafts, "2023", "tfx_click365_fx_open_interest_year_end", "チェココルナ／円")).toBe(false);
    const ye = find(drafts, "2025", "tfx_click365_fx_open_interest_year_end", "米ドル／円");
    expect([ye.value, ye.periodStart, ye.periodEnd]).toEqual([389_171, "2025-12-31", "2025-12-31"]);
    expect(find(drafts, "2023", "tfx_click365_fx_open_interest_year_end", "メキシコペソ／円").value).toBe(160_672);
    expect(sumOf(drafts, "tfx_click365_fx_turnover_annual")).toBe(74_772_657);
    expect(sumOf(drafts, "tfx_click365_fx_open_interest_year_end")).toBe(4_594_081);
  });

  it("resolve()/fetch(): 実ページのバイト列から月次・年次のキーを決め、同じバイト列を返す", async () => {
    const bytes = readBytes(FX_FIXTURE);
    stubFetch({ [TFX_CLICK365_FX_URL]: bytes });
    const m = await tfxClick365FxSpec.resolve(NOW_2026_09_27);
    expect(m.key).toBe("tfx-click365-fx-2026-08");
    const mb = await m.fetch();
    expect(mb.key).toBe(m.key);
    expect(mb.files.map((f) => f.filename)).toEqual(["tfx-click365-fx-2026-08.html"]);
    expect(sameBytes(mb.files[0]?.bytes, bytes)).toBe(true);
    expect(tfxClick365FxSpec.toObservations({ key: mb.key, files: mb.files })).toHaveLength(462);
    const a = await tfxClick365FxAnnualSpec.resolve(NOW_2026_09_27);
    expect(a.key).toBe("tfx-click365-fx-annual-2025");
    const ab = await a.fetch();
    expect(ab.files.map((f) => f.filename)).toEqual(["tfx-click365-fx-annual-2025.html"]);
    expect(tfxClick365FxAnnualSpec.toObservations({ key: ab.key, files: ab.files })).toHaveLength(186);
  });
});

describe.skipIf(!existsSync(CFD_FIXTURE))("実ファイル くりっく株365 (tfx-clickkabu365-cfd-2026-09.html)", () => {
  it("月次: 検証を通り、11 銘柄 × 7 か月 × 2 指標 = 154 行、値は原本どおり", () => {
    const drafts = runReal(tfxClick365CfdSpec, "tfx-click365-cfd-2026-08", CFD_FIXTURE);
    expect(drafts).toHaveLength(154);
    const n225 = find(drafts, "2026-08", "tfx_clickkabu365_cfd_turnover", "日経 225 リセット付証拠金取引／26");
    expect([n225.value, n225.unit, n225.categoryKind]).toEqual([728_991, "枚", "商品"]);
    expect(find(drafts, "2026-02", "tfx_clickkabu365_cfd_turnover", "原油ETF リセット付証拠金取引／26").value).toBe(121_284);
    const oi = find(drafts, "2026-08", "tfx_clickkabu365_cfd_open_interest", "日経 225 リセット付証拠金取引／26");
    expect([oi.value, oi.periodStart, oi.periodEnd]).toEqual([34_495, "2026-08-31", "2026-08-31"]);
    expect(sumOf(drafts, "tfx_clickkabu365_cfd_turnover")).toBe(33_002_264);
    expect(sumOf(drafts, "tfx_clickkabu365_cfd_open_interest")).toBe(1_546_125);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.category, last.value]).toEqual(["2026-08", "原油ETF リセット付証拠金取引／26", 30_440]);
  });

  it("年次: 2025 年だけ値があり (2024・2023 年は全銘柄空欄) 22 行、値は原本どおり", () => {
    const drafts = runReal(tfxClick365CfdAnnualSpec, "tfx-click365-cfd-annual-2025", CFD_FIXTURE);
    expect(drafts).toHaveLength(22);
    expect(new Set(drafts.map((d) => d.period))).toEqual(new Set(["2025"]));
    expect(find(drafts, "2025", "tfx_clickkabu365_cfd_turnover_annual", "日経 225 リセット付証拠金取引／26").value).toBe(
      2_364_089
    );
    expect(
      find(drafts, "2025", "tfx_clickkabu365_cfd_open_interest_year_end", "日経 225 リセット付証拠金取引／26").value
    ).toBe(17_837);
    expect(find(drafts, "2025", "tfx_clickkabu365_cfd_open_interest_year_end", "金ETF リセット付証拠金取引／26").value).toBe(
      14_210
    );
    expect(sumOf(drafts, "tfx_clickkabu365_cfd_turnover_annual")).toBe(10_118_152);
    expect(sumOf(drafts, "tfx_clickkabu365_cfd_open_interest_year_end")).toBe(175_429);
  });

  it("resolve()/fetch(): 実ページのバイト列から月次・年次のキーを決め、同じバイト列を返す", async () => {
    const bytes = readBytes(CFD_FIXTURE);
    stubFetch({ [TFX_CLICKKABU365_CFD_URL]: bytes });
    const m = await tfxClick365CfdSpec.resolve(NOW_2026_09_27);
    expect(m.key).toBe("tfx-click365-cfd-2026-08");
    const mb = await m.fetch();
    expect(mb.files.map((f) => f.filename)).toEqual(["tfx-click365-cfd-2026-08.html"]);
    expect(sameBytes(mb.files[0]?.bytes, bytes)).toBe(true);
    expect(tfxClick365CfdSpec.toObservations({ key: mb.key, files: mb.files })).toHaveLength(154);
    const a = await tfxClick365CfdAnnualSpec.resolve(NOW_2026_09_27);
    expect(a.key).toBe("tfx-click365-cfd-annual-2025");
    const ab = await a.fetch();
    expect(tfxClick365CfdAnnualSpec.toObservations({ key: ab.key, files: ab.files })).toHaveLength(22);
  });

  it.skipIf(!existsSync(FX_FIXTURE))("FX のページを CFD の spec に渡すと市場ラベルの取り違えとして throw", () => {
    const key = "tfx-click365-cfd-2026-08";
    expect(() =>
      tfxClick365CfdSpec.toObservations({ key, files: [{ filename: tfxPageFilename(key), bytes: readBytes(FX_FIXTURE) }] })
    ).toThrow(/市場ラベル/);
  });
});
