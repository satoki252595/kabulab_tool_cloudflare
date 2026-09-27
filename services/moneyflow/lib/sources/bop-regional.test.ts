/**
 * 国際収支統計 地域別 (bop-regional.ts) のユニットテスト。
 *
 * fixture は日本銀行「時系列統計データ検索サイト」から実際に取得した ZIP
 * (地域別国際収支（四半期）) を、直接投資・証券投資の行と直近9四半期
 * (2024Q1〜2026Q1) の列だけに絞って再構成した実データそのもの (架空値は
 * 使わない)。fixtures/regbp-q-jp-sample.zip 生成手順は本ファイル末尾の
 * コメントを参照。
 *
 * 期待値は 2026-09-27 に実ファイルを目視確認して採取した実測値。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOP_REGIONS,
  BOP_REGIONAL_INDICATORS,
  parseBopRegionalPeriodCode,
  expectedBopRegionalPublicationMonth,
  parseBopRegionalCsvText,
  extractBopRegionalObservations,
  decodeBopRegionalZip,
  extractBopRegionalZipHref,
  latestObservedPeriod,
  isPeriodObserved,
  bopRegionalArchiveInput,
  type BopRegionalObservation,
} from "./bop-regional.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fxBytes = (n: string) => new Uint8Array(readFileSync(join(FX, n)));
// boj-dload-excerpt.html は実際の HTTP レスポンスと同じ Shift_JIS バイト列の
// ままリポジトリに保存している (本番の resolveBopRegionalZipUrl と同じ
// デコード経路を通す)。utf8 として読むと文字化けするので明示的に変換する。
const fxShiftJisText = (n: string) => new TextDecoder("shift_jis").decode(fxBytes(n));

function loadFixtureObservations(): BopRegionalObservation[] {
  const zipBytes = fxBytes("regbp-q-jp-sample.zip");
  const csvText = decodeBopRegionalZip(zipBytes);
  const parsed = parseBopRegionalCsvText(csvText);
  return extractBopRegionalObservations(parsed);
}

function find(
  observations: BopRegionalObservation[],
  period: string,
  metricKey: string,
  region: string
): BopRegionalObservation | undefined {
  return observations.find(
    (o) => o.period === period && o.metricKey === metricKey && o.region === region
  );
}

describe("parseBopRegionalPeriodCode (期間コードの検証)", () => {
  it("YYYYQQ 形式を年・四半期へ変換する", () => {
    expect(parseBopRegionalPeriodCode("202601")).toEqual({ year: 2026, quarter: 1, label: "2026Q1" });
    expect(parseBopRegionalPeriodCode("201404")).toEqual({ year: 2014, quarter: 4, label: "2014Q4" });
  });

  it("形式が想定と違えば throw する (ルール2)", () => {
    expect(() => parseBopRegionalPeriodCode("2026-01")).toThrow();
    expect(() => parseBopRegionalPeriodCode("202605")).toThrow(); // 四半期は 01-04 のみ
    expect(() => parseBopRegionalPeriodCode("2026")).toThrow();
    expect(() => parseBopRegionalPeriodCode("")).toThrow();
  });
});

describe("expectedBopRegionalPublicationMonth (公式ルールに基づく参考公表月)", () => {
  it("対象四半期の最終月+5か月 (公式アナウンス通り)", () => {
    // 2026年1〜3月期 (Q1、最終月=3月) → 実際に 2026-08-10 に公表された事実と整合。
    expect(expectedBopRegionalPublicationMonth(2026, 1)).toEqual({ year: 2026, month: 8 });
  });

  it("年をまたぐ四半期 (Q4) の繰り上がりを計算する", () => {
    // 2025年10〜12月期 (Q4、最終月=12月) → 12+5=17か月後 = 翌年5月。
    expect(expectedBopRegionalPublicationMonth(2025, 4)).toEqual({ year: 2026, month: 5 });
  });
});

describe("extractBopRegionalZipHref (一括ダウンロードページからのリンク抽出、実HTML fixture)", () => {
  it("実際のページ抜粋から regbp_q_jp.zip を抽出する", () => {
    const html = fxShiftJisText("boj-dload-excerpt.html");
    expect(extractBopRegionalZipHref(html)).toBe("regbp_q_jp.zip");
  });

  it("目的のラベルが無い場合は throw する (ルール2)", () => {
    const html = '<a href="other.zip">別の統計</a>';
    expect(() => extractBopRegionalZipHref(html)).toThrow();
  });

  it("リンク先が .zip 以外なら throw する", () => {
    const html = '<a href="regbp_q_jp.pdf">地域別国際収支（四半期）</a>';
    expect(() => extractBopRegionalZipHref(html)).toThrow();
  });
});

describe("decodeBopRegionalZip + parseBopRegionalCsvText + extractBopRegionalObservations (実ZIP fixture)", () => {
  const observations = loadFixtureObservations();

  it("実ファイルの既知の値を再現する (2026Q1、直接投資ネット・中華人民共和国)", () => {
    const o = find(observations, "2026Q1", "bop_regional_direct_investment_net", "中華人民共和国");
    expect(o?.value).toBeCloseTo(-1631.38201514, 6);
    expect(o?.unit).toBe("億円");
    expect(o?.approximate).toBe(false);
    expect(o?.estimated).toBe(false);
    expect(o?.regionKind).toBe("country");
    expect(o?.sourceCode).toBe("BPBP6QFBCN1");
  });

  it("実ファイルの既知の値を再現する (2026Q1、証券投資ネット・アメリカ合衆国)", () => {
    const o = find(observations, "2026Q1", "bop_regional_portfolio_investment_net", "アメリカ合衆国");
    expect(o?.value).toBeCloseTo(-3214.85204568, 6);
  });

  it("実ファイルの既知の値を再現する (2026Q1、証券投資[株式]資産・アメリカ合衆国)", () => {
    const o = find(
      observations,
      "2026Q1",
      "bop_regional_portfolio_investment_equity_asset",
      "アメリカ合衆国"
    );
    expect(o?.value).toBeCloseTo(18925.53442, 6);
  });

  it("実ファイルの既知の値を再現する (2026Q1、証券投資[債券]資産・ドイツ)", () => {
    const o = find(observations, "2026Q1", "bop_regional_portfolio_investment_debt_asset", "ドイツ");
    expect(o?.value).toBeCloseTo(-2983.81395215, 6);
  });

  it("実ファイルの既知の値を再現する (2026Q1、直接投資ネット・アジア計、直接投資ネット・地域別合計)", () => {
    const asia = find(observations, "2026Q1", "bop_regional_direct_investment_net", "アジア計");
    expect(asia?.value).toBeCloseTo(7230.99152397, 6);
    expect(asia?.regionKind).toBe("continent_group");

    const total = find(observations, "2026Q1", "bop_regional_direct_investment_net", "地域別合計");
    expect(total?.value).toBeCloseTo(40673.64563458, 6);
    expect(total?.regionKind).toBe("world_total");
  });

  it("クロスカッティングな集計区分 (OECD諸国・ASEAN・EU・東欧・ロシア等) を country/continent_group と区別する", () => {
    for (const region of ["OECD諸国", "ASEAN", "EU", "東欧・ロシア等"]) {
      const o = observations.find((x) => x.region === region);
      expect(o, `region=${region} が観測ログに存在しない`).toBeDefined();
      expect(o?.regionKind).toBe("cross_cutting_group");
    }
  });

  it("国・地域ではない区分「国際機関」を other に分類する (実ファイル値、証券投資ネット)", () => {
    // 「非分類」は direct/portfolio investment の全期間が実データで "NA"
    // (統計的秘匿) のため fixture からは観測ログが出ない。regionKind の分類
    // 自体は次の describe (合成1行入力) で別途検証する。
    const o = observations.find((x) => x.region === "国際機関");
    expect(o?.regionKind).toBe("other");
  });

  it("fixture の非欠損セル数とちょうど一致する (190行 × 9期間 − 144件のNA秘匿セル)", () => {
    // 実ファイルは "" (系列なし) と "NA" (統計的秘匿・非開示) の2種の欠損表現を
    // 持つ。どちらも 0 で埋めず観測ログから除外する (ルール2)。
    expect(observations).toHaveLength(190 * 9 - 144);
  });

  it('"NA" (秘匿・非開示) のセルは観測ログから除外され、0 として現れない', () => {
    // ロシアの直接投資(負債側)は fixture の全9期間が "NA"。
    const russiaLiability = observations.filter(
      (o) => o.region === "ロシア" && o.metricKey === "bop_regional_direct_investment_liability"
    );
    expect(russiaLiability).toHaveLength(0);
  });

  it("最新観測期間は fixture の最終列 (2026Q1) に一致する", () => {
    expect(latestObservedPeriod(observations)).toBe("2026Q1");
    expect(isPeriodObserved(observations, 2026, 1)).toBe(true);
    expect(isPeriodObserved(observations, 2026, 2)).toBe(false); // まだ公表されていない
  });
});

describe("parseBopRegionalCsvText (様式チェック、ルール2: 想定外は throw)", () => {
  const HEADER = ',,,,202601';
  const VALID_ROW =
    'BPBP6QFBCN1,"地域別国際収支（四半期）（6版基準）","金融/直接投資/中華人民共和国/ネット","億円",-1631.38201514';

  it("正常系はパースできる", () => {
    const parsed = parseBopRegionalCsvText(`${HEADER}\n${VALID_ROW}`);
    expect(parsed.periods).toEqual([{ year: 2026, quarter: 1, label: "2026Q1" }]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.values).toEqual([-1631.38201514]);
  });

  it("区分名(カテゴリ)が想定外なら throw する", () => {
    const badRow = VALID_ROW.replace(
      "地域別国際収支（四半期）（6版基準）",
      "全く別の統計"
    );
    expect(() => parseBopRegionalCsvText(`${HEADER}\n${badRow}`)).toThrow();
  });

  it("単位が想定外 (億円以外) なら throw する", () => {
    const badRow = VALID_ROW.replace('"億円"', '"百万円"');
    expect(() => parseBopRegionalCsvText(`${HEADER}\n${badRow}`)).toThrow();
  });

  it("列数がヘッダと不一致なら throw する", () => {
    const badRow = `${VALID_ROW},999`; // 列が1つ多い
    expect(() => parseBopRegionalCsvText(`${HEADER}\n${badRow}`)).toThrow();
  });

  it("数値化できないセルは throw する (空文字は欠損として許容、それ以外の非数値は throw)", () => {
    const badRow = VALID_ROW.replace("-1631.38201514", "N/A");
    expect(() => parseBopRegionalCsvText(`${HEADER}\n${badRow}`)).toThrow();
  });

  it("欠損セル (空文字) は 0 で埋めず null として保持する", () => {
    const emptyRow = VALID_ROW.replace("-1631.38201514", "");
    const parsed = parseBopRegionalCsvText(`${HEADER}\n${emptyRow}`);
    expect(parsed.rows[0]!.values).toEqual([null]);
  });

  it('"NA" (実ファイルでの秘匿・非開示の表現) も 0 で埋めず null として保持する', () => {
    const naRow = VALID_ROW.replace("-1631.38201514", "NA");
    const parsed = parseBopRegionalCsvText(`${HEADER}\n${naRow}`);
    expect(parsed.rows[0]!.values).toEqual([null]);
  });

  it("データ行が 0 件なら throw する", () => {
    expect(() => parseBopRegionalCsvText(HEADER)).toThrow();
  });
});

describe("extractBopRegionalObservations (未知の地域名 = 様式変更は throw する)", () => {
  it("BOP_REGIONS に無い地域名が出たら throw する", () => {
    const parsed = parseBopRegionalCsvText(
      ',,,,202601\n' +
        'BPBP6QFBXX1,"地域別国際収支（四半期）（6版基準）","金融/直接投資/謎の新地域/ネット","億円",1.0'
    );
    expect(() => extractBopRegionalObservations(parsed)).toThrow();
  });

  it("対象外の項目 (経常収支等) は無視する (throw しない)", () => {
    const parsed = parseBopRegionalCsvText(
      ',,,,202601\n' +
        'BPBP6QCBAS,"地域別国際収支（四半期）（6版基準）","経常収支/アジア計","億円",1.0'
    );
    expect(extractBopRegionalObservations(parsed)).toEqual([]);
  });
});

describe("regionKind の分類 (合成1行入力。BOP_REGIONS の定義を経路まで検証する)", () => {
  // 非分類・国際機関の direct/portfolio investment は実ファイルで恒常的に
  // "NA" (統計的秘匿) のため、大規模 fixture からは分類結果を観測できない。
  // 実在する地域名 + 実データではない値1つ、という最小合成入力で
  // classifyLabel → BOP_REGIONS 引きの経路そのものを検証する。
  const KIND_BY_REGION: Record<string, string> = {
    地域別合計: "world_total",
    アジア計: "continent_group",
    中華人民共和国: "country",
    国際機関: "other",
    非分類: "other",
    OECD諸国: "cross_cutting_group",
    ASEAN: "cross_cutting_group",
    EU: "cross_cutting_group",
    "東欧・ロシア等": "cross_cutting_group",
  };

  for (const [region, kind] of Object.entries(KIND_BY_REGION)) {
    it(`"${region}" → ${kind}`, () => {
      const parsed = parseBopRegionalCsvText(
        `,,,,202601\nBPBP6QFBXX,"地域別国際収支（四半期）（6版基準）","金融/直接投資/${region}/ネット","億円",1.0`
      );
      const [o] = extractBopRegionalObservations(parsed);
      expect(o?.regionKind).toBe(kind);
    });
  }
});

describe("BOP_REGIONS / BOP_REGIONAL_INDICATORS (定義の健全性)", () => {
  it("地域名の重複が無い", () => {
    const names = BOP_REGIONS.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("指標は10種類、キーの重複が無い", () => {
    expect(BOP_REGIONAL_INDICATORS).toHaveLength(10);
    const keys = BOP_REGIONAL_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("各指標に要件・出典・利用条件・頻度・限界・平易な説明が揃っている (ルール7)", () => {
    for (const def of BOP_REGIONAL_INDICATORS) {
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.sourceUrl).toMatch(/^https:\/\//);
      expect(def.license.length).toBeGreaterThan(0);
      expect(def.frequency.length).toBeGreaterThan(0);
      expect(def.limitations.length).toBeGreaterThan(0);
      expect(def.plainExplanation.length).toBeGreaterThan(0);
      expect(def.measures.length).toBeGreaterThan(0);
      expect(def.unit).toBe("億円");
    }
  });

  /**
   * https://www.stat-search.boj.or.jp/info/notice.html (2026-09-27 取得) の
   * 実文言に合わせた回帰テスト (ルール1: 由来不明確な第三者要件を事実として
   * 書かない)。転載・複製の事前相談窓口は「日本銀行情報サービス局」であり
   * 「調査統計局」ではない (調査統計局は同ページ末尾のサイト利用一般問合せ
   * 窓口)。事前相談が要るのは商用目的・無断転載禁止注記・画像データの3件
   * のみで、それ以外は出所明記だけで足りる。「指定クレジット文言」の掲示
   * 要件は notice.html のどこにも存在しない。
   */
  it("利用条件の記述が日本銀行サイトの実文言と一致する (転載相談窓口・要件)", () => {
    for (const def of BOP_REGIONAL_INDICATORS) {
      expect(def.license).toContain("情報サービス局");
      expect(def.license).not.toContain("調査統計局");
      expect(def.license).not.toMatch(/指定クレジット文言.*(求め|必要)/);
    }
  });
});

describe("bopRegionalArchiveInput (ルール6: 一次データ記録の入力を組む純関数)", () => {
  it("最新観測期間で冪等キーを組み、ZIP実体をそのまま渡す", () => {
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const observations: BopRegionalObservation[] = [
      {
        period: "2026Q1",
        year: 2026,
        quarter: 1,
        metricKey: "bop_regional_direct_investment_net",
        region: "中華人民共和国",
        regionKind: "country",
        value: -1631.38201514,
        unit: "億円",
        approximate: false,
        estimated: false,
        sourceCode: "BPBP6QFBCN1",
      },
    ];
    const input = bopRegionalArchiveInput(
      { zipBytes, sourceUrl: "https://www.stat-search.boj.or.jp/info/regbp_q_jp.zip" },
      observations
    );
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("boj-bop-regional-2026Q1");
    expect(input.metadata).toMatchObject({ latestPeriod: "2026Q1", observationCount: 1 });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("regbp_q_jp-2026Q1.zip");
    expect(input.files[0]!.bytes).toBe(zipBytes);
  });

  it("観測レコードが 0 件なら throw する (キーを決定できない)", () => {
    expect(() =>
      bopRegionalArchiveInput(
        { zipBytes: new Uint8Array(), sourceUrl: "https://example.invalid/x.zip" },
        []
      )
    ).toThrow();
  });
});

/**
 * fixtures/regbp-q-jp-sample.zip の生成手順 (再現用メモ):
 * 1. https://www.stat-search.boj.or.jp/info/regbp_q_jp.zip を取得・展開。
 * 2. 展開した regbp_q_jp.csv (shift_jis) から、ラベルが
 *    "金融/直接投資/<地域>/..." または "金融/証券投資/<地域>/..." に一致し、
 *    かつ地域が代表的な19区分 (地域別合計・アジア計・中華人民共和国・香港・
 *    台湾・大韓民国・北米計・アメリカ合衆国・カナダ・欧州計・ドイツ・英国・
 *    ロシア・国際機関・非分類・OECD諸国・ASEAN・EU・東欧・ロシア等) に
 *    含まれる行だけをバイト単位 (Shift_JIS の安全な comma/newline 境界) で
 *    抽出。
 * 3. 期間列は直近9四半期 (202401〜202601) だけを残す。
 * 4. 得られた CSV (実データのみ、値の書き換えなし) を stored (無圧縮) 方式
 *    で ZIP コンテナに手詰めし、regbp-q-jp-sample.zip として保存。
 * fixtures/boj-dload-excerpt.html は
 * https://www.stat-search.boj.or.jp/info/dload.html の実バイト列から、
 * 対象リンクの前後 1400 バイトだけを切り出したもの。
 */
