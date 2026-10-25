/**
 * 公開表示用要約 (`yutai_benefits.short_summary`) が満たすべき契約。
 *
 * この列は**公開面に出る唯一の優待内容テキスト**で、出典サイトの掲載文
 * `description` は公開しない (app.ts の `publicSummary()` 参照)。したがって
 * 要約は「掲載文から抜き出した事実」でなければならず、掲載文の注記ブロックや
 * 説明文をそのまま持ち込んではいけない。
 *
 * 要約は決定的な定型処理、固定ローカルMLXモデルまたは外部エージェントが作る
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

import { createHash } from "node:crypto";
import { HEADED_MARK, splitHeadedDescription } from "./estimated-value-guard.js";
import { compileDepartmentHoldingLiteral, compileHoldingPointCarryLiteral, compilePointExchangeLiteral, compilePremiumClubCarryLiteral, compileVenueAdmissionLiteral } from "./holding-structure.js";

/**
 * 要約契約の版。タスクファイルと結果ファイルの各行に載り、取り込み時に
 * 一致しない行ははじく。規則 (下の上限・記号・文体) や作業仕様書の要約規則を
 * 変えたら上げる。日付 + 連番にしているのは、外部エージェントの作業ログと
 * 突き合わせやすくするため。
 */
export const SUMMARY_CONTRACT_VERSION = "2026-10-25.8";

/** 比較時だけ同じ月期間の表記を揃え、数値・比較条件・保存文面は変えない。 */
function normalizeMonthPeriods(text: string): string {
  return text.normalize("NFKC").replace(/[ヶカヵ]月/g, "か月");
}

const periods = (s: string): string[] => [...s.matchAll(/(?<![0-9.,])([0-9]+|半)\s*(年|か月|ヶ月|カ月|ヵ月)\s*(以上|未満|以下|超)/g)].map(m => `${m[1]}${m[2]}${m[3]}`);

/** 重要語・期間表記を検出し、要約での脱落を防ぐ。対象・必要性の確定や原文返却は行わない。 */
export function sourceSummaryConditions(description: string) {
  const source = normalizeMonthPeriods(description);
  const choice = /選[択べんぶび]|いずれか|または|又は/;
  // 株主名簿の「記載又は記録」は優待の選択肢ではない。
  const choices = source.replace(/記載\s*(?:または|又は)\s*記録/g, "");
  let periodSource = source;
  const noteStart = source.indexOf("\n■継続保有期間について");
  if (noteStart >= 0) {
    // 実対象の期間見出しと定義欄が双方明示された場合だけ、別tierの
    // 独立定義ラベルを条件に数えない。本文・例外・曖昧な説明は残す。
    const headings = [...source.slice(0, noteStart).matchAll(/^【((?:[0-9]+|半)\s*(?:年|か月)\s*(?:以上|未満|以下|超))\s*(?:継続)?保有(?:株主)?】$/gm)];
    const headingPeriods = [...new Set(headings.flatMap(m => periods(m[1])))];
    if (headingPeriods.length === 1) {
      const noteEnd = source.indexOf("\n■", noteStart + 1);
      const end = noteEnd < 0 ? source.length : noteEnd;
      const definition = /^((?:[0-9]+|半)\s*(?:年|か月)\s*(?:以上|未満|以下|超))\s*(?:継続)?保有(?:株主)?\s*(?:とは(?=[、,]?[ \t]*株主名簿(?:\(毎年[0-9]+月[0-9]+日(?:及び|および|・)[0-9]+月[0-9]+日\))?に[0-9]+株以上の保有が同一株主番号で[0-9]+回以上連続して(?:記録|記載)されたことをいいます[。]?[ \t]*$)|:(?=[ \t]*連続(?:して)?[ \t]*[0-9]+[ \t]*回以上[。]?[ \t]*$))/gm;
      let note = source.slice(noteStart, end);
      if ([...note.matchAll(definition)].some(m => periods(m[1])[0] === headingPeriods[0])) {
        note = note.replace(definition,
          (label, threshold: string) => periods(threshold)[0] === headingPeriods[0] ? label : label.slice(threshold.length));
      }
      periodSource = source.slice(0, noteStart) + note + source.slice(end);
    }
  }
  const requiredPeriods = [...new Set(periods(periodSource))];
  return {
    choice: choice.test(choices),
    holding: /保有期間|継続保有|長期保有/.test(source) || requiredPeriods.length > 0,
    holdingPeriods: requiredPeriods,
    lottery: /抽選|当選/.test(source),
    application: /応募|申(?:し)?込/.test(source),
  };
}

/** 全生成・取込経路で、選択・保有・抽選・応募条件の欠落を保留する。 */
export function missingSummaryConditions(description: string, summary: string): string[] {
  const facts = sourceSummaryConditions(description);
  const text = normalizeMonthPeriods(summary);
  const missing: string[] = [];
  if (facts.choice && !/選[択べんぶび]|いずれか|または|又は/.test(text)) missing.push("choice_condition_missing");
  const requiredPeriods = facts.holdingPeriods;
  const claimedPeriods = periods(text);
  const generalHolding = /保有期間(?:に応じ|別|により|によって)/.test(text) && !/[0-9]+[,.0-9]*\s*(?:万|千|百)?\s*(?:円|ポイント)/.test(text);
  if (facts.holding &&
      ((!/保有|継続|長期/.test(text) && claimedPeriods.length === 0) ||
       (requiredPeriods.some(p => !claimedPeriods.includes(p)) && !(requiredPeriods.length > 1 && generalHolding)))) {
    missing.push("holding_condition_missing");
  }
  if (facts.lottery && !/抽選|当選/.test(text)) missing.push("lottery_condition_missing");
  const application = /応募|申(?:し)?込/;
  if (facts.application && !application.test(text)) missing.push("application_condition_missing");
  return missing;
}

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
  const normalized = shortSummary.normalize("NFKC").trim();
  const departmentHolding = compileDepartmentHoldingLiteral(description);
  // 歴史的100株は現在tierではない。完全な全文と定型句だけを別scopeで照合する。
  if (departmentHolding !== null || normalized.includes("3年判定:")) return departmentHolding !== null && normalized === departmentHolding &&
    context.minShares.length > 0 && context.minShares.every(value => Number.isSafeInteger(value) && value >= 100) &&
    context.recordMonths.length > 0 && context.recordMonths.every(value => value === 2 || value === 8);
  const holdingPointCarry = compileHoldingPointCarryLiteral(description);
  // 600株は保有期間/繰越の定義。既知全文と完全な定型句以外を一般株数へ降格させない。
  if (holdingPointCarry !== null || normalized.includes("繰越条件")) return holdingPointCarry !== null && normalized === holdingPointCarry &&
    context.minShares.length > 0 && context.minShares.every(value => Number.isSafeInteger(value) && value >= 600) &&
    context.recordMonths.length > 0 && context.recordMonths.every(value => value === 12);
  const clubCarry = compilePremiumClubCarryLiteral(description);
  // 繰越の株数を現tierへ転用しない。既知全文＋完全な定型句だけを別scopeで照合する。
  if (clubCarry !== null || normalized.includes("繰越:")) return clubCarry !== null && normalized === clubCarry &&
    context.minShares.length > 0 && context.minShares.every(value => Number.isSafeInteger(value) && value >= 1000) &&
    context.recordMonths.length > 0 && context.recordMonths.every(value => Number.isInteger(value) && value >= 1 && value <= 12);
  const pointExchange = compilePointExchangeLiteral(description);
  if (pointExchange !== null && shortSummary.normalize("NFKC").trim() !== pointExchange.shortSummary.normalize("NFKC")) return false;
  const admission = compileVenueAdmissionLiteral(description);
  if (admission !== null && normalized !== admission.normalize("NFKC")) return false;
  // 全文資格と施設・枚数・利用制限の同値が成立した場合だけ、固有施設名の
  // 「六本」を数量に数えない。原文・公開要約自体は変更しない。
  const withoutVenue = admission === null ? normalized : normalized.replace("六本木・西麻布店", "");
  // 実製品語2つと正準の正整数N周年は、原文の同一literalだけを照合する。
  // 周年を金額・株数・年数へ転用せず、後続の額や数量も通常どおり検証する。
  const numericTerm = /(?<![0-9A-Za-z.,+\-万千百億兆])(?:3Dプリンター住宅|1デーパスポート|[1-9][0-9]*周年)/g;
  const sourceNumericTerms = new Set(description.normalize("NFKC").match(numericTerm));
  let normalizedSummary = withoutVenue.replace(numericTerm, term =>
    sourceNumericTerms.has(term) && (!term.endsWith("周年") || Number.isSafeInteger(Number(term.slice(0, -2))))
      ? term.replace(/[0-9]/g, "") : term);
  // 継続保有の定義にある株数は現tierの株数ではない。既知の完全句と明示scopeだけを束縛する。
  if (normalizedSummary.includes("継続条件")) {
    const source = splitHeadedDescription(description);
    if (source.malformed || source.heading === null) return false;
    const body = source.body.normalize("NFKC").replace(/\r\n/g, "\n");
    const sections = body.split("\n■継続保有期間について\n");
    if (sections.length !== 2) return false;
    const clause = sections[1].split("\n■")[0].trim();
    const numbers = clause.match(/[0-9]+/g);
    if (numbers === null || numbers.length !== 5 || numbers.some(value =>
      !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) return false;
    // 実原文の転載を避け、数値slot以外の定義文全体を固定する。例外・名義交換もHOLD。
    if (createHash("sha256").update(clause.replace(/[0-9]+/g, "#")).digest("hex") !==
        "85f8a4cac6c0c3a82472df66d06424c4a9f197e68baf7ca55d4627fd1eb84ffe") return false;
    const [years, firstMonth, secondMonth, records, shares] = numbers.map(Number);
    const headings = body.match(/^【.*保有.*】$/gm);
    if (headings?.length !== 1 || headings[0] !== `【${years}年以上保有】` || !sections[0].split("\n").includes(headings[0]) ||
        firstMonth > 12 || secondMonth > 12 || firstMonth === secondMonth ||
        context.minShares.length === 0 || context.minShares.some(value => !Number.isSafeInteger(value) || value < shares) ||
        context.recordMonths.length === 0 || context.recordMonths.some(value => ![firstMonth, secondMonth].includes(value))) return false;
    const literal = `継続条件:${years}年以上・${firstMonth}月末/${secondMonth}月末同一株主番号${shares}株以上${records}回連続記録`;
    const scoped = new RegExp(`(^|[(、])${literal}(?=$|[)、])`, "u");
    // scopeの不一致を一般数値照合へ降格させない。句外の株数は従来のrecipient照合へ残す。
    if (normalizedSummary.split("継続条件").length !== 2 || !scoped.test(normalizedSummary)) return false;
    normalizedSummary = normalizedSummary.replace(scoped, (_match, boundary: string) => boundary);
  }
  // 同一(の)株主番号の「一株」は数量ではない。この同義2表記だけを
  // 原文で確認して比較時に外し、実際の株数・保有期間・金額には触れない。
  const identityTerm = /同一(?:の)?株主番号/g;
  const sourceHasIdentityTerm = description.normalize("NFKC").match(identityTerm) !== null;
  if (!sourceHasIdentityTerm && normalizedSummary.match(identityTerm) !== null) return false;
  const summaryWithoutIdentityNumber = sourceHasIdentityTerm
    ? normalizedSummary.replace(identityTerm, "株主番号") : normalizedSummary;
  // 上限株数はrecipientの下限ではない。原文と同じ完全な範囲だけを
  // 下限recipientに結び付け、上限単体や別tierを根拠にしない。
  const shareRange = /(?<![0-9.,+\-万千百億兆])([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*株\s*以上\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*株\s*未満/g;
  const ranges = [...description.normalize("NFKC").matchAll(shareRange)].map((m) =>
    [Number(m[1].replaceAll(",", "")), Number(m[2].replaceAll(",", ""))]);
  let rangesGrounded = true;
  const summaryWithoutRanges = summaryWithoutIdentityNumber.replace(shareRange, (_, low: string, high: string) => {
    const lower = Number(low.replaceAll(",", ""));
    const upper = Number(high.replaceAll(",", ""));
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower <= 0 || lower >= upper ||
        context.minShares.length === 0 || !context.minShares.every((value) => value === lower) ||
        !ranges.some(([sourceLower, sourceUpper]) => sourceLower === lower && sourceUpper === upper)) {
      rangesGrounded = false;
    }
    return "";
  });
  if (!rangesGrounded) return false;
  const facts = (text: string, strict: boolean): { value: number; unit: string }[] | null => {
    // Unicode省略記号は数値前の区切りだけで扱い、小数・桁区切りの
    // 直後や数値間の省略を別の数値の根拠へ変えない。
    const normalized = normalizeMonthPeriods(text.replace(/(?<![0-9０-９.,．，〇零一二三四五六七八九十百千万億兆])…(?=[0-9０-９])/g, " "));
    // 1万5千円の末尾5千円だけ、1億円の一部などを根拠にしない。
    const pattern = /(?<![0-9.,万千百億兆])((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)\s*(万|千|百)?\s*(円|ポイント|枚|個|袋|パック|セット|冊|ケース|リットル|室|杯|台|箱|ゲーム|ホール|商品|品(?!目|種)|缶(?!目|詰)|足(?!目|袋)|親等|種類|株|年|か月|月|日|回|名|人|点|口|泊|食|本|部|件|時間|kg|Kg|g|ml|L|%)/g;
    const matches = [...normalized.matchAll(pattern)];
    const remainder = normalized.replace(pattern, "");
    if (strict && (/[0-9]/.test(remainder) ||
      /[〇零一二三四五六七八九十百千万億兆]+\s*(円|ポイント|枚|個|袋|パック|セット|冊|ケース|リットル|室|杯|台|箱|ゲーム|ホール|商品|品(?!目|種)|缶(?!目|詰)|足(?!目|袋)|親等|種類|株|年|か月|月|日|回|名|人|点|口|泊|食|本|件|時間|kg|Kg|g|ml|L|%)/.test(remainder))) return null;
    return matches.map((m) => ({ value: Number(m[1].replaceAll(",", "")) * (m[2] === "万" ? 10000 : m[2] === "千" ? 1000 : m[2] === "百" ? 100 : 1),
      unit: m[3] === "名" ? "人" : m[3] === "Kg" ? "kg" : m[3] }));
  };
  const have = facts(description, false);
  const wanted = facts(summaryWithoutRanges, true);
  if (have === null || wanted === null) return false;
  return wanted.every((wanted) => {
    if (!Number.isFinite(wanted.value)) return false;
    if (wanted.unit === "株") return context.minShares.length > 0 && context.minShares.every((value) => value === wanted.value);
    // 暦の月だけを権利月で裏づける。期間「か月」は掲載文の同じ単位を要する。
    if (wanted.unit === "月" && wanted.value === 0) return false;
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

/** 数量と重要条件を省略せず保持する上限。作業仕様書の上限と同じ値。 */
export const SUMMARY_MAX_CHARS = 120;

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
