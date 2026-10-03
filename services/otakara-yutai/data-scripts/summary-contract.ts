/**
 * 公開表示用要約 (`yutai_benefits.short_summary`) が満たすべき契約。
 *
 * この列は**公開面に出る唯一の優待内容テキスト**で、出典サイトの掲載文
 * `description` は公開しない (app.ts の `publicSummary()` 参照)。したがって
 * 要約は「掲載文から抜き出した事実」でなければならず、掲載文の注記ブロックや
 * 説明文をそのまま持ち込んではいけない。
 *
 * 要約は固定ローカルMLXモデルまたは外部エージェントが作る
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

import { HEADED_MARK } from "./estimated-value-guard.js";

/**
 * 要約契約の版。タスクファイルと結果ファイルの各行に載り、取り込み時に
 * 一致しない行ははじく。規則 (下の上限・記号・文体) や作業仕様書の要約規則を
 * 変えたら上げる。日付 + 連番にしているのは、外部エージェントの作業ログと
 * 突き合わせやすくするため。
 */
export const SUMMARY_CONTRACT_VERSION = "2026-10-04.2";

/**
 * 要約の % 表現が掲載文に裏づけられているか。
 *
 * 別群の割引要約が貼り付いた行 (2026-09-28 監査の 8508・7075: 抽選や定額の
 * 掲載文に「○○の20%割引」の要約) は、% が掲載文のどこにも無い。要約の %
 * (`%` `％`) は掲載文の % で裏づけられていなければならず、そうでない結果は
 * 取り込まない。raw の人数 (20 名) で要約の率 (20%) を根拠づけられないのと
 * 同じく、単位の意味が違うものは根拠にならない。さらに数値も一致すること:
 * 掲載文の「10%」で要約の「20%」は根拠づけられない (単位つき数値の一致)。
 * 2026-09-28 時点の % 要約 621 行で検証し、数値一致 615 行・不一致 0 行・
 * 掲載文に % なし 6 行 (既知の 8508・7075 群で修復計画に収録済み)。
 * 割表記 (2割→20%) の読み替えはしない — 実在 0 行のため。
 */
export function isSummaryPercentGrounded(description: string, shortSummary: string): boolean {
  const percents = (s: string): number[] =>
    [...s.normalize("NFKC").matchAll(/([0-9]+(?:\.[0-9]+)?)\s*%/g)].map((m) =>
      Number(m[1])
    );
  const wanted = percents(shortSummary);
  if (wanted.length === 0) return true;
  const have = percents(description);
  return wanted.every((w) => have.some((h) => h === w));
}

/** 要約の額・数量・条件を単位付きで照合する。桁表現だけ正規化し、計算はしない。 */
export function isSummaryNumbersGrounded(
  description: string,
  shortSummary: string,
  context: { minShares: readonly number[]; recordMonths: readonly number[] },
): boolean {
  const facts = (text: string, strict: boolean): { value: number; unit: string }[] | null => {
    const normalized = text.normalize("NFKC");
    // 1万5千円の末尾5千円だけ、1億円の一部などを根拠にしない。
    const pattern = /(?<![0-9.,万千百億兆])((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)\s*(万|千|百)?\s*(円|ポイント|枚|個|株|年|か月|月|日|回|名|人|点|口|泊|食|本|件|時間|kg|g|ml|L|%)/g;
    const matches = [...normalized.matchAll(pattern)];
    const remainder = normalized.replace(pattern, "");
    if (strict && (/[0-9]/.test(remainder) ||
      /[〇零一二三四五六七八九十百千万億兆]+\s*(円|ポイント|枚|個|株|年|か月|月|日|回|名|人|点|口|泊|食|本|件|時間|kg|g|ml|L|%)/.test(remainder))) return null;
    return matches.map((m) => ({ value: Number(m[1].replaceAll(",", "")) * (m[2] === "万" ? 10000 : m[2] === "千" ? 1000 : m[2] === "百" ? 100 : 1),
      unit: m[3] === "名" ? "人" : m[3] }));
  };
  const have = facts(description, false);
  const wanted = facts(shortSummary, true);
  if (have === null || wanted === null) return false;
  return wanted.every((wanted) => {
    if (!Number.isFinite(wanted.value)) return false;
    if (wanted.unit === "株") return context.minShares.length > 0 && context.minShares.every((value) => value === wanted.value);
    // 暦の月だけを権利月で裏づける。期間「か月」は掲載文の同じ単位を要する。
    if (wanted.unit === "月" && context.recordMonths.includes(wanted.value)) return true;
    return have.some((source) => source.value === wanted.value && source.unit === wanted.unit);
  });
}

/**
 * `contractVersion` の形式 (日付 + 連番)。結果ファイル側のスキーマ検証に使う —
 * ここを外すと、結果行のフィールドを取り違えた入力 (掲載文が `contractVersion` に
 * 入る等) がスキーマを通ってしまい、契約違反の dry-run 出力に本文が乗る。
 */
export const CONTRACT_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}\.\d+$/;

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
  rule: "annotation" | "too_long" | "prose" | "empty" | "internal";
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
  // タスク掲載文の先頭にある内部 headed marker を写した要約は、公開面に
  // 内部 encoding が漏れるので落とす (読みやすい条件文言自体は落とさない)。
  // 取り込み側は NFKC 済み (：→:) で来るため両形を見る。書き出し側の
  // checkSummary (素文) と取り込み側 (正規化済み) のどちらからも漏らさない。
  if (text.includes(HEADED_MARK) || text.normalize("NFKC").includes(HEADED_MARK.normalize("NFKC"))) {
    out.push({ rule: "internal", detail: "内部 headed marker を含む" });
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
