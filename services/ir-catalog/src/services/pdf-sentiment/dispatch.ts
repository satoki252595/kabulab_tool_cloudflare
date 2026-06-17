/**
 * primaryTag → エンジン振り分け。
 *
 * 「title 判定で方向確定済」と「内容的に判定不要」は skipped。
 * 「定型テーブル系」は Engine 1 (rule_v1)、「定性判断要」は Engine 2 (dict_v1)。
 *
 * skipped 一覧 (タグ→理由):
 *   - 上方修正 / 下方修正 / 増配 / 減配・無配 / 自社株買い / 自己株式の消却
 *     → title sentiment.ts で既に方向確定
 *   - 決算短信 / 月次・速報 / 株式分割・併合 / 人事・組織 / 訂正・取消 /
 *     上場・市場区分 / M&A・資本提携 / 重要事象(調査等)
 *     → ユーザ指示「判断しなくて良い」または定型方向なし
 */
import type { PdfSentimentResult } from "./types.js";
import { skipped, unknown } from "./types.js";
import { classifyForecastRevision } from "./rules/forecast-revision.js";
import { classifyDividendRevision } from "./rules/dividend-revision.js";
import { classifyExtraordinaryPL } from "./rules/extraordinary-pl.js";
import { classifyByDictionary } from "./dict/polarity-score.js";

type Engine = "rule_v1_forecast" | "rule_v1_dividend" | "rule_v1_extra" | "dict_v1" | "skip";

const TAG_TO_ENGINE: Record<string, Engine> = {
  // Engine 1 (数値テーブル抽出)
  業績予想の修正: "rule_v1_forecast",
  "配当(決定・予想)": "rule_v1_dividend",
  特別損益: "rule_v1_extra",
  // Engine 2 (辞書ベース)
  配当政策の変更: "dict_v1",
  エクイティファイナンス: "dict_v1",
  自己株式の処分: "dict_v1",
  // 以下は skipped (title 判定済 or 判断不要)
  上方修正: "skip",
  下方修正: "skip",
  増配: "skip",
  "減配・無配": "skip",
  自社株買い: "skip",
  自己株式の消却: "skip",
  決算短信: "skip",
  "月次・速報": "skip",
  "株式分割・併合": "skip",
  "人事・組織": "skip",
  "訂正・取消": "skip",
  "上場・市場区分": "skip",
  "M&A・資本提携": "skip",
  "重要事象(調査等)": "skip",
};

/**
 * primaryTag を元に判定エンジンを選んで実行する。
 * primaryTag が null (未分類) や TAG_TO_ENGINE に無いタグは `skipped` を返す。
 */
export async function dispatchClassify(
  text: string,
  primaryTag: string | null
): Promise<PdfSentimentResult> {
  if (primaryTag === null) {
    return skipped("未分類タグ (primary_tag=null) は判定対象外");
  }
  const engine = TAG_TO_ENGINE[primaryTag];
  if (engine === undefined) {
    return skipped(`タグ「${primaryTag}」はディスパッチ表に未登録 (将来追加検討)`);
  }
  if (engine === "skip") {
    return skipped(`タグ「${primaryTag}」は判定対象外`);
  }
  if (text.trim().length === 0) {
    return unknown("PDF テキスト 0 文字 (画像化 PDF 等)");
  }
  switch (engine) {
    case "rule_v1_forecast":
      return classifyForecastRevision(text);
    case "rule_v1_dividend":
      return classifyDividendRevision(text);
    case "rule_v1_extra":
      return classifyExtraordinaryPL(text);
    case "dict_v1":
      return classifyByDictionary(text);
  }
}
