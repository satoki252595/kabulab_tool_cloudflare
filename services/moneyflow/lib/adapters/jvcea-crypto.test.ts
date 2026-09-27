/**
 * jvcea-crypto アダプタ (JVCEA 会員の暗号資産取引状況表・月次) のテスト。
 *
 * 実ファイル (private/ — 利用条件要確認のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/jvcea-crypto/` に置く:
 *   - jvcea-crypto-202607-koukai-01-full-8p.pdf
 *       2026-09-27 に https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf
 *       から取得した原本そのもの (全8ページ、2018年9月〜2026年7月分、印字「更新日：2026年9月3日」)
 *   - jvcea-statistics-information-20260927.html
 *       同日に https://jvcea.or.jp/statistics/information/ から取得した一覧ページ
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は python (pymupdf) で原本 PDF の 1 ページ目のテキストを独立に読み、百万円→円に換算した値。
 *
 * CI でも走るテストは、合算表のテキスト様式 (列見出し行・「年 月 19個の数値」の行・更新日) だけを
 * 真似てテスト内で組み立てた **合成テストデータ** を使う (実データではない。数値も架空)。
 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { JVCEA_CRYPTO_INDICATORS, parseJvceaCryptoText } from "../sources/jvcea-crypto.js";
import {
  JVCEA_CRYPTO_SPECS,
  JVCEA_CRYPTO_SPEC_INDICATORS,
  JVCEA_CRYPTO_WINDOW_MONTHS,
  assertJvceaCryptoFresh,
  buildJvceaCryptoPagesFile,
  jvceaCryptoPagesFilename,
  jvceaCryptoPdfFilename,
  jvceaCryptoRowsToDrafts,
  jvceaCryptoSpec,
  parseJvceaCryptoBatchKey,
} from "./jvcea-crypto.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/jvcea-crypto/", import.meta.url));
const REAL_PDF = join(FIXTURE_DIR, "jvcea-crypto-202607-koukai-01-full-8p.pdf");
const REAL_INDEX = join(FIXTURE_DIR, "jvcea-statistics-information-20260927.html");
const HAS_REAL = existsSync(REAL_PDF) && existsSync(REAL_INDEX);

const INDEX_URL = "https://jvcea.or.jp/statistics/information/";
const PDF_URL = "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf";
const REAL_KEY = "jvcea-crypto-2026-07-updated-2026-09-03";
const ROW_BUDGET = 600;
const MILLION = 1_000_000;
/** 実ファイル取得日 (2026-09-27 12:00 JST)。 */
const FETCHED_AT = new Date("2026-09-27T03:00:00Z");

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

function find(drafts: readonly ObservationDraft[], period: string, indicatorKey: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey);
  if (hits.length !== 1) throw new Error(`テスト: ${period}|${indicatorKey} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

/** fetch をスタブし、URL → バイト列の対応だけ 200 で返す (他は 404)。 */
function stubFetch(routes: Record<string, Uint8Array>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown) => {
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
// 合成テストデータ (実データではない): 合算表ページのテキスト様式だけを真似る
// ---------------------------------------------------------------------------

const HEADER =
  "数量 金額 数量 金額 数量 金額 売建数 買建数 合計 売建額 買建額 合計 設定口座 稼働口座 設定口座 稼働口座";

/** 合成の 19 数値列。月の通し番号 n から決まる架空の値 (列ごとに区別できるよう列番号を混ぜる)。 */
function syntheticNumbers(n: number): number[] {
  return Array.from({ length: 19 }, (_, col) => (n + 1) * 1000 + col);
}

function ymList(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number) as [number, number];
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    out.push(ym);
    if (ym === to) return out;
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
}

/** 合成の合算表ページ (1 ページ、新しい月が上)。 */
function syntheticPage(latest: string, updated = "2019年12月5日", extraLine?: string): string {
  const months = ymList("2018-09", latest).reverse();
  const lines = [HEADER, `更新日：${updated}`];
  months.forEach((ym, i) => {
    const [y, m] = ym.split("-").map(Number) as [number, number];
    lines.push(`${y} ${m} ${syntheticNumbers(months.length - 1 - i).join(" ")}`);
  });
  if (extraLine) lines.push(extraLine);
  return lines.join("\n");
}

/** 合成バッチ (PDF 原本の代わりの合成バイト列 + そのハッシュを持つページテキスト JSON)。 */
function syntheticFiles(key: string, pages: string[]): SpecFile[] {
  const pdfBytes = new TextEncoder().encode("%PDF-合成テストデータ (実PDFではない)");
  const pdfName = jvceaCryptoPdfFilename(key);
  return [
    { filename: pdfName, bytes: pdfBytes },
    { filename: jvceaCryptoPagesFilename(key), bytes: buildJvceaCryptoPagesFile(pdfName, pdfBytes, pages) },
  ];
}

const SYN_KEY = "jvcea-crypto-2019-12-updated-2019-12-05";

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  it("全指標が列挙型の値を持ち、キーが一意で、https の出典と日本語の説明・限界がある", () => {
    const keys = JVCEA_CRYPTO_SPEC_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(JVCEA_CRYPTO_INDICATORS.map((d) => d.key));
    expect(keys.length).toBe(13);
    for (const d of JVCEA_CRYPTO_SPEC_INDICATORS) {
      expect(isMoneyflowFlowType(d.flowType)).toBe(true);
      expect(isMoneyflowFrequency(d.frequency)).toBe(true);
      expect(isMoneyflowLicense(d.license)).toBe(true);
      expect(isMoneyflowRequirement(d.requirement)).toBe(true);
      expect(d.requirement).toBe("R3");
      expect(d.frequency).toBe("月次");
      expect(d.license).toBe("要確認");
      expect(d.sourceUrl.startsWith("https://")).toBe(true);
      expect(d.description).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(d.limitations).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(d.description).toContain("純流入額");
      expect(d.limitations).toContain(`直近${JVCEA_CRYPTO_WINDOW_MONTHS}か月`);
    }
  });

  it("取引高は売買代金、預り資産・口座数は残高、建玉は建玉に分類し、金額は円・口座数は口座と説明する", () => {
    const byKey = new Map(JVCEA_CRYPTO_SPEC_INDICATORS.map((d) => [d.key, d]));
    expect(byKey.get("jvcea_crypto_spot_turnover_jpy")?.flowType).toBe("売買代金");
    expect(byKey.get("jvcea_crypto_deposits_total_jpy")?.flowType).toBe("残高");
    expect(byKey.get("jvcea_crypto_margin_position_total_jpy")?.flowType).toBe("建玉");
    expect(byKey.get("jvcea_crypto_accounts_total_active")?.flowType).toBe("残高");
    expect(byKey.get("jvcea_crypto_spot_turnover_jpy")?.description).toContain("単位は円 (原本の百万円を換算)");
    expect(byKey.get("jvcea_crypto_accounts_total_active")?.description).toContain("単位は口座");
  });

  it("どの指標も純流入額の目安・代理指標とは説明せず、分類ごとの意味 (注目度/残高/持ち高/口座の数) を書く", () => {
    const byKey = new Map(JVCEA_CRYPTO_SPEC_INDICATORS.map((d) => [d.key, d]));
    for (const d of JVCEA_CRYPTO_SPEC_INDICATORS) {
      // 口座数や売建玉まで「純流入額の目安 (代理指標)」と教える誤った説明を再発させない
      expect(d.description).not.toMatch(/純流入額[^。]*の?目安/);
      expect(d.description).not.toContain("代理指標");
      expect(d.description).toMatch(/純流入額 \(入ったお金 − 出たお金\) (を表すもの)?(ではない|でもない|とみなさない)/);
    }
    expect(byKey.get("jvcea_crypto_spot_turnover_jpy")?.description).toContain("取引の活発さ (注目度) の目安");
    expect(byKey.get("jvcea_crypto_deposits_crypto_jpy")?.description).toContain("値段が上下するだけでも増減");
    expect(byKey.get("jvcea_crypto_margin_position_sell_jpy")?.description).toContain("まだ決済されていない持ち高");
    expect(byKey.get("jvcea_crypto_accounts_margin_active")?.description).toContain("口座の数であってお金の額ではなく");
  });

  it("spec は 1 本で、名前は jvcea-crypto", () => {
    expect(JVCEA_CRYPTO_SPECS.map((s) => s.name)).toEqual(["jvcea-crypto"]);
    expect(jvceaCryptoSpec.indicators).toBe(JVCEA_CRYPTO_SPEC_INDICATORS);
  });
});

// ---------------------------------------------------------------------------
// 3. 合成テストデータでの変換 (CI で走る)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  it("直近12か月 × 13指標 = 156 行、円換算・期間・区分が規約どおりで検証を通る", () => {
    const drafts = jvceaCryptoSpec.toObservations({ key: SYN_KEY, files: syntheticFiles(SYN_KEY, [syntheticPage("2019-12")]) });
    validateDrafts(jvceaCryptoSpec.name, drafts, jvceaCryptoSpec.indicators);
    expect(drafts.length).toBe(12 * 13);
    expect(new Set(drafts.map((d) => d.period))).toEqual(new Set(ymList("2019-01", "2019-12")));
    // 2019-12 は 2018-09 起点の通し番号 15 → 合成値 (15+1)*1000 + 列番号
    const spot = find(drafts, "2019-12", "jvcea_crypto_spot_turnover_jpy"); // 列1 (金額)
    expect(spot.value).toBe(16_001 * MILLION);
    expect(spot.unit).toBe("円");
    expect(spot.periodStart).toBe("2019-12-01");
    expect(spot.periodEnd).toBe("2019-12-31");
    const dep = find(drafts, "2019-02", "jvcea_crypto_deposits_total_jpy"); // 列7、通し番号 5
    expect(dep.value).toBe(6_007 * MILLION);
    expect(dep.periodStart).toBe("2019-02-28");
    expect(dep.periodEnd).toBe("2019-02-28");
    const acc = find(drafts, "2019-01", "jvcea_crypto_accounts_margin_active"); // 列18、通し番号 4
    expect(acc.value).toBe(5_018);
    expect(acc.unit).toBe("口座");
    for (const d of drafts) {
      expect(d.category).toBe("暗号資産");
      expect(d.categoryKind).toBe("資産クラス");
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(last.period).toBe("2019-12");
    expect(last.indicatorKey).toBe("jvcea_crypto_accounts_margin_active");
  });

  it("同じ入力なら同じ結果 (決定的)", () => {
    const files = syntheticFiles(SYN_KEY, [syntheticPage("2019-12")]);
    expect(jvceaCryptoSpec.toObservations({ key: SYN_KEY, files })).toEqual(
      jvceaCryptoSpec.toObservations({ key: SYN_KEY, files })
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw
// ---------------------------------------------------------------------------

describe("想定外の入力は throw する (合成テストデータ)", () => {
  it("ページテキスト JSON が無い", () => {
    const files = syntheticFiles(SYN_KEY, [syntheticPage("2019-12")]).slice(0, 1);
    expect(() => jvceaCryptoSpec.toObservations({ key: SYN_KEY, files })).toThrow(/該当ファイルが 0 件/);
  });

  it("ページテキスト JSON が別の PDF の抽出結果 (sha256 不一致)", () => {
    const files = syntheticFiles(SYN_KEY, [syntheticPage("2019-12")]);
    const tampered = [{ ...files[0], bytes: new TextEncoder().encode("%PDF-別の合成バイト列") } as SpecFile, files[1] as SpecFile];
    expect(() => jvceaCryptoSpec.toObservations({ key: SYN_KEY, files: tampered })).toThrow(/sha256 不一致/);
  });

  it("キーの形式違い・キーと本文の最新月/更新日の食い違い", () => {
    expect(() => parseJvceaCryptoBatchKey("jvcea-crypto-2019-12")).toThrow(/形式が違います/);
    const key = "jvcea-crypto-2019-11-updated-2019-12-05";
    expect(() => jvceaCryptoSpec.toObservations({ key, files: syntheticFiles(key, [syntheticPage("2019-12")]) })).toThrow(
      /最新月 2019-12 がキーの収録最新月 2019-11/
    );
    const key2 = "jvcea-crypto-2019-12-updated-2019-12-06";
    expect(() => jvceaCryptoSpec.toObservations({ key: key2, files: syntheticFiles(key2, [syntheticPage("2019-12")]) })).toThrow(
      /更新日 2019-12-05 がキーの更新日 2019-12-06/
    );
  });

  it("列数が合わない行・合算表の見出しが無いページ", () => {
    const bad = syntheticPage("2019-12", "2019年12月5日", `2018 8 ${syntheticNumbers(0).slice(0, 18).join(" ")}`);
    expect(() => jvceaCryptoSpec.toObservations({ key: SYN_KEY, files: syntheticFiles(SYN_KEY, [bad]) })).toThrow(/列数/);
    const noHeader = syntheticPage("2019-12").replace(HEADER, "見出しが変わった表");
    expect(() => jvceaCryptoSpec.toObservations({ key: SYN_KEY, files: syntheticFiles(SYN_KEY, [noHeader]) })).toThrow(
      /列見出し行が見つかりません/
    );
  });

  it("記録対象の月が欠けている・未知の実行時刻に対する古すぎる/未来の最新月", () => {
    const rows = parseJvceaCryptoText([syntheticPage("2019-12")]).filter((r) => r.period !== "2019-06");
    expect(() => jvceaCryptoRowsToDrafts(rows, "2019-12")).toThrow(/2019-06 の行がありません/);
    expect(() => assertJvceaCryptoFresh("2026-05", FETCHED_AT)).toThrow(/古すぎます/);
    expect(() => assertJvceaCryptoFresh("2026-09", FETCHED_AT)).toThrow(/以降です/);
    expect(() => assertJvceaCryptoFresh("2026-06", FETCHED_AT)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2・4. 実ファイル (private)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_REAL)("実ファイル (2026-09-27 取得、202607 版・更新日 2026-09-03)", () => {
  async function resolveReal(): Promise<{ key: string; files: SpecFile[]; fetchMock: ReturnType<typeof vi.fn> }> {
    const fetchMock = stubFetch({ [INDEX_URL]: readBytes(REAL_INDEX), [PDF_URL]: readBytes(REAL_PDF) });
    const resolved = await jvceaCryptoSpec.resolve(FETCHED_AT);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    return { key: resolved.key, files: batch.files, fetchMock };
  }

  it("resolve/fetch: 一覧ページ + PDF の 2 回だけ取得し、キーと安定したファイル名を返す。PDF 原本は無改変", async () => {
    const { key, files, fetchMock } = await resolveReal();
    expect(key).toBe(REAL_KEY);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([INDEX_URL, PDF_URL]);
    expect(files.map((f) => f.filename)).toEqual([`${REAL_KEY}.pdf`, `${REAL_KEY}.pages.json`]);
    const pdf = files[0] as SpecFile;
    expect(Buffer.from(pdf.bytes).equals(Buffer.from(readBytes(REAL_PDF)))).toBe(true);
    expect(createHash("sha256").update(pdf.bytes).digest("hex")).toBe(
      "ec16877d5fcce8953c86a350d0a6601a3c12cd02e111804f963ca0a0cda04657"
    );
  });

  it("toObservations: 156 行で検証を通り、値は原本 (pymupdf で独立に抽出) を円換算したものと一致する", async () => {
    const { key, files } = await resolveReal();
    const drafts = jvceaCryptoSpec.toObservations({ key, files });
    validateDrafts(jvceaCryptoSpec.name, drafts, jvceaCryptoSpec.indicators);
    expect(drafts.length).toBe(156);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(new Set(drafts.map((d) => d.period))).toEqual(new Set(ymList("2025-08", "2026-07")));

    // 2026年7月 (pymupdf: 674,240 / 627,529 / 2,872,363 / 18,477 百万円、14,280,598 / 1,015,983 口座)
    expect(find(drafts, "2026-07", "jvcea_crypto_spot_turnover_jpy").value).toBe(674_240 * MILLION);
    expect(find(drafts, "2026-07", "jvcea_crypto_margin_turnover_jpy").value).toBe(627_529 * MILLION);
    expect(find(drafts, "2026-07", "jvcea_crypto_deposits_crypto_jpy").value).toBe(2_641_858 * MILLION);
    expect(find(drafts, "2026-07", "jvcea_crypto_deposits_total_jpy").value).toBe(2_872_363 * MILLION);
    expect(find(drafts, "2026-07", "jvcea_crypto_margin_position_total_jpy").value).toBe(18_477 * MILLION);
    expect(find(drafts, "2026-07", "jvcea_crypto_accounts_total_established").value).toBe(14_280_598);
    expect(find(drafts, "2026-07", "jvcea_crypto_accounts_margin_active").value).toBe(1_015_983);
    // 2025年8月 (窓の最古月。pymupdf: 2,007,049 / 4,755,410 百万円、7,874,470 口座)
    expect(find(drafts, "2025-08", "jvcea_crypto_spot_turnover_jpy").value).toBe(2_007_049 * MILLION);
    expect(find(drafts, "2025-08", "jvcea_crypto_deposits_crypto_jpy").value).toBe(4_755_410 * MILLION);
    expect(find(drafts, "2025-08", "jvcea_crypto_accounts_total_active").value).toBe(7_874_470);

    const spot = find(drafts, "2026-07", "jvcea_crypto_spot_turnover_jpy");
    expect([spot.periodStart, spot.periodEnd, spot.unit]).toEqual(["2026-07-01", "2026-07-31", "円"]);
    const acc = find(drafts, "2026-07", "jvcea_crypto_accounts_total_established");
    expect([acc.periodStart, acc.periodEnd, acc.unit]).toEqual(["2026-07-31", "2026-07-31", "口座"]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey]).toEqual(["2026-07", "jvcea_crypto_accounts_margin_active"]);
  });

  it("保管ファイルからの再解析 (取得元へは行かない) でも同じ行になる", async () => {
    const { key, files } = await resolveReal();
    const first = jvceaCryptoSpec.toObservations({ key, files });
    vi.unstubAllGlobals();
    const copies = files.map((f) => ({ filename: f.filename, bytes: new Uint8Array(f.bytes) }));
    expect(jvceaCryptoSpec.toObservations({ key, files: copies })).toEqual(first);
  });

  it("実行時刻に対して最新月が古すぎれば resolve が throw する (更新停止の検知)", async () => {
    stubFetch({ [INDEX_URL]: readBytes(REAL_INDEX), [PDF_URL]: readBytes(REAL_PDF) });
    await expect(jvceaCryptoSpec.resolve(new Date("2026-12-15T03:00:00Z"))).rejects.toThrow(/古すぎます/);
  });
});
