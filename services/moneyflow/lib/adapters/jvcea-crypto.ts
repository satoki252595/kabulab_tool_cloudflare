/**
 * moneyflow アダプタ: 日本暗号資産等取引業協会 (JVCEA) 会員統計「会員の暗号資産取引状況表（月次）」
 * (Phase 4 資産クラス横断・R3)。
 *
 * 取得元モジュール `../sources/jvcea-crypto.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `jvcea-crypto` の 1 本。統計情報ページに載る累積 PDF (`YYYYMM-KOUKAI-01-FINAL.pdf`、
 * 2018年9月分から毎月 1 行ずつ追記) 1 版で 1 バッチ。指標はモジュールの 13 件
 * (現物/証拠金の月間取引高、預り資産残高 4 種、証拠金取引建玉 3 種、口座数 4 種。
 * 「数量」列は通貨単位が混在するためモジュールの方針どおり指標化しない)。
 *
 * ## 冪等キー・期間
 * `jvcea-crypto-<収録最新月 YYYY-MM>-updated-<PDF 印字の更新日 YYYY-MM-DD>`
 * (モジュールの `jvceaCryptoArchiveInput()` のキーそのもの)。累積 PDF は同じ収録最新月の
 * まま訂正差し替えされうる (2026-09-27 時点の 202607 版の印字は「更新日：2026年9月3日」)
 * ため、更新日まで含めないと差し替え版を取りこぼす。更新日は PDF 本文にしか無いので、
 * `resolve()` は一覧ページに加えて PDF 本体も取得してキーを決め、`fetch()` はそのバイト列を
 * そのまま返す (取得元へは 1 回の実行で一覧ページ 1 回 + PDF 1 回のみ)。
 *
 * ## PDF の解析と「純関数」契約 (保管ファイル 2 件)
 * モジュールの PDF 解析は unpdf (pdf.js) による **非同期** のテキスト抽出が前提で、同期の
 * `toObservations()` からは呼べない。そこで `fetch()` の時点でモジュールと同じ抽出
 * (`extractText(..., { mergePages: false })`) を行い、ページごとのテキストを JSON
 * (`<キー>.pages.json`) にして PDF 原本と一緒に一次データとして保管する。JSON には原本 PDF の
 * バイト数と sha256 を入れ、`toObservations()` は保管された PDF のハッシュと突き合わせてから
 * JSON のテキストをモジュールのパーサ (`selectAggregateTablePages` / `parseJvceaCryptoText` /
 * `parseJvceaCryptoUpdatedDate`) に通す (別の PDF の抽出結果を取り違えて解析しない)。
 * PDF 原本そのものも必ず保管する (ルール6。JSON は解析用の派生物で、原本の代わりではない)。
 *
 * ## 記録する範囲 (行数)
 * 累積 PDF は全期間 (2026-07 版で 95 か月) を持つが、13 指標 × 95 か月 = 1,235 行は
 * 1 バッチの目安 600 行を超える。固定の規則として **その版の収録最新月を含む直近 12 か月**
 * (13 × 12 = 156 行) だけを観測ログへ記録する (過去分の訂正も直近 1 年分は拾える)。
 * それより前の月は保管した PDF 原本には残るが観測ログには載らない (各指標の「限界」に明記)。
 */
import { createHash } from "node:crypto";
import { extractText, getDocumentProxy } from "unpdf";
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowFrequency,
  MoneyflowRequirement,
  MoneyflowUnit,
} from "../../../../src/shared/notion-archive/index.js";
import {
  isMoneyflowFrequency,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type ResolvedBatch,
  type SpecFile,
} from "../source-spec.js";
import {
  JVCEA_CRYPTO_CATEGORY,
  JVCEA_CRYPTO_INDICATORS,
  fetchJvceaCrypto,
  jvceaCryptoArchiveInput,
  jvceaCryptoRowToObservations,
  parseJvceaCryptoText,
  parseJvceaCryptoUpdatedDate,
  selectAggregateTablePages,
  type JvceaCryptoRow,
  type MoneyflowIndicatorDef,
} from "../sources/jvcea-crypto.js";

export const JVCEA_CRYPTO_SPEC_NAME = "jvcea-crypto";

/** 観測ログへ記録する月数 (その版の収録最新月を含む直近 N か月)。固定。 */
export const JVCEA_CRYPTO_WINDOW_MONTHS = 12;

/**
 * 累積表の最古月。JVCEA は 2018年9月分から毎月 1 行ずつ追記している (統計情報ページの
 * リンク名「暗号資産取引月次データ（2018年9月〜…）」、2026-09-27 実ファイルの最終行も 2018-09)。
 * 最古行の抽出漏れは月の連続性チェックでは検知できないため、ここでも照合する。
 * (取得元モジュールの最新コミットは同値を `JVCEA_CRYPTO_SERIES_START` として export し
 * `fetchJvceaCrypto()` 内で照合しているが、`toObservations()` は保管ファイルからの
 * 再解析でそこを通らないため、アダプタ側でも照合する。)
 */
export const JVCEA_CRYPTO_SERIES_START = "2018-09";

/**
 * 更新停止の検知: 収録最新月が「実行月 (JST) − N か月」より前なら throw する。
 * 公表は「翌月」とだけ示され具体日は明記が無い (実測: 2026年7月分は uploads/2026/08 に置かれ、
 * 印字の更新日は 2026-09-03)。通常は実行月の 1〜2 か月前が最新になるため、3 か月前までは
 * 許し、それより古いまま (例: 9 月の実行で 5 月分まで) なら掲載停止・一覧ページの様式変更を
 * 疑って失敗させる (古い版を「最新」として黙って記録し続けない — ルール2)。
 */
export const JVCEA_CRYPTO_MAX_LAG_MONTHS = 3;

const OBS_CATEGORY = "暗号資産";
const OBS_CATEGORY_KIND: MoneyflowCategoryKind = "資産クラス";
const PAGES_FORMAT = "jvcea-crypto-pages/v1";
const PAGES_EXTRACTOR = "unpdf extractText(mergePages:false)";
const MILLION = 1_000_000;

const tag = `[${JVCEA_CRYPTO_SPEC_NAME}]`;

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

/** 期間の取り方: 月間の合計 (取引高) か、月末時点の残高・口座数か。 */
type PeriodShape = "monthTotal" | "monthEnd";

interface IndicatorMapping {
  flowType: MoneyflowFlowType;
  shape: PeriodShape;
  /** モジュールの観測行の単位 (これ以外なら throw) */
  moduleUnit: "百万円" | "口座";
  unit: MoneyflowUnit;
}

/** モジュールの flowType 語彙 → 観測ログの「何を測るか」。未知の語彙は throw。 */
function mapFlowType(def: MoneyflowIndicatorDef): MoneyflowFlowType {
  switch (def.flowType) {
    case "gross_turnover":
      return "売買代金";
    case "holdings_stock":
      return "残高";
    case "positions":
      return "建玉";
    case "net_flow":
    case "fund_flow":
    case "estimated":
    case "price_only":
      throw new Error(`${tag} 指標 ${def.key}: このアダプタが想定していない分類 ${def.flowType} です`);
  }
}

function mapShape(flowType: MoneyflowFlowType, key: string): PeriodShape {
  if (flowType === "売買代金") return "monthTotal";
  if (flowType === "残高" || flowType === "建玉") return "monthEnd";
  throw new Error(`${tag} 指標 ${key}: 期間の取り方を決められない分類 ${flowType} です`);
}

function mapUnit(def: MoneyflowIndicatorDef): Pick<IndicatorMapping, "moduleUnit" | "unit"> {
  if (def.unit === "百万円") return { moduleUnit: "百万円", unit: "円" };
  if (def.unit === "口座") return { moduleUnit: "口座", unit: "口座" };
  throw new Error(`${tag} 指標 ${def.key}: 想定していない単位 ${def.unit} です`);
}

function singleRequirement(def: MoneyflowIndicatorDef): MoneyflowRequirement {
  if (def.requirements.length !== 1) {
    throw new Error(`${tag} 指標 ${def.key}: 要件が 1 つではありません (${def.requirements.join(",")})`);
  }
  const r = def.requirements[0] as string;
  if (!isMoneyflowRequirement(r)) throw new Error(`${tag} 指標 ${def.key}: 未知の要件 ${r}`);
  return r;
}

function frequencyOf(def: MoneyflowIndicatorDef): MoneyflowFrequency {
  if (!isMoneyflowFrequency(def.frequency) || def.frequency !== "月次") {
    throw new Error(`${tag} 指標 ${def.key}: 月次以外の頻度 ${def.frequency} はこのアダプタで扱いません`);
  }
  return def.frequency;
}

/**
 * 各指標の説明の末尾に足す、単位・期間・「純流入額ではない」の明記。
 *
 * 「何の目安か」は分類ごとに違うので書き分ける。どれも暗号資産への純流入額
 * (入ったお金 − 出たお金) の代わり (代理指標) にはならない: 取引高は売りと買いの
 * 合計 (取引の活発さ)、残高は価格の上下でも増減する時点の値、建玉は未決済の持ち高、
 * 口座数はお金の額ですらない (Phase 1 の indicators.ts と同じく「目安であって純流入ではない」
 * と正確に書く。ルール7)。
 */
function descriptionSuffix(m: IndicatorMapping): string {
  const period =
    m.shape === "monthTotal"
      ? "1か月間に行われた取引の合計 (フロー。期間開始・終了はその月の初日と末日)。"
      : "月末時点の残高・数 (ストック。期間開始・終了はどちらもその月の末日)。";
  const unit =
    m.unit === "円"
      ? "値は0以上 (マイナスにならない)。単位は円 (原本の百万円を換算)。"
      : "値は0以上。単位は口座 (お金の額ではなく口座の数)。";
  let meaning: string;
  if (m.flowType === "売買代金") {
    meaning =
      "売った額と買った額を足した総額 (グロス) なので、取引の活発さ (注目度) の目安であり、" +
      "暗号資産へ正味いくらお金が入ったか、つまり純流入額 (入ったお金 − 出たお金) ではない。";
  } else if (m.flowType === "建玉") {
    meaning =
      "まだ決済されていない持ち高の大きさで、その月にお金が出入りした額ではなく、" +
      "純流入額 (入ったお金 − 出たお金) を表すものでもない。";
  } else if (m.unit === "口座") {
    meaning =
      "口座の数であってお金の額ではなく、純流入額 (入ったお金 − 出たお金) を表すものではない" +
      " (口座が増えてもお金が入ったとは限らない)。";
  } else if (m.flowType === "残高" && m.unit === "円") {
    meaning =
      "ある時点の残高で、その月の出入りの額ではない。暗号資産の値段が上下するだけでも増減するため、" +
      "前月との差をそのまま純流入額 (入ったお金 − 出たお金) とみなさないこと。";
  } else {
    throw new Error(`${tag} 説明文を決められない分類と単位の組 (${m.flowType} / ${m.unit}) です`);
  }
  return ` ${period}${unit}${meaning}前期比は記録しない (null)。`;
}

const WINDOW_LIMITATION =
  ` 観測ログには、その版の収録最新月を含む直近${JVCEA_CRYPTO_WINDOW_MONTHS}か月分だけを記録する` +
  " (原本の累積PDFは2018年9月分からの全期間を収録しており、それ以前の月も一次データとして保管した" +
  "PDFには残る)。公表は翌月以降で具体的な公表日の明記は無く (実測: 2026年7月分の印字更新日は" +
  "2026年9月3日)、同じ月のまま訂正差し替えされることがある (版は PDF 印字の更新日で区別する)。" +
  "原本の「数量」列 (各暗号資産の1通貨単位の単純合算) は通貨の違うコインを足した値で意味を" +
  "持たないため記録しない。PDFの表からテキスト抽出して読むため、様式変更時は取込が失敗する。";

function toIndicatorDef(def: MoneyflowIndicatorDef, m: IndicatorMapping): IndicatorDefInput {
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: singleRequirement(def),
    flowType: m.flowType,
    description: `${def.plainDescription} ${def.measures}${descriptionSuffix(m)}`,
    sourceUrl: def.sourceUrl,
    // モジュールの利用条件: JVCEA サイト規約に商用利用可否の明記なし (2026-09-27 調査時点で不明)。
    // personal-only 等に丸めず「要確認」のまま記録する (README の規約)。
    license: "要確認",
    frequency: frequencyOf(def),
    limitations: `${def.limitations}${WINDOW_LIMITATION} 利用条件: ${def.usageTerms}`,
  };
}

function buildMappings(): Map<string, IndicatorMapping> {
  const out = new Map<string, IndicatorMapping>();
  for (const def of JVCEA_CRYPTO_INDICATORS) {
    if (out.has(def.key)) throw new Error(`${tag} 指標キー ${def.key} が重複しています`);
    const flowType = mapFlowType(def);
    out.set(def.key, { flowType, shape: mapShape(flowType, def.key), ...mapUnit(def) });
  }
  return out;
}

const MAPPINGS = buildMappings();

function mappingOf(key: string): IndicatorMapping {
  const m = MAPPINGS.get(key);
  if (!m) throw new Error(`${tag} 指標定義に無い指標キー ${key} の観測行です`);
  return m;
}

export const JVCEA_CRYPTO_SPEC_INDICATORS: readonly IndicatorDefInput[] = JVCEA_CRYPTO_INDICATORS.map((def) =>
  toIndicatorDef(def, mappingOf(def.key))
);

// ---------------------------------------------------------------------------
// キー・期間 (純関数)
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;
const KEY_RE = /^jvcea-crypto-(\d{4}-\d{2})-updated-(\d{4}-\d{2}-\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`${tag} shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 冪等キーを分解する。形式が違えば throw。 */
export function parseJvceaCryptoBatchKey(key: string): { latestMonth: string; updatedDate: string } {
  const m = KEY_RE.exec(key);
  if (!m) {
    throw new Error(`${tag} 冪等キーの形式が違います (jvcea-crypto-YYYY-MM-updated-YYYY-MM-DD): ${key}`);
  }
  const latestMonth = m[1] as string;
  monthRange(latestMonth); // 月が 1〜12 でなければ throw
  return { latestMonth, updatedDate: m[2] as string };
}

/** 版 (キー) に対応する保管ファイル名。 */
export function jvceaCryptoPdfFilename(key: string): string {
  parseJvceaCryptoBatchKey(key);
  return `${key}.pdf`;
}
export function jvceaCryptoPagesFilename(key: string): string {
  parseJvceaCryptoBatchKey(key);
  return `${key}.pages.json`;
}

/** 実行時刻の JST の年月 ("YYYY-MM")。 */
function jstMonth(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`${tag} 不正な実行時刻です: ${String(now)}`);
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/**
 * 収録最新月が実行時刻に対して妥当か確かめる (未来の月・更新停止の疑いは throw)。
 */
export function assertJvceaCryptoFresh(latestMonth: string, now: Date): void {
  const current = jstMonth(now);
  if (latestMonth >= current) {
    throw new Error(`${tag} 収録最新月 ${latestMonth} が実行月 ${current} (JST) 以降です (日付の取り違えの疑い)`);
  }
  const oldestAllowed = shiftMonth(current, -JVCEA_CRYPTO_MAX_LAG_MONTHS);
  if (latestMonth < oldestAllowed) {
    throw new Error(
      `${tag} 収録最新月 ${latestMonth} が古すぎます (実行月 ${current} の ${JVCEA_CRYPTO_MAX_LAG_MONTHS} か月前 ` +
        `${oldestAllowed} より前)。掲載停止・一覧ページの様式変更の可能性があります`
    );
  }
}

// ---------------------------------------------------------------------------
// ページテキスト JSON (解析用の派生ファイル)
// ---------------------------------------------------------------------------

interface JvceaCryptoPagesFile {
  format: typeof PAGES_FORMAT;
  extractor: typeof PAGES_EXTRACTOR;
  pdfFilename: string;
  pdfBytes: number;
  pdfSha256: string;
  pages: string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** PDF のページごとのテキストを抽出する (モジュールの `fetchJvceaCrypto()` と同じ抽出方法)。 */
export async function extractJvceaCryptoPageTexts(pdfBytes: Uint8Array): Promise<string[]> {
  // getDocumentProxy は渡した配列の ArrayBuffer を detach するため、コピーを渡す
  // (原本は一次データとして保管するので空にしない)。
  const pdf = await getDocumentProxy(pdfBytes.slice());
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

/** ページテキスト JSON を組み立てる。 */
export function buildJvceaCryptoPagesFile(pdfFilename: string, pdfBytes: Uint8Array, pages: string[]): Uint8Array {
  if (pdfBytes.byteLength === 0) throw new Error(`${tag} PDF 実体が空です (${pdfFilename})`);
  const body: JvceaCryptoPagesFile = {
    format: PAGES_FORMAT,
    extractor: PAGES_EXTRACTOR,
    pdfFilename,
    pdfBytes: pdfBytes.byteLength,
    pdfSha256: sha256Hex(pdfBytes),
    pages,
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

function parsePagesFile(bytes: Uint8Array, where: string): JvceaCryptoPagesFile {
  const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (typeof raw !== "object" || raw === null) throw new Error(`${where}: JSON オブジェクトではありません`);
  const o = raw as Record<string, unknown>;
  if (o.format !== PAGES_FORMAT) throw new Error(`${where}: 未知の format ${String(o.format)}`);
  if (o.extractor !== PAGES_EXTRACTOR) throw new Error(`${where}: 未知の extractor ${String(o.extractor)}`);
  if (typeof o.pdfFilename !== "string") throw new Error(`${where}: pdfFilename がありません`);
  if (typeof o.pdfBytes !== "number" || !Number.isSafeInteger(o.pdfBytes) || o.pdfBytes <= 0) {
    throw new Error(`${where}: pdfBytes が正の整数ではありません`);
  }
  if (typeof o.pdfSha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.pdfSha256)) {
    throw new Error(`${where}: pdfSha256 が sha256 の16進ではありません`);
  }
  if (!Array.isArray(o.pages) || o.pages.length === 0 || !o.pages.every((p) => typeof p === "string")) {
    throw new Error(`${where}: pages が文字列の配列 (1 件以上) ではありません`);
  }
  return {
    format: PAGES_FORMAT,
    extractor: PAGES_EXTRACTOR,
    pdfFilename: o.pdfFilename,
    pdfBytes: o.pdfBytes,
    pdfSha256: o.pdfSha256,
    pages: o.pages as string[],
  };
}

// ---------------------------------------------------------------------------
// 観測行 (純関数)
// ---------------------------------------------------------------------------

function toCanonical(value: number, m: IndicatorMapping, where: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${where}: 値が 0 以上の整数ではありません (${value})`);
  }
  const v = m.moduleUnit === "百万円" ? value * MILLION : value;
  if (!Number.isSafeInteger(v)) throw new Error(`${where}: 円換算後の値が安全な整数の範囲を超えます (${v})`);
  return v;
}

/**
 * 解析済みの行 (モジュールの `JvceaCryptoRow`) から観測行を作る。
 * `latestMonth` を含む直近 JVCEA_CRYPTO_WINDOW_MONTHS か月 (古い順) × 指標 (モジュールの順)。
 * 最後の行は最新月の最後の指標 (取込完了の印)。
 *
 * @throws 窓の月が欠けている・最新月より新しい行がある・モジュールの観測行が想定と違う場合
 */
export function jvceaCryptoRowsToDrafts(rows: readonly JvceaCryptoRow[], latestMonth: string): ObservationDraft[] {
  const byPeriod = new Map<string, JvceaCryptoRow>();
  for (const r of rows) {
    if (byPeriod.has(r.period)) throw new Error(`${tag} 同じ月 ${r.period} の行が複数あります`);
    if (r.period > latestMonth) throw new Error(`${tag} 収録最新月 ${latestMonth} より新しい行 ${r.period} があります`);
    byPeriod.set(r.period, r);
  }
  const out: ObservationDraft[] = [];
  for (let i = JVCEA_CRYPTO_WINDOW_MONTHS - 1; i >= 0; i -= 1) {
    const period = shiftMonth(latestMonth, -i);
    const row = byPeriod.get(period);
    if (!row) throw new Error(`${tag} 記録対象の月 ${period} の行がありません (抽出漏れ・様式変更の可能性)`);
    const { start, end } = monthRange(period);
    const moduleObs = jvceaCryptoRowToObservations(row);
    const emitted = new Set<string>();
    for (const o of moduleObs) {
      const where = `${tag} ${period} ${o.indicatorKey}`;
      const m = mappingOf(o.indicatorKey);
      if (o.period !== period) throw new Error(`${where}: モジュールの観測行の期間が ${o.period} です`);
      if (o.category !== JVCEA_CRYPTO_CATEGORY) throw new Error(`${where}: 未知の区分 ${o.category}`);
      if (o.unit !== m.moduleUnit) throw new Error(`${where}: 単位が ${o.unit} です (${m.moduleUnit} を想定)`);
      if (o.isEstimated) throw new Error(`${where}: 推定値 (isEstimated) はこのアダプタで扱いません`);
      if (o.isApproximate) throw new Error(`${where}: モジュールが近似値 (isApproximate) としています (想定外)`);
      if (emitted.has(o.indicatorKey)) throw new Error(`${where}: 同じ指標の観測行が重複しています`);
      emitted.add(o.indicatorKey);
      out.push({
        period,
        periodStart: m.shape === "monthTotal" ? start : end,
        periodEnd: end,
        indicatorKey: o.indicatorKey,
        category: OBS_CATEGORY,
        categoryKind: OBS_CATEGORY_KIND,
        value: toCanonical(o.value, m, where),
        unit: m.unit,
        changeFromPrev: null,
        // いずれも「流れ」そのものではない (グロスの取引高・残高・建玉・口座数) ため、
        // 規約どおり近似フラグを立てる。値自体は JVCEA の公表値 (実測)。
        approximate: true,
        measureKind: "実測",
      });
    }
    if (emitted.size !== MAPPINGS.size) {
      const missing = [...MAPPINGS.keys()].filter((k) => !emitted.has(k));
      throw new Error(`${tag} ${period}: 観測行が欠けている指標があります: ${missing.join(", ")}`);
    }
  }
  return out;
}

/** key とファイル (PDF 原本 + ページテキスト JSON) から観測行を作る純関数。 */
export function jvceaCryptoToObservations(input: { key: string; files: readonly SpecFile[] }): ObservationDraft[] {
  const { key, files } = input;
  const { latestMonth, updatedDate } = parseJvceaCryptoBatchKey(key);
  const pdfName = jvceaCryptoPdfFilename(key);
  const pagesName = jvceaCryptoPagesFilename(key);
  const pdf = requireSpecFile(files, (n) => n === pdfName, `${tag} PDF 原本 ${pdfName}`);
  const pagesFile = requireSpecFile(files, (n) => n === pagesName, `${tag} ページテキスト ${pagesName}`);
  const pages = parsePagesFile(pagesFile.bytes, `${tag} ${pagesName}`);
  if (pages.pdfFilename !== pdfName) {
    throw new Error(`${tag} ${pagesName} の対象 PDF が ${pages.pdfFilename} です (${pdfName} を想定)`);
  }
  if (pdf.bytes.byteLength !== pages.pdfBytes || sha256Hex(pdf.bytes) !== pages.pdfSha256) {
    throw new Error(`${tag} ${pagesName} は保管された PDF 原本 ${pdfName} の抽出結果ではありません (サイズ/sha256 不一致)`);
  }
  const aggregatePages = selectAggregateTablePages(pages.pages);
  const rows = parseJvceaCryptoText(aggregatePages);
  const printed = parseJvceaCryptoUpdatedDate(aggregatePages);
  if (printed !== updatedDate) {
    throw new Error(`${tag} PDF 印字の更新日 ${printed} がキーの更新日 ${updatedDate} と一致しません`);
  }
  const periods = rows.map((r) => r.period).sort();
  const newest = periods[periods.length - 1] as string;
  const oldest = periods[0] as string;
  if (newest !== latestMonth) {
    throw new Error(`${tag} PDF 本文の最新月 ${newest} がキーの収録最新月 ${latestMonth} と一致しません`);
  }
  if (oldest !== JVCEA_CRYPTO_SERIES_START) {
    throw new Error(
      `${tag} PDF 本文の最古月 ${oldest} が累積表の起点 ${JVCEA_CRYPTO_SERIES_START} と一致しません (先頭行の抽出漏れ・様式変更の可能性)`
    );
  }
  return jvceaCryptoRowsToDrafts(rows, latestMonth);
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

async function resolveJvceaCrypto(now: Date): Promise<ResolvedBatch> {
  // 一覧ページで最新 PDF の URL を解決し PDF を取得・解析 (ファイル名と本文の最新月の一致を確認済み)。
  const data = await fetchJvceaCrypto();
  assertJvceaCryptoFresh(data.latestMonth, now);
  const archive = jvceaCryptoArchiveInput(data);
  const key = archive.key;
  const parsedKey = parseJvceaCryptoBatchKey(key);
  if (parsedKey.latestMonth !== data.latestMonth || parsedKey.updatedDate !== data.updatedDate) {
    throw new Error(`${tag} モジュールのキー ${key} が取得結果 (${data.latestMonth} / ${data.updatedDate}) と一致しません`);
  }
  const pdfFile = archive.files.find((f) => f.filename === jvceaCryptoPdfFilename(key));
  if (archive.files.length !== 1 || !pdfFile) {
    throw new Error(
      `${tag} モジュールの保管ファイルが想定 (${jvceaCryptoPdfFilename(key)} 1 件) と違います: ` +
        archive.files.map((f) => f.filename).join(", ")
    );
  }
  const pages = await extractJvceaCryptoPageTexts(pdfFile.bytes);
  const pagesBytes = buildJvceaCryptoPagesFile(pdfFile.filename, pdfFile.bytes, pages);
  const batch: FetchedBatch = {
    key,
    source: archive.source,
    metadata: {
      ...archive.metadata,
      pdfUrl: data.pdfUrl,
      pagesFile: jvceaCryptoPagesFilename(key),
      pagesExtractor: PAGES_EXTRACTOR,
      windowMonths: JVCEA_CRYPTO_WINDOW_MONTHS,
      windowStart: shiftMonth(data.latestMonth, -(JVCEA_CRYPTO_WINDOW_MONTHS - 1)),
      resolvedAt: now.toISOString(),
    },
    files: [
      { bytes: pdfFile.bytes, filename: pdfFile.filename, contentType: pdfFile.contentType },
      { bytes: pagesBytes, filename: jvceaCryptoPagesFilename(key), contentType: "application/json" },
    ],
  };
  return {
    key,
    fetch: () => Promise.resolve(batch),
  };
}

export const jvceaCryptoSpec: MoneyflowSourceSpec = {
  name: JVCEA_CRYPTO_SPEC_NAME,
  indicators: JVCEA_CRYPTO_SPEC_INDICATORS,
  resolve: resolveJvceaCrypto,
  toObservations: jvceaCryptoToObservations,
};

export const JVCEA_CRYPTO_SPECS: readonly MoneyflowSourceSpec[] = [jvceaCryptoSpec];
