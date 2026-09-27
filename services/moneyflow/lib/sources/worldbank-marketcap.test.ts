/**
 * World Bank 上場企業時価総額 (CM.MKT.LCAP.CD) パーサの固定テスト。
 *
 * fixtures/public/worldbank-marketcap/worldbank-marketcap-2020-2026.json と
 * fixtures/public/worldbank-marketcap/worldbank-country-meta.json は 2026-09-27 に
 * https://api.worldbank.org/v2/country/all/indicator/CM.MKT.LCAP.CD
 * および https://api.worldbank.org/v2/country/all から実際に取得した
 * 生レスポンスそのもの (合成データではない)。
 *
 * 以下の値は fixture 内容および https://data.worldbank.org/indicator/CM.MKT.LCAP.CD
 * (JP 指定, 2026-09-27 取得の HTML) の埋め込みデータの両方で目視確認済み:
 *   - 日本 2023 年: 6,149,200,180,000 USD
 *   - 日本 2025 年: 7,610,543,670,000 USD
 *   - アメリカ 2023 年: 48,979,397,700,000 USD
 *   - ドイツ 2023 年: 2,178,052,520,000 USD
 *   - World (集計) 2023 年: 102,946,352,260,000 USD
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCountryMetaUrl,
  buildMarketCapUrl,
  defaultFetchWindow,
  isYearPublished,
  latestPublishedYear,
  parseCountryMetaResponse,
  parseMarketCapLastUpdated,
  parseMarketCapResponse,
  toObservationRecords,
  toObservations,
  WORLDBANK_MARKETCAP_INDICATOR,
  worldBankCountryMetaArchiveInput,
  worldBankMarketCapArchiveInput,
} from "./worldbank-marketcap.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "public", "worldbank-marketcap");

function readFixtureJson(filename: string): unknown {
  return JSON.parse(readFileSync(join(FX, filename), "utf-8"));
}

const marketCapFixture = () => readFixtureJson("worldbank-marketcap-2020-2026.json");
const countryMetaFixture = () => readFixtureJson("worldbank-country-meta.json");

describe("buildMarketCapUrl / buildCountryMetaUrl", () => {
  it("国=all・年レンジ指定の URL を組み立てる", () => {
    const url = buildMarketCapUrl({ fromYear: 2020, toYear: 2026 });
    expect(url).toBe(
      "https://api.worldbank.org/v2/country/all/indicator/CM.MKT.LCAP.CD?format=json&per_page=20000&date=2020%3A2026"
    );
  });

  it("fromYear > toYear は throw する (ルール2: 不正値を黙って通さない)", () => {
    expect(() => buildMarketCapUrl({ fromYear: 2026, toYear: 2020 })).toThrow();
  });

  it("country メタデータ URL を組み立てる", () => {
    const url = buildCountryMetaUrl();
    expect(url).toBe("https://api.worldbank.org/v2/country/all?format=json&per_page=20000");
  });
});

describe("defaultFetchWindow", () => {
  it("直近7年分の窓を返す (年ごとの公表ラグを吸収するため広めに取る)", () => {
    const window = defaultFetchWindow(new Date(Date.UTC(2026, 8, 27)));
    expect(window).toEqual({ fromYear: 2020, toYear: 2026 });
  });
});

describe("parseMarketCapResponse (実 fixture)", () => {
  it("実測値: 日本 2023/2025年の時価総額を原本どおりに抽出する", () => {
    const rows = parseMarketCapResponse(marketCapFixture());
    const jp2023 = rows.find((r) => r.iso3 === "JPN" && r.year === 2023);
    const jp2025 = rows.find((r) => r.iso3 === "JPN" && r.year === 2025);
    expect(jp2023?.marketCapUsd).toBe(6149200180000);
    expect(jp2025?.marketCapUsd).toBe(7610543670000);
    expect(jp2023?.entityName).toBe("Japan");
    expect(jp2023?.entityId).toBe("JP");
  });

  it("実測値: アメリカ・ドイツ・World(集計) 2023年の時価総額を原本どおりに抽出する", () => {
    const rows = parseMarketCapResponse(marketCapFixture());
    const usa2023 = rows.find((r) => r.iso3 === "USA" && r.year === 2023);
    const deu2023 = rows.find((r) => r.iso3 === "DEU" && r.year === 2023);
    const wld2023 = rows.find((r) => r.iso3 === "WLD" && r.year === 2023);
    expect(usa2023?.marketCapUsd).toBe(48979397700000);
    expect(deu2023?.marketCapUsd).toBe(2178052520000);
    expect(wld2023?.marketCapUsd).toBe(102946352260000);
  });

  it("value: null (未公表) は捏造せず undefined にする", () => {
    const rows = parseMarketCapResponse(marketCapFixture());
    const withNull = rows.filter((r) => r.marketCapUsd === undefined);
    expect(withNull.length).toBeGreaterThan(0);
    // 未公表行も entityId・年は正しく持ったままである (行ごと消さない)。iso3 は
    // 一部の集計行でそもそも未割当 (undefined) なのでここでは検証しない。
    for (const r of withNull) {
      expect(r.entityId).not.toBe("");
      expect(Number.isInteger(r.year)).toBe(true);
    }
  });

  it("indicator.id が想定外なら throw する (様式変化の検知)", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [
        {
          indicator: { id: "NY.GDP.MKTP.CD", value: "GDP" },
          country: { id: "JP", value: "Japan" },
          countryiso3code: "JPN",
          date: "2023",
          value: 1,
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/indicator\.id/);
  });

  it("date が YYYY 形式でなければ throw する", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [
        {
          indicator: { id: "CM.MKT.LCAP.CD", value: "x" },
          country: { id: "JP", value: "Japan" },
          countryiso3code: "JPN",
          date: "2023-01",
          value: 1,
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/date/);
  });

  it("value が数値でも null でもなければ throw する", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [
        {
          indicator: { id: "CM.MKT.LCAP.CD", value: "x" },
          country: { id: "JP", value: "Japan" },
          countryiso3code: "JPN",
          date: "2023",
          value: "6149200180000",
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/value/);
  });

  it("country.value (entityName) が空文字列なら throw する (黙って空欄のまま通さない)", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [
        {
          indicator: { id: "CM.MKT.LCAP.CD", value: "x" },
          country: { id: "JP", value: "" },
          countryiso3code: "JPN",
          date: "2023",
          value: 1,
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/country\.value/);
  });

  it("country.id が文字列でなければ throw する (数値等を黙って文字列化して結合キーにしない)", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [
        {
          indicator: { id: "CM.MKT.LCAP.CD", value: "x" },
          country: { id: 392, value: "Japan" },
          countryiso3code: "JPN",
          date: "2023",
          value: 1,
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/country\.id/);
  });

  it("複数ページに分割されたレスポンスは throw する (黙って1ページ目だけ使わない)", () => {
    const bad = [
      { page: 1, pages: 2, per_page: 1, total: 2 },
      [
        {
          indicator: { id: "CM.MKT.LCAP.CD", value: "x" },
          country: { id: "JP", value: "Japan" },
          countryiso3code: "JPN",
          date: "2023",
          value: 1,
        },
      ],
    ];
    expect(() => parseMarketCapResponse(bad)).toThrow(/ページ/);
  });

  it("meta.total と実際の行数が食い違えば throw する (欠けた応答を全件として黙って通さない)", () => {
    const json = marketCapFixture() as [Record<string, unknown>, unknown[]];
    const truncated = [json[0], json[1].slice(0, 1000)];
    expect(() => parseMarketCapResponse(truncated)).toThrow(/total \(1590\) と実際の行数 \(1000\)/);
    const meta = countryMetaFixture() as [Record<string, unknown>, unknown[]];
    expect(() => parseCountryMetaResponse([meta[0], meta[1].slice(1)])).toThrow(/total/);
  });

  it("meta.pages / total が空文字などの非整数なら throw する (Number(\"\") = 0 で黙って通さない)", () => {
    const json = marketCapFixture() as [Record<string, unknown>, unknown[]];
    expect(() => parseMarketCapResponse([{ ...json[0], pages: "" }, json[1]])).toThrow(/pages/);
    expect(() => parseMarketCapResponse([{ ...json[0], total: undefined }, json[1]])).toThrow(/total/);
    // 実レスポンスの数字文字列 (country メタの per_page: "400" と同じ形) は受ける
    expect(parseMarketCapResponse([{ ...json[0], pages: "1", total: "1590" }, json[1]])).toHaveLength(1590);
  });

  it("負の時価総額は throw する (残高として黙って通さない)", () => {
    const json = marketCapFixture() as [Record<string, unknown>, Array<Record<string, unknown>>];
    const rows = json[1].map((r) => ({ ...r }));
    const jpIdx = rows.findIndex(
      (r) => (r.country as { id: string }).id === "JP" && r.date === "2025"
    );
    rows[jpIdx] = { ...rows[jpIdx], value: -1 };
    expect(() => parseMarketCapResponse([json[0], rows])).toThrow(/JP 2025.*負の時価総額/);
  });

  it("[meta, rows] の形をしていなければ throw する", () => {
    expect(() => parseMarketCapResponse({ not: "an array" })).toThrow();
    expect(() => parseMarketCapResponse([1])).toThrow();
  });

  it("データ行が 0 件なら throw する", () => {
    const empty = [{ page: 1, pages: 1, per_page: 1, total: 0 }, []];
    expect(() => parseMarketCapResponse(empty)).toThrow(/0 件/);
  });
});

describe("parseCountryMetaResponse (実 fixture)", () => {
  it("実測値: Japan は個別国 (isAggregate=false)", () => {
    const rows = parseCountryMetaResponse(countryMetaFixture());
    const jp = rows.find((r) => r.iso3 === "JPN");
    expect(jp).toMatchObject({ iso3: "JPN", entityId: "JP", name: "Japan", isAggregate: false });
  });

  it("実測値: World (WLD) は集計行 (isAggregate=true)", () => {
    const rows = parseCountryMetaResponse(countryMetaFixture());
    const wld = rows.find((r) => r.iso3 === "WLD");
    expect(wld).toMatchObject({ iso3: "WLD", name: "World", isAggregate: true });
  });

  it("集計行と個別国の内訳が既知の比率どおりである (World Bank 側の分類が変わっていないことの確認)", () => {
    const rows = parseCountryMetaResponse(countryMetaFixture());
    const aggregates = rows.filter((r) => r.isAggregate);
    const countries = rows.filter((r) => !r.isAggregate);
    expect(aggregates.length).toBe(78);
    expect(countries.length).toBe(217);
  });

  it("region がオブジェクトでなければ throw する", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [{ id: "JPN", iso2Code: "JP", name: "Japan", region: "not-an-object" }],
    ];
    expect(() => parseCountryMetaResponse(bad)).toThrow();
  });

  it("region.value が空文字列なら throw する (isAggregate=false へ静かに倒さない)", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [{ id: "JPN", iso2Code: "JP", name: "Japan", region: { id: "", value: "" } }],
    ];
    expect(() => parseCountryMetaResponse(bad)).toThrow(/region\.value/);
  });

  it("region.value が文字列でなければ throw する (\"[object Object]\" に文字列化して個別国へ倒さない)", () => {
    const bad = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [{ id: "WLD", iso2Code: "1W", name: "World", region: { id: "NA", value: { label: "Aggregates" } } }],
    ];
    expect(() => parseCountryMetaResponse(bad)).toThrow(/region\.value/);
  });

  it("region.id と region.value の集計判定が食い違えば throw する (ラベル変更で集計行が個別国に紛れ込むのを防ぐ)", () => {
    // 実データ 295 行では region.id === "NA" ⇔ region.value === "Aggregates" が全件成り立つ。
    // 片方だけ変わった (例: ラベルが "Aggregates (regional)" に改称) ら、黙って個別国扱いにしない。
    const renamed = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [{ id: "WLD", iso2Code: "1W", name: "World", region: { id: "NA", value: "Aggregates (regional)" } }],
    ];
    expect(() => parseCountryMetaResponse(renamed)).toThrow(/集計行かどうか/);
    const idChanged = [
      { page: 1, pages: 1, per_page: 1, total: 1 },
      [{ id: "WLD", iso2Code: "1W", name: "World", region: { id: "AGG", value: "Aggregates" } }],
    ];
    expect(() => parseCountryMetaResponse(idChanged)).toThrow(/集計行かどうか/);
  });

  it("実データでは region.id と region.value の集計判定が全行で一致する", () => {
    expect(() => parseCountryMetaResponse(countryMetaFixture())).not.toThrow();
  });
});

describe("toObservations", () => {
  it("時価総額行と国メタデータを突き合わせ、前年比を計算する", () => {
    const marketCap = parseMarketCapResponse(marketCapFixture());
    const meta = parseCountryMetaResponse(countryMetaFixture());
    const observations = toObservations(marketCap, meta);

    const jp2023 = observations.find((o) => o.entityId === "JP" && o.year === 2023);
    const jp2022 = observations.find((o) => o.entityId === "JP" && o.year === 2022);
    expect(jp2022?.marketCapUsd).toBe(5380475460000);
    expect(jp2023?.marketCapUsd).toBe(6149200180000);
    expect(jp2023?.changeFromPreviousYearUsd).toBe(6149200180000 - 5380475460000);
    expect(jp2023?.isAggregate).toBe(false);
    expect(jp2023?.iso3).toBe("JPN");

    const wld2023 = observations.find((o) => o.entityId === "1W" && o.year === 2023);
    expect(wld2023?.isAggregate).toBe(true);
  });

  it("所得階層集計 (High income) は countryiso3code が空でも entityId で結合でき、iso3 は undefined になる", () => {
    const marketCap = parseMarketCapResponse(marketCapFixture());
    const meta = parseCountryMetaResponse(countryMetaFixture());
    const observations = toObservations(marketCap, meta);

    const highIncome2024 = observations.find((o) => o.entityId === "XD" && o.year === 2024);
    expect(highIncome2024).toBeDefined();
    expect(highIncome2024?.entityName).toBe("High income");
    expect(highIncome2024?.isAggregate).toBe(true);
    expect(highIncome2024?.iso3).toBeUndefined();
    expect(highIncome2024?.marketCapUsd).toBe(93057441170000);
  });

  it("メタデータに存在しない entityId が時価総額側にあれば throw する", () => {
    const marketCap = parseMarketCapResponse(marketCapFixture());
    const meta = parseCountryMetaResponse(countryMetaFixture()).filter(
      (m) => m.entityId !== "JP"
    );
    expect(() => toObservations(marketCap, meta)).toThrow(/JP.*メタデータが見つかりません/);
  });

  it("同じ entityId×年 の時価総額行が重複していれば throw する (前年比の相手を黙って後勝ちで選ばない)", () => {
    const marketCap = parseMarketCapResponse(marketCapFixture());
    const meta = parseCountryMetaResponse(countryMetaFixture());
    const jp2022 = marketCap.find((r) => r.entityId === "JP" && r.year === 2022);
    expect(jp2022).toBeDefined();
    const duplicated = [...marketCap, { ...jp2022!, marketCapUsd: 1 }];
    expect(() => toObservations(duplicated, meta)).toThrow(/JP:2022.*重複/);
  });

  it("国メタデータの entityId が重複していれば throw する (集計行/個別国の判定を黙って後勝ちにしない)", () => {
    const marketCap = parseMarketCapResponse(marketCapFixture());
    const meta = parseCountryMetaResponse(countryMetaFixture());
    const jp = meta.find((m) => m.entityId === "JP");
    expect(jp).toBeDefined();
    const duplicated = [...meta, { ...jp!, isAggregate: true }];
    expect(() => toObservations(marketCap, duplicated)).toThrow(/JP.*重複/);
  });
});

describe("isYearPublished / latestPublishedYear", () => {
  const observations = toObservations(
    parseMarketCapResponse(marketCapFixture()),
    parseCountryMetaResponse(countryMetaFixture())
  );

  it("値が入っている年は true、存在しない年/未公表の年は false", () => {
    expect(isYearPublished(observations, "JP", 2023)).toBe(true);
    expect(isYearPublished(observations, "JP", 1999)).toBe(false); // fixture の取得レンジ外
  });

  it("最新の公表年を返す (国ごとに異なりうる)", () => {
    const jpLatest = latestPublishedYear(observations, "JP");
    expect(jpLatest).toBeDefined();
    expect(jpLatest).toBeGreaterThanOrEqual(2023);
  });

  it("観測に無い entityId は undefined を返す (存在しないことをそのまま示す)", () => {
    expect(latestPublishedYear(observations, "ZZ")).toBeUndefined();
  });
});

describe("toObservationRecords (縦長フォーマット)", () => {
  it("観測ログ向けの列を持つ", () => {
    const observations = toObservations(
      parseMarketCapResponse(marketCapFixture()),
      parseCountryMetaResponse(countryMetaFixture())
    );
    const records = toObservationRecords(observations);
    const jp2023 = records.find((r) => r.categoryCode === "JP" && r.period === "2023");
    expect(jp2023).toMatchObject({
      indicatorKey: "worldbank_marketcap",
      period: "2023",
      periodType: "annual",
      category: "国地域",
      categoryValue: "Japan",
      categoryCode: "JP",
      iso3: "JPN",
      isAggregate: false,
      value: 6149200180000,
      unit: "USD",
      isApprox: true,
      measurement: "actual",
    });
  });

  it("High income (集計・iso3 無し) も categoryCode (entityId) は非空のまま出力される", () => {
    const observations = toObservations(
      parseMarketCapResponse(marketCapFixture()),
      parseCountryMetaResponse(countryMetaFixture())
    );
    const records = toObservationRecords(observations);
    const highIncome2024 = records.find(
      (r) => r.categoryCode === "XD" && r.period === "2024"
    );
    expect(highIncome2024).toMatchObject({
      categoryValue: "High income",
      categoryCode: "XD",
      iso3: undefined,
      isAggregate: true,
    });
  });
});

describe("WORLDBANK_MARKETCAP_INDICATOR (指標定義)", () => {
  it("必須フィールドがすべて埋まっている", () => {
    expect(WORLDBANK_MARKETCAP_INDICATOR.key).toBe("worldbank_marketcap");
    expect(WORLDBANK_MARKETCAP_INDICATOR.requirements).toContain("R4");
    expect(WORLDBANK_MARKETCAP_INDICATOR.flowType).toBe("holdings_stock");
    expect(WORLDBANK_MARKETCAP_INDICATOR.frequency).toBe("annual");
    expect(WORLDBANK_MARKETCAP_INDICATOR.sourceUrl).toBe(
      "https://data.worldbank.org/indicator/CM.MKT.LCAP.CD"
    );
    expect(WORLDBANK_MARKETCAP_INDICATOR.license).toMatch(/CC BY-4.0/);
    expect(WORLDBANK_MARKETCAP_INDICATOR.limitations.length).toBeGreaterThan(0);
    // ルール7: 平易な説明は中学生でも分かる長さ・内容であること (実装コードでの厳密検証は
    // できないため、最低限「フロー/ストックの混同を否定する一文」を含むことだけ固定する)
    expect(WORLDBANK_MARKETCAP_INDICATOR.plainDescription).toMatch(/フロー/);
  });

  it("定義が原典 (World Bank sourceNote) どおり: 国内企業のみ・年末・米ドル換算で、為替の影響を明示する (ルール7)", () => {
    const { plainDescription, measures, limitations } = WORLDBANK_MARKETCAP_INDICATOR;
    // sourceNote: "... for listed domestic companies" — 上場している会社「ぜんぶ」ではない
    expect(plainDescription).toMatch(/国内企業/);
    expect(plainDescription).not.toMatch(/会社ぜんぶ/);
    // sourceNote: "end of year values converted to U.S. dollars using corresponding
    // year-end foreign exchange rates" — 米ドル換算なので為替だけでも増減する
    expect(plainDescription).toMatch(/年末/);
    expect(plainDescription).toMatch(/米ドル/);
    expect(plainDescription).toMatch(/為替/);
    expect(limitations.some((l) => /為替/.test(l))).toBe(true);
    // "unit trusts" (英国等の契約型でオープンエンドの投資信託) を日本の「単位型投資信託」
    // (募集期間後に追加設定しない型) と同一視しない。「単元投資信託」という制度も無い
    expect(measures).not.toMatch(/単元投資信託/);
    expect(measures).toMatch(/ユニット・トラスト\(英国等の契約型の投資信託/);
    expect(measures).not.toMatch(/単位型投資信託\(ユニット・トラスト\)/);
    // World Bank の対象外の市場 (台湾) は World 集計にも入らないことを明示する
    expect(limitations.some((l) => /台湾/.test(l))).toBe(true);
  });
});

describe("アーカイブ入力の組み立て (ルール6準備、Notion 書込自体はしない)", () => {
  const window = { fromYear: 2020, toYear: 2026 };
  const marketCapFetchResult = () => {
    const bytes = new Uint8Array(readFileSync(join(FX, "worldbank-marketcap-2020-2026.json")));
    return {
      url: buildMarketCapUrl(window),
      bytes,
      json: JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown,
    };
  };

  it("parseMarketCapLastUpdated: 実レスポンスの meta.lastupdated (WDI の最終更新日) を読む", () => {
    expect(parseMarketCapLastUpdated(marketCapFixture())).toBe("2026-07-13");
  });

  it("parseMarketCapLastUpdated: lastupdated が無い・日付形式でなければ throw する (版を推測で埋めない)", () => {
    const [meta, rows] = marketCapFixture() as [Record<string, unknown>, unknown];
    const { lastupdated: _omit, ...withoutLastUpdated } = meta;
    expect(() => parseMarketCapLastUpdated([withoutLastUpdated, rows])).toThrow(/lastupdated/);
    expect(() => parseMarketCapLastUpdated([{ ...meta, lastupdated: "13/07/2026" }, rows])).toThrow(
      /lastupdated/
    );
  });

  it("時価総額: 冪等キーに年レンジと World Bank 最終更新日を含め、JSON 実体をそのまま組む", () => {
    const fetched = marketCapFetchResult();
    const input = worldBankMarketCapArchiveInput(fetched, window);
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("worldbank-marketcap-2020-2026-lu20260713");
    expect(input.metadata).toMatchObject({ fromYear: 2020, toYear: 2026, lastUpdated: "2026-07-13" });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("worldbank-marketcap-2020-2026-lu20260713.json");
    expect(input.files[0]!.contentType).toBe("application/json");
    expect(input.files[0]!.bytes).toBe(fetched.bytes);
  });

  it("時価総額: 同じ年レンジでも WDI が更新されれば (lastupdated が変われば) 別キーになる (改訂を取りこぼさない)", () => {
    const fetched = marketCapFetchResult();
    const [meta, rows] = fetched.json as [Record<string, unknown>, unknown];
    const revised = { ...fetched, json: [{ ...meta, lastupdated: "2026-12-16" }, rows] as unknown };
    expect(worldBankMarketCapArchiveInput(revised, window).key).toBe(
      "worldbank-marketcap-2020-2026-lu20261216"
    );
  });

  it("時価総額: 取得 URL の年レンジとキーに使う window が食い違えば throw する (中身と違うキーで保管しない)", () => {
    const fetched = marketCapFetchResult();
    expect(() => worldBankMarketCapArchiveInput(fetched, { fromYear: 2021, toYear: 2027 })).toThrow(
      /年レンジ/
    );
  });

  it("国メタデータ: 取得年単位の冪等キーを組む", () => {
    const bytes = new Uint8Array(readFileSync(join(FX, "worldbank-country-meta.json")));
    const input = worldBankCountryMetaArchiveInput(
      { url: buildCountryMetaUrl(), bytes, json: countryMetaFixture() },
      2026
    );
    expect(input.key).toBe("worldbank-country-meta-2026");
    expect(input.files[0]!.bytes).toBe(bytes);
  });
});
