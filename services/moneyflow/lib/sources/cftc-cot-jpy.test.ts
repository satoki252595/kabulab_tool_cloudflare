/**
 * CFTC COT (円先物・日経平均先物円建て) パーサ/期間判定の単体テスト。
 *
 * fixtures/public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json は 2026-09-27 に
 * Socrata API (https://publicreporting.cftc.gov/resource/6dca-aqww.json)
 * から実際に取得した生レスポンス (直近8週 × 2契約 = 16行、加工なし)。
 * 検証に使う数値は、同日に一次レポートページ
 * https://www.cftc.gov/dea/futures/deacmesf.htm ("FUTURES ONLY POSITIONS
 * AS OF 09/22/26" の JAPANESE YEN 節・NIKKEI STOCK AVERAGE YEN DENOM 節)
 * を目視して独立に確認した値と一致することを確認済み:
 *   - JAPANESE YEN 2026-09-22: OPEN INTEREST 378,701 / NON-COMMERCIAL
 *     LONG 192,274 / SHORT 120,292 (COMMITMENTS 行)
 *   - NIKKEI STOCK AVERAGE YEN DENOM 2026-09-22: OPEN INTEREST 21,974 /
 *     NON-COMMERCIAL LONG 4,199 / SHORT 2,654 (COMMITMENTS 行)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CFTC_TRACKED_CONTRACTS,
  CFTC_COT_JPY_INDICATORS,
  buildCftcCotJpyRequestUrl,
  determineCftcCotAvailability,
  determineExpectedCftcCotPeriod,
  parseCftcCotJpyRows,
  resolveCftcCotJpy,
  toCftcCotObservationRecords,
  cftcCotJpyArchiveInput,
  type CftcCotJpyRow,
} from "./cftc-cot-jpy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "public", "cftc-cot-jpy", "cftc-cot-jpy-legacy-futures-only.json");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf-8");
const FIXTURE_RAW: unknown = JSON.parse(FIXTURE_TEXT);

describe("buildCftcCotJpyRequestUrl", () => {
  it("追跡対象2契約のみに絞ったSoQLクエリを組み立てる", () => {
    const url = buildCftcCotJpyRequestUrl(16);
    expect(url.startsWith("https://publicreporting.cftc.gov/resource/6dca-aqww.json?")).toBe(true);
    expect(url).toContain("097741");
    expect(url).toContain("240743");
    expect(url).toContain("%24limit=16");
  });
});

describe("parseCftcCotJpyRows (実フィクスチャ)", () => {
  const rows = parseCftcCotJpyRows(FIXTURE_RAW);

  it("16行 (2契約 × 8週) をすべて読み取る", () => {
    expect(rows).toHaveLength(16);
  });

  it("2026-09-22 の JAPANESE YEN が一次レポート(deacmesf.htm)の実測値と一致する", () => {
    const row = rows.find((r) => r.contractCode === "097741" && r.asOfDate === "2026-09-22");
    expect(row).toBeDefined();
    expect(row?.openInterestAll).toBe(378_701);
    expect(row?.noncommLong).toBe(192_274);
    expect(row?.noncommShort).toBe(120_292);
    expect(row?.commLong).toBe(143_954);
    expect(row?.commShort).toBe(220_368);
  });

  it("2026-09-22 の NIKKEI STOCK AVERAGE YEN DENOM が一次レポートの実測値と一致する", () => {
    const row = rows.find((r) => r.contractCode === "240743" && r.asOfDate === "2026-09-22");
    expect(row).toBeDefined();
    expect(row?.openInterestAll).toBe(21_974);
    expect(row?.noncommLong).toBe(4_199);
    expect(row?.noncommShort).toBe(2_654);
    expect(row?.commLong).toBe(11_364);
    expect(row?.commShort).toBe(6_758);
  });

  it("基準日は YYYY-MM-DD に正規化される (元は ISO日時文字列)", () => {
    const row = rows.find((r) => r.contractCode === "097741" && r.asOfDate === "2026-09-22");
    expect(row?.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("追跡対象2契約それぞれについて8週分ずつ取得できている", () => {
    for (const contract of CFTC_TRACKED_CONTRACTS) {
      const contractRows = rows.filter((r) => r.contractCode === contract.code);
      expect(contractRows).toHaveLength(8);
    }
  });
});

describe("parseCftcCotJpyRows (様式異常)", () => {
  const goodRow = (FIXTURE_RAW as Array<Record<string, unknown>>).find(
    (r) => r.cftc_contract_market_code === "097741"
  )!;

  it("レスポンスが配列でなければ throw する", () => {
    expect(() => parseCftcCotJpyRows({ not: "an array" })).toThrow(/配列ではありません/);
  });

  it("必須フィールドが欠けていれば throw する", () => {
    const broken = { ...goodRow };
    delete broken.open_interest_all;
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/open_interest_all/);
  });

  it("数値フィールドが整数文字列でなければ throw する", () => {
    const broken = { ...goodRow, noncomm_positions_long_all: "N/A" };
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/整数文字列ではありません/);
  });

  it("追跡対象外の契約コードが紛れ込んだら throw する", () => {
    const broken = { ...goodRow, cftc_contract_market_code: "999999" };
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/追跡対象外の契約コード/);
  });

  it("契約名が想定と異なれば throw する (CFTC側の銘柄名変更を検知)", () => {
    const broken = { ...goodRow, contract_market_name: "JAPANESE YEN RENAMED" };
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/contract_market_name が想定と異なります/);
  });

  it("契約単位 (contract_units) が想定と異なれば throw する", () => {
    const broken = { ...goodRow, contract_units: "(CONTRACTS OF JPY 6,250,000)" };
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/contract_units が想定と異なります/);
  });

  it("契約単位は完全一致で検査し、乗数だけの変更 (日経 ×500円 → ×100円 等) も throw する", () => {
    const nikkeiRow = (FIXTURE_RAW as Array<Record<string, unknown>>).find(
      (r) => r.cftc_contract_market_code === "240743"
    )!;
    // 実データ (2026-09-27 取得) の値そのものは受理する
    expect(nikkeiRow.contract_units).toBe("(NIKKEI INDEX X JPY 500)");
    expect(goodRow.contract_units).toBe("(CONTRACTS OF JPY 12,500,000)");
    for (const units of ["(NIKKEI INDEX X JPY 100)", "(NIKKEI INDEX X JPY 5,000)"]) {
      expect(() => parseCftcCotJpyRows([{ ...nikkeiRow, contract_units: units }])).toThrow(
        /contract_units が想定と異なります/
      );
    }
    expect(() =>
      parseCftcCotJpyRows([{ ...goodRow, contract_units: "(CONTRACTS OF JPY 12,500,000,000)" }])
    ).toThrow(/contract_units が想定と異なります/);
  });

  it("report_date の形式が想定と異なれば throw する", () => {
    const broken = { ...goodRow, report_date_as_yyyy_mm_dd: "2026/09/22" };
    expect(() => parseCftcCotJpyRows([broken])).toThrow(/形式が想定外です/);
  });
});

describe("determineExpectedCftcCotPeriod", () => {
  it("金曜15:30(ET)より前は、前週の火曜が期待基準日になる", () => {
    // 2026-09-25 15:00 ET (= 2026-09-25T19:00:00Z, 9月はEDTでUTC-4)
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-25T19:00:00Z"));
    expect(result.asOfDate).toBe("2026-09-15");
    expect(result.releaseDate).toBe("2026-09-18");
  });

  it("金曜15:30(ET)ちょうどで当週の火曜が期待基準日になる", () => {
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-25T19:30:00Z"));
    expect(result.asOfDate).toBe("2026-09-22");
    expect(result.releaseDate).toBe("2026-09-25");
  });

  it("金曜15:30(ET)より後は当週の火曜が期待基準日になる", () => {
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-25T20:00:00Z"));
    expect(result.asOfDate).toBe("2026-09-22");
  });

  it("日曜(ET)は直前の金曜が既に公表済みなので当該火曜が期待基準日になる", () => {
    // 2026-09-27 08:00 ET (= 2026-09-27T12:00:00Z)
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-27T12:00:00Z"));
    expect(result.asOfDate).toBe("2026-09-22");
  });

  it("金曜0:30(ET)は、深夜0時台を24時台と誤読せず公表前として扱う", () => {
    // 2026-09-25 00:30 ET (= 2026-09-25T04:30:00Z)。hour が "24" と解釈されると
    // 15:30 を過ぎた扱いになり、当週火曜を期待基準日にしてしまう。
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-25T04:30:00Z"));
    expect(result.asOfDate).toBe("2026-09-15");
    expect(result.releaseDate).toBe("2026-09-18");
  });

  it("火曜0:00(ET)は、まだ今週金曜の公表前なので前週の火曜が期待基準日になる", () => {
    // 2026-09-22 00:00 ET (= 2026-09-22T04:00:00Z)
    const result = determineExpectedCftcCotPeriod(new Date("2026-09-22T04:00:00Z"));
    expect(result.asOfDate).toBe("2026-09-15");
  });
});

describe("determineCftcCotAvailability", () => {
  it("実測の最新基準日が期待日と一致すれば published", () => {
    const result = determineCftcCotAvailability(new Date("2026-09-27T12:00:00Z"), {
      jpy: "2026-09-22",
      nikkei225_yen: "2026-09-22",
    });
    expect(result).toEqual({ status: "published", asOfDate: "2026-09-22" });
  });

  it("実測の最新基準日が期待日より古ければ not_yet_published", () => {
    const result = determineCftcCotAvailability(new Date("2026-09-27T12:00:00Z"), {
      jpy: "2026-09-15",
      nikkei225_yen: "2026-09-15",
    });
    expect(result.status).toBe("not_yet_published");
    if (result.status === "not_yet_published") {
      expect(result.expectedAsOfDate).toBe("2026-09-22");
    }
  });

  it("実測の最新基準日が期待日より新しければ published (祝日等での前倒し公表も許容)", () => {
    const result = determineCftcCotAvailability(new Date("2026-09-25T19:00:00Z"), {
      jpy: "2026-09-22",
    });
    expect(result).toEqual({ status: "published", asOfDate: "2026-09-22" });
  });

  it("データが0件なら未公表に丸めず throw する (応答が空なのは契約コード変更等の異常)", () => {
    expect(() => determineCftcCotAvailability(new Date("2026-09-27T12:00:00Z"), {})).toThrow(
      /1件も取得できませんでした/
    );
  });
});

describe("resolveCftcCotJpy (fetch を差し替えて実フィクスチャで通しで検証)", () => {
  const fetchReturning =
    (body: string, init: ResponseInit = { status: 200 }): typeof fetch =>
    async () =>
      new Response(body, init);

  it("2026-09-27(日) 12:40 JST 時点では 2026-09-22 基準日の2契約×5指標=10レコードを返す", async () => {
    const result = await resolveCftcCotJpy({
      now: new Date("2026-09-27T03:40:00Z"),
      fetchImpl: fetchReturning(FIXTURE_TEXT),
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.asOfDate).toBe("2026-09-22");
    expect(result.missingContracts).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.records).toHaveLength(10);
    expect(result.rawResponseText).toBe(FIXTURE_TEXT);
    expect(result.records.find((r) => r.indicatorKey === "cftc_cot_nikkei225_yen_comm_net")?.value).toBe(
      11_364 - 6_758
    );
  });

  it("次の公表 (2026-10-02 ET 15:30) 後に同じ応答しか返らなければ not_yet_published", async () => {
    const result = await resolveCftcCotJpy({
      now: new Date("2026-10-02T20:00:00Z"),
      fetchImpl: fetchReturning(FIXTURE_TEXT),
    });
    expect(result.status).toBe("not_yet_published");
    if (result.status === "not_yet_published") {
      expect(result.expectedAsOfDate).toBe("2026-09-29");
      expect(result.expectedReleaseDate).toBe("2026-10-02");
    }
  });

  it("API が空配列を返したら not_yet_published に丸めず throw する", async () => {
    await expect(
      resolveCftcCotJpy({ now: new Date("2026-09-27T03:40:00Z"), fetchImpl: fetchReturning("[]") })
    ).rejects.toThrow(/1件も取得できませんでした/);
  });

  it("HTTP エラーは throw する", async () => {
    await expect(
      resolveCftcCotJpy({
        now: new Date("2026-09-27T03:40:00Z"),
        fetchImpl: fetchReturning("forbidden", { status: 403, statusText: "Forbidden" }),
      })
    ).rejects.toThrow(/HTTP エラー: 403/);
  });
});

describe("CFTC_COT_JPY_INDICATORS", () => {
  it("2契約 × 5指標 = 10件を export する", () => {
    expect(CFTC_COT_JPY_INDICATORS).toHaveLength(10);
  });

  it("指標キーは重複しない", () => {
    const keys = CFTC_COT_JPY_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("各指標が必須メタデータをすべて持つ (空文字を許さない)", () => {
    for (const def of CFTC_COT_JPY_INDICATORS) {
      expect(def.plainDescription.length).toBeGreaterThan(10);
      expect(def.definition.length).toBeGreaterThan(10);
      expect(def.sourceUrl).toMatch(/^https:\/\//);
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.measures).toBe("positions");
    }
  });

  it("各契約のバルーンヘルプ(plainDescription)は自契約の表示名のみを含み、他契約の表示名を含まない", () => {
    // METRIC_SPECS は2契約で共有するテンプレートなので、契約ごとの具体例
    // (実測値・方向解釈) を取り違えて使い回すと、他契約の displayName が
    // 紛れ込むことはないが、文中の数値例が他契約の値になっている場合は
    // displayName チェックだけでは検出できない。そのため数値例も別途検証する。
    for (const def of CFTC_COT_JPY_INDICATORS) {
      const ownContract = CFTC_TRACKED_CONTRACTS.find((c) => def.key.startsWith(`cftc_cot_${c.key}_`));
      expect(ownContract).toBeDefined();
      const otherContracts = CFTC_TRACKED_CONTRACTS.filter((c) => c.key !== ownContract!.key);
      expect(def.plainDescription).toContain(ownContract!.displayName);
      for (const other of otherContracts) {
        expect(def.plainDescription).not.toContain(other.displayName);
      }
    }
  });

  it("noncomm_net/noncomm_long/noncomm_short/open_interest の数値例は、その契約自身の実測値(fixture)と一致し、もう一方の契約の数値は含まない", () => {
    const rows = parseCftcCotJpyRows(FIXTURE_RAW);
    const byContract: Record<string, CftcCotJpyRow> = {};
    for (const contract of CFTC_TRACKED_CONTRACTS) {
      const row = rows.find((r) => r.contractCode === contract.code && r.asOfDate === "2026-09-22");
      expect(row).toBeDefined();
      byContract[contract.key] = row!;
    }

    for (const contract of CFTC_TRACKED_CONTRACTS) {
      const ownRow = byContract[contract.key]!;
      const otherContract = CFTC_TRACKED_CONTRACTS.find((c) => c.key !== contract.key)!;
      const otherRow = byContract[otherContract.key]!;

      const netDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === `cftc_cot_${contract.key}_noncomm_net`)!;
      const longDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === `cftc_cot_${contract.key}_noncomm_long`)!;
      const shortDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === `cftc_cot_${contract.key}_noncomm_short`)!;
      const oiDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === `cftc_cot_${contract.key}_open_interest`)!;

      const ownNet = ownRow.noncommLong - ownRow.noncommShort;
      expect(netDef.plainDescription).toContain(ownRow.noncommLong.toLocaleString("ja-JP"));
      expect(netDef.plainDescription).toContain(ownRow.noncommShort.toLocaleString("ja-JP"));
      expect(netDef.plainDescription).toContain(ownNet.toLocaleString("ja-JP"));

      expect(longDef.plainDescription).toContain(ownRow.noncommLong.toLocaleString("ja-JP"));
      expect(shortDef.plainDescription).toContain(ownRow.noncommShort.toLocaleString("ja-JP"));
      expect(oiDef.plainDescription).toContain(ownRow.openInterestAll.toLocaleString("ja-JP"));

      // もう一方の契約の建玉数(桁が被らない値)が紛れ込んでいないことも確認する。
      if (otherRow.noncommLong !== ownRow.noncommLong) {
        expect(longDef.plainDescription).not.toContain(otherRow.noncommLong.toLocaleString("ja-JP"));
      }
      if (otherRow.openInterestAll !== ownRow.openInterestAll) {
        expect(oiDef.plainDescription).not.toContain(otherRow.openInterestAll.toLocaleString("ja-JP"));
      }
    }
  });

  it("日経平均先物(円建て)のネットポジション説明は、通貨方向('円高'/'円安')ではなく株価指数の方向で解釈する", () => {
    const def = CFTC_COT_JPY_INDICATORS.find((d) => d.key === "cftc_cot_nikkei225_yen_noncomm_net")!;
    expect(def.plainDescription).not.toContain("円高");
    expect(def.plainDescription).not.toContain("円安");
    expect(def.plainDescription).toContain("日経平均");
  });

  it("円先物のネットポジション説明は、通貨の方向(円高/円安)で解釈する", () => {
    const def = CFTC_COT_JPY_INDICATORS.find((d) => d.key === "cftc_cot_jpy_noncomm_net")!;
    expect(def.plainDescription).toMatch(/円高|円安/);
  });

  it("正確な実測値に「約」を付けない (丸めていない値を概数のように見せない)", () => {
    for (const def of CFTC_COT_JPY_INDICATORS) {
      expect(def.plainDescription).not.toMatch(/約[\d,]+枚/);
    }
  });

  it("商業筋ネットの数値例は、その契約自身の実測値(fixture)と一致する", () => {
    const rows = parseCftcCotJpyRows(FIXTURE_RAW);
    for (const contract of CFTC_TRACKED_CONTRACTS) {
      const row = rows.find((r) => r.contractCode === contract.code && r.asOfDate === "2026-09-22")!;
      const def = CFTC_COT_JPY_INDICATORS.find((d) => d.key === `cftc_cot_${contract.key}_comm_net`)!;
      const commNet = row.commLong - row.commShort;
      const noncommNet = row.noncommLong - row.noncommShort;
      expect(def.plainDescription).toContain(`買い建玉${row.commLong.toLocaleString("ja-JP")}枚`);
      expect(def.plainDescription).toContain(`売り建玉${row.commShort.toLocaleString("ja-JP")}枚`);
      expect(def.plainDescription).toContain(`ネット${commNet >= 0 ? "+" : ""}${commNet.toLocaleString("ja-JP")}枚`);
      expect(def.plainDescription).toContain(
        `非商業筋(ネット${noncommNet >= 0 ? "+" : ""}${noncommNet.toLocaleString("ja-JP")}枚)`
      );
    }
  });

  it("商業筋ネットと非商業筋ネットの向きの説明は、契約ごとに fixture 8週の実測と一致する (契約共通の一般論にしない)", () => {
    const rows = parseCftcCotJpyRows(FIXTURE_RAW);
    const dates = [...new Set(rows.map((r) => r.asOfDate))].sort();
    expect(dates).toHaveLength(8);
    const window = `${dates[0]}〜${dates[dates.length - 1]}の8週すべて`;

    const signsOf = (code: string) =>
      rows
        .filter((r) => r.contractCode === code)
        .map((r) => ({
          noncomm: Math.sign(r.noncommLong - r.noncommShort),
          comm: Math.sign(r.commLong - r.commShort),
          nonrept: Math.sign(r.nonreptLong - r.nonreptShort),
        }));

    // 円先物: 8週すべてで商業筋と非商業筋のネットが逆向き
    const jpy = signsOf("097741");
    expect(jpy).toHaveLength(8);
    expect(jpy.every((s) => s.comm !== 0 && s.comm === -s.noncomm)).toBe(true);
    const jpyDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === "cftc_cot_jpy_comm_net")!;
    expect(jpyDef.plainDescription).toContain(window);
    expect(jpyDef.plainDescription).toContain("とは逆向き");

    // 日経平均先物(円建て): 8週すべてで商業筋・非商業筋ともに買い越し、売り越しは未報告だけ
    const nikkei = signsOf("240743");
    expect(nikkei).toHaveLength(8);
    expect(nikkei.every((s) => s.noncomm > 0 && s.comm > 0 && s.nonrept < 0)).toBe(true);
    const nikkeiDef = CFTC_COT_JPY_INDICATORS.find((d) => d.key === "cftc_cot_nikkei225_yen_comm_net")!;
    expect(nikkeiDef.plainDescription).toContain(window);
    expect(nikkeiDef.plainDescription).toContain("と同じ向き");
    expect(nikkeiDef.plainDescription).toContain("未報告");
    // 旧実装の契約共通テンプレート (日経側の実測と矛盾する一般論) が残っていないこと
    expect(nikkeiDef.plainDescription).not.toContain("符号が逆になりやすい");
    expect(nikkeiDef.plainDescription).not.toContain("とは逆向き");
  });

  it("3区分(非商業筋・商業筋・未報告)のネットの合計は全行でゼロ (商業筋ネットの定義文の前提を実データで確認)", () => {
    for (const r of parseCftcCotJpyRows(FIXTURE_RAW)) {
      const sum = r.noncommLong - r.noncommShort + (r.commLong - r.commShort) + (r.nonreptLong - r.nonreptShort);
      expect(sum).toBe(0);
    }
  });

  it("建玉残高合計は買い側(=売り側)の片側合計であり、買いと売りを足した数ではない (定義文の前提を実データで確認)", () => {
    const toInt = (v: unknown) => Number.parseInt(String(v), 10);
    for (const r of FIXTURE_RAW as Array<Record<string, unknown>>) {
      const spread = toInt(r.noncomm_postions_spread_all); // CFTC 側のフィールド名の綴り (postions) のまま
      const longSide =
        toInt(r.noncomm_positions_long_all) + spread + toInt(r.comm_positions_long_all) + toInt(r.nonrept_positions_long_all);
      const shortSide =
        toInt(r.noncomm_positions_short_all) + spread + toInt(r.comm_positions_short_all) + toInt(r.nonrept_positions_short_all);
      expect(toInt(r.open_interest_all)).toBe(longSide);
      expect(toInt(r.open_interest_all)).toBe(shortSide);
    }
    for (const def of CFTC_COT_JPY_INDICATORS.filter((d) => d.key.endsWith("_open_interest"))) {
      expect(def.plainDescription).toContain("買いと売りを足した数ではない");
    }
  });
});

describe("toCftcCotObservationRecords", () => {
  const rows = parseCftcCotJpyRows(FIXTURE_RAW);
  const jpyRow = rows.find((r) => r.contractCode === "097741" && r.asOfDate === "2026-09-22") as CftcCotJpyRow;

  it("1行につき5レコード(指標)を展開する", () => {
    const records = toCftcCotObservationRecords([jpyRow]);
    expect(records).toHaveLength(5);
  });

  it("ネットポジションは 買い-売り で計算される", () => {
    const records = toCftcCotObservationRecords([jpyRow]);
    const net = records.find((r) => r.indicatorKey === "cftc_cot_jpy_noncomm_net");
    expect(net?.value).toBe(192_274 - 120_292);
  });

  it("生成される indicatorKey はすべて CFTC_COT_JPY_INDICATORS に定義済み", () => {
    const definedKeys = new Set(CFTC_COT_JPY_INDICATORS.map((d) => d.key));
    const records = toCftcCotObservationRecords(rows);
    for (const record of records) {
      expect(definedKeys.has(record.indicatorKey)).toBe(true);
    }
  });

  it("近似フラグは true・推定フラグは false (実測の建玉数のため)", () => {
    const records = toCftcCotObservationRecords([jpyRow]);
    for (const r of records) {
      expect(r.isApproximate).toBe(true);
      expect(r.isEstimated).toBe(false);
    }
  });
});

describe("cftcCotJpyArchiveInput (ルール6の入力生成)", () => {
  it("週次の冪等キーと生レスポンスの実体を持つ", () => {
    const rows = parseCftcCotJpyRows(FIXTURE_RAW).filter((r) => r.asOfDate === "2026-09-22");
    const input = cftcCotJpyArchiveInput({
      asOfDate: "2026-09-22",
      rows,
      rawResponseText: FIXTURE_TEXT,
      requestUrl: buildCftcCotJpyRequestUrl(),
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("cftc-cot-jpy-2026-09-22");
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("cftc-cot-jpy-2026-09-22.json");
    expect(input.files[0]!.contentType).toBe("application/json");
    expect(new TextDecoder().decode(input.files[0]!.bytes)).toBe(FIXTURE_TEXT);
  });

  it("メタデータは観測に使う行数と保存ファイルの行数を取り違えない (ファイルは16行、基準日の行は2行)", () => {
    const rows = parseCftcCotJpyRows(FIXTURE_RAW).filter((r) => r.asOfDate === "2026-09-22");
    const input = cftcCotJpyArchiveInput({
      asOfDate: "2026-09-22",
      rows,
      rawResponseText: FIXTURE_TEXT,
      requestUrl: buildCftcCotJpyRequestUrl(),
    });
    expect(input.metadata.rowCountAtAsOfDate).toBe(2);
    expect(input.metadata.rowCountInFile).toBe(16);
    expect(input.metadata).not.toHaveProperty("rowCount");
    expect(input.metadata.bytes).toBe(input.files[0]!.bytes.byteLength);
  });
});
