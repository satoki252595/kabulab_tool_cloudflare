/**
 * 開示タグの株主視点センチメント (positive / negative / neutral)。
 *
 * **「方向が表題から確信できた時だけ」** ポジ/ネガを付与する (ルール1)。
 * classify.ts と同じ精神で、配当政策の変更 / 業績予想の修正 / 訂正・取消 など
 * 表題に方向が明示されないタグは neutral に留め、UI で「中立」表示にする。
 * 株主視点で意味の解釈が分かれるタグ (M&A・特別損益・人事 等) も neutral。
 *
 * - Positive (4): 上方修正 / 増配 / 自社株買い / 自己株式の消却
 * - Negative (2): 下方修正 / 減配・無配
 * - その他全て: neutral
 *
 * このマッピングは「投資判断を補助する直感的な色分け」目的であり、
 * 個別事案の最終判断は資料 PDF で確認する前提。新タグを足すときに
 * 「それっぽい方向に丸める」のは禁止。`sentiment.test.ts` を先に固定すること。
 */

export type Sentiment = "positive" | "negative" | "neutral";

const POSITIVE_TAGS: ReadonlySet<string> = new Set([
  "上方修正",
  "増配",
  "自社株買い",
  "自己株式の消却",
]);

const NEGATIVE_TAGS: ReadonlySet<string> = new Set([
  "下方修正",
  "減配・無配",
]);

/** 1 タグのセンチメント。未知タグや方向不明タグは neutral (捏造しない) */
export function tagSentiment(tag: string): Sentiment {
  if (POSITIVE_TAGS.has(tag)) return "positive";
  if (NEGATIVE_TAGS.has(tag)) return "negative";
  return "neutral";
}

/**
 * 開示行 (tags 配列) に含まれる全ポジ/ネガを Set で返す。
 * ポジとネガが両方含まれるケースは理論上稀だが、その場合は両方返して
 * 呼び出し側に判断を委ねる (片側に丸めない — ルール2)。
 * tags が空 (未分類) の場合は空 Set。
 */
export function rowSentiments(tags: readonly string[]): Set<Sentiment> {
  const out = new Set<Sentiment>();
  for (const t of tags) {
    const s = tagSentiment(t);
    if (s !== "neutral") out.add(s);
  }
  return out;
}

/** ポジ/ネガ判定対象のタグ一覧 (UI のツールチップで「対象タグはこれ」と説明するため) */
export const POSITIVE_TAG_LIST: readonly string[] = [...POSITIVE_TAGS];
export const NEGATIVE_TAG_LIST: readonly string[] = [...NEGATIVE_TAGS];
