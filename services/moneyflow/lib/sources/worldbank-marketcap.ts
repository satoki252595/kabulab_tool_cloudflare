/**
 * 取得元: World Bank Open Data (World Development Indicators)
 *   指標: CM.MKT.LCAP.CD
 *     "Market capitalization of listed domestic companies (current US$)"
 *   出典ページ: https://data.worldbank.org/indicator/CM.MKT.LCAP.CD
 *   原典: World Federation of Exchanges (WFE) database の集計を World Bank が
 *     年次で再配布したもの (sourceOrganization を出典ページで確認済み)。
 *   ライセンス: CC BY-4.0 (https://datacatalog.worldbank.org/int/public-licenses#cc-by)
 *     — 出典表示を条件に商用利用・改変・再配布とも許諾。
 *   利用条件: 個人利用限定の制約なし (JPX 系ソースと異なり personal-only 縛りは無い)。
 *
 * 計画: /Users/satoki252595/.claude/plans/notion-velvet-goose.md の Phase 5
 *   (R4「世界の概況」)。「各国の対外証券投資残高・時価総額」のうち時価総額分。
 *   すべて残高 (ストック) であり真の資金フローではない前提が計画に明記されている。
 *
 * このファイルは Notion への書込は一切行わない (統合担当が
 * `worldBankMarketCapArchiveInput` / `toObservationRecords` の出力を使って書く)。
 */

const WORLD_BANK_API_BASE = "https://api.worldbank.org/v2";
const INDICATOR_CODE = "CM.MKT.LCAP.CD";

// World Bank API はブラウザ相当 UA を要求しない公開 REST API (JPX 系のような
// bot 対策は確認されなかった。無 UA の素の curl でも 200 が返る)。とはいえ
// 送信元を名乗るのは行儀として付けておく。個人情報 (メールアドレス等) は含めない。
// リポジトリ内に共有 UA 定数はまだ存在しない (JPX 系の既存コードも各ファイルで
// 個別にリテラルを持つ現状の慣例に合わせ、ここでも自己完結させる)。
const USER_AGENT = "kabulab-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

// ---------------------------------------------------------------------------
// (4) この取得元の指標定義
// ---------------------------------------------------------------------------

/** 観測ログの「何を測るか」区分 (計画書の型に合わせる)。 */
export type MoneyflowFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

export interface MoneyflowIndicatorDefinition {
  /** 観測ログからのリレーションキー */
  key: string;
  /** 画面表示用ラベル */
  label: string;
  /** この指標が満たす要件 (計画書の R1〜R4) */
  requirements: string[];
  /** 何を測るか */
  flowType: MoneyflowFlowType;
  /** 財務的に正確な定義 (出典ページの sourceNote を日本語で要約) */
  measures: string;
  /** 投資初心者向けの平易な説明 (ルール7: 1〜3文・具体例つき。バルーンヘルプの原文に使う想定) */
  plainDescription: string;
  /** 単位 */
  unit: string;
  /** 出典 URL */
  sourceUrl: string;
  /** 利用条件 */
  license: string;
  /** 表示・保存時に必ず添える出典表示文 (CC BY-4.0 の attribution 要件) */
  attribution: string;
  /** 公表頻度 */
  frequency: "annual";
  /** この指標の限界 (計画書の「近似」に相当する注意点) */
  limitations: string[];
}

export const WORLDBANK_MARKETCAP_INDICATOR: MoneyflowIndicatorDefinition = {
  key: "worldbank_marketcap",
  label: "上場企業 時価総額(国・地域別、World Bank)",
  requirements: ["R4"],
  flowType: "holdings_stock",
  measures:
    "各国証券取引所に上場する国内企業の時価総額(株価×発行済株式数の合計)を、" +
    "年末時点・米ドル建てで示す年次のストック指標。投資信託・単元投資信託や、" +
    "他の上場会社の株式保有のみを目的とする会社は対象から除く。原典は World " +
    "Federation of Exchanges (WFE) 加盟取引所の統計で、World Bank が国別に集計・" +
    "米ドル換算(当該年末の為替レート)して再配布している。ある時点の残高であり、" +
    "その年に新規にいくら投資されたか(資金フロー)を示す指標ではない点に注意。",
  plainDescription:
    "その国の証券取引所に上場している会社ぜんぶの「株価×株数」を足し合わせた合計額。" +
    "例えば日本の時価総額が1年で1.2倍になっても、それは(1)株価が上がった分と" +
    "(2)新しく上場した会社が増えた分が混ざっており、「その年に新しくいくら" +
    "投資されたか」を表すお金の流れ(フロー)ではない。ある一時点で積み上がっている" +
    "株式資産の残高(ストック)だと覚えておくとよい。",
  unit: "USD",
  sourceUrl: "https://data.worldbank.org/indicator/CM.MKT.LCAP.CD",
  license:
    "CC BY-4.0 (https://datacatalog.worldbank.org/int/public-licenses#cc-by)。" +
    "出典表示を条件に商用利用・改変・再配布とも許諾。個人利用限定の制約はない。",
  attribution:
    "出典: World Bank, World Development Indicators " +
    "(CM.MKT.LCAP.CD, 原典 World Federation of Exchanges database), CC BY-4.0. " +
    "https://data.worldbank.org/indicator/CM.MKT.LCAP.CD",
  frequency: "annual",
  limitations: [
    "残高(ストック)であり、真の資金フロー(純流入出)ではない。株価変動の影響を含む。",
    "国ごとに取引所側の統計提出・World Bank 側の反映ラグが異なるため、同じ取得時点でも" +
      "国によって『最新で入っている年』が揃わない (isYearPublished / latestPublishedYear で" +
      "国ごとに判定する必要がある)。",
    "原データは WFE 加盟取引所の集計であり、非加盟取引所・店頭市場は含まれない可能性がある。",
    "地域集計 (World / High income 等の Aggregates) が個別国と同じ形式で配信されるため、" +
      "国別集計と混同しないよう isAggregate で明示的に区別する必要がある。",
  ],
};

// ---------------------------------------------------------------------------
// (1) 最新データの URL 解決 + 取得
// ---------------------------------------------------------------------------

export interface WorldBankFetchWindow {
  /** 取得対象の開始年 (含む) */
  fromYear: number;
  /** 取得対象の終了年 (含む) */
  toYear: number;
}

/**
 * 既定の取得年レンジ。年次公表かつ国ごとに公表ラグが異なるため、単一の
 * 「今年から何年ラグ」という決め打ちはしない。広めの窓 (直近7年分) を毎回
 * 取得し、実際にどの年まで値が入っているかは isYearPublished /
 * latestPublishedYear が実データから判定する。
 */
export function defaultFetchWindow(now: Date): WorldBankFetchWindow {
  const toYear = now.getUTCFullYear();
  return { fromYear: toYear - 6, toYear };
}

function assertValidWindow(window: WorldBankFetchWindow): void {
  if (
    !Number.isInteger(window.fromYear) ||
    !Number.isInteger(window.toYear) ||
    window.fromYear > window.toYear
  ) {
    throw new Error(
      `World Bank marketcap: 不正な年レンジです: ${JSON.stringify(window)}`
    );
  }
}

/** 全世界・全期間を1ページで確実に収めるための per_page (実測 total は295国×最大数十年でも数千件)。 */
const PER_PAGE = "20000";

/** (1) 時価総額データの取得先 URL を組み立てる (国は全件、年はレンジ指定)。 */
export function buildMarketCapUrl(window: WorldBankFetchWindow): string {
  assertValidWindow(window);
  const params = new URLSearchParams({
    format: "json",
    per_page: PER_PAGE,
    date: `${window.fromYear}:${window.toYear}`,
  });
  return `${WORLD_BANK_API_BASE}/country/all/indicator/${INDICATOR_CODE}?${params.toString()}`;
}

/** (1) 国・地域メタデータ (集計行かどうかの判定に必要) の取得先 URL。 */
export function buildCountryMetaUrl(): string {
  const params = new URLSearchParams({ format: "json", per_page: PER_PAGE });
  return `${WORLD_BANK_API_BASE}/country/all?${params.toString()}`;
}

export interface WorldBankFetchResult {
  url: string;
  /** ルール6 (一次データアーカイブ) 用の実体バイト列 */
  bytes: Uint8Array;
  /** JSON.parse 済みの生レスポンス (型は未検証 = unknown。検証は各 parse* 関数が行う) */
  json: unknown;
}

async function fetchWorldBankJson(url: string): Promise<WorldBankFetchResult> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `World Bank API HTTP エラー: ${res.status} ${res.statusText} (${url})`
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `World Bank API: レスポンスが JSON として解析できません (${url})`,
      { cause: err }
    );
  }
  return { url, bytes, json };
}

/** (1) 時価総額データを取得する。窓省略時は defaultFetchWindow(現在時刻) を使う。 */
export async function fetchMarketCapWindow(
  window: WorldBankFetchWindow = defaultFetchWindow(new Date())
): Promise<WorldBankFetchResult> {
  return fetchWorldBankJson(buildMarketCapUrl(window));
}

/** (1) 国・地域メタデータを取得する。 */
export async function fetchCountryMeta(): Promise<WorldBankFetchResult> {
  return fetchWorldBankJson(buildCountryMetaUrl());
}

// ---------------------------------------------------------------------------
// (2) 純関数パーサ: 取得物 (JSON) → 型付きレコード
// ---------------------------------------------------------------------------

export interface WorldBankMarketCapRow {
  /**
   * World Bank の国/地域コード (`country.id`。例 "JP", "1W", "XD")。
   * この値は country メタデータ (`/v2/country/all`) の `iso2Code` と必ず一致する
   * (実データで検証済み — indicator エンドポイント側の `countryiso3code` より
   * こちらの方が両エンドポイント間の結合キーとして信頼できる。理由は iso3 の
   * コメント参照)。
   */
  entityId: string;
  /**
   * ISO 3166-1 alpha-3 相当 (`countryiso3code`)。**一部の所得階層集計
   * (例: "High income" / entityId "XD") では World Bank がこの欄を空文字列で
   * 返し、alpha-3 コードが割り当てられていない** (実 fixture で確認済み)。
   * 表示用の補助情報として持つのみで、結合キーには entityId を使うこと。
   */
  iso3: string | undefined;
  entityName: string;
  year: number;
  /** 未取得 (World Bank 側で value: null = 当年分がまだ集計・公表されていない) は undefined。捏造で埋めない (ルール2)。 */
  marketCapUsd: number | undefined;
}

export interface WorldBankCountryMetaRow {
  /** `/v2/country/all` の `iso2Code`。indicator エンドポイントの `country.id` と結合するキー。 */
  entityId: string;
  /** `/v2/country/all` の `id` (常に非空。集計行も "HIC" 等の World Bank 独自3文字コードを持つ)。 */
  iso3: string;
  name: string;
  /** true = World Bank の地域・所得階層集計 (region.value === "Aggregates")。個別国ではない。 */
  isAggregate: boolean;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `World Bank API: ${context} がオブジェクトではありません: ${JSON.stringify(value)}`
    );
  }
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown, context: string): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(`World Bank API: ${context} が数値ではありません: ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * World Bank REST API の共通レスポンス形状 `[meta, rows]` の先頭要素を検証する。
 * 1 ページで完結しない (`pages > 1`) 場合は、黙って1ページ目だけを使うと欠損に
 * 気づけないため throw する (per_page を大きく取っているため通常は起きない)。
 */
function assertSinglePage(metaRaw: unknown, context: string): void {
  const meta = asRecord(metaRaw, context);
  const page = asFiniteNumber(meta.page, `${context}.page`);
  const pages = asFiniteNumber(meta.pages, `${context}.pages`);
  if (page !== 1 || pages > 1) {
    throw new Error(
      `World Bank API: ${context} が複数ページに分割されています (page=${page}, pages=${pages})。` +
        "per_page を増やすか、呼び出し側でページングを実装してください。"
    );
  }
}

/** (2) 時価総額レスポンスの純関数パーサ。様式が想定と違えば throw する。 */
export function parseMarketCapResponse(json: unknown): WorldBankMarketCapRow[] {
  if (!Array.isArray(json) || json.length !== 2) {
    throw new Error(
      "World Bank API: レスポンス形状が想定 [meta, rows] と異なります"
    );
  }
  const [metaRaw, rowsRaw] = json as [unknown, unknown];
  assertSinglePage(metaRaw, "marketcap meta");
  if (!Array.isArray(rowsRaw)) {
    throw new Error(
      "World Bank API: rows が配列ではありません (指標コードが存在しない可能性があります)"
    );
  }
  if (rowsRaw.length === 0) {
    throw new Error("World Bank API: データ行が 0 件です");
  }

  return rowsRaw.map((rowRaw, i) => {
    const row = asRecord(rowRaw, `rows[${i}]`);
    const indicator = asRecord(row.indicator, `rows[${i}].indicator`);
    const indicatorId = String(indicator.id ?? "");
    if (indicatorId !== INDICATOR_CODE) {
      throw new Error(
        `World Bank API: rows[${i}].indicator.id が想定外です: "${indicatorId}" ` +
          `(期待値 "${INDICATOR_CODE}")`
      );
    }
    const country = asRecord(row.country, `rows[${i}].country`);
    const entityId = String(country.id ?? "");
    const entityName = String(country.value ?? "");
    if (!entityId) {
      throw new Error(`World Bank API: rows[${i}] の国/地域コード (country.id) が取得できません`);
    }
    // countryiso3code は一部の所得階層集計で空文字列になる (実データで確認済み。
    // WorldBankMarketCapRow.iso3 のコメント参照)。これは欠損ではなく「この
    // 集計行には alpha-3 コードが割り当てられていない」という事実そのものなので、
    // throw はせず undefined として明示的に表現する (ルール2)。
    if (typeof row.countryiso3code !== "string") {
      throw new Error(
        `World Bank API: rows[${i}].countryiso3code が文字列ではありません: ${JSON.stringify(row.countryiso3code)}`
      );
    }
    const iso3 = row.countryiso3code === "" ? undefined : row.countryiso3code;
    const dateRaw = row.date;
    if (typeof dateRaw !== "string" || !/^\d{4}$/.test(dateRaw)) {
      throw new Error(
        `World Bank API: rows[${i}].date が年 (YYYY) 形式ではありません: ${JSON.stringify(dateRaw)}`
      );
    }
    const year = Number(dateRaw);
    const valueRaw = row.value;
    if (valueRaw !== null && typeof valueRaw !== "number") {
      throw new Error(
        `World Bank API: rows[${i}].value が数値または null ではありません: ${JSON.stringify(valueRaw)}`
      );
    }
    return {
      entityId,
      iso3,
      entityName,
      year,
      // null (World Bank の「未取得」表現) は undefined に正規化する (表現揺れの吸収であり、
      // 値を捏造するフォールバックではない — ルール2の許容範囲)。
      marketCapUsd: valueRaw === null ? undefined : valueRaw,
    };
  });
}

/** (2) 国・地域メタデータレスポンスの純関数パーサ。様式が想定と違えば throw する。 */
export function parseCountryMetaResponse(json: unknown): WorldBankCountryMetaRow[] {
  if (!Array.isArray(json) || json.length !== 2) {
    throw new Error(
      "World Bank API: country メタデータのレスポンス形状が想定 [meta, rows] と異なります"
    );
  }
  const [metaRaw, rowsRaw] = json as [unknown, unknown];
  assertSinglePage(metaRaw, "country meta");
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    throw new Error("World Bank API: country メタデータの行が 0 件です");
  }

  return rowsRaw.map((rowRaw, i) => {
    const row = asRecord(rowRaw, `country[${i}]`);
    const iso3 = String(row.id ?? "");
    const entityId = String(row.iso2Code ?? "");
    const name = String(row.name ?? "");
    const region = asRecord(row.region, `country[${i}].region`);
    const regionValue = String(region.value ?? "");
    if (!iso3 || !entityId || !name) {
      throw new Error(`World Bank API: country[${i}] の id/iso2Code/name が取得できません`);
    }
    return { entityId, iso3, name, isAggregate: regionValue === "Aggregates" };
  });
}

// ---------------------------------------------------------------------------
// 統合: 時価総額行 + 国メタデータ → 観測 (前年比つき)
// ---------------------------------------------------------------------------

export interface WorldBankMarketCapObservation {
  /** World Bank の国/地域コード (常に非空。結合・冪等キーはこちらを使う)。 */
  entityId: string;
  /** ISO 3166-1 alpha-3 相当。一部の所得階層集計では割り当てが無く undefined (WorldBankMarketCapRow.iso3 参照)。 */
  iso3: string | undefined;
  entityName: string;
  isAggregate: boolean;
  year: number;
  marketCapUsd: number | undefined;
  /** 前年比の差分 (当年・前年とも値がある場合のみ。ルール2: 欠損は欠損のまま undefined) */
  changeFromPreviousYearUsd: number | undefined;
}

/**
 * 時価総額の生行と国メタデータを突き合わせて観測配列を作る。
 *
 * 結合キーは `entityId` (indicator エンドポイントの `country.id` ⇔ country
 * メタデータの `iso2Code`)。`countryiso3code` (iso3) を結合キーに使わないのは、
 * 一部の所得階層集計 (例: entityId "XD" = High income) では indicator
 * エンドポイント側の `countryiso3code` が空文字列で返るため (実データで確認済み)。
 * entityId はどちらのエンドポイントでも欠けたことがない。
 *
 * メタデータに存在しない entityId が時価総額側に出た場合は、集計行かどうか
 * 判定できず「個別国として画面に混入させる」誤りを防ぐため throw する。
 */
export function toObservations(
  marketCapRows: WorldBankMarketCapRow[],
  countryMeta: WorldBankCountryMetaRow[]
): WorldBankMarketCapObservation[] {
  const metaByEntityId = new Map(countryMeta.map((m) => [m.entityId, m]));
  const byEntityIdYear = new Map(marketCapRows.map((r) => [`${r.entityId}:${r.year}`, r]));

  return marketCapRows.map((row) => {
    const meta = metaByEntityId.get(row.entityId);
    if (!meta) {
      throw new Error(
        `World Bank API: ${row.entityId} (${row.entityName}) の国/地域メタデータが見つかりません。` +
          "fetchCountryMeta() の取得漏れ、または想定外の新規コードです。"
      );
    }
    const prev = byEntityIdYear.get(`${row.entityId}:${row.year - 1}`);
    const changeFromPreviousYearUsd =
      row.marketCapUsd !== undefined && prev?.marketCapUsd !== undefined
        ? row.marketCapUsd - prev.marketCapUsd
        : undefined;
    return {
      entityId: row.entityId,
      iso3: row.iso3,
      entityName: meta.name,
      isAggregate: meta.isAggregate,
      year: row.year,
      marketCapUsd: row.marketCapUsd,
      changeFromPreviousYearUsd,
    };
  });
}

// ---------------------------------------------------------------------------
// (3) 期間の判定 + 「まだ公表されていない」の判定
// ---------------------------------------------------------------------------

/** この指標の公表周期。観測ログの「対象期間」列は年 (YYYY) の文字列で持つ。 */
export const PERIODICITY = "annual" as const;

/**
 * 特定の国/地域・年について、値が公表済みかどうかを実データから判定する (推測しない)。
 * `entityId` (例 "JP", "1W") で指定する。iso3 は一部の集計行で undefined になりうるため
 * 識別子としては使わない (WorldBankMarketCapObservation.iso3 参照)。
 */
export function isYearPublished(
  observations: WorldBankMarketCapObservation[],
  entityId: string,
  year: number
): boolean {
  const found = observations.find((o) => o.entityId === entityId && o.year === year);
  return found !== undefined && found.marketCapUsd !== undefined;
}

/** 特定の国/地域について、取得済み観測の中で値が入っている最新年を返す (無ければ undefined)。 */
export function latestPublishedYear(
  observations: WorldBankMarketCapObservation[],
  entityId: string
): number | undefined {
  const years = observations
    .filter((o) => o.entityId === entityId && o.marketCapUsd !== undefined)
    .map((o) => o.year);
  return years.length > 0 ? Math.max(...years) : undefined;
}

// ---------------------------------------------------------------------------
// (4) 観測ログ用の縦長レコード出力
// ---------------------------------------------------------------------------

export interface MoneyflowObservationRecord {
  indicatorKey: string;
  /** 対象期間 (年次のため YYYY 形式の文字列) */
  period: string;
  periodType: "annual";
  /** 区分の種類 (計画書の「業種/投資部門/資産クラス/国地域/商品」のうちこの取得元は「国地域」固定) */
  category: "国地域";
  /** 区分の値 (国・地域名) */
  categoryValue: string;
  /** 区分コード (World Bank entityId。常に非空で冪等キーに使える) */
  categoryCode: string;
  /** ISO 3166-1 alpha-3 相当の補助コード。一部の所得階層集計では未割当のため undefined。 */
  iso3: string | undefined;
  isAggregate: boolean;
  value: number | undefined;
  unit: "USD";
  changeFromPreviousPeriod: number | undefined;
  /** 近似フラグ: 残高(ストック)を「世界の概況」の近似指標として使うため常に true */
  isApprox: true;
  /** 実測/推定: World Bank 公式統計をそのまま使うため常に "actual" (モデル推定ではない) */
  measurement: "actual";
  sourceUrl: string;
}

/** (4) 観測ログ書込 (Notion) 用の縦長レコードに変換する純関数。Notion 書込はここでは行わない。 */
export function toObservationRecords(
  observations: WorldBankMarketCapObservation[]
): MoneyflowObservationRecord[] {
  return observations.map((o) => ({
    indicatorKey: WORLDBANK_MARKETCAP_INDICATOR.key,
    period: String(o.year),
    periodType: "annual",
    category: "国地域",
    categoryValue: o.entityName,
    categoryCode: o.entityId,
    iso3: o.iso3,
    isAggregate: o.isAggregate,
    value: o.marketCapUsd,
    unit: "USD",
    changeFromPreviousPeriod: o.changeFromPreviousYearUsd,
    isApprox: true,
    measurement: "actual",
    sourceUrl: WORLDBANK_MARKETCAP_INDICATOR.sourceUrl,
  }));
}

// ---------------------------------------------------------------------------
// ルール6 準備: 一次データアーカイブ入力の組み立て (Notion 書込自体は統合担当が行う)
// ---------------------------------------------------------------------------

export interface WorldBankArchiveInput {
  service: string;
  key: string;
  source: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
}

/** 時価総額取得物のアーカイブ入力。冪等キーは年レンジ単位 (年1回程度しか窓がずれないため十分)。 */
export function worldBankMarketCapArchiveInput(
  fetchResult: WorldBankFetchResult,
  window: WorldBankFetchWindow
): WorldBankArchiveInput {
  assertValidWindow(window);
  return {
    service: "moneyflow",
    key: `worldbank-marketcap-${window.fromYear}-${window.toYear}`,
    source: fetchResult.url,
    metadata: {
      fromYear: window.fromYear,
      toYear: window.toYear,
      bytes: fetchResult.bytes.byteLength,
    },
    files: [
      {
        bytes: fetchResult.bytes,
        filename: `worldbank-marketcap-${window.fromYear}-${window.toYear}.json`,
        contentType: "application/json",
      },
    ],
  };
}

/** 国・地域メタデータ取得物のアーカイブ入力。冪等キーは取得年単位 (分類はほぼ年1回程度しか変わらない)。 */
export function worldBankCountryMetaArchiveInput(
  fetchResult: WorldBankFetchResult,
  asOfYear: number
): WorldBankArchiveInput {
  if (!Number.isInteger(asOfYear)) {
    throw new Error(`World Bank country meta: 不正な年です: ${JSON.stringify(asOfYear)}`);
  }
  return {
    service: "moneyflow",
    key: `worldbank-country-meta-${asOfYear}`,
    source: fetchResult.url,
    metadata: {
      asOfYear,
      bytes: fetchResult.bytes.byteLength,
    },
    files: [
      {
        bytes: fetchResult.bytes,
        filename: `worldbank-country-meta-${asOfYear}.json`,
        contentType: "application/json",
      },
    ],
  };
}
