/**
 * 「資金フロー（個人用）」の Notion 保管 (計画: notion-velvet-goose.md「構成」節)。
 *
 * 親ページは `NOTION_MONEYFLOW_PAGE_ID` (ユーザーが作成し、kabulab-cf の
 * インテグレーションのみを接続する個人用ページ)。この直下に 3 つの単一 DB を
 * 置く (CLAUDE.md ルール6: 銘柄/業種ごとの子ページ・子DBは量産しない):
 *
 *   1. 「資金フロー｜指標定義」 … 指標ごとの定義 (何を測るか・出典・利用条件・
 *      頻度・限界)。1 指標 1 行。`indicators.ts` のカタログを起動時に upsert する。
 *   2. 「資金フロー｜観測ログ」 … 縦長の事実テーブル。冪等キーは
 *      `期間|指標|区分`。「指標」は 1. への relation。
 *   3. 「資金フロー｜取込ログ」 … 1 回の取込実行につき 1 行 (`price-sync-log.ts`
 *      と同じ「1 実行 1 行」の形。upsert キーを持たず常に新規作成する)。
 *
 * 一次データ (取得した原ファイル) は本モジュールではなく
 * `recordPrimaryData({ service: "moneyflow", parentPageId: NOTION_MONEYFLOW_PAGE_ID() })`
 * で「一次データ｜moneyflow」へ記録する (呼び出し元は `services/moneyflow/`)。
 * 「観測ログ」の「一次データ」列はその記録済みページへの relation で、
 * `ensureObservationsDb()` は **「一次データ｜moneyflow」DB が既に存在する
 * こと** (= 呼び出し順序として recordPrimaryData を先に呼んでいること) を
 * 前提にする。無ければ throw する (推測で relation 先を作らない — ルール2)。
 *
 * select 列の選択肢は既存を消さず追加のみ・累積 100 件で throw する
 * (`stock-supplement.ts` の `buildMissingPatch`/`SELECT_OPTIONS_CUMULATIVE_MAX`
 * と同じ設計。「区分」列は Phase 2 以降で投資部門・資産クラス・国地域の値が
 * 積み上がるため、この安全弁を最初から持たせる)。
 */
import { findBackupChildByTitle } from "./archive.js";
import { notionRequest } from "./client.js";
import type { NotionSelectColor } from "./dataset.js";
import { notionEnv } from "./env.js";
import { splitRichText } from "./rich-text.js";

export const MONEYFLOW_DEFS_DB_TITLE = "資金フロー｜指標定義";
export const MONEYFLOW_OBS_DB_TITLE = "資金フロー｜観測ログ";
export const MONEYFLOW_RUNLOG_DB_TITLE = "資金フロー｜取込ログ";
/** `recordPrimaryData({ service: "moneyflow", ... })` が作る一次データ DB のタイトル (archive.ts の命名規約と同一)。 */
export const MONEYFLOW_PRIMARY_DB_TITLE = "一次データ｜moneyflow";

// ---------------------------------------------------------------------------
// 共通: select/multi_select の「足りない列・選択肢だけ足す」パッチ
// (stock-supplement.ts の buildMissingPatch と同じ設計。既存の選択肢は
// 運用者が Notion 上で使っている値なので絶対に消さない)。
// ---------------------------------------------------------------------------

interface NotionPropertyDef {
  id: string;
  type: string;
  select?: { options?: Array<{ name: string }> };
  multi_select?: { options?: Array<{ name: string }> };
}
interface DbSchemaResponse {
  id: string;
  properties: Record<string, NotionPropertyDef>;
}

function optionKindOf(def: unknown): "select" | "multi_select" | undefined {
  const d = def as Record<string, unknown>;
  if (d && typeof d === "object" && "select" in d) return "select";
  if (d && typeof d === "object" && "multi_select" in d) return "multi_select";
  return undefined;
}
function optionsOf(def: unknown, kind: "select" | "multi_select"): Array<{ name: string }> {
  const d = def as Record<string, { options?: Array<{ name: string }> }>;
  return d[kind]?.options ?? [];
}

/** select/multi_select 列に累積してよい選択肢数の安全上限 (stock-supplement.ts と同値)。 */
const SELECT_OPTIONS_CUMULATIVE_MAX = 100;

/**
 * 「足りない列だけ足す」差分パッチを作る (stock-supplement.ts の
 * `buildMissingPatch` と同じロジック)。列自体が無ければ丸ごと追加。
 * select/multi_select は既存の選択肢を保ったまま無い選択肢だけ追加し、
 * 累積数が上限を超えるパッチは送らず throw する。
 */
function buildMissingPatch(
  current: Record<string, NotionPropertyDef>,
  want: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [name, wantDef] of Object.entries(want)) {
    const cur = current[name];
    if (!cur) {
      patch[name] = wantDef;
      continue;
    }
    const kind = optionKindOf(wantDef);
    if (kind && cur.type === kind) {
      const curOptions = optionsOf(cur, kind);
      const wantOptions = optionsOf(wantDef, kind);
      const curNames = new Set(curOptions.map((o) => o.name));
      const missingOptions = wantOptions.filter((o) => !curNames.has(o.name));
      if (missingOptions.length > 0) {
        const cumulative = curOptions.length + missingOptions.length;
        if (cumulative > SELECT_OPTIONS_CUMULATIVE_MAX) {
          throw new Error(
            `moneyflow buildMissingPatch: 列「${name}」の累積選択肢数が上限 ${SELECT_OPTIONS_CUMULATIVE_MAX} を超えます ` +
              `(既存 ${curOptions.length} 件 + 追加 ${missingOptions.length} 件 = ${cumulative} 件)。` +
              `運営判断で Notion 側の不要な選択肢を手動整理するか、区分の追加方針を見直してください。`
          );
        }
        patch[name] = { [kind]: { options: [...curOptions, ...missingOptions] } };
      }
    }
  }
  return patch;
}

function toOptions(names: readonly string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

// ---------------------------------------------------------------------------
// 1. 資金フロー｜指標定義
// ---------------------------------------------------------------------------

/** 何を測るか (フロー/ストックの種別)。誤解を招かないよう指標定義の説明文と対で使う。 */
export type MoneyflowFlowType =
  | "純買い越し"
  | "売買代金"
  | "シェア"
  | "残高"
  | "建玉"
  | "設定解約"
  | "比率"
  | "推定";
export type MoneyflowFrequency = "日次" | "週次" | "月次" | "不定期";
export type MoneyflowLicense = "personal-only" | "attribution-required" | "public-domain";
export type MoneyflowRequirement = "R1" | "R2" | "R3" | "R4";

const FLOW_TYPE_VALUES: readonly MoneyflowFlowType[] = [
  "純買い越し",
  "売買代金",
  "シェア",
  "残高",
  "建玉",
  "設定解約",
  "比率",
  "推定",
];
const FREQUENCY_VALUES: readonly MoneyflowFrequency[] = ["日次", "週次", "月次", "不定期"];
const LICENSE_VALUES: readonly MoneyflowLicense[] = [
  "personal-only",
  "attribution-required",
  "public-domain",
];
const REQUIREMENT_VALUES: readonly MoneyflowRequirement[] = ["R1", "R2", "R3", "R4"];

const FLOW_TYPE_OPTIONS: Array<{ name: MoneyflowFlowType; color: NotionSelectColor }> = [
  { name: "純買い越し", color: "blue" },
  { name: "売買代金", color: "default" },
  { name: "シェア", color: "default" },
  { name: "残高", color: "gray" },
  { name: "建玉", color: "gray" },
  { name: "設定解約", color: "purple" },
  { name: "比率", color: "default" },
  { name: "推定", color: "orange" },
];
const FREQUENCY_OPTIONS: Array<{ name: MoneyflowFrequency; color: NotionSelectColor }> = [
  { name: "日次", color: "green" },
  { name: "週次", color: "blue" },
  { name: "月次", color: "purple" },
  { name: "不定期", color: "gray" },
];
const LICENSE_OPTIONS: Array<{ name: MoneyflowLicense; color: NotionSelectColor }> = [
  { name: "personal-only", color: "red" },
  { name: "attribution-required", color: "orange" },
  { name: "public-domain", color: "green" },
];
const REQUIREMENT_OPTIONS: Array<{ name: MoneyflowRequirement; color: NotionSelectColor }> = [
  { name: "R1", color: "blue" },
  { name: "R2", color: "purple" },
  { name: "R3", color: "pink" },
  { name: "R4", color: "yellow" },
];

export function isMoneyflowFlowType(v: string): v is MoneyflowFlowType {
  return (FLOW_TYPE_VALUES as readonly string[]).includes(v);
}
export function isMoneyflowFrequency(v: string): v is MoneyflowFrequency {
  return (FREQUENCY_VALUES as readonly string[]).includes(v);
}
export function isMoneyflowLicense(v: string): v is MoneyflowLicense {
  return (LICENSE_VALUES as readonly string[]).includes(v);
}
export function isMoneyflowRequirement(v: string): v is MoneyflowRequirement {
  return (REQUIREMENT_VALUES as readonly string[]).includes(v);
}

export const MONEYFLOW_DEFS_PROPS = {
  key: "指標キー",
  displayName: "表示名",
  requirement: "要件",
  flowType: "何を測るか",
  description: "説明",
  sourceUrl: "出典URL",
  license: "利用条件",
  frequency: "頻度",
  limitations: "限界",
} as const;

function buildDefsDbProperties(): Record<string, unknown> {
  return {
    [MONEYFLOW_DEFS_PROPS.key]: { title: {} },
    [MONEYFLOW_DEFS_PROPS.displayName]: { rich_text: {} },
    [MONEYFLOW_DEFS_PROPS.requirement]: { select: { options: REQUIREMENT_OPTIONS } },
    [MONEYFLOW_DEFS_PROPS.flowType]: { select: { options: FLOW_TYPE_OPTIONS } },
    [MONEYFLOW_DEFS_PROPS.description]: { rich_text: {} },
    [MONEYFLOW_DEFS_PROPS.sourceUrl]: { url: {} },
    [MONEYFLOW_DEFS_PROPS.license]: { select: { options: LICENSE_OPTIONS } },
    [MONEYFLOW_DEFS_PROPS.frequency]: { select: { options: FREQUENCY_OPTIONS } },
    [MONEYFLOW_DEFS_PROPS.limitations]: { rich_text: {} },
  };
}

let cachedDefsDbId: string | null = null;

/**
 * 「資金フロー｜指標定義」DB を確保する (無ければ作成、あれば不足列/選択肢だけ足す)。
 * 発見順: `NOTION_MONEYFLOW_DEFS_DB_ID` (固定) → Search 完全一致 → 新規作成
 * (`stock-supplement.ts` の `ensureSupplementDb` と同じ流儀)。
 */
export async function ensureIndicatorDefsDb(): Promise<{ dbId: string }> {
  if (cachedDefsDbId) return { dbId: cachedDefsDbId };
  const want = buildDefsDbProperties();

  let dbId = notionEnv.NOTION_MONEYFLOW_DEFS_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
      title: MONEYFLOW_DEFS_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const created = await notionRequest<DbSchemaResponse>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_MONEYFLOW_PAGE_ID() },
      title: [{ type: "text", text: { content: MONEYFLOW_DEFS_DB_TITLE } }],
      properties: want,
    });
    cachedDefsDbId = created.id;
    return { dbId: created.id };
  }

  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const patch = buildMissingPatch(schema.properties, want);
  if (Object.keys(patch).length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, { properties: patch });
  }
  cachedDefsDbId = dbId;
  return { dbId };
}

export interface IndicatorDefInput {
  key: string;
  displayName: string;
  requirement: MoneyflowRequirement;
  flowType: MoneyflowFlowType;
  /** 平易な説明 + 正確な定義 (誤解しやすい点は明示的に否定する)。長文は自動分割。 */
  description: string;
  sourceUrl: string;
  license: MoneyflowLicense;
  frequency: MoneyflowFrequency;
  /** 何が測れないか・近似の限界。 */
  limitations: string;
}

interface QueryResponse {
  results: Array<{ id: string }>;
}

async function findDefRowByKey(dbId: string, key: string): Promise<string | null> {
  const res = await notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, {
    filter: { property: MONEYFLOW_DEFS_PROPS.key, title: { equals: key } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

function buildDefRowProperties(input: IndicatorDefInput): Record<string, unknown> {
  return {
    [MONEYFLOW_DEFS_PROPS.key]: { title: [{ text: { content: input.key } }] },
    [MONEYFLOW_DEFS_PROPS.displayName]: { rich_text: splitRichText(input.displayName) },
    [MONEYFLOW_DEFS_PROPS.requirement]: { select: { name: input.requirement } },
    [MONEYFLOW_DEFS_PROPS.flowType]: { select: { name: input.flowType } },
    [MONEYFLOW_DEFS_PROPS.description]: { rich_text: splitRichText(input.description) },
    [MONEYFLOW_DEFS_PROPS.sourceUrl]: { url: input.sourceUrl },
    [MONEYFLOW_DEFS_PROPS.license]: { select: { name: input.license } },
    [MONEYFLOW_DEFS_PROPS.frequency]: { select: { name: input.frequency } },
    [MONEYFLOW_DEFS_PROPS.limitations]: { rich_text: splitRichText(input.limitations) },
  };
}

export interface UpsertIndicatorDefResult {
  pageId: string;
  outcome: "created" | "updated";
}

/** 指標キーで upsert する (`indicators.ts` のカタログを起動時に同期する用)。 */
export async function upsertIndicatorDef(
  dbId: string,
  input: IndicatorDefInput
): Promise<UpsertIndicatorDefResult> {
  const props = buildDefRowProperties(input);
  const existing = await findDefRowByKey(dbId, input.key);
  if (existing) {
    await notionRequest("PATCH", `/pages/${existing}`, { properties: props });
    return { pageId: existing, outcome: "updated" };
  }
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: props,
  });
  return { pageId: created.id, outcome: "created" };
}

// ---------------------------------------------------------------------------
// 2. 資金フロー｜観測ログ
// ---------------------------------------------------------------------------

export type MoneyflowCategoryKind = "業種" | "投資部門" | "資産クラス" | "国地域";
export type MoneyflowUnit = "円" | "比率" | "件" | "社";
export type MoneyflowMeasureKind = "実測" | "推定";

const CATEGORY_KIND_VALUES: readonly MoneyflowCategoryKind[] = ["業種", "投資部門", "資産クラス", "国地域"];
const UNIT_VALUES: readonly MoneyflowUnit[] = ["円", "比率", "件", "社"];
const MEASURE_KIND_VALUES: readonly MoneyflowMeasureKind[] = ["実測", "推定"];

const CATEGORY_KIND_OPTIONS: Array<{ name: MoneyflowCategoryKind; color: NotionSelectColor }> = [
  { name: "業種", color: "blue" },
  { name: "投資部門", color: "purple" },
  { name: "資産クラス", color: "pink" },
  { name: "国地域", color: "yellow" },
];
const UNIT_OPTIONS: Array<{ name: MoneyflowUnit; color: NotionSelectColor }> = [
  { name: "円", color: "default" },
  { name: "比率", color: "default" },
  { name: "件", color: "default" },
  { name: "社", color: "default" },
];
const MEASURE_KIND_OPTIONS: Array<{ name: MoneyflowMeasureKind; color: NotionSelectColor }> = [
  { name: "実測", color: "green" },
  { name: "推定", color: "orange" },
];

export function isMoneyflowCategoryKind(v: string): v is MoneyflowCategoryKind {
  return (CATEGORY_KIND_VALUES as readonly string[]).includes(v);
}
export function isMoneyflowUnit(v: string): v is MoneyflowUnit {
  return (UNIT_VALUES as readonly string[]).includes(v);
}
export function isMoneyflowMeasureKind(v: string): v is MoneyflowMeasureKind {
  return (MEASURE_KIND_VALUES as readonly string[]).includes(v);
}

export const MONEYFLOW_OBS_PROPS = {
  /** title。冪等キー `期間|指標キー|区分` */
  key: "キー",
  indicator: "指標",
  period: "対象期間",
  periodStart: "期間開始",
  periodEnd: "期間終了",
  category: "区分",
  categoryKind: "区分種別",
  value: "値",
  unit: "単位",
  changeFromPrev: "前期比",
  approximate: "近似フラグ",
  measureKind: "実測推定",
  primaryData: "一次データ",
} as const;

function buildObsDbProperties(args: {
  defsDbId: string;
  primaryDataDbId: string;
  categoryOptions: readonly string[];
}): Record<string, unknown> {
  return {
    [MONEYFLOW_OBS_PROPS.key]: { title: {} },
    [MONEYFLOW_OBS_PROPS.indicator]: {
      relation: { database_id: args.defsDbId, type: "single_property", single_property: {} },
    },
    [MONEYFLOW_OBS_PROPS.period]: { rich_text: {} },
    [MONEYFLOW_OBS_PROPS.periodStart]: { date: {} },
    [MONEYFLOW_OBS_PROPS.periodEnd]: { date: {} },
    [MONEYFLOW_OBS_PROPS.category]: { select: { options: toOptions(args.categoryOptions) } },
    [MONEYFLOW_OBS_PROPS.categoryKind]: { select: { options: CATEGORY_KIND_OPTIONS } },
    [MONEYFLOW_OBS_PROPS.value]: { number: {} },
    [MONEYFLOW_OBS_PROPS.unit]: { select: { options: UNIT_OPTIONS } },
    [MONEYFLOW_OBS_PROPS.changeFromPrev]: { number: {} },
    [MONEYFLOW_OBS_PROPS.approximate]: { checkbox: {} },
    [MONEYFLOW_OBS_PROPS.measureKind]: { select: { options: MEASURE_KIND_OPTIONS } },
    [MONEYFLOW_OBS_PROPS.primaryData]: {
      relation: { database_id: args.primaryDataDbId, type: "single_property", single_property: {} },
    },
  };
}

let cachedObsDbId: string | null = null;

/**
 * 「資金フロー｜観測ログ」DB を確保する。
 *
 * @param categoryOptions 「区分」列に事前登録しておく選択肢 (例: JPX 33 業種名)。
 *   既存の選択肢は消さず追加のみ (累積 100 件で throw)。
 *
 * @throws 「一次データ｜moneyflow」DB がまだ存在しない場合 (この DB の
 *   「一次データ」relation 列の作成に必要。呼び出し順序として、その回の
 *   取込で `recordPrimaryData({ service: "moneyflow", ... })` を先に
 *   呼んでいることが前提 — 推測で relation 先を作らない、ルール2)。
 */
export async function ensureObservationsDb(
  categoryOptions: readonly string[]
): Promise<{ dbId: string }> {
  const { dbId: defsDbId } = await ensureIndicatorDefsDb();

  const primaryDataDbId = await findBackupChildByTitle({
    parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
    title: MONEYFLOW_PRIMARY_DB_TITLE,
    kind: "database",
  });
  if (!primaryDataDbId) {
    throw new Error(
      `ensureObservationsDb: 「${MONEYFLOW_PRIMARY_DB_TITLE}」DB がまだ存在しません。` +
        `recordPrimaryData({ service: "moneyflow", parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID() }) を` +
        `先に呼んで一次データを記録してください (観測ログの「一次データ」列は relation のため、` +
        `関連先 DB が実在しないと作成できません)。`
    );
  }

  const want = buildObsDbProperties({ defsDbId, primaryDataDbId, categoryOptions });

  if (cachedObsDbId) {
    // 既にキャッシュ済みでも「区分」の新規選択肢だけは毎回追いつかせる
    // (Phase 2 以降で投資部門/資産クラス/国地域の値が増える前提)。
    const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${cachedObsDbId}`);
    const patch = buildMissingPatch(schema.properties, want);
    if (Object.keys(patch).length > 0) {
      await notionRequest("PATCH", `/databases/${cachedObsDbId}`, { properties: patch });
    }
    return { dbId: cachedObsDbId };
  }

  let dbId = notionEnv.NOTION_MONEYFLOW_OBS_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
      title: MONEYFLOW_OBS_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const created = await notionRequest<DbSchemaResponse>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_MONEYFLOW_PAGE_ID() },
      title: [{ type: "text", text: { content: MONEYFLOW_OBS_DB_TITLE } }],
      properties: want,
    });
    cachedObsDbId = created.id;
    return { dbId: created.id };
  }

  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const patch = buildMissingPatch(schema.properties, want);
  if (Object.keys(patch).length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, { properties: patch });
  }
  cachedObsDbId = dbId;
  return { dbId };
}

export interface ObservationInput {
  /** 対象期間の表示ラベル (例: "2026-W38"、月次なら "2026-08" 等)。 */
  period: string;
  periodStart: string;
  periodEnd: string;
  /** 冪等キーの一部として使う指標キー (`IndicatorDefInput.key` と同じ値)。 */
  indicatorKey: string;
  /** upsertIndicatorDef の結果 pageId (「指標」relation の値)。 */
  indicatorPageId: string;
  category: string;
  categoryKind: MoneyflowCategoryKind;
  value: number;
  unit: MoneyflowUnit;
  /** 前期比。求まらない (初回等) 場合は null (捏造しない)。 */
  changeFromPrev: number | null;
  approximate: boolean;
  measureKind: MoneyflowMeasureKind;
  /** この観測が由来する一次データの Notion ページ ID。単一ファイルに紐付かない
   *  (例: D1 集計から直接算出した観測) 場合は null。 */
  primaryDataPageId: string | null;
}

/** 冪等キー `期間|指標キー|区分` を組み立てる。 */
export function observationKey(input: Pick<ObservationInput, "period" | "indicatorKey" | "category">): string {
  return `${input.period}|${input.indicatorKey}|${input.category}`;
}

function buildObsRowProperties(input: ObservationInput): Record<string, unknown> {
  return {
    [MONEYFLOW_OBS_PROPS.key]: { title: [{ text: { content: observationKey(input) } }] },
    [MONEYFLOW_OBS_PROPS.indicator]: { relation: [{ id: input.indicatorPageId }] },
    [MONEYFLOW_OBS_PROPS.period]: { rich_text: splitRichText(input.period) },
    [MONEYFLOW_OBS_PROPS.periodStart]: { date: { start: input.periodStart } },
    [MONEYFLOW_OBS_PROPS.periodEnd]: { date: { start: input.periodEnd } },
    [MONEYFLOW_OBS_PROPS.category]: { select: { name: input.category } },
    [MONEYFLOW_OBS_PROPS.categoryKind]: { select: { name: input.categoryKind } },
    [MONEYFLOW_OBS_PROPS.value]: { number: input.value },
    [MONEYFLOW_OBS_PROPS.unit]: { select: { name: input.unit } },
    [MONEYFLOW_OBS_PROPS.changeFromPrev]: { number: input.changeFromPrev },
    [MONEYFLOW_OBS_PROPS.approximate]: { checkbox: input.approximate },
    [MONEYFLOW_OBS_PROPS.measureKind]: { select: { name: input.measureKind } },
    [MONEYFLOW_OBS_PROPS.primaryData]: {
      relation: input.primaryDataPageId ? [{ id: input.primaryDataPageId }] : [],
    },
  };
}

async function findObsRowByKey(dbId: string, key: string): Promise<string | null> {
  const res = await notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, {
    filter: { property: MONEYFLOW_OBS_PROPS.key, title: { equals: key } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

export interface UpsertObservationResult {
  pageId: string;
  outcome: "created" | "updated";
}

/** 冪等キー `期間|指標|区分` で upsert する。 */
export async function upsertObservation(
  dbId: string,
  input: ObservationInput
): Promise<UpsertObservationResult> {
  const key = observationKey(input);
  const props = buildObsRowProperties(input);
  const existing = await findObsRowByKey(dbId, key);
  if (existing) {
    await notionRequest("PATCH", `/pages/${existing}`, { properties: props });
    return { pageId: existing, outcome: "updated" };
  }
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: props,
  });
  return { pageId: created.id, outcome: "created" };
}

// ---------------------------------------------------------------------------
// 3. 資金フロー｜取込ログ
// ---------------------------------------------------------------------------

export type MoneyflowRunStatus = "完了" | "一部失敗" | "失敗";
const RUN_STATUS_VALUES: readonly MoneyflowRunStatus[] = ["完了", "一部失敗", "失敗"];
const RUN_STATUS_OPTIONS: Array<{ name: MoneyflowRunStatus; color: NotionSelectColor }> = [
  { name: "完了", color: "green" },
  { name: "一部失敗", color: "orange" },
  { name: "失敗", color: "red" },
];

export function isMoneyflowRunStatus(v: string): v is MoneyflowRunStatus {
  return (RUN_STATUS_VALUES as readonly string[]).includes(v);
}

export const MONEYFLOW_RUNLOG_PROPS = {
  /** title。実行のたびに新規作成するので ISO 8601 の実行時刻を使う。 */
  runAt: "実行日時",
  status: "状態",
  sources: "対象取得元",
  successCount: "成功件数",
  failedCount: "失敗件数",
  runUrl: "実行URL",
  reason: "失敗理由",
} as const;

function buildRunLogDbProperties(): Record<string, unknown> {
  return {
    [MONEYFLOW_RUNLOG_PROPS.runAt]: { title: {} },
    [MONEYFLOW_RUNLOG_PROPS.status]: { select: { options: RUN_STATUS_OPTIONS } },
    [MONEYFLOW_RUNLOG_PROPS.sources]: { rich_text: {} },
    [MONEYFLOW_RUNLOG_PROPS.successCount]: { number: {} },
    [MONEYFLOW_RUNLOG_PROPS.failedCount]: { number: {} },
    [MONEYFLOW_RUNLOG_PROPS.runUrl]: { url: {} },
    [MONEYFLOW_RUNLOG_PROPS.reason]: { rich_text: {} },
  };
}

let cachedRunLogDbId: string | null = null;

/**
 * 「資金フロー｜取込ログ」DB を確保する。発見順は他の 2 DB と同じ
 * (固定 ID → Search 完全一致 → 新規作成)。
 */
export async function ensureRunLogDb(): Promise<{ dbId: string }> {
  if (cachedRunLogDbId) return { dbId: cachedRunLogDbId };
  const want = buildRunLogDbProperties();

  let dbId = notionEnv.NOTION_MONEYFLOW_RUNLOG_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_MONEYFLOW_PAGE_ID(),
      title: MONEYFLOW_RUNLOG_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const created = await notionRequest<DbSchemaResponse>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_MONEYFLOW_PAGE_ID() },
      title: [{ type: "text", text: { content: MONEYFLOW_RUNLOG_DB_TITLE } }],
      properties: want,
    });
    cachedRunLogDbId = created.id;
    return { dbId: created.id };
  }

  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const patch = buildMissingPatch(schema.properties, want);
  if (Object.keys(patch).length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, { properties: patch });
  }
  cachedRunLogDbId = dbId;
  return { dbId };
}

export interface RunLogInput {
  runAt: string;
  status: MoneyflowRunStatus;
  /** 今回実行した取得元 (カンマ区切り。例 "jpx-sector-marketcap,jpx-short-selling")。 */
  sources: string;
  successCount: number;
  failedCount: number;
  runUrl: string | null;
  /** 失敗理由 (成功時は null)。 */
  reason: string | null;
}

function richTextValue(value: string | null): { rich_text: unknown[] } {
  if (value === null || value === "") return { rich_text: [] };
  return { rich_text: splitRichText(value) };
}

/**
 * 1 回の取込実行結果を「資金フロー｜取込ログ」DB へ新規 1 行として記録する。
 * upsert キーを持たない (`price-sync-log.ts` の「取引日不明」行と同じ設計:
 * 実行のたびに新しい行を作り、運営が個別に実行を追えるようにする)。
 */
export async function recordRunLog(
  dbId: string,
  input: RunLogInput
): Promise<{ pageId: string }> {
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: {
      [MONEYFLOW_RUNLOG_PROPS.runAt]: { title: [{ text: { content: input.runAt } }] },
      [MONEYFLOW_RUNLOG_PROPS.status]: { select: { name: input.status } },
      [MONEYFLOW_RUNLOG_PROPS.sources]: { rich_text: splitRichText(input.sources) },
      [MONEYFLOW_RUNLOG_PROPS.successCount]: { number: input.successCount },
      [MONEYFLOW_RUNLOG_PROPS.failedCount]: { number: input.failedCount },
      [MONEYFLOW_RUNLOG_PROPS.runUrl]: { url: input.runUrl },
      [MONEYFLOW_RUNLOG_PROPS.reason]: richTextValue(input.reason),
    },
  });
  return { pageId: created.id };
}

