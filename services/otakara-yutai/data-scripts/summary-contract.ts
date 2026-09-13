/**
 * 公開表示用要約 (`yutai_benefits.short_summary`) が満たすべき契約。
 *
 * この列は**公開面に出る唯一の優待内容テキスト**で、出典サイトの掲載文
 * `description` は公開しない (app.ts の `publicSummary()` 参照)。したがって
 * 要約は「掲載文から抜き出した事実」でなければならず、掲載文の注記ブロックや
 * 説明文をそのまま持ち込んではいけない。
 *
 * 要約はリポジトリの外のクラウド LLM (Cursor Automations 等) が作る
 * (`docs/llm-summary-task.md`)。LLM の出力は信用しない前提なので、DB へ書く
 * 唯一の経路 `import-summary-results.ts` が**公開面に一番近いここを最終ゲート**
 * にする (ルール2: 黙って切り詰めず、違反は明示的にはじく)。
 * 以前のローカル LLM 経路は生成側に `lenientLength` の退路があり、実測で 35 行が
 * 60 字上限をすり抜けていた。生成側の自己申告に頼らないのはそのため。
 *
 * **ここの規則を変えたら `SUMMARY_CONTRACT_VERSION` を上げ、作業仕様書
 * `services/otakara-yutai/docs/llm-summary-task.md` も同時に直すこと。**
 * 版が合わない結果は取り込み側がはじくので、古い規則で作られた要約は入らない。
 *
 * 2026-09-12 の本番実測 (8,314 行) での違反内訳:
 *   注記記号の取り込み 38 行 / 60 字超 35 行 / です・ます調 5 行 (重複あり計 ~70 行)
 */

/**
 * 要約契約の版。タスクファイルと結果ファイルの各行に載り、取り込み時に
 * 一致しない行ははじく。規則 (下の上限・記号・文体) や作業仕様書の要約規則を
 * 変えたら上げる。日付 + 連番にしているのは、外部エージェントの作業ログと
 * 突き合わせやすくするため。
 */
export const SUMMARY_CONTRACT_VERSION = "2026-09-13.1";

/** 一覧カードに 1 行で出す前提の上限。作業仕様書の上限と同じ値。 */
export const SUMMARY_MAX_CHARS = 60;

/** 取り込み前に揃える表記揺れ。 */
export function normalizeSummary(summary: string): string {
  // NFKC で全角英数字を半角に揃える (`１,０００円` → `1,000円`)。同じ意味の
  // 表現揺れの吸収で、内容は変えない (ルール2 の例外節: 入力の正規化)。
  // ローカル LLM 経路でも同じ正規化を後段で掛けていた。
  return (summary ?? "").normalize("NFKC").trim();
}

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
