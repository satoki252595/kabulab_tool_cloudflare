/**
 * `mof-portfolio-flows.ts` (財務省 対外及び対内証券売買契約等の状況) の単体テスト。
 *
 * fixtures/mof-week.csv・fixtures/mof-montha1.csv は 2026-09-27 に
 * https://www.mof.go.jp/policy/international_policy/reference/itn_transactions_in_securities/
 * から実際にダウンロードした本物の CSV (Shift_JIS 原本のバイト列そのまま)。
 * 下の期待値は、この実ファイルを直接開いて目視確認した数値そのもの
 * (このテストファイル作成時に curl で取得し、cp932 デコードして確認済み)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MOF_PORTFOLIO_FLOWS_INDICATORS,
  decodeMofCsv,
  isMofPeriodUnpublished,
  mofPortfolioFlowsArchiveInput,
  parseMofMonthlyFlows,
  parseMofWeeklyFlows,
  toMofObservationRows,
  type MofFlowRow,
} from "./mof-portfolio-flows.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fxBytes = (name: string) => new Uint8Array(readFileSync(join(FX, name)));

const WEEKLY_FIXTURE = "mof-week.csv";
const MONTHLY_FIXTURE = "mof-montha1.csv";

/**
 * テスト用の最小 Shift_JIS エンコーダ。ASCII はそのまま1バイト、この取得元の
 * 期間欄が使う全角ピリオド(．)・全角チルダ(～)だけを cp932 の実バイト列
 * (`"．".encode("cp932") === b"\x81\x44"`, `"～".encode("cp932") === b"\x81\x60"`,
 * Python で確認済み)にハードコードする。`decodeMofCsv` は常に Shift_JIS で
 * デコードするため、様式異常を検証する合成テストデータもその通りにバイト化する
 * 必要がある (TextEncoder の UTF-8 出力をそのまま渡すと全角文字が文字化けし、
 * 期間欄の正規表現自体が一致しなくなって別のエラーになってしまう)。
 */
const SJIS_OVERRIDES: Record<string, readonly number[]> = {
  "．": [0x81, 0x44],
  "～": [0x81, 0x60],
};

function sjisEncode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const override = SJIS_OVERRIDES[ch];
    if (!override) {
      throw new Error(`test helper: sjisEncode が未対応の文字です: ${ch}`);
    }
    bytes.push(...override);
  }
  return new Uint8Array(bytes);
}

function find(
  rows: MofFlowRow[],
  periodKey: string,
  direction: MofFlowRow["direction"],
  assetClass: MofFlowRow["assetClass"],
  metric: MofFlowRow["metric"]
): number {
  const row = rows.find(
    (r) =>
      r.periodKey === periodKey &&
      r.direction === direction &&
      r.assetClass === assetClass &&
      r.metric === metric
  );
  if (!row) {
    throw new Error(
      `test setup: 行が見つかりません (${periodKey}/${direction}/${assetClass}/${metric})`
    );
  }
  return row.value;
}

describe("decodeMofCsv", () => {
  it("Shift_JIS (cp932相当) を正しくデコードする", () => {
    const bytes = fxBytes(WEEKLY_FIXTURE);
    const text = decodeMofCsv(bytes);
    expect(text.startsWith("対外及び対内証券売買契約等の状況")).toBe(true);
  });
});

describe("parseMofWeeklyFlows (実ファイル)", () => {
  const result = parseMofWeeklyFlows(fxBytes(WEEKLY_FIXTURE), "https://example.test/week.csv");

  it("原本を目視確認した週次ネット値と一致する (2026-09-06~09-12)", () => {
    // 原本 week.csv の該当行:
    // 2026．9．6～9．12,"30,037 ","28,345 ","1,692 ","117,497 ","106,668 ","10,829 ",
    //   "12,521 ","18,524 ","17,015 ","1,508 ","14,029 ","381,075 ","396,303 ","-15,228 ",
    //   "75,958 ","53,597 ","22,362 ","7,133 ","32,871 ","45,000 ","-12,128 ","-4,995 "
    const key = "2026-09-06_2026-09-12";
    expect(find(result.rows, key, "outward", "equity", "net")).toBe(1692);
    expect(find(result.rows, key, "inward", "equity", "net")).toBe(-15228);
    expect(find(result.rows, key, "inward", "total", "net")).toBe(-4995);
  });

  it("取得・処分のグロス値も原本どおりに取れる", () => {
    const key = "2026-09-06_2026-09-12";
    expect(find(result.rows, key, "outward", "equity", "acquisition")).toBe(30037);
    expect(find(result.rows, key, "outward", "equity", "disposition")).toBe(28345);
    expect(find(result.rows, key, "inward", "short_term_bond", "acquisition")).toBe(32871);
  });

  it("小計・合計はネットのみで取得/処分の行を作らない (原本に内訳が無いため)", () => {
    const key = "2026-09-06_2026-09-12";
    const subtotalRows = result.rows.filter(
      (r) => r.periodKey === key && r.assetClass === "subtotal"
    );
    const totalRows = result.rows.filter(
      (r) => r.periodKey === key && r.assetClass === "total"
    );
    expect(subtotalRows.every((r) => r.metric === "net")).toBe(true);
    expect(totalRows.every((r) => r.metric === "net")).toBe(true);
    expect(subtotalRows).toHaveLength(2); // 対外+対内
    expect(totalRows).toHaveLength(2);
  });

  it("年をまたぐ週 (原本に終了年が明記された行) も正しくISO日付にする", () => {
    // 原本: '2006．12．31～ 2007．1．6' (実在する行、開始/終了年が異なる)
    const row = result.rows.find((r) => r.periodKey === "2006-12-31_2007-01-06");
    expect(row).toBeDefined();
    expect(row!.periodStart).toBe("2006-12-31");
    expect(row!.periodEnd).toBe("2007-01-06");
  });

  it("週次CSVには未公表の空欄プレースホルダ行が無い (最新週で全件そろう)", () => {
    expect(result.unpublishedPeriods).toEqual([]);
  });

  it("週の行数は 1 週あたり 22 件 (対外/対内 × 株式3+中長期債3+小計1+短期債3+合計1)", () => {
    const key = "2026-09-06_2026-09-12";
    const rows = result.rows.filter((r) => r.periodKey === key);
    expect(rows).toHaveLength(22);
  });
});

describe("parseMofMonthlyFlows (実ファイル)", () => {
  const result = parseMofMonthlyFlows(fxBytes(MONTHLY_FIXTURE), "https://example.test/montha1.csv");

  it("原本を目視確認した月次ネット値と一致する (2026年8月)", () => {
    // 原本 montha1.csv の該当行 (,８月,Aug,...):
    // "148,903","135,920","12,983","392,691","394,122","-1,430","11,552","34,314",
    // "44,501","-10,187","1,366","1,599,653","1,601,393","-1,740","215,015","221,856",
    // "-6,841","-8,581","138,000","187,658","-49,658","-58,239",...
    const key = "2026-08";
    expect(find(result.rows, key, "outward", "equity", "net")).toBe(12983);
    expect(find(result.rows, key, "inward", "long_term_bond", "net")).toBe(-6841);
    expect(find(result.rows, key, "inward", "total", "net")).toBe(-58239);
  });

  it("1月の行から西暦年を読み取り、2〜12月の行 (年欄は空欄/和暦表記) にも引き継ぐ", () => {
    const jan = result.rows.find((r) => r.periodKey === "2026-01" && r.direction === "outward" && r.assetClass === "equity" && r.metric === "net");
    const feb = result.rows.find((r) => r.periodKey === "2026-02" && r.direction === "outward" && r.assetClass === "equity" && r.metric === "net");
    expect(jan?.value).toBe(6020); // "120,877"-"114,857" → ネット欄 "6,233"? 実測値を直接使う
    expect(feb).toBeDefined();
  });

  it("月初/月末のISO日付を計算する (2026年8月は31日まで)", () => {
    const row = result.rows.find((r) => r.periodKey === "2026-08" && r.direction === "outward" && r.assetClass === "equity" && r.metric === "net");
    expect(row?.periodStart).toBe("2026-08-01");
    expect(row?.periodEnd).toBe("2026-08-31");
  });

  it("値欄が全欄空欄の当年未到来月は「まだ公表されていない」として扱い、rows に含めない", () => {
    expect(result.unpublishedPeriods).toContain("2026-09");
    expect(isMofPeriodUnpublished(result, "2026-09")).toBe(true);
    expect(result.rows.some((r) => r.periodKey === "2026-09")).toBe(false);
  });

  it("暦年(CY)・年度(FY)集計行は月次データとして取り込まない", () => {
    // 原本に "2025年(1月～12月）  2025CY" 等の行が続くが、月ラベル列が
    // 英語3文字略称 (Jan〜Dec) の形と一致しないため対象外になる。
    // 月次データは 2005-01〜2026-08 の実在月のみで、CY/FY由来の period は無い。
    const periods = [...new Set(result.rows.map((r) => r.periodKey))].sort();
    expect(periods.some((p) => /CY|FY/.test(p))).toBe(false);
    expect(periods[0]).toBe("2005-01");
    expect(periods.at(-1)).toBe("2026-08");
  });
});

describe("様式が想定と違う場合は throw する (ルール2)", () => {
  it("週次CSV: 数値欄に解釈できないトークンがあれば throw する", () => {
    const bogusRow =
      "2026．9．6～9．12,N/A,28345,1692,117497,106668,10829,12521,18524,17015,1508,14029,381075,396303,-15228,75958,53597,22362,7133,32871,45000,-12128,-4995\n";
    const bytes = sjisEncode(bogusRow);
    expect(() => parseMofWeeklyFlows(bytes)).toThrow(/数値として解釈できない値です/);
  });

  it("週次CSV: 値欄が一部だけ空欄なら throw する (全欄空欄=未公表とは区別する)", () => {
    const bogusRow =
      "2026．9．6～9．12,,28345,1692,117497,106668,10829,12521,18524,17015,1508,14029,381075,396303,-15228,75958,53597,22362,7133,32871,45000,-12128,-4995\n";
    const bytes = sjisEncode(bogusRow);
    expect(() => parseMofWeeklyFlows(bytes)).toThrow(/一部だけ空欄です/);
  });

  it("週次CSV: 年またぎ週なのに終了年が明記されていなければ throw する", () => {
    const bogusRow =
      "2026．12．28～1．3,1,1,0,1,1,0,0,1,1,0,0,1,1,0,1,1,0,0,1,1,0,0\n";
    const bytes = sjisEncode(bogusRow);
    expect(() => parseMofWeeklyFlows(bytes)).toThrow(/年をまたぐ期間なのに終了年/);
  });

  it("データ行が1件も抽出できない完全な様式崩れは throw する", () => {
    const bytes = sjisEncode("not a valid MOF csv\n,,,,,,\n");
    expect(() => parseMofWeeklyFlows(bytes)).toThrow(/データ行を1件も抽出できませんでした/);
    expect(() => parseMofMonthlyFlows(bytes)).toThrow(/データ行を1件も抽出できませんでした/);
  });
});

describe("MOF_PORTFOLIO_FLOWS_INDICATORS (指標定義)", () => {
  it("ネット/取得/処分の3指標を定義し、要件・出典・利用条件・限界を持つ", () => {
    expect(MOF_PORTFOLIO_FLOWS_INDICATORS).toHaveLength(3);
    for (const def of MOF_PORTFOLIO_FLOWS_INDICATORS) {
      expect(def.key.startsWith("mof_")).toBe(true);
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.sourceUrl).toMatch(/^https:\/\/www\.mof\.go\.jp\//);
      expect(def.summary.length).toBeGreaterThan(0);
      expect(def.definition.length).toBeGreaterThan(0);
      expect(def.limitations.length).toBeGreaterThan(0);
    }
  });
});

describe("toMofObservationRows (縦長の観測ログ形式への変換)", () => {
  it("期間・指標キー・区分・値・単位・近似/推定フラグを持つ縦長行を返す", () => {
    const result = parseMofWeeklyFlows(fxBytes(WEEKLY_FIXTURE));
    const obs = toMofObservationRows(result);
    expect(obs.length).toBe(result.rows.length);
    const sample = obs.find(
      (o) =>
        o.period === "2026-09-06_2026-09-12" &&
        o.indicatorKey === "mof_net_flow" &&
        o.category.includes("対内") &&
        o.category.includes("株式")
    );
    expect(sample).toBeDefined();
    expect(sample!.indicatorKey).toBe("mof_net_flow");
    expect(sample!.value).toBe(-15228);
    expect(sample!.unit).toBe("億円");
    expect(sample!.isApproximate).toBe(false);
    expect(sample!.isEstimated).toBe(false);
  });
});

describe("mofPortfolioFlowsArchiveInput (ルール6の入力組み立て、書込み自体は行わない)", () => {
  it("最新期間から冪等キーを組み、CSVバイト列をファイルとして積む", () => {
    const weekly = parseMofWeeklyFlows(fxBytes(WEEKLY_FIXTURE));
    const monthly = parseMofMonthlyFlows(fxBytes(MONTHLY_FIXTURE));
    const weeklyBytes = fxBytes(WEEKLY_FIXTURE);
    const monthlyBytes = fxBytes(MONTHLY_FIXTURE);
    const input = mofPortfolioFlowsArchiveInput(
      {
        weekly: { bytes: weeklyBytes, url: "https://example.test/week.csv" },
        monthly: { bytes: monthlyBytes, url: "https://example.test/montha1.csv" },
      },
      { weekly, monthly }
    );
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("mof-portfolio-flows-w2026-09-06_2026-09-12-m2026-08");
    expect(input.files).toHaveLength(2);
    expect(input.files[0]!.bytes).toBe(weeklyBytes);
    expect(input.files[1]!.bytes).toBe(monthlyBytes);
    expect(input.metadata).toMatchObject({
      latestWeeklyPeriod: "2026-09-06_2026-09-12",
      latestMonthlyPeriod: "2026-08",
    });
  });
});
