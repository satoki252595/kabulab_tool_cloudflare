/**
 * JVCEA「会員の暗号資産取引状況表（月次）」パーサのテスト。
 *
 * フィクスチャは 2026-09-27 に実際に取得した実ファイル (架空値ではない):
 *   - jvcea-crypto-202607-koukai-01-p1-2.pdf
 *       元URL: https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf
 *       (全8ページ中、本パーサが対象とする1〜2ページ目 [合算表] のみを
 *        pymupdf で抽出したもの。3ページ目以降は銘柄別内訳でスコープ外)
 *   - jvcea-crypto-202607-koukai-01-full-8p.pdf
 *       同URL の全8ページそのまま (トリミング無し)。本番の fetchJvceaCrypto()
 *       が実際に受け取るのと同じ形。3ページ目以降 (銘柄別内訳、列構成が
 *       異なる) を含めても合算表だけを正しく取り出せることを検証するために
 *       使う (このトリミング無し版が無いと、本番が壊れていても
 *       p1-2 版だけのテストは全て pass してしまう)。
 *   - jvcea-statistics-information-20260927.html
 *       元URL: https://jvcea.or.jp/statistics/information/ (2026-09-27 時点)
 *
 * 期待値は PDF を画像化して目視確認した数値 (下記コメントの通り)。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import {
  JVCEA_CRYPTO_CATEGORY,
  JVCEA_CRYPTO_INDICATORS,
  isJvceaCryptoMonthPublished,
  jvceaCryptoArchiveInput,
  jvceaCryptoRowToObservations,
  parseJvceaCryptoText,
  parseLatestJvceaCryptoPdfUrl,
  selectAggregateTablePages,
  type JvceaCryptoRow,
} from "./jvcea-crypto.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

async function extractPageTexts(filename: string): Promise<string[]> {
  const bytes = readFileSync(join(FIXTURES, filename));
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

async function loadFixtureRows(): Promise<JvceaCryptoRow[]> {
  const text = await extractPageTexts("jvcea-crypto-202607-koukai-01-p1-2.pdf");
  return parseJvceaCryptoText(text);
}

describe("parseJvceaCryptoText (実フィクスチャ)", () => {
  it("2018年9月〜2026年7月の95か月分を、欠落・重複なく抽出する", async () => {
    const rows = await loadFixtureRows();
    expect(rows).toHaveLength(95);
    const periods = rows.map((r) => r.period);
    expect(new Set(periods).size).toBe(95);
    expect(periods).toContain("2018-09");
    expect(periods).toContain("2026-07");
  });

  it("2026-07 (最新月) の値が原本の目視確認値と一致する", async () => {
    const rows = await loadFixtureRows();
    const row = rows.find((r) => r.period === "2026-07");
    expect(row).toBeDefined();
    // 以下は PDF 1ページ目 (会員の暗号資産取引状況表(月次)) 2026年7月行を
    // 画像化して目視確認した値。
    expect(row!.spotTurnoverJpy).toBe(674_240); // 現物取引 金額 (百万円)
    expect(row!.marginTurnoverJpy).toBe(627_529); // 証拠金取引 金額 (取引高、百万円)
    expect(row!.depositsTotalJpy).toBe(2_872_363); // 利用者預託金残高 合計 (百万円)
    expect(row!.marginPositionTotalJpy).toBe(18_477); // 証拠金取引建玉残高 合計金額 (百万円)
    expect(row!.accountsTotalEstablished).toBe(14_280_598); // 利用者口座数 全体 設定口座
    expect(row!.accountsMarginActive).toBe(1_015_983); // 利用者口座数 うち証拠金取引 稼働口座
  });

  it("2018-09 (最古月) の値が原本の目視確認値と一致する", async () => {
    const rows = await loadFixtureRows();
    const row = rows.find((r) => r.period === "2018-09");
    expect(row).toBeDefined();
    // PDF 2ページ目 (表の末尾行) を画像化して目視確認した値。
    expect(row!.spotTurnoverJpy).toBe(813_446);
    expect(row!.accountsTotalEstablished).toBe(2_838_620);
    expect(row!.accountsMarginActive).toBe(439_694);
  });

  it("月次系列が連続している (2026-07 の次は 2026-06)", async () => {
    const rows = await loadFixtureRows();
    const idx = rows.findIndex((r) => r.period === "2026-07");
    expect(rows[idx + 1]!.period).toBe("2026-06");
  });
});

describe("parseJvceaCryptoText (様式異常時は throw する)", () => {
  it("列数が想定 (19) と異なる行があれば throw する", () => {
    // 合成データ: 意図的に列を1つ減らしている (18列)。
    const malformed =
      "2026 7 1,376,706,952,792 674,240 56,700,555,851 627,529 12,558,517,490,795 " +
      "2,641,858 230,505 2,872,363 406,181 11,048,072,156 44,220,770,769 55,268,842,925 " +
      "4,119 14,358 18,477 14,280,598 8,858,935";
    expect(() => parseJvceaCryptoText([malformed])).toThrow(/数値列数/);
  });

  it("数値として解釈できないトークン (例: ー) があれば throw する", () => {
    // 19列目 (稼働口座うち証拠金取引) だけを "ー" (JVCEA表内の欠損記号) に置換。
    const malformed =
      "2026 7 1,376,706,952,792 674,240 56,700,555,851 627,529 12,558,517,490,795 " +
      "2,641,858 230,505 2,872,363 406,181 11,048,072,156 44,220,770,769 55,268,842,925 " +
      "4,119 14,358 18,477 14,280,598 8,858,935 2,238,288 ー";
    expect(() => parseJvceaCryptoText([malformed])).toThrow(/解釈できない/);
  });

  it("月が重複していれば throw する", () => {
    const line = "2026 7 " + Array(19).fill("1").join(" ");
    expect(() => parseJvceaCryptoText([`${line}\n${line}`])).toThrow(/複数回出現/);
  });

  it("月次系列が不連続なら throw する", () => {
    const row = (y: number, m: number) => `${y} ${m} ${Array(19).fill("1").join(" ")}`;
    // 2026-07 の次が 2026-05 (2026-06 が抜けている)
    expect(() => parseJvceaCryptoText([`${row(2026, 7)}\n${row(2026, 5)}`])).toThrow(/連続していません/);
  });

  it("表の行が1件も抽出できなければ throw する", () => {
    expect(() => parseJvceaCryptoText(["見出しだけの本文で数値行が無い"])).toThrow(/1件も抽出/);
  });
});

describe("selectAggregateTablePages (実フィクスチャ、本番と同じ全8ページ入力の回帰テスト)", () => {
  // 回帰テスト: 本番の fetchJvceaCrypto() は unpdf extractText の結果 (実際に
  // 取得した全8ページぶんのテキスト、うち3ページ目以降は銘柄別内訳表で
  // 列構成が異なる) をそのまま parseJvceaCryptoText に渡していたため、
  // 3ページ目 (BTC 保有状況表、「年 月 ...」パターンにマッチしつつ列数が
  // 19 と異なる行を含む) で必ず throw していた (2026-09-27 実データで確認)。
  // フィクスチャをあらかじめ1〜2ページ目だけにトリミングしたテスト
  // (loadFixtureRows 系) だけでは、この本番専用の壊れ方を検知できない。

  it("全8ページの生テキストをそのまま渡すと (旧実装相当)、銘柄別内訳表の列数不一致で throw する", async () => {
    const pageTexts = await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf");
    expect(pageTexts).toHaveLength(8);
    expect(() => parseJvceaCryptoText(pageTexts)).toThrow(/数値列数/);
  });

  it("全8ページから合算表のページだけを絞り込むと2ページに絞られ、以後は解析可能", async () => {
    const pageTexts = await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf");
    const aggregatePages = selectAggregateTablePages(pageTexts);
    expect(aggregatePages).toHaveLength(2);
    const rows = parseJvceaCryptoText(aggregatePages);
    expect(rows).toHaveLength(95);
    const row2607 = rows.find((r) => r.period === "2026-07");
    expect(row2607).toBeDefined();
    // p1-2 版フィクスチャ (loadFixtureRows) のテストと同じ目視確認値。
    expect(row2607!.spotTurnoverJpy).toBe(674_240);
    expect(row2607!.marginPositionTotalJpy).toBe(18_477);
    const row1809 = rows.find((r) => r.period === "2018-09");
    expect(row1809).toBeDefined();
    expect(row1809!.spotTurnoverJpy).toBe(813_446);
  });

  it("見出し行が1件も見つからなければ throw する (様式変更の疑い)", () => {
    expect(() => selectAggregateTablePages(["見出しの無い本文", "別の本文"])).toThrow(
      /列見出し行が見つかりません/
    );
  });
});

describe("parseLatestJvceaCryptoPdfUrl (実フィクスチャ)", () => {
  it("統計情報ページから最新の累積 PDF の URL と収録最新月を得る", () => {
    const html = readFileSync(
      join(FIXTURES, "jvcea-statistics-information-20260927.html"),
      "utf-8"
    );
    const info = parseLatestJvceaCryptoPdfUrl(html);
    expect(info.pdfUrl).toBe(
      "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf"
    );
    expect(info.latestMonth).toBe("2026-07");
  });

  it("リンクが1件も無ければ throw する (様式変更の疑い)", () => {
    expect(() => parseLatestJvceaCryptoPdfUrl("<html>no links here</html>")).toThrow(
      /リンクが/
    );
  });
});

describe("isJvceaCryptoMonthPublished (まだ公表されていない判定)", () => {
  it("対象月が最新公表月以前なら公表済み", () => {
    expect(isJvceaCryptoMonthPublished("2026-07", "2026-07")).toBe(true);
    expect(isJvceaCryptoMonthPublished("2026-06", "2026-07")).toBe(true);
  });

  it("対象月が最新公表月より先なら未公表 (2026-08 分はまだ出ていない)", () => {
    expect(isJvceaCryptoMonthPublished("2026-08", "2026-07")).toBe(false);
  });

  it("YYYY-MM 形式でなければ throw する", () => {
    expect(() => isJvceaCryptoMonthPublished("2026/08", "2026-07")).toThrow(/YYYY-MM/);
  });
});

describe("jvceaCryptoRowToObservations / JVCEA_CRYPTO_INDICATORS", () => {
  const sampleRow: JvceaCryptoRow = {
    period: "2026-07",
    spotTurnoverQty: 1,
    spotTurnoverJpy: 674_240,
    marginTurnoverQty: 1,
    marginTurnoverJpy: 627_529,
    depositsCryptoQty: 1,
    depositsCryptoJpy: 2_641_858,
    depositsCashJpy: 230_505,
    depositsTotalJpy: 2_872_363,
    depositsMarginJpy: 406_181,
    marginPositionSellQty: 1,
    marginPositionBuyQty: 1,
    marginPositionTotalQty: 1,
    marginPositionSellJpy: 4_119,
    marginPositionBuyJpy: 14_358,
    marginPositionTotalJpy: 18_477,
    accountsTotalEstablished: 14_280_598,
    accountsTotalActive: 8_858_935,
    accountsMarginEstablished: 2_238_288,
    accountsMarginActive: 1_015_983,
  };

  it("13指標ぶんの縦長レコードを返し、数量(参考値)は含めない", () => {
    const obs = jvceaCryptoRowToObservations(sampleRow);
    expect(obs).toHaveLength(13);
    for (const o of obs) {
      expect(o.period).toBe("2026-07");
      expect(o.category).toBe(JVCEA_CRYPTO_CATEGORY);
      expect(o.isApproximate).toBe(false);
      expect(o.isEstimated).toBe(false);
      expect(Number.isFinite(o.value)).toBe(true);
    }
    const byKey = Object.fromEntries(obs.map((o) => [o.indicatorKey, o]));
    expect(byKey["jvcea_crypto_spot_turnover_jpy"]!.value).toBe(674_240);
    expect(byKey["jvcea_crypto_margin_position_total_jpy"]!.value).toBe(18_477);
    expect(byKey["jvcea_crypto_accounts_total_established"]!.unit).toBe("口座");
  });

  it("観測ログが出す indicatorKey は、指標定義 (JVCEA_CRYPTO_INDICATORS) と過不足なく一致する", () => {
    const obsKeys = new Set(jvceaCryptoRowToObservations(sampleRow).map((o) => o.indicatorKey));
    const defKeys = new Set(JVCEA_CRYPTO_INDICATORS.map((d) => d.key));
    expect(obsKeys).toEqual(defKeys);
  });

  it("指標定義は key が重複しない", () => {
    const keys = JVCEA_CRYPTO_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("指標定義は全てR3(資産クラス横断)要件を持つ", () => {
    for (const d of JVCEA_CRYPTO_INDICATORS) {
      expect(d.requirements).toContain("R3");
    }
  });

  // 回帰テスト: PDF 原本の脚注 (注1〜注3、2026-09-27 実データで本文確認済み)
  // は「他の交換業者等への取次ぎ」分の扱いがカテゴリごとに逆方向であることを
  // 明記している。
  //   注1 取引高      (現物・証拠金取引高)               → 含む   (二重計上の可能性)
  //   注2 利用者残高   (預託金残高・証拠金取引建玉残高)     → 含まない (過小に出うる)
  //   注3 利用者口座数 (設定/稼働、全体/証拠金)            → 含む   (口座単位の重複計上)
  // 単一の注記文を全指標に一律適用すると注1/注2で向きが逆になる。
  it("取引高系(2指標)の limitations は「含む・二重計上」(原本注1)", () => {
    const turnoverKeys = ["jvcea_crypto_spot_turnover_jpy", "jvcea_crypto_margin_turnover_jpy"];
    for (const key of turnoverKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含むため");
      expect(def!.limitations).toContain("二重計上");
    }
  });

  it("預託金残高・建玉残高系(7指標)の limitations は「含まない」(原本注2、取引高とは逆方向)", () => {
    const balanceKeys = [
      "jvcea_crypto_deposits_crypto_jpy",
      "jvcea_crypto_deposits_cash_jpy",
      "jvcea_crypto_deposits_total_jpy",
      "jvcea_crypto_deposits_margin_jpy",
      "jvcea_crypto_margin_position_sell_jpy",
      "jvcea_crypto_margin_position_buy_jpy",
      "jvcea_crypto_margin_position_total_jpy",
    ];
    for (const key of balanceKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含まない");
      // 取引高向けの「二重計上」文言をそのまま使い回していないこと。
      expect(def!.limitations).not.toContain("二重計上");
    }
  });

  it("利用者口座数系(4指標)の limitations は「含む」(原本注3、取引高とは別文言)", () => {
    const accountsKeys = [
      "jvcea_crypto_accounts_total_established",
      "jvcea_crypto_accounts_total_active",
      "jvcea_crypto_accounts_margin_established",
      "jvcea_crypto_accounts_margin_active",
    ];
    for (const key of accountsKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含む");
      expect(def!.limitations).not.toContain("含まない");
      // 取引高向けの「取引高の二重計上」という的外れな文言を流用していないこと。
      expect(def!.limitations).not.toContain("取引高の二重計上");
    }
  });
});

describe("jvceaCryptoArchiveInput (ルール6の入力組み立て、記録自体はしない)", () => {
  it("月次冪等キー + PDF実体で記録入力を組む", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const input = jvceaCryptoArchiveInput({
      latestMonth: "2026-07",
      rows: [],
      pdfBytes: bytes,
      pdfUrl:
        "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf",
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("jvcea-crypto-2026-07");
    expect(input.source).toBe(
      "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf"
    );
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("jvcea-crypto-2026-07.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
  });
});
