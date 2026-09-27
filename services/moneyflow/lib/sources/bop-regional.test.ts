/**
 * 国際収支統計 地域別 (bop-regional.ts) のユニットテスト。
 *
 * fixture は日本銀行「時系列統計データ検索サイト」から実際に取得した ZIP
 * (地域別国際収支（四半期）) を、直接投資・証券投資の行と直近9四半期
 * (2024Q1〜2026Q1) の列だけに絞って再構成した実データそのもの (架空値は
 * 使わない)。fixtures/private/bop-regional/regbp-q-jp-sample.zip 生成手順は
 * 本ファイル末尾のコメントを参照。
 *
 * fixture (fixtures/private/bop-regional/) は日本銀行の再配布条件を確認して
 * いないため commit しない (.gitignore 済み)。無い環境 (CI) では fixture を
 * 読むテストだけ describe.skipIf で skip し、合成入力のテストは常に走らせる。
 *
 * 期待値は 2026-09-27 に実ファイルを目視確認して採取した実測値。
 */
import { beforeAll, describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
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

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "bop-regional");
const HAS_FIXTURES =
  existsSync(join(FX, "regbp-q-jp-sample.zip")) && existsSync(join(FX, "boj-dload-excerpt.html"));
const fxBytes = (n: string) => new Uint8Array(readFileSync(join(FX, n)));
// boj-dload-excerpt.html は実際の HTTP レスポンスと同じ Shift_JIS バイト列の
// まま保存している (本番の resolveBopRegionalZipUrl と同じ
// デコード経路を通す)。utf8 として読むと文字化けするので明示的に変換する。
const fxShiftJisText = (n: string) => new TextDecoder("shift_jis").decode(fxBytes(n));

function loadFixtureCsvText(): string {
  return decodeBopRegionalZip(fxBytes("regbp-q-jp-sample.zip"));
}

function loadFixtureObservations(): BopRegionalObservation[] {
  return extractBopRegionalObservations(parseBopRegionalCsvText(loadFixtureCsvText()));
}

/**
 * fixture (実データ) の「地域別合計」10行 (= 10指標すべて) を、最終列
 * (2026Q1) だけ残した CSV 行として返す。extractBopRegionalObservations は
 * 10指標のどれかが1行も無いと様式変更として throw するため、合成1行の
 * 入力を検証するテストはこの実データ行を土台に足して使う。
 * (fixture の区分名・ラベルはカンマを含まないので単純 split で足りる)
 */
function realWorldTotalRows2026Q1(): string[] {
  const lines = loadFixtureCsvText().split(/\r?\n/);
  const header = lines[0]!.split(",");
  if (header[header.length - 1] !== "202601") {
    throw new Error(`fixture の最終列が 202601 ではありません: ${header[header.length - 1]}`);
  }
  return lines
    .slice(1)
    .filter((l) => l.includes("/地域別合計/"))
    .map((l) => {
      const f = l.split(",");
      return [...f.slice(0, 4), f[f.length - 1]].join(",");
    });
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
  describe.skipIf(!HAS_FIXTURES)("実HTML fixture", () => {
    it("実際のページ抜粋から regbp_q_jp.zip を抽出する", () => {
      const html = fxShiftJisText("boj-dload-excerpt.html");
      expect(extractBopRegionalZipHref(html)).toBe("regbp_q_jp.zip");
    });
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

describe.skipIf(!HAS_FIXTURES)("decodeBopRegionalZip + parseBopRegionalCsvText + extractBopRegionalObservations (実ZIP fixture)", () => {
  // skip された describe でも factory は実行されるため、読込は beforeAll で行う
  let observations: BopRegionalObservation[];
  beforeAll(() => {
    observations = loadFixtureObservations();
  });

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

/**
 * fixture ZIP (stored = 無圧縮) から CSV の生バイト列 (Shift_JIS のまま) を
 * 取り出す。ヘッダの CRC と一致することを確かめてから返す。
 */
function fixtureCsvRawBytes(): Buffer {
  const buf = Buffer.from(fxBytes("regbp-q-jp-sample.zip"));
  if (buf.readUInt32LE(0) !== 0x04034b50 || buf.readUInt16LE(8) !== 0) {
    throw new Error("fixture ZIP の先頭が stored の Local File Header ではありません");
  }
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  const bytes = buf.subarray(start, start + buf.readUInt32LE(18));
  if (crc32(bytes) !== buf.readUInt32LE(14)) {
    throw new Error("fixture ZIP の CRC が一致しません");
  }
  return bytes;
}

/**
 * CSV 生バイト列を deflate (method 8) の単一エントリ ZIP に詰める。本番で
 * 日本銀行から降ってくる ZIP は圧縮されているため、fixture (stored) では
 * 通らない inflate 経路を検証する。dataDescriptor=true なら Local File
 * Header の CRC/サイズを 0 にして後置 Data Descriptor に置く (bit 3)。
 */
function deflateZip(name: string, data: Buffer, dataDescriptor: boolean): Uint8Array {
  const nameBuf = Buffer.from(name, "utf8");
  const comp = deflateRawSync(data);
  const crc = crc32(data);
  const flags = dataDescriptor ? 0x0008 : 0;
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(flags, 6);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(dataDescriptor ? 0 : crc, 14);
  lfh.writeUInt32LE(dataDescriptor ? 0 : comp.length, 18);
  lfh.writeUInt32LE(dataDescriptor ? 0 : data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const dd = Buffer.alloc(dataDescriptor ? 16 : 0);
  if (dataDescriptor) {
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(comp.length, 8);
    dd.writeUInt32LE(data.length, 12);
  }
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(flags, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + nameBuf.length, 12);
  eocd.writeUInt32LE(lfh.length + nameBuf.length + comp.length + dd.length, 16);
  return new Uint8Array(Buffer.concat([lfh, nameBuf, comp, dd, cd, nameBuf, eocd]));
}

describe.skipIf(!HAS_FIXTURES)("decodeBopRegionalZip (deflate 圧縮 ZIP = 本番の配布形式の経路)", () => {
  for (const dataDescriptor of [false, true]) {
    it(`deflate (method 8${dataDescriptor ? "、Data Descriptor 付き" : ""}) の実 CSV を stored と同一テキストへ展開する`, () => {
      const csvBytes = fixtureCsvRawBytes();
      const zip = deflateZip("regbp_q_jp.csv", csvBytes, dataDescriptor);
      expect(zip.byteLength).toBeLessThan(csvBytes.byteLength); // 実際に圧縮されている
      const text = decodeBopRegionalZip(zip);
      expect(text).toBe(loadFixtureCsvText());
      expect(extractBopRegionalObservations(parseBopRegionalCsvText(text))).toHaveLength(
        190 * 9 - 144
      );
    });
  }

  it("想定エントリ (regbp_q_jp.csv) が無い ZIP は throw する", () => {
    const zip = deflateZip("other.csv", fixtureCsvRawBytes(), false);
    expect(() => decodeBopRegionalZip(zip)).toThrow(/regbp_q_jp\.csv/);
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

  it("空白だけのセルや16進表記を 0 や別の数値へ黙って読み替えず throw する (ルール2)", () => {
    // Number(" ") は 0、Number("0x10") は 16 になる。10進表記以外は受け付けない。
    for (const bad of [" ", "0x10"]) {
      const badRow = VALID_ROW.replace("-1631.38201514", bad);
      expect(() => parseBopRegionalCsvText(`${HEADER}\n${badRow}`), `cell="${bad}"`).toThrow(
        /数値でも欠損表現/
      );
    }
  });

  it("実ファイルに現れる数値表記 (負の小数・整数 0) はそのまま読める", () => {
    for (const [cell, expected] of [
      ["-0.64", -0.64],
      ["0", 0],
      ["18925.53442", 18925.53442],
    ] as const) {
      const row = VALID_ROW.replace("-1631.38201514", cell);
      expect(parseBopRegionalCsvText(`${HEADER}\n${row}`).rows[0]!.values).toEqual([expected]);
    }
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
    expect(() => extractBopRegionalObservations(parsed)).toThrow(/未知の地域名/);
  });

  describe.skipIf(!HAS_FIXTURES)("実 fixture の地域別合計行を土台にした入力", () => {
    it("対象外の項目 (経常収支等) は無視する (throw しない・観測ログに出さない)", () => {
      const outOfScope =
        'BPBP6QCBAS,"地域別国際収支（四半期）（6版基準）","経常収支/アジア計","億円",1.0';
      const parsed = parseBopRegionalCsvText(
        `,,,,202601\n${realWorldTotalRows2026Q1().join("\n")}\n${outOfScope}`
      );
      const observations = extractBopRegionalObservations(parsed);
      expect(observations).toHaveLength(10); // 地域別合計 × 10指標 (2026Q1) のみ
      expect(observations.some((o) => o.sourceCode === "BPBP6QCBAS")).toBe(false);
    });
  });
});

describe.skipIf(!HAS_FIXTURES)("extractBopRegionalObservations (対象指標が丸ごと欠ける = 様式変更は throw する)", () => {
  // 対象外の行は黙って読み飛ばす設計のため、項目ラベルが改名されると該当
  // 指標が丸ごと 0 件のまま正常終了してしまい、isPeriodObserved() が
  // 「未公表」と誤判定する (ルール2 違反)。実 fixture のラベルだけを
  // 改名した入力で、黙って続行せず throw することを確かめる。
  it("「金融/証券投資/」系のラベルが改名されたら (直接投資だけ残っても) throw する", () => {
    const renamed = loadFixtureCsvText().replaceAll("金融/証券投資/", "金融/証券投資計/");
    expect(() => extractBopRegionalObservations(parseBopRegionalCsvText(renamed))).toThrow(
      /bop_regional_portfolio_investment_net/
    );
  });

  it("対象の全ラベルが改名されたら 0 件で正常終了せず throw する", () => {
    const renamed = loadFixtureCsvText()
      .replaceAll("金融/証券投資/", "金融/証券投資計/")
      .replaceAll("金融/直接投資/", "金融/直接投資計/");
    expect(() => extractBopRegionalObservations(parseBopRegionalCsvText(renamed))).toThrow(
      /該当する行が CSV に1行もありません/
    );
  });

  it("株式・投資ファンド持分の内訳だけが欠けても throw する", () => {
    const withoutEquity = loadFixtureCsvText()
      .split("\n")
      .filter((l) => !l.includes("/株式・投資ファンド持分/"))
      .join("\n");
    expect(() => extractBopRegionalObservations(parseBopRegionalCsvText(withoutEquity))).toThrow(
      /bop_regional_portfolio_investment_equity_asset, bop_regional_portfolio_investment_equity_liability/
    );
  });
});

describe.skipIf(!HAS_FIXTURES)("同一キーの重複 (値違いの観測が2件出て upsert で黙って上書きされる) は throw する", () => {
  // 実 fixture のヘッダ/行だけを複製・改変した入力で確かめる (ルール2)。
  it("ヘッダに同じ期間コードの列が2つあれば throw する", () => {
    const lines = loadFixtureCsvText().split(/\r?\n/);
    // 最終列 202601 を 202504 に書き換える → 2025Q4 が2列になる
    lines[0] = lines[0]!.replace(/,202601$/, ",202504");
    expect(lines[0]).toMatch(/,202504,202504$/);
    expect(() => parseBopRegionalCsvText(lines.join("\n"))).toThrow(/2025Q4.*重複/);
  });

  it("同じ指標・地域の系列が2行あれば (コード違いでも) throw する", () => {
    const lines = loadFixtureCsvText().split(/\r?\n/);
    const dup = lines[1]!.replace(/^BPBP6QFB1,/, "BPBP6QFB1DUP,");
    expect(dup).not.toBe(lines[1]);
    const text = [lines[0], dup, ...lines.slice(1)].join("\n");
    expect(() => extractBopRegionalObservations(parseBopRegionalCsvText(text))).toThrow(
      /bop_regional_direct_investment_net \/ 地域別合計: BPBP6QFB1DUP と BPBP6QFB1/
    );
  });

  it("実ファイルには重複が無く、(期間・指標・地域) は観測ログ内で一意", () => {
    const obs = loadFixtureObservations();
    const keys = new Set(obs.map((o) => `${o.period}|${o.metricKey}|${o.region}`));
    expect(keys.size).toBe(obs.length);
  });
});

describe.skipIf(!HAS_FIXTURES)("regionKind の分類 (合成1行入力。BOP_REGIONS の定義を経路まで検証する)", () => {
  // 非分類・国際機関の direct/portfolio investment は実ファイルで恒常的に
  // "NA" (統計的秘匿) のため、大規模 fixture からは分類結果を観測できない。
  // 実在する地域名 + 実データではない値1つ、という最小合成入力で
  // classifyLabel → BOP_REGIONS 引きの経路そのものを検証する (10指標が揃って
  // いないと throw するため、実データの「地域別合計」10行を土台に足す)。
  // skip された describe でも factory は実行されるため、読込は beforeAll で行う
  let baseRows: string[];
  beforeAll(() => {
    baseRows = realWorldTotalRows2026Q1();
  });
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
      // 「地域別合計」は土台の実データ行そのもの (BPBP6QFB1) で検証する。
      // 同じ系列を足すと重複系列として throw するため (ルール2)。
      const isBase = region === "地域別合計";
      const parsed = parseBopRegionalCsvText(
        `,,,,202601\n${baseRows.join("\n")}` +
          (isBase
            ? ""
            : `\nBPBP6QFBXX,"地域別国際収支（四半期）（6版基準）","金融/直接投資/${region}/ネット","億円",1.0`)
      );
      const code = isBase ? "BPBP6QFB1" : "BPBP6QFBXX";
      const o = extractBopRegionalObservations(parsed).find((x) => x.sourceCode === code);
      expect(o?.region).toBe(region);
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
      // notice.html「３．リンクについて」: リンク元 URL を情報サービス局へ知らせる
      expect(def.license).toMatch(/リンク.*情報\s*サービス局|リンク元の URL/);
    }
  });

  it("直接投資の定義は BPM6 の構成 (株式資本・収益の再投資・負債性資本) を落とさない (ルール7)", () => {
    for (const def of BOP_REGIONAL_INDICATORS.filter((d) => d.key.includes("direct_investment"))) {
      expect(def.measures).toMatch(/収益の再投資/);
      expect(def.measures).toMatch(/負債性資本/);
      expect(def.plainExplanation).toMatch(/貸付/);
    }
  });

  it("地域は国籍ではなく相手方の居住地による区分である旨を限界に明記する (ルール7)", () => {
    for (const def of BOP_REGIONAL_INDICATORS) {
      expect(def.limitations).toMatch(/居住地/);
      expect(def.limitations).toMatch(/国籍ではない/);
      expect(def.plainExplanation).not.toMatch(/その国・地域の投資家/);
    }
  });

  describe.skipIf(!HAS_FIXTURES)("実 fixture との整合", () => {
    it("限界に書いた英国の対内債券投資の倍率は実 fixture の値と整合する", () => {
      const obs = loadFixtureObservations();
      const gb = find(obs, "2026Q1", "bop_regional_portfolio_investment_debt_liability", "英国");
      const total = find(obs, "2026Q1", "bop_regional_portfolio_investment_debt_liability", "地域別合計");
      expect(gb!.value / total!.value).toBeCloseTo(2.7, 1);
      expect(BOP_REGIONAL_INDICATORS[0]!.limitations).toContain("約2.7倍");
    });
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
 * fixtures/private/bop-regional/regbp-q-jp-sample.zip の生成手順 (再現用メモ):
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
 * fixtures/private/bop-regional/boj-dload-excerpt.html は
 * https://www.stat-search.boj.or.jp/info/dload.html の実バイト列から、
 * 対象リンクの前後 1400 バイトだけを切り出したもの。
 */
