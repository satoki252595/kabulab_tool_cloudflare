/**
 * 公開表示用要約 (`yutai_benefits.short_summary`) が満たすべき契約。
 *
 * この列は**公開面に出る唯一の優待内容テキスト**で、出典サイトの掲載文
 * `description` は公開しない (app.ts の `publicSummary()` 参照)。したがって
 * 要約は「掲載文から抜き出した事実」でなければならず、掲載文の注記ブロックや
 * 説明文をそのまま持ち込んではいけない。
 *
 * 生成側 (`interpret-benefits.ts`) は上限 60 字を課しているが、
 * `lenientLength` の退路があり実測で 35 行がすり抜けていた。DB へ書くのは
 * `apply-benefit-interpretations.ts` なので、**公開面に一番近いここを最終ゲート**
 * にする (ルール2: 黙って切り詰めず、違反は明示的に失敗させる)。
 *
 * 2026-09-12 の本番実測 (8,314 行) での違反内訳:
 *   注記記号の取り込み 38 行 / 60 字超 35 行 / です・ます調 5 行 (重複あり計 ~70 行)
 */

/** 一覧カードに 1 行で出す前提の上限。`interpret-benefits.ts` と同じ値。 */
export const SUMMARY_MAX_CHARS = 60;

/**
 * 掲載文側の注記ブロックを導く記号。
 * `■贈呈時期` `◇保有する株式数に応じて…` `※ポイントは…` のように、
 * 出典サイトが説明文を始めるときに使う。要約に現れたら掲載文の取り込み。
 */
const ANNOTATION_MARKS = ["※", "■", "◆", "◇"] as const;

/** 事実の列挙ではなく説明文になっている兆候。 */
const POLITE_ENDINGS = ["です。", "ます。", "ください", "いたします"] as const;

export type SummaryViolation = {
  rule: "annotation" | "too_long" | "prose" | "empty";
  detail: string;
};

/** 1 件の要約を検査する。違反が無ければ空配列。 */
export function checkSummary(summary: string): SummaryViolation[] {
  const text = (summary ?? "").trim();
  const out: SummaryViolation[] = [];
  if (text === "") {
    out.push({ rule: "empty", detail: "要約が空" });
    return out;
  }
  const marks = ANNOTATION_MARKS.filter((m) => text.includes(m));
  if (marks.length > 0) {
    out.push({
      rule: "annotation",
      detail: `掲載文の注記記号 ${marks.join(" ")} を含む`,
    });
  }
  if (text.length > SUMMARY_MAX_CHARS) {
    out.push({
      rule: "too_long",
      detail: `${text.length} 字 (上限 ${SUMMARY_MAX_CHARS})`,
    });
  }
  const polite = POLITE_ENDINGS.filter((p) => text.includes(p));
  if (polite.length > 0) {
    out.push({
      rule: "prose",
      detail: `説明文調の表現 ${polite.join(" ")} を含む`,
    });
  }
  return out;
}

/** 要約が掲載文の逐語コピーになっていないか (事実の最小表現は除外する)。 */
export function isVerbatimCopy(summary: string, description: string): boolean {
  const s = (summary ?? "").trim();
  const d = (description ?? "").trim();
  if (s === "" || d === "") return false;
  // 事実そのもの (「1,000円相当」「5kg」「優待券2枚」等) は言い換えようが無く、
  // 一致しても掲載文の"表現"を写したことにはならない。実測では掲載文1行目と
  // 一致する 759 行の中央値が 8 字・最大 34 字で、全て事実の記述だった。
  // 長い一致だけを逐語コピーとして扱う。
  const VERBATIM_MIN_CHARS = 40;
  if (s.length < VERBATIM_MIN_CHARS) return false;
  return d.includes(s);
}

/** 違反を 1 行の可読文字列にする (ログ出力用)。 */
export function formatViolations(v: SummaryViolation[]): string {
  return v.map((x) => `${x.rule}: ${x.detail}`).join(" / ");
}
