/**
 * moneyflow アダプタ: 国際収支統計 地域別 (直接投資・証券投資、国・地域別、四半期)。
 *
 * 取得元モジュール `../sources/bop-regional.ts` (取得・解析・独自の指標定義) を
 * `MoneyflowSourceSpec` (`../source-spec.ts`) に揃える。規約は `./README.md`。
 *
 * ## spec
 * `bop-regional` の 1 本 (指標 10 件)。日本銀行「時系列統計データ検索サイト」一括
 * ダウンロードの「地域別国際収支（四半期）」ZIP (regbp_q_jp.zip) と、その ZIP へのリンクと
 * 最終更新日付が載った一括ダウンロードページ (dload.html) の 2 ファイルで 1 バッチ。
 *
 * ## 1 バッチの中身 (行数の上限)
 * ZIP の CSV には全 47 区分 (国・地域・地域計・グループ) × 全四半期 (6版基準の開始以降) が
 * 入っており、全部を観測ログにすると 1 バッチ約 600 行の目安を大きく超える。そのため
 * **CSV に載っている最新の四半期 1 期分だけ** を、全 47 区分 × 10 指標について観測行に
 * する (固定の規則。最大 470 行。取得元で「NA」・空欄の組み合わせは行を作らない)。
 * 区分を絞らず全部入れるのは、国・地域を選ぶ主観を入れないため。代わりに過去の四半期は
 * 取り込まない (履歴は取込を始めた四半期から 1 期ずつ増える。指標定義の「限界」に明記)。
 *
 * ## 冪等キー
 * `bop-regional-<最新の四半期 YYYY-Qn>-updated-<一括ダウンロードページの最終更新日付 YYYY-MM-DD>`。
 * 同じ最新四半期のまま訂正されうる (日本銀行サイトの留意点「誤計数の判明等により…
 * 遡って訂正される可能性」) ため、ページに載る ZIP の最終更新日付を版として含める。
 * キーの要素はどちらも保管するファイル (CSV のヘッダ・ページ HTML) から決まるので、
 * `toObservations()` はファイルからキーを計算し直して一致を確かめる。
 *
 * ## resolve() が本体を取る理由
 * 「最新の四半期」は ZIP の中の CSV ヘッダにしか無く、ページには最終更新日付しか無い。
 * そのため resolve() でページ (1 リクエスト) と ZIP (1 リクエスト) を取ってキーを決め、
 * fetch() はそのバイト列をそのまま返す (二重に取りに行かない)。
 *
 * ## モジュールを直接呼ばずにアダプタで GET する理由 (ルール6)
 * モジュールの `resolveBopRegionalZipUrl()` / `fetchBopRegionalData()` はページの
 * バイト列も最終更新日付も返さず、ページ URL・User-Agent も export していない。
 * ページを一次データとして保管し、版 (最終更新日付) をキーに入れるため、アダプタで
 * モジュールと同じ URL・同じ User-Agent の GET を行い、解析はモジュールの純関数
 * (`extractBopRegionalZipHref` / `decodeBopRegionalZip` / `parseBopRegionalCsvText` /
 * `extractBopRegionalObservations`) に任せる。
 */
import type {
  IndicatorDefInput,
  MoneyflowCategoryKind,
  MoneyflowFlowType,
  MoneyflowRequirement,
  PrimaryFile,
} from "../../../../src/shared/notion-archive/index.js";
import {
  quarterRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type ResolvedBatch,
  type SpecFile,
} from "../source-spec.js";
import {
  BOP_REGIONAL_INDICATORS,
  BOP_REGIONS,
  decodeBopRegionalZip,
  expectedBopRegionalPublicationMonth,
  extractBopRegionalObservations,
  extractBopRegionalZipHref,
  latestObservedPeriod,
  parseBopRegionalCsvText,
  type BopRegionalFlowType,
  type BopRegionalIndicatorDef,
  type BopRegionalObservation,
  type BopRegionalPeriod,
  type BopRegionKind,
} from "../sources/bop-regional.js";

export const BOP_REGIONAL_SPEC_NAME = "bop-regional";

/**
 * 日本銀行「時系列統計データ検索サイト」一括ダウンロードページ。モジュールの
 * `DLOAD_PAGE_URL` (非 export) と同じ値で、モジュールの各指標定義の `sourceUrl` とも同じ
 * (テストで一致を確かめる)。
 */
export const BOP_REGIONAL_DLOAD_PAGE_URL = "https://www.stat-search.boj.or.jp/info/dload.html";

/**
 * 取得に使う User-Agent。モジュール (`../sources/bop-regional.ts`) の `UA` (非 export) と
 * 同じ値 (2026-09-27 の実取得・検証で使った値。取得元を名乗るためのもの)。
 */
const USER_AGENT = "kabulab-cf-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

/**
 * 一括ダウンロードページ上の表示名。モジュールの `DLOAD_LABEL` (非 export) と同じ値で、
 * ZIP のリンクの行 (最終更新日付を読む行) を特定するのに使う。
 */
const BOP_REGIONAL_DLOAD_LABEL = "地域別国際収支（四半期）";

/** 保管する ZIP のファイル名 (取得元のファイル名そのまま。期間に依らず固定)。 */
export const BOP_REGIONAL_ZIP_FILENAME = "regbp_q_jp.zip";
/** 保管する一括ダウンロードページのファイル名 (期間に依らず固定)。 */
export const BOP_REGIONAL_DLOAD_FILENAME = "boj-stat-search-dload.html";

/** 1 億円 = 100,000,000 円 (取得元の単位「億円」→ 観測ログの単位「円」)。 */
const YEN_PER_OKU_YEN = 100_000_000;

/**
 * 更新停止の検知の猶予 (月)。公表予定月 (四半期末の 5 か月後。モジュールの
 * `expectedBopRegionalPublicationMonth`) の翌月いっぱいまでは未公表を許し、それを過ぎても
 * CSV の最新四半期が進んでいなければ throw する (URL 移転・更新停止を「取込済み」のまま
 * 黙って見過ごさない — ルール2)。例: 2026 年 1〜3 月期 (公表予定 2026-08) は 2026-10 以降の
 * 実行で必須になる。
 */
export const BOP_REGIONAL_PUBLICATION_GRACE_MONTHS = 1;

const KEY_RE = /^bop-regional-(\d{4})-Q([1-4])-updated-(\d{4}-\d{2}-\d{2})$/;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 区分 (国・地域) — モジュールの全 47 区分をそのまま使う
// ---------------------------------------------------------------------------

/** 全世界の合計の区分名 (CSV 上の表記)。 */
const WORLD_TOTAL_REGION = "地域別合計";

function toCategoryKind(kind: BopRegionKind, region: string): MoneyflowCategoryKind {
  switch (kind) {
    case "world_total":
      return "全体";
    case "country":
    case "continent_group":
    case "cross_cutting_group":
    case "other":
      // 「アジア計」等の地域計、「EU」等のグループ、「国際機関」「非分類」も
      // 「相手の国・地域」という同じ軸の値なので区分種別は国地域にする
      // (重なり・国でない区分であることは指標定義の説明・限界に書く)。
      return "国地域";
    default: {
      const unknown: never = kind;
      throw new Error(`[bop-regional] 対応付けの無い地域の種類です (アダプタの更新が必要): ${String(unknown)} (${region})`);
    }
  }
}

const REGION_ORDER: ReadonlyMap<string, number> = new Map(BOP_REGIONS.map((r, i) => [r.name, i]));
const REGION_KIND: ReadonlyMap<string, BopRegionKind> = new Map(BOP_REGIONS.map((r) => [r.name, r.kind]));
const INDICATOR_ORDER: ReadonlyMap<string, number> = new Map(BOP_REGIONAL_INDICATORS.map((d, i) => [d.key, i]));

function requireOrder(map: ReadonlyMap<string, number>, key: string, what: string): number {
  const v = map.get(key);
  if (v === undefined) throw new Error(`[bop-regional] 想定外の${what}です: ${key}`);
  return v;
}

// ---------------------------------------------------------------------------
// 指標定義 (モジュールの定義 → IndicatorDefInput)
// ---------------------------------------------------------------------------

function toFlowType(ft: BopRegionalFlowType): MoneyflowFlowType {
  // 金融収支は「取得−処分」「実行−回収」のネットの取引額で、資金の向きを表す。
  if (ft === "net_flow") return "純買い越し";
  throw new Error(`[bop-regional] 対応付けの無い flowType です (アダプタの更新が必要): ${String(ft)}`);
}

function toRequirement(key: string, reqs: readonly string[]): MoneyflowRequirement {
  // docs/moneyflow.md の在庫表で国際収支統計 (地域別内訳) は R4 (日本⇔海外・世界の概況)。
  if (reqs.length === 1 && reqs[0] === "R4") return "R4";
  throw new Error(`[bop-regional] ${key}: 要件が想定 (R4 のみ) と違います: ${reqs.join(",")}`);
}

type Direction = "net" | "asset" | "liability";
type InvestmentKind = "direct" | "portfolio";

function directionOfKey(key: string): Direction {
  if (key.endsWith("_net")) return "net";
  if (key.endsWith("_asset")) return "asset";
  if (key.endsWith("_liability")) return "liability";
  throw new Error(`[bop-regional] 指標キーから向き (ネット/資産/負債) を判別できません: ${key}`);
}

function investmentKindOfKey(key: string): InvestmentKind {
  if (key.startsWith("bop_regional_direct_investment_")) return "direct";
  if (key.startsWith("bop_regional_portfolio_investment_")) return "portfolio";
  throw new Error(`[bop-regional] 指標キーから直接投資/証券投資を判別できません: ${key}`);
}

const NET_SIGN =
  " 【符号】資産 (日本から海外への投資の増加) − 負債 (海外から日本への投資の増加) の差。" +
  "プラスは日本から出たお金の方が多い (流出超)、マイナスは日本に入ったお金の方が多い (流入超)。";

const NET_EXAMPLE: Readonly<Record<InvestmentKind, string>> = {
  direct:
    "例: ある国の直接投資のネットが −1,000億円なら、その四半期はその国の会社による日本の会社への出資・買収 " +
    "(または日本の会社によるその国からの投資の回収) の方が多く、差し引き1,000億円が日本に入ったことを示す。",
  portfolio:
    "例: ある国の証券投資のネットが −1,000億円なら、その四半期はその国の投資家による日本の株・債券の買い越し " +
    "(または日本の投資家によるその国の証券の売り越し) の方が多く、差し引き1,000億円が日本に入ったことを示す。",
};

const ASSET_SIGN =
  " 【符号】プラスは日本の居住者 (日本に住む人や日本の会社・銀行・年金など) がその国・地域への投資を" +
  "増やした (お金が日本から出た)、マイナスは回収・売り越しの方が多く、お金が日本に戻ったことを示す。";

const LIABILITY_SIGN =
  " 【符号】プラスはその国・地域の居住者が日本への投資を増やした (お金が日本に入った)、" +
  "マイナスは回収・売り越しの方が多く、お金が日本から出ていったことを示す。";

function signDescription(direction: Direction, kind: InvestmentKind): string {
  switch (direction) {
    case "net":
      return NET_SIGN + NET_EXAMPLE[kind];
    case "asset":
      return ASSET_SIGN;
    case "liability":
      return LIABILITY_SIGN;
    default: {
      const unknown: never = direction;
      throw new Error(`[bop-regional] 未知の向きです: ${String(unknown)}`);
    }
  }
}

const COMMON_DESCRIPTION =
  " 値は1四半期 (3か月) の間の取引の差し引き (フロー) で、その時点で持っている額 (残高=ストック) ではない。" +
  "単位は円 (取得元の「億円」を1億倍して換算。1円未満は四捨五入)。" +
  "区分は相手の国・地域で、「地域別合計」は全世界の合計。「アジア計」などの地域計や「EU」「OECD諸国」などの" +
  "グループは個別の国と重なっているので、足し合わせると二重に数えることになる。" +
  "直接投資 (相手の会社の議決権の10%以上を持つような、経営に関わる目的の投資。出資・買収や親子会社間の貸し借り等) と" +
  "証券投資 (経営に関わらない株・投資ファンド持分・債券への投資) は別の項目。";

/** 1 バッチの最大行数 (全区分 × 全指標。NA・空欄の分だけ実際は少ない)。 */
export const BOP_REGIONAL_MAX_ROWS = BOP_REGIONS.length * BOP_REGIONAL_INDICATORS.length;

const COMMON_LIMITATIONS =
  " 【取込の範囲】1回の取込で記録するのは、CSV に載っている最新の四半期1期分だけ " +
  `(全${BOP_REGIONS.length}区分×${BOP_REGIONAL_INDICATORS.length}指標、最大${BOP_REGIONAL_MAX_ROWS}行)。` +
  "それより前の四半期は取り込まないため、観測ログの履歴は取込を始めた四半期から1期ずつ増える。" +
  "翌年・翌々年5月の年次改訂などで過去の四半期の値が改められても、観測ログの過去の行は更新されない " +
  "(最新の四半期そのものが訂正された場合は、一括ダウンロードページの最終更新日付が変わるので取り直して上書きする)。" +
  "【公表の遅れ】四半期の終わりから約5か月後に公表されるため、最新でも5〜8か月前の動きになる。" +
  "公表予定月の翌月を過ぎても最新の四半期が進まない場合は、取込を失敗させて知らせる。" +
  "【値が無い組み合わせ】取得元で「NA」(非開示など) や空欄になっている国・地域と指標の組み合わせは行を作らない " +
  "(0 で埋めない)。どの組み合わせに値が無かったかは一次データの取得時メタデータに記録する。" +
  "【地域の分け方】国・地域は統計上の取引相手や投資先の所在地による分類で、最終的にお金を出した人・" +
  "受け取った人の国籍とは限らない (ファンドの設立地や金融センターの国・地域に計上されることがある)。" +
  "【利用条件】日本銀行「時系列統計データ検索サイト」のご利用上の留意点により、出所を明記すれば転載・複製できるが、" +
  "商用目的の場合・「無断転載・複製を禁じます」等の注記がある部分・写真やイラスト等の画像データの場合は" +
  "日本銀行情報サービス局への事前相談が必要で、日本銀行に無断での改変はできない。" +
  "取込では単位の換算 (億円→円) と最新四半期の抜き出し以外の加工はしていない。本機能は個人利用・非公開。";

/**
 * 直接投資の 3 指標にだけ足す注意書き。国際収支マニュアル第6版では、海外の子会社が
 * 配当に回さず社内に残した利益 (再投資収益) も「親会社がその分を追加で投資した」と
 * みなして直接投資の取引に含める。お金が実際に国境を越えていない分も入るので、
 * 「お金が日本から出た/入った」という説明をそのまま受け取らないよう明記する。
 */
const DIRECT_INVESTMENT_NOTE =
  " 【直接投資の注意】直接投資の値には、海外の子会社が配当として親会社に送らずに手元に残した利益" +
  " (再投資収益) も「親会社による追加の投資」として含まれる。この分は実際にはお金が国境を越えていないため、" +
  "「お金が日本から出た/入った」は、実際の送金の額と同じとは限らない。";

function toIndicatorDef(def: BopRegionalIndicatorDef): IndicatorDefInput {
  if (def.unit !== "億円") {
    throw new Error(`[bop-regional] ${def.key}: 単位が想定 (億円) と違います: ${String(def.unit)}`);
  }
  if (!def.frequency.startsWith("四半期")) {
    throw new Error(`[bop-regional] ${def.key}: 頻度が想定 (四半期) と違います: ${def.frequency}`);
  }
  // 利用条件の区分 (attribution-required) はモジュールの記述 (日本銀行サイトの留意点の要約:
  // 出所明記で転載・複製可、商用目的等は事前相談) に基づく。記述が変わったら区分を見直す。
  if (!def.license.includes("出所を明記") || !def.license.includes("商用目的")) {
    throw new Error(`[bop-regional] ${def.key}: 利用条件の記述が想定と違います (区分の見直しが必要): ${def.license}`);
  }
  if (def.sourceUrl !== BOP_REGIONAL_DLOAD_PAGE_URL) {
    throw new Error(`[bop-regional] ${def.key}: 出典URL が一括ダウンロードページと違います: ${def.sourceUrl}`);
  }
  const direction = directionOfKey(def.key);
  const kind = investmentKindOfKey(def.key);
  return {
    key: def.key,
    displayName: def.displayName,
    requirement: toRequirement(def.key, def.requirements),
    flowType: toFlowType(def.flowType),
    description:
      def.plainExplanation +
      " 【定義】" +
      def.measures +
      signDescription(direction, kind) +
      (kind === "direct" ? DIRECT_INVESTMENT_NOTE : "") +
      COMMON_DESCRIPTION,
    sourceUrl: def.sourceUrl,
    license: "attribution-required",
    frequency: "四半期",
    limitations: def.limitations + COMMON_LIMITATIONS,
  };
}

export const BOP_REGIONAL_ADAPTER_INDICATORS: readonly IndicatorDefInput[] = BOP_REGIONAL_INDICATORS.map(toIndicatorDef);

// ---------------------------------------------------------------------------
// 一括ダウンロードページ (HTML) → ZIP のリンクと最終更新日付 (純関数)
// ---------------------------------------------------------------------------

export interface BopRegionalDloadEntry {
  /** ZIP へのリンク (ページ上の相対 URL のまま。例 "regbp_q_jp.zip")。 */
  href: string;
  /** その行の「最終更新日付」(YYYY-MM-DD)。 */
  updatedOn: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 一括ダウンロードページ (デコード済み) から「地域別国際収支（四半期）」の行を読み、
 * ZIP のリンク (モジュールの `extractBopRegionalZipHref`) と同じ行の「最終更新日付」
 * (例「2026年8月10日」) を返す。日付が無い・複数ある・暦に無い場合は throw する
 * (モジュールには最終更新日付を読む関数が無いため、アダプタで読む)。
 */
export function readBopRegionalDloadEntry(html: string): BopRegionalDloadEntry {
  const href = extractBopRegionalZipHref(html);
  // モジュールがリンクを見つけたのと同じ「リンク先 + 表示名」の <a> の行を読む。リンク先だけで
  // 探すと、同じ ZIP への別のリンク (お知らせ欄など) が先にあったときに別の行の日付を読んでしまう。
  const anchors = [...html.matchAll(new RegExp(`<a href="${escapeRegExp(href)}">${escapeRegExp(BOP_REGIONAL_DLOAD_LABEL)}</a>`, "g"))];
  if (anchors.length !== 1) {
    throw new Error(
      `[bop-regional] 一括ダウンロードページに「${BOP_REGIONAL_DLOAD_LABEL}」(${href}) のリンクが 1 件ではありません (${anchors.length} 件)`
    );
  }
  const anchor = anchors[0] as RegExpMatchArray & { index: number };
  const rest = html.slice(anchor.index);
  const rowEnd = rest.indexOf("</tr>");
  if (rowEnd < 0) {
    throw new Error(`[bop-regional] 一括ダウンロードページの ${href} の行の終わり (</tr>) が見つかりません`);
  }
  const row = rest.slice(0, rowEnd);
  const dates = [...row.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)];
  if (dates.length !== 1) {
    throw new Error(
      `[bop-regional] 一括ダウンロードページの ${href} の行に最終更新日付が 1 件ではありません (${dates.length} 件)` +
        ` — ページ構成が変わった可能性があります`
    );
  }
  const m = dates[0] as RegExpMatchArray;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!isValidYmd(year, month, day)) {
    throw new Error(`[bop-regional] 最終更新日付が暦にありません: ${m[0]}`);
  }
  return {
    href,
    updatedOn: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function decodeShiftJis(file: SpecFile): string {
  // 日本銀行サイトのページ・CSV は Shift_JIS (モジュールも同じ扱い)。
  return new TextDecoder("shift_jis").decode(file.bytes);
}

// ---------------------------------------------------------------------------
// 冪等キー
// ---------------------------------------------------------------------------

function quarterLabel(p: Pick<BopRegionalPeriod, "year" | "quarter">): string {
  return `${p.year}-Q${p.quarter}`;
}

export function bopRegionalBatchKey(period: Pick<BopRegionalPeriod, "year" | "quarter">, updatedOn: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updatedOn)) {
    throw new Error(`[bop-regional] 最終更新日付が YYYY-MM-DD ではありません: ${updatedOn}`);
  }
  const key = `${BOP_REGIONAL_SPEC_NAME}-${quarterLabel(period)}-updated-${updatedOn}`;
  if (!KEY_RE.test(key)) throw new Error(`[bop-regional] 冪等キーの形式が不正です: ${key}`);
  return key;
}

// ---------------------------------------------------------------------------
// ファイル (ZIP + ページ HTML) → 観測行 (純関数)
// ---------------------------------------------------------------------------

interface Analysis {
  key: string;
  period: BopRegionalPeriod;
  updatedOn: string;
  href: string;
  csvRows: number;
  headerPeriods: { first: string; last: string; count: number };
  /** 最新四半期に値が無かった (NA・空欄・行なし) 「指標キー|区分」。 */
  seriesWithoutValue: string[];
  /** 最新四半期に 10 指標のどれにも値が無かった区分。 */
  regionsWithoutAnyValue: string[];
  drafts: ObservationDraft[];
}

function analyzeFiles(files: readonly SpecFile[]): Analysis {
  const expected = [BOP_REGIONAL_ZIP_FILENAME, BOP_REGIONAL_DLOAD_FILENAME];
  const unexpected = files.filter((f) => !expected.includes(f.filename)).map((f) => f.filename);
  if (unexpected.length > 0) {
    throw new Error(`[bop-regional] 想定外のファイル名があります: ${unexpected.join(", ")}`);
  }
  const zip = requireSpecFile(files, (f) => f === BOP_REGIONAL_ZIP_FILENAME, `[bop-regional] ${BOP_REGIONAL_ZIP_FILENAME}`);
  const page = requireSpecFile(files, (f) => f === BOP_REGIONAL_DLOAD_FILENAME, `[bop-regional] ${BOP_REGIONAL_DLOAD_FILENAME}`);

  const entry = readBopRegionalDloadEntry(decodeShiftJis(page));
  const parsed = parseBopRegionalCsvText(decodeBopRegionalZip(zip.bytes));

  // ヘッダの期間は古い→新しいの順で重複なし (最後の列 = 最新の四半期) であること。
  parsed.periods.forEach((p, i) => {
    const prev = parsed.periods[i - 1];
    if (prev && prev.year * 10 + prev.quarter >= p.year * 10 + p.quarter) {
      throw new Error(`[bop-regional] CSV ヘッダの期間が古い順に並んでいません: ${prev.label} → ${p.label}`);
    }
  });
  const period = parsed.periods[parsed.periods.length - 1];
  const first = parsed.periods[0];
  if (!period || !first) throw new Error("[bop-regional] CSV ヘッダに期間の列がありません");

  const all = extractBopRegionalObservations(parsed);
  const latest = latestObservedPeriod(all);
  if (latest !== period.label) {
    throw new Error(
      `[bop-regional] CSV ヘッダの最新の四半期 ${period.label} に直接投資・証券投資の値がありません ` +
        `(値のある最新は ${String(latest)}) — 様式変更か公表途中の可能性があります`
    );
  }
  const inPeriod = all.filter((o) => o.year === period.year && o.quarter === period.quarter);

  // 同じ指標×区分が 2 行あれば取り違え (後の行が黙って上書きする) になるので throw。
  const seen = new Map<string, BopRegionalObservation>();
  for (const o of inPeriod) {
    const k = `${o.metricKey}|${o.region}`;
    const prev = seen.get(k);
    if (prev) {
      throw new Error(`[bop-regional] 同じ指標×区分が 2 行あります: ${k} (${prev.sourceCode}, ${o.sourceCode})`);
    }
    seen.set(k, o);
  }

  // 全世界の合計は 10 指標すべてに値があるはず。欠けていたら様式変更として throw する。
  const missingWorld = BOP_REGIONAL_INDICATORS.filter((d) => !seen.has(`${d.key}|${WORLD_TOTAL_REGION}`)).map(
    (d) => d.key
  );
  if (missingWorld.length > 0) {
    throw new Error(
      `[bop-regional] ${period.label} の「${WORLD_TOTAL_REGION}」に値の無い指標があります: ${missingWorld.join(", ")}` +
        ` — 様式変更の可能性があります`
    );
  }

  const seriesWithoutValue: string[] = [];
  const regionsWithoutAnyValue: string[] = [];
  for (const r of BOP_REGIONS) {
    const missing = BOP_REGIONAL_INDICATORS.filter((d) => !seen.has(`${d.key}|${r.name}`));
    for (const d of missing) seriesWithoutValue.push(`${d.key}|${r.name}`);
    if (missing.length === BOP_REGIONAL_INDICATORS.length) regionsWithoutAnyValue.push(r.name);
  }

  const range = quarterRange(period.year, period.quarter);
  const label = quarterLabel(period);
  const keyed = inPeriod.map((o) => {
    if (o.unit !== "億円") throw new Error(`[bop-regional] 想定外の単位です: ${String(o.unit)} (${o.sourceCode})`);
    const kind = REGION_KIND.get(o.region);
    if (kind === undefined || kind !== o.regionKind) {
      throw new Error(`[bop-regional] 区分の種類が定義と一致しません: ${o.region} (${String(o.regionKind)})`);
    }
    const yen = Math.round(o.value * YEN_PER_OKU_YEN);
    const draft: ObservationDraft = {
      period: label,
      periodStart: range.start,
      periodEnd: range.end,
      indicatorKey: o.metricKey,
      category: o.region,
      categoryKind: toCategoryKind(o.regionKind, o.region),
      value: Object.is(yen, -0) ? 0 : yen,
      unit: "円",
      changeFromPrev: null,
      approximate: o.approximate,
      measureKind: o.estimated ? "推定" : "実測",
    };
    const order: [number, number] = [
      requireOrder(INDICATOR_ORDER, o.metricKey, "指標キー"),
      requireOrder(REGION_ORDER, o.region, "区分"),
    ];
    return { order, draft };
  });
  keyed.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);

  return {
    key: bopRegionalBatchKey(period, entry.updatedOn),
    period,
    updatedOn: entry.updatedOn,
    href: entry.href,
    csvRows: parsed.rows.length,
    headerPeriods: { first: first.label, last: period.label, count: parsed.periods.length },
    seriesWithoutValue,
    regionsWithoutAnyValue,
    drafts: keyed.map((k) => k.draft),
  };
}

// ---------------------------------------------------------------------------
// 更新停止の検知 (resolve 専用。toObservations は実行日に依存させない)
// ---------------------------------------------------------------------------

function monthIndex(year: number, month1: number): number {
  return year * 12 + (month1 - 1);
}

/**
 * 実行日時点で「公表済みであるはず」の最も新しい四半期 (公表予定月 + 猶予を過ぎたもの)。
 * 公表予定月はモジュールの `expectedBopRegionalPublicationMonth` (四半期末の 5 か月後)。
 * 月の判定は日本時間。
 */
export function bopRegionalRequiredLatestQuarter(now: Date): { year: number; quarter: 1 | 2 | 3 | 4 } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const nowIdx = monthIndex(jst.getUTCFullYear(), jst.getUTCMonth() + 1);
  let year = jst.getUTCFullYear();
  let quarter = (Math.floor(jst.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  // 公表は四半期末の 5 か月後なので、2 年 (8 期) 遡れば必ず見つかる。
  for (let i = 0; i < 8; i++) {
    const pub = expectedBopRegionalPublicationMonth(year, quarter);
    if (monthIndex(pub.year, pub.month) + BOP_REGIONAL_PUBLICATION_GRACE_MONTHS < nowIdx) return { year, quarter };
    if (quarter === 1) {
      quarter = 4;
      year -= 1;
    } else {
      quarter = (quarter - 1) as 1 | 2 | 3;
    }
  }
  throw new Error(`[bop-regional] 公表済みであるはずの四半期を決められません (now=${now.toISOString()})`);
}

function assertFresh(period: BopRegionalPeriod, now: Date): void {
  const today = new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
  const range = quarterRange(period.year, period.quarter);
  if (range.end > today) {
    throw new Error(
      `[bop-regional] CSV の最新の四半期 ${quarterLabel(period)} が実行日 ${today} の時点で終わっていません (ファイルが不正)`
    );
  }
  const required = bopRegionalRequiredLatestQuarter(now);
  if (period.year * 10 + period.quarter < required.year * 10 + required.quarter) {
    throw new Error(
      `[bop-regional] CSV の最新の四半期 ${quarterLabel(period)} が、公表済みであるはずの ${quarterLabel(required)} より古いです ` +
        `(公表予定月の翌月を過ぎても更新されていない)。取得元の更新停止・URL 移転を確認してください`
    );
  }
}

// ---------------------------------------------------------------------------
// 取得 (resolve / fetch)
// ---------------------------------------------------------------------------

async function getBytes(url: string, what: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`[bop-regional] ${what}の取得に失敗しました: HTTP ${res.status} (${url})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function resolveBopRegional(now: Date): Promise<ResolvedBatch> {
  const pageBytes = await getBytes(BOP_REGIONAL_DLOAD_PAGE_URL, "一括ダウンロードページ");
  const pageFile: PrimaryFile = { filename: BOP_REGIONAL_DLOAD_FILENAME, bytes: pageBytes, contentType: "text/html" };
  const entry = readBopRegionalDloadEntry(decodeShiftJis(pageFile));
  const zipUrl = new URL(entry.href, BOP_REGIONAL_DLOAD_PAGE_URL).toString();
  const zipBytes = await getBytes(zipUrl, "地域別国際収支（四半期）の ZIP ");
  const files: PrimaryFile[] = [
    { filename: BOP_REGIONAL_ZIP_FILENAME, bytes: zipBytes, contentType: "application/zip" },
    pageFile,
  ];

  const analysis = analyzeFiles(files);
  assertFresh(analysis.period, now);
  if (analysis.regionsWithoutAnyValue.length > 0) {
    console.warn(
      `[bop-regional] ${quarterLabel(analysis.period)} に 10 指標のどれにも値が無い区分があります (行は作らない): ` +
        analysis.regionsWithoutAnyValue.join(", ")
    );
  }

  const batch: FetchedBatch = {
    key: analysis.key,
    source: `日本銀行 時系列統計データ検索サイト 一括ダウンロード「地域別国際収支（四半期）」 ${zipUrl} (一覧: ${BOP_REGIONAL_DLOAD_PAGE_URL})`,
    metadata: {
      dataset: "地域別国際収支（四半期）（6版基準）",
      zipUrl,
      dloadPageUrl: BOP_REGIONAL_DLOAD_PAGE_URL,
      dloadPageEncoding: "Shift_JIS",
      lastUpdatedOnPage: analysis.updatedOn,
      targetQuarter: quarterLabel(analysis.period),
      csvHeaderPeriods: analysis.headerPeriods,
      csvRows: analysis.csvRows,
      observationRows: analysis.drafts.length,
      unitConversion: "億円 × 100,000,000 → 円 (1円未満四捨五入)",
      seriesWithoutValue: analysis.seriesWithoutValue,
      regionsWithoutAnyValue: analysis.regionsWithoutAnyValue,
      zipBytes: zipBytes.byteLength,
      dloadPageBytes: pageBytes.byteLength,
    },
    files,
  };
  return { key: analysis.key, fetch: async () => batch };
}

/** 国際収支統計 地域別 (直接投資・証券投資、国・地域別、四半期)。 */
export const bopRegionalSpec: MoneyflowSourceSpec = {
  name: BOP_REGIONAL_SPEC_NAME,
  indicators: BOP_REGIONAL_ADAPTER_INDICATORS,
  resolve: resolveBopRegional,
  toObservations({ key, files }) {
    if (!KEY_RE.test(key)) throw new Error(`[bop-regional] 冪等キーの形式が不正です: ${key}`);
    const analysis = analyzeFiles(files);
    if (analysis.key !== key) {
      throw new Error(`[bop-regional] キー ${key} がファイルの中身から決まるキー ${analysis.key} と一致しません`);
    }
    return analysis.drafts;
  },
};
