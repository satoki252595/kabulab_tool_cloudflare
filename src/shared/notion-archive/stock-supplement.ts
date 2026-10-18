/**
 * 「銘柄マスタ（補足）」の Notion 保管 (005 yuho-quant 事業タグ)。
 * 設計: docs/005-yuho-quant-business-tags.md §3.1。
 *
 * 1 銘柄 1 行。有報の開示テキスト (39 列。列名は
 * `TEXT_SECTIONS` が正本 — 本モジュールは列名を受け取るだけで知らない) +
 * 事業タグ判定の結果・状態を持つ。スキーマは「足りない列だけ足す」
 * (`dataset.ts` の `ensureChildDb` と同じ流儀。既存の選択肢は消さない)。
 *
 * 親は「株式情報」ページ (`NOTION_STOCK_INFO_PAGE_ID`)。探索は Search の
 * 完全一致 + 親ページ一致 + 最古優先 (`archive.ts` の `findBackupChildByTitle`
 * を汎用パラメータのまま流用。P6 重複事件の教訓)。
 *
 * 欠損は欠損のまま (ルール2): 判定できていない列は `null`/未設定のまま送る。
 * 架空値・既定値で埋めない。
 */
import {
  recordPrimaryData,
  createDatabaseOrAdopt,
  findBackupChildByTitle,
  findUniqueBackupChildByTitle,
} from "./archive.js";
import { assertCursorProgress, notionRequest, NotionUnknownResultError } from "./client.js";
import type { NotionSelectColor } from "./dataset.js";
import { notionEnv } from "./env.js";
import { verifyArchivedAttachments } from "./readback.js";
import { canonicalizeForHash } from "./biztag-ledger.js";
import { sha256Hex } from "../sha256.js";
import { RICH_TEXT_MAX, joinRichText, splitRichText } from "./rich-text.js";
import { NotionConfigError } from "./env.js";
import { parseStockCode } from "../jpx/stock-code.js";

export const SUPPLEMENT_DB_TITLE = "銘柄マスタ（補足）";

/** 列キー (ドメイン語) → Notion 列名 (日本語)。設計書 §3.1 の表そのもの。 */
export const SUPPLEMENT_PROPS = {
  name: "銘柄名",
  code: "銘柄コード",
  master: "銘柄マスタ",
  sector33: "33業種",
  docId: "有報書類ID",
  docType: "書類種別",
  periodEnd: "会計期末",
  submittedAt: "提出日",
  textStatus: "本文の状態",
  upstream: "事業タグ（素材・部品・装置）",
  downstream: "事業タグ（製品・サービス）",
  distribution: "事業タグ（流通・サービス）",
  themes: "投資テーマ",
  uncertain: "要確認タグ",
  evidenceText: "事業タグの根拠文",
  tagStatus: "事業タグの状態",
  tagDoc: "事業タグの根拠書類",
  vocabVersion: "単語帳の版",
  judgedAt: "事業タグ判定日",
  candidateCount: "候補語数",
  judgeInput: "判定入力",
  error: "判定エラー",
  attempts: "再試行回数",
  nextRetryAt: "次回再試行日",
} as const;

export type TextStatus = "取得済" | "本文なし" | "読込失敗";
export type TagStatus = "判定済" | "本文なし" | "読込失敗" | "判定不能" | "未判定";
export type DocTypeLabel = "有報" | "訂正有報";

const TEXT_STATUS_VALUES: readonly TextStatus[] = ["取得済", "本文なし", "読込失敗"];
const TAG_STATUS_VALUES: readonly TagStatus[] = [
  "判定済",
  "本文なし",
  "読込失敗",
  "判定不能",
  "未判定",
];
const DOC_TYPE_VALUES: readonly DocTypeLabel[] = ["有報", "訂正有報"];

export interface SupplementSchemaSpec {
  /** 開示テキスト列 (`TEXT_SECTIONS` の項目名そのまま)。呼び出し側が正本を持つ */
  textColumns: string[];
  upstreamOptions: string[];
  downstreamOptions: string[];
  distributionOptions: string[];
  themeOptions: string[];
  versionOptions: string[];
  sector33Options: string[];
}

// Status は運用者が状態を一目で追えるよう色を固定する (archive.ts と同じ方針)。
const TEXT_STATUS_OPTIONS: Array<{ name: TextStatus; color: NotionSelectColor }> = [
  { name: "取得済", color: "green" },
  { name: "本文なし", color: "gray" },
  { name: "読込失敗", color: "red" },
];
const TAG_STATUS_OPTIONS: Array<{ name: TagStatus; color: NotionSelectColor }> = [
  { name: "判定済", color: "green" },
  { name: "本文なし", color: "gray" },
  { name: "読込失敗", color: "red" },
  { name: "判定不能", color: "orange" },
  { name: "未判定", color: "default" },
];
const DOC_TYPE_OPTIONS: Array<{ name: DocTypeLabel; color: NotionSelectColor }> = [
  { name: "有報", color: "blue" },
  { name: "訂正有報", color: "purple" },
];

function toOptions(names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

/** DB プロパティ定義一式 (作成時 POST body / 差分検査の「あるべき姿」) */
function buildDbProperties(spec: SupplementSchemaSpec): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [SUPPLEMENT_PROPS.name]: { title: {} },
    [SUPPLEMENT_PROPS.code]: { rich_text: {} },
    [SUPPLEMENT_PROPS.master]: {
      relation: {
        database_id: notionEnv.NOTION_DB_STOCK_MASTER(),
        type: "single_property",
        single_property: {},
      },
    },
    [SUPPLEMENT_PROPS.sector33]: {
      select: { options: toOptions(spec.sector33Options) },
    },
    [SUPPLEMENT_PROPS.docId]: { rich_text: {} },
    [SUPPLEMENT_PROPS.docType]: { select: { options: DOC_TYPE_OPTIONS } },
    [SUPPLEMENT_PROPS.periodEnd]: { date: {} },
    [SUPPLEMENT_PROPS.submittedAt]: { date: {} },
    [SUPPLEMENT_PROPS.textStatus]: { select: { options: TEXT_STATUS_OPTIONS } },
    [SUPPLEMENT_PROPS.upstream]: {
      multi_select: { options: toOptions(spec.upstreamOptions) },
    },
    [SUPPLEMENT_PROPS.downstream]: {
      multi_select: { options: toOptions(spec.downstreamOptions) },
    },
    [SUPPLEMENT_PROPS.distribution]: {
      multi_select: { options: toOptions(spec.distributionOptions) },
    },
    [SUPPLEMENT_PROPS.themes]: {
      multi_select: { options: toOptions(spec.themeOptions) },
    },
    [SUPPLEMENT_PROPS.uncertain]: { rich_text: {} },
    [SUPPLEMENT_PROPS.evidenceText]: { rich_text: {} },
    [SUPPLEMENT_PROPS.tagStatus]: { select: { options: TAG_STATUS_OPTIONS } },
    [SUPPLEMENT_PROPS.tagDoc]: { rich_text: {} },
    [SUPPLEMENT_PROPS.vocabVersion]: {
      select: { options: toOptions(spec.versionOptions) },
    },
    [SUPPLEMENT_PROPS.judgedAt]: { date: {} },
    [SUPPLEMENT_PROPS.candidateCount]: { number: {} },
    [SUPPLEMENT_PROPS.judgeInput]: { rich_text: {} },
    [SUPPLEMENT_PROPS.error]: { rich_text: {} },
    [SUPPLEMENT_PROPS.attempts]: { number: {} },
    [SUPPLEMENT_PROPS.nextRetryAt]: { date: {} },
  };
  for (const col of spec.textColumns) {
    // 開示テキスト列名が固定列名と衝突することは無い前提 (TEXT_SECTIONS 側で
    // 担保)。衝突した場合は固定列の定義を優先して上書きしない方が安全なため
    // 固定列を先に置き、あとから text 列で上書きしない (in 演算子で確認)。
    if (!(col in props)) props[col] = { rich_text: {} };
  }
  return props;
}

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

function optionsOf(
  def: unknown,
  kind: "select" | "multi_select"
): Array<{ name: string }> {
  const d = def as Record<string, { options?: Array<{ name: string }> }>;
  return d[kind]?.options ?? [];
}

/**
 * select/multi_select 列に累積してよい選択肢数の安全上限。
 *
 * 単語帳側の `validateVocabulary`(`NOTION_OPTIONS_PER_COLUMN_MAX=100`)は
 * **廃止していない語だけ**を数えて列ごと 100 語以内かを検査するが、この
 * `buildMissingPatch` は既存の選択肢を絶対に消さない設計 (運用者が Notion 上で
 * 使っている値を壊さないため) のため、廃止済みの語の選択肢名も Notion の
 * スキーマには永久に残り続ける。つまり年次見直しで語を廃止して入れ替える
 * たびに、Notion 側の実際の選択肢数は「非廃止のみ 100 件以内」という単語帳側の
 * 検査をすり抜けて増え続ける (廃止 0 件の v1 時点で upstream/downstream は
 * 既に 96/100 まで来ており、次の見直しでの入れ替えでほぼ確実に超過する)。
 * ここで累積数そのものに同じ 100 を安全上限として課し、超えるパッチは
 * 送らずに throw する (Notion 側の実スキーマが黙って肥大化する/次回の
 * PATCH が Notion 側で拒否されるのを未然に防ぐ — ルール2: 運営が気づける
 * 形で早期に失敗する)。
 */
const SELECT_OPTIONS_CUMULATIVE_MAX = 100;

/**
 * 「足りない列だけ足す」差分パッチを作る。
 * - 列自体が無ければ丸ごと追加。
 * - select/multi_select は既存の選択肢を保ったまま、無い選択肢だけ追加する
 *   (既存の選択肢は絶対に消さない — 運用者が Notion 上で使っている値を壊さない)。
 *   ただし追加後の累積選択肢数が `SELECT_OPTIONS_CUMULATIVE_MAX` を超える
 *   ときは、その列へのパッチを送らず throw する (上のコメント参照)。
 * - それ以外の型 (rich_text/date/number/title/relation) は既存があれば触らない。
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
            `buildMissingPatch: 列「${name}」の累積選択肢数が上限 ${SELECT_OPTIONS_CUMULATIVE_MAX} を超えます ` +
              `(既存 ${curOptions.length} 件 + 追加 ${missingOptions.length} 件 = ${cumulative} 件)。` +
              `廃止済みの語の選択肢は既存値保護のため自動では削除しない設計のため、運営判断で` +
              `Notion 側の不要な選択肢を手動整理するか、単語帳の廃止方針を見直してください。`
          );
        }
        patch[name] = { [kind]: { options: [...curOptions, ...missingOptions] } };
      }
    }
  }
  return patch;
}

function extractIds(properties: Record<string, NotionPropertyDef>): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.id]));
}

/** プロセス内キャッシュ (探索コスト削減。スキーマ完全性チェックは毎回行う) */
let cachedDbId: string | null = null;

/**
 * 「銘柄マスタ（補足）」DB を確保する (無ければ作成、あれば不足列だけ足す)。
 * 発見順: `NOTION_STOCK_SUPPLEMENT_DB_ID` (固定) → Search 完全一致 → 新規作成。
 */
export async function ensureSupplementDb(
  spec: SupplementSchemaSpec
): Promise<{ dbId: string; created: boolean; propertyIds: Record<string, string> }> {
  const want = buildDbProperties(spec);

  let dbId = cachedDbId ?? notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_STOCK_INFO_PAGE_ID(),
      title: SUPPLEMENT_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const res = await createDatabaseOrAdopt<DbSchemaResponse>(
      {
        parent: { type: "page_id", page_id: notionEnv.NOTION_STOCK_INFO_PAGE_ID() },
        title: [{ type: "text", text: { content: SUPPLEMENT_DB_TITLE } }],
        properties: want,
      },
      () =>
        findUniqueBackupChildByTitle({
          parentPageId: notionEnv.NOTION_STOCK_INFO_PAGE_ID(),
          title: SUPPLEMENT_DB_TITLE,
          kind: "database",
        })
    );
    if (res.created && res.response) {
      cachedDbId = res.id;
      return { dbId: res.id, created: true, propertyIds: extractIds(res.response.properties) };
    }
    // adopted → 下の schema 検証へ進む (同名の古い DB かもしれないため)。
    dbId = res.id;
  }

  cachedDbId = dbId;
  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const patch = buildMissingPatch(schema.properties, want);
  if (Object.keys(patch).length === 0) {
    return { dbId, created: false, propertyIds: extractIds(schema.properties) };
  }
  const patched = await notionRequest<DbSchemaResponse>("PATCH", `/databases/${dbId}`, {
    properties: patch,
  });
  return { dbId, created: false, propertyIds: extractIds(patched.properties) };
}

export interface SupplementRow {
  pageId: string;
  stockCode: string;
  companyName: string;
  sector33: string | null;
  docId: string | null;
  docType: DocTypeLabel | null;
  periodEnd: string | null;
  submittedAt: string | null;
  textStatus: TextStatus | null;
  tagStatus: TagStatus | null;
  tagDoc: string | null;
  vocabVersion: string | null;
  judgedAt: string | null;
  candidateCount: number | null;
  /** 既存の判定入力列。旧unit行の未読取はundefinedであり、新規判定の証明ではない。 */
  judgeInput?: string | null;
  attempts: number | null;
  nextRetryAt: string | null;
  error: string | null;
  upstream: string[];
  downstream: string[];
  distribution: string[];
  themes: string[];
  uncertain: string | null;
  evidenceText: string | null;
  masterLinked: boolean;
  /** 要求した開示テキスト列だけ (呼び出し側が `opts.textColumns` で指定した分) */
  texts: Record<string, string>;
}

interface NotionPageProperty {
  type?: string;
  has_more?: boolean;
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  multi_select?: Array<{ name: string }>;
  date?: { start?: string } | null;
  number?: number | null;
  relation?: Array<{ id: string }>;
}
interface NotionPage {
  id: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { type?: string; database_id?: string };
  properties: Record<string, NotionPageProperty>;
}
interface QueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

function readTitle(p: NotionPageProperty | undefined): string {
  return (p?.title ?? []).map((t) => t.plain_text ?? "").join("");
}
function readRich(p: NotionPageProperty | undefined): string {
  return joinRichText(p?.rich_text);
}
function readDate(p: NotionPageProperty | undefined): string | null {
  return p?.date?.start ?? null;
}
function readNumber(p: NotionPageProperty | undefined): number | null {
  return typeof p?.number === "number" ? p.number : null;
}
function readMultiSelect(p: NotionPageProperty | undefined): string[] {
  return (p?.multi_select ?? []).map((o) => o.name);
}
function readSelectEnum<T extends string>(
  p: NotionPageProperty | undefined,
  allowed: readonly T[],
  columnLabel: string
): T | null {
  const name = p?.select?.name;
  if (name === undefined || name === null) return null;
  if (!(allowed as readonly string[]).includes(name)) {
    throw new Error(`loadSupplementRows: 想定外の${columnLabel}の値です: ${name}`);
  }
  return name as T;
}

function parseSupplementRow(page: NotionPage, textColumns: string[]): SupplementRow {
  const p = page.properties;
  const texts: Record<string, string> = {};
  for (const col of textColumns) {
    texts[col] = readRich(p[col]);
  }
  return {
    pageId: page.id,
    stockCode: readRich(p[SUPPLEMENT_PROPS.code]),
    companyName: readTitle(p[SUPPLEMENT_PROPS.name]),
    sector33: p[SUPPLEMENT_PROPS.sector33]?.select?.name ?? null,
    docId: readRich(p[SUPPLEMENT_PROPS.docId]) || null,
    docType: readSelectEnum(p[SUPPLEMENT_PROPS.docType], DOC_TYPE_VALUES, "書類種別"),
    periodEnd: readDate(p[SUPPLEMENT_PROPS.periodEnd]),
    submittedAt: readDate(p[SUPPLEMENT_PROPS.submittedAt]),
    textStatus: readSelectEnum(p[SUPPLEMENT_PROPS.textStatus], TEXT_STATUS_VALUES, "本文の状態"),
    tagStatus: readSelectEnum(p[SUPPLEMENT_PROPS.tagStatus], TAG_STATUS_VALUES, "事業タグの状態"),
    tagDoc: readRich(p[SUPPLEMENT_PROPS.tagDoc]) || null,
    vocabVersion: p[SUPPLEMENT_PROPS.vocabVersion]?.select?.name ?? null,
    judgedAt: readDate(p[SUPPLEMENT_PROPS.judgedAt]),
    candidateCount: readNumber(p[SUPPLEMENT_PROPS.candidateCount]),
    judgeInput: readRich(p[SUPPLEMENT_PROPS.judgeInput]) || null,
    attempts: readNumber(p[SUPPLEMENT_PROPS.attempts]),
    nextRetryAt: readDate(p[SUPPLEMENT_PROPS.nextRetryAt]),
    error: readRich(p[SUPPLEMENT_PROPS.error]) || null,
    upstream: readMultiSelect(p[SUPPLEMENT_PROPS.upstream]),
    downstream: readMultiSelect(p[SUPPLEMENT_PROPS.downstream]),
    distribution: readMultiSelect(p[SUPPLEMENT_PROPS.distribution]),
    themes: readMultiSelect(p[SUPPLEMENT_PROPS.themes]),
    uncertain: readRich(p[SUPPLEMENT_PROPS.uncertain]) || null,
    evidenceText: readRich(p[SUPPLEMENT_PROPS.evidenceText]) || null,
    masterLinked: (p[SUPPLEMENT_PROPS.master]?.relation ?? []).length > 0,
    texts,
  };
}

function buildFilterPropertiesQs(
  propertyIds: Record<string, string>,
  columnNames: string[]
): string {
  const ids = columnNames.map((name) => {
    const id = propertyIds[name];
    if (!id) {
      throw new Error(`loadSupplementRows: プロパティ ID が見つかりません: ${name}`);
    }
    return id;
  });
  return ids.map((id) => `filter_properties=${encodeURIComponent(id)}`).join("&");
}

/**
 * 「銘柄マスタ（補足）」の行を読む。`filter_properties` で必要な列だけ
 * 取得しコストを抑える (公式 `POST /v1/databases/{id}/query` のクエリ
 * パラメータ)。銘柄コードの重複は判断を委ねず throw する (ルール2)。
 */
export async function loadSupplementRows(
  dbId: string,
  propertyIds: Record<string, string>,
  opts?: { textColumns?: string[]; codes?: string[]; strictNative?: boolean; beforeRequest?: () => void }
): Promise<SupplementRow[]> {
  const textColumns = opts?.textColumns ?? [];
  const columnNames = [...Object.values(SUPPLEMENT_PROPS), ...textColumns];
  const qs = buildFilterPropertiesQs(propertyIds, columnNames);

  const rows: SupplementRow[] = [];
  const codeToPageIds = new Map<string, string[]>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (opts?.codes && opts.codes.length > 0) {
      body.filter = {
        or: opts.codes.map((code) => ({
          property: SUPPLEMENT_PROPS.code,
          rich_text: { equals: code },
        })),
      };
    }
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<QueryResponse>(
      "POST",
      `/databases/${dbId}/query?${qs}`,
      body,
      opts?.beforeRequest === undefined ? undefined : { beforeRequest: opts.beforeRequest }
    );
    if (res.has_more === true) {
      assertCursorProgress(seen, res.next_cursor as string);
    }
    for (const page of res.results) {
      if (opts?.strictNative) assertCompleteSupplementPage(page, dbId, textColumns);
      const row = parseSupplementRow(page, textColumns);
      rows.push(row);
      const ids = codeToPageIds.get(row.stockCode) ?? [];
      ids.push(row.pageId);
      codeToPageIds.set(row.stockCode, ids);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  const dupCodes = [...codeToPageIds.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([code]) => code);
  if (dupCodes.length > 0) {
    throw new Error(
      `loadSupplementRows: 銘柄コードが重複しています (${dupCodes.join(", ")})`
    );
  }
  return rows;
}

/** 長文の未完/未知形状を空文字へ読み替えない。既存readerの明示strict経路だけに適用。 */
export function assertCompleteSupplementPage(page: NotionPage, dbId: string, textColumns: string[]): void {
  const stop = (): never => { throw new NotionConfigError("補足のnative行・長文が未完/不正です。準備を停止します"); };
  if (typeof page.id !== "string" || page.id.length === 0 || page.archived !== false || page.in_trash !== false ||
      page.parent?.type !== "database_id" || page.parent.database_id?.replaceAll("-", "") !== dbId.replaceAll("-", "")) stop();
  const rich = [SUPPLEMENT_PROPS.code, SUPPLEMENT_PROPS.docId, SUPPLEMENT_PROPS.tagDoc, SUPPLEMENT_PROPS.judgeInput,
    SUPPLEMENT_PROPS.uncertain, SUPPLEMENT_PROPS.evidenceText, SUPPLEMENT_PROPS.error, ...textColumns];
  for (const name of rich) {
    const p = page.properties[name];
    if (p?.type !== "rich_text" || p.has_more === true || !Array.isArray(p.rich_text) ||
        p.rich_text.some(v => typeof v.plain_text !== "string")) stop();
  }
  const title = page.properties[SUPPLEMENT_PROPS.name];
  if (title?.type !== "title" || title.has_more === true || !Array.isArray(title.title) || title.title.some(v => typeof v.plain_text !== "string")) stop();
  for (const name of [SUPPLEMENT_PROPS.upstream, SUPPLEMENT_PROPS.downstream, SUPPLEMENT_PROPS.distribution, SUPPLEMENT_PROPS.themes]) {
    const p = page.properties[name];
    if (p?.type !== "multi_select" || !Array.isArray(p.multi_select) || p.multi_select.some(v => typeof v.name !== "string")) stop();
  }
  for (const name of [SUPPLEMENT_PROPS.sector33, SUPPLEMENT_PROPS.docType, SUPPLEMENT_PROPS.textStatus, SUPPLEMENT_PROPS.tagStatus, SUPPLEMENT_PROPS.vocabVersion]) {
    const p = page.properties[name];
    if (p?.type !== "select" || !(p.select === null || typeof p.select?.name === "string")) stop();
  }
  for (const name of [SUPPLEMENT_PROPS.periodEnd, SUPPLEMENT_PROPS.submittedAt, SUPPLEMENT_PROPS.judgedAt, SUPPLEMENT_PROPS.nextRetryAt]) {
    const p = page.properties[name];
    if (p?.type !== "date" || !(p.date === null || typeof p.date?.start === "string")) stop();
  }
  for (const name of [SUPPLEMENT_PROPS.candidateCount, SUPPLEMENT_PROPS.attempts]) {
    const p = page.properties[name];
    if (p?.type !== "number" || !(p.number === null || typeof p.number === "number" && Number.isFinite(p.number))) stop();
  }
}

/**
 * ① 銘柄マスタ (`NOTION_DB_STOCK_MASTER`) から 銘柄コード → ページ ID の
 * 索引を作る (`銘柄マスタ（補足）` の relation 先解決用)。
 *
 * 同じ銘柄コードの行が複数あるコード (① 側のデータ不備。2026-09-25 実測で 7129・3681)
 * は、どれかを黙って選ばず (ルール2) 索引から外して `duplicates` に返す。呼び出し側は
 * その銘柄の relation を空のままにし、件数を運営に見せる。relation は閲覧用の
 * つながりなので、1 件の不備で全銘柄の処理を止めない。
 */
export interface StockMasterIndex {
  /** 一意に決まる銘柄コード → ① のページ ID */
  index: Map<string, string>;
  /** 複数行ある銘柄コード → 該当する ① のページ ID 群 */
  duplicates: Map<string, string[]>;
}

export async function loadStockMasterIndex(codes?: readonly string[]): Promise<StockMasterIndex> {
  let scopes: Array<readonly string[] | undefined> = [undefined];
  if (codes !== undefined) {
    if (!Array.isArray(codes) || codes.length === 0 || new Set(codes).size !== codes.length ||
        Array.from(codes).some(code => typeof code !== "string" || parseStockCode(code) !== code)) {
      throw new NotionConfigError("銘柄マスタの限定読取には空でない一意な正準コード一覧が必要です");
    }
    scopes = Array.from({ length: Math.ceil(codes.length / 50) }, (_, i) => codes.slice(i * 50, (i + 1) * 50));
  }
  const dbId = notionEnv.NOTION_DB_STOCK_MASTER();
  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const entry = Object.entries(schema.properties).find(([name]) => name === "銘柄コード");
  if (!entry) {
    throw new Error(
      `loadStockMasterIndex: 銘柄マスタ DB に「銘柄コード」列が見つかりません (dbId=${dbId})`
    );
  }
  const [, propDef] = entry;
  if (codes !== undefined && (typeof propDef.id !== "string" || propDef.id.length === 0 ||
      propDef.type !== "rich_text" && propDef.type !== "title")) throw new NotionConfigError("銘柄マスタのコード列型が不正です");
  const qs = `filter_properties=${encodeURIComponent(propDef.id)}`;

  const pagesByCode = new Map<string, string[]>();
  for (const scope of scopes) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (;;) {
      const body: Record<string, unknown> = { page_size: 100 };
      if (scope !== undefined) body.filter = { or: scope.map(code => ({ property: "銘柄コード", [propDef.type]: { equals: code } })) };
      if (cursor) body.start_cursor = cursor;
      const res = await notionRequest<QueryResponse>(
        "POST",
        `/databases/${dbId}/query?${qs}`,
        body
      );
      if (scope !== undefined && (!Array.isArray(res.results) || typeof res.has_more !== "boolean" ||
          (res.has_more ? typeof res.next_cursor !== "string" || res.next_cursor.length === 0 : res.next_cursor !== null))) {
        throw new NotionConfigError("銘柄マスタ限定queryのpaginationが不正です");
      }
      if (res.has_more === true) {
        assertCursorProgress(seen, res.next_cursor as string);
      }
      for (const page of res.results) {
        const prop = page.properties["銘柄コード"];
        const code = scope === undefined ? readRich(prop) || readTitle(prop) : propDef.type === "rich_text" ? readRich(prop) : readTitle(prop);
        if (scope !== undefined) {
          const parts = propDef.type === "rich_text" ? prop?.rich_text : prop?.title;
          if (typeof page.id !== "string" || page.id.length === 0 || prop?.type !== propDef.type || prop.has_more === true ||
              !Array.isArray(parts) || parts.some(part => typeof part.plain_text !== "string") || !scope.includes(code) || parseStockCode(code) !== code) {
            throw new NotionConfigError("銘柄マスタ限定queryが対象外/不正の行を返しました");
          }
        }
        if (!code) continue;
        const pages = pagesByCode.get(code);
        if (pages) pages.push(page.id);
        else pagesByCode.set(code, [page.id]);
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
  }
  const index = new Map<string, string>();
  const duplicates = new Map<string, string[]>();
  for (const [code, pages] of pagesByCode) {
    if (pages.length === 1) index.set(code, pages[0]);
    else duplicates.set(code, pages);
  }
  return { index, duplicates };
}

export interface SupplementRowInput {
  companyName?: string;
  stockCode?: string;
  masterPageId?: string | null;
  sector33?: string | null;
  docId?: string | null;
  docType?: DocTypeLabel | null;
  periodEnd?: string | null;
  submittedAt?: string | null;
  textStatus?: TextStatus;
  /** 列名(開示テキスト項目名) → 原文全文。Notion本文表示だけU+200Bを除く。null/""はクリア */
  texts?: Record<string, string | null>;
  upstream?: string[];
  downstream?: string[];
  distribution?: string[];
  themes?: string[];
  uncertain?: string | null;
  /** 「はい」「要確認」タグごとの根拠文 (§3.1)。タグが空/再判定でクリアされる時は null。 */
  evidenceText?: string | null;
  tagStatus?: TagStatus;
  tagDoc?: string | null;
  vocabVersion?: string | null;
  judgedAt?: string | null;
  candidateCount?: number | null;
  judgeInput?: string | null;
  error?: string | null;
  attempts?: number | null;
  nextRetryAt?: string | null;
}

/** 1 行の multi_select に許す値の最大数 (安全側の防御的上限) */
const ROW_MULTI_SELECT_MAX = 100;
/** 1 プロパティの rich_text 要素数上限 (超える = 200,000 字超。実測上あり得ない) */
const ROW_RICH_TEXT_SEGMENTS_MAX = 100;

/**
 * Notion は select/multi_select の選択肢名にカンマを許さない (公式: "Commas are not
 * allowed")。半角「,」と全角「，」を弾く。読点「、」はカンマではなく、Notion も受け付ける
 * (実例: 33業種「証券、商品先物取引業」。① 銘柄マスタもこの名前の選択肢を持つ)。
 * 2026-09-25 の全件処理で「、」まで弾いて証券会社 33 社が失敗したため直した。
 * 単語帳のラベルで「、」も禁止しているのは単語帳側の規則 (validate.ts) で、こことは別。
 */
function assertNoComma(name: string, columnLabel: string): void {
  if (name.includes(",") || name.includes("，")) {
    throw new Error(
      `buildSupplementProperties: 選択肢名にカンマは使えません (${columnLabel}): ${name}`
    );
  }
}

function richTextValue(value: string, columnLabel: string): { rich_text: unknown[] } {
  const chunks = splitRichText(value, RICH_TEXT_MAX);
  if (chunks.length > ROW_RICH_TEXT_SEGMENTS_MAX) {
    throw new Error(
      `buildSupplementProperties: 「${columnLabel}」が rich_text ${ROW_RICH_TEXT_SEGMENTS_MAX} 要素を超えます (${chunks.length} 要素・${value.length} 字)`
    );
  }
  return { rich_text: chunks };
}
function clearableRichText(
  value: string | null | undefined,
  columnLabel: string
): { rich_text: unknown[] } {
  if (value === null || value === undefined || value === "") return { rich_text: [] };
  return richTextValue(value, columnLabel);
}
function selectValue(
  columnLabel: string,
  name: string | null
): { select: { name: string } | null } {
  if (name === null) return { select: null };
  assertNoComma(name, columnLabel);
  return { select: { name } };
}
function multiSelectValue(
  columnLabel: string,
  values: string[]
): { multi_select: Array<{ name: string }> } {
  if (values.length > ROW_MULTI_SELECT_MAX) {
    throw new Error(
      `buildSupplementProperties: 「${columnLabel}」の選択肢が ${ROW_MULTI_SELECT_MAX} 件を超えます (${values.length} 件)`
    );
  }
  for (const v of values) assertNoComma(v, columnLabel);
  return { multi_select: values.map((name) => ({ name })) };
}
function dateValue(value: string | null): { date: { start: string } | null } {
  return { date: value === null ? null : { start: value } };
}
function numberValue(value: number | null): { number: number | null } {
  return { number: value };
}
function relationValue(pageId: string | null | undefined): { relation: Array<{ id: string }> } {
  return { relation: pageId ? [{ id: pageId }] : [] };
}

/**
 * ドメイン入力 → Notion プロパティペイロード (純粋関数)。
 * `undefined` のフィールドはペイロードから省略 (既存値を変えない)。
 * `null` は明示的にクリアする (ルール2: 黙って既定値で埋めない代わりに、
 * 「値が無い」という事実を明示的に書く)。
 *
 * **フィールドの並び順が壊れやすい不変条件を守っている**: `chunkPropertiesByBytes`
 * は `Object.entries(props)` の順に貪欲に詰めるため、1 要求 (400KB) に収まらない
 * ときは並び順どおりに複数の PATCH に分割される (§3.1「本文列は…複数の PATCH に
 * 分ける」)。途中の PATCH で中断される (GH Actions の強制終了等) と、それより前の
 * 並びのプロパティだけが確定した状態になりうる。`有報書類ID`(docId) が
 * `事業タグの状態`(tagStatus)/`事業タグの根拠書類`(tagDoc)/`単語帳の版`
 * (vocabVersion) より先に確定すると、「docId は新しい書類を指すのに tagStatus/
 * tagDoc は古い書類のまま」という**不変条件違反の状態**が生まれ、かつ
 * `docId` が最新と一致してしまうため `planWork` の差分検知(`row.docId !==
 * doc.docId`)が二度と拾えず、恒久的に取り残される (docs §3.1 不変条件)。
 * そのため `docId`/`docType`/`periodEnd`/`submittedAt` は、この書類に関する
 * 判定結果一式 (`tagStatus`/`tagDoc`/`vocabVersion` および判定メタ情報) と
 * まとめて **最後** に書く。中断が起きても「書類の入れ替わりだけが先に見える」
 * 状態を作らない (中断前の状態のまま = 次回の `planWork` が正しく再処理する)。
 */
/** 本文列の送信表現だけを揃える。原文mapや他metadataへは適用しない。 */
export function normalizeSupplementText(value: string | null): string | null {
  return typeof value === "string" ? value.replaceAll("\u200B", "") : value;
}

export function buildSupplementProperties(
  input: SupplementRowInput
): Record<string, unknown> {
  const props: Record<string, unknown> = {};

  if (input.companyName !== undefined) {
    props[SUPPLEMENT_PROPS.name] = { title: splitRichText(input.companyName) };
  }
  if (input.stockCode !== undefined) {
    props[SUPPLEMENT_PROPS.code] = richTextValue(input.stockCode, SUPPLEMENT_PROPS.code);
  }
  if (input.masterPageId !== undefined) {
    props[SUPPLEMENT_PROPS.master] = relationValue(input.masterPageId);
  }
  if (input.sector33 !== undefined) {
    props[SUPPLEMENT_PROPS.sector33] = selectValue(SUPPLEMENT_PROPS.sector33, input.sector33);
  }
  if (input.textStatus !== undefined) {
    props[SUPPLEMENT_PROPS.textStatus] = selectValue(
      SUPPLEMENT_PROPS.textStatus,
      input.textStatus
    );
  }
  if (input.texts !== undefined) {
    for (const [col, value] of Object.entries(input.texts)) {
      // Notionは本文rich_textのU+200Bを保存時に除去する（9273/S100Z2Z6実native）。
      // 表示本文だけ同じ送信表現へ揃える。raw/source物理・入力map・同期/判定SHAと
      // judgeInput/根拠/他metadataは変更せず、可視文字の読戻し照合も緩めない。
      props[col] = clearableRichText(normalizeSupplementText(value), col);
    }
  }
  if (input.upstream !== undefined) {
    props[SUPPLEMENT_PROPS.upstream] = multiSelectValue(SUPPLEMENT_PROPS.upstream, input.upstream);
  }
  if (input.downstream !== undefined) {
    props[SUPPLEMENT_PROPS.downstream] = multiSelectValue(
      SUPPLEMENT_PROPS.downstream,
      input.downstream
    );
  }
  if (input.distribution !== undefined) {
    props[SUPPLEMENT_PROPS.distribution] = multiSelectValue(
      SUPPLEMENT_PROPS.distribution,
      input.distribution
    );
  }
  if (input.themes !== undefined) {
    props[SUPPLEMENT_PROPS.themes] = multiSelectValue(SUPPLEMENT_PROPS.themes, input.themes);
  }
  if (input.uncertain !== undefined) {
    props[SUPPLEMENT_PROPS.uncertain] = clearableRichText(
      input.uncertain,
      SUPPLEMENT_PROPS.uncertain
    );
  }
  if (input.evidenceText !== undefined) {
    props[SUPPLEMENT_PROPS.evidenceText] = clearableRichText(
      input.evidenceText,
      SUPPLEMENT_PROPS.evidenceText
    );
  }
  if (input.candidateCount !== undefined) {
    props[SUPPLEMENT_PROPS.candidateCount] = numberValue(input.candidateCount);
  }
  if (input.judgeInput !== undefined) {
    props[SUPPLEMENT_PROPS.judgeInput] = clearableRichText(
      input.judgeInput,
      SUPPLEMENT_PROPS.judgeInput
    );
  }
  // ここから下 (書類の同定 + 判定結果の確定) は、途中で中断されても不変条件を
  // 壊さないよう常に最後の 1 グループとしてまとめて書く (コメント参照)。
  if (input.docId !== undefined) {
    props[SUPPLEMENT_PROPS.docId] = clearableRichText(input.docId, SUPPLEMENT_PROPS.docId);
  }
  if (input.docType !== undefined) {
    props[SUPPLEMENT_PROPS.docType] = selectValue(SUPPLEMENT_PROPS.docType, input.docType);
  }
  if (input.periodEnd !== undefined) {
    props[SUPPLEMENT_PROPS.periodEnd] = dateValue(input.periodEnd);
  }
  if (input.submittedAt !== undefined) {
    props[SUPPLEMENT_PROPS.submittedAt] = dateValue(input.submittedAt);
  }
  if (input.tagStatus !== undefined) {
    props[SUPPLEMENT_PROPS.tagStatus] = selectValue(SUPPLEMENT_PROPS.tagStatus, input.tagStatus);
  }
  if (input.tagDoc !== undefined) {
    props[SUPPLEMENT_PROPS.tagDoc] = clearableRichText(input.tagDoc, SUPPLEMENT_PROPS.tagDoc);
  }
  if (input.vocabVersion !== undefined) {
    props[SUPPLEMENT_PROPS.vocabVersion] = selectValue(
      SUPPLEMENT_PROPS.vocabVersion,
      input.vocabVersion
    );
  }
  if (input.judgedAt !== undefined) {
    props[SUPPLEMENT_PROPS.judgedAt] = dateValue(input.judgedAt);
  }
  if (input.error !== undefined) {
    props[SUPPLEMENT_PROPS.error] = clearableRichText(input.error, SUPPLEMENT_PROPS.error);
  }
  if (input.attempts !== undefined) {
    props[SUPPLEMENT_PROPS.attempts] = numberValue(input.attempts);
  }
  if (input.nextRetryAt !== undefined) {
    props[SUPPLEMENT_PROPS.nextRetryAt] = dateValue(input.nextRetryAt);
  }

  return props;
}

/**
 * プロパティの束を 1 要求あたりのバイト上限 (既定 400,000B。Notion の
 * 500KB/要求上限に安全マージンを見た値) 以下に分割する。単一プロパティが
 * 上限を超える場合は分割不能なため throw する (欠落させて黙って続行しない)。
 */
export function chunkPropertiesByBytes(
  props: Record<string, unknown>,
  maxBytes = 400_000
): Record<string, unknown>[] {
  const entries = Object.entries(props);
  if (entries.length === 0) return [];
  const encoder = new TextEncoder();
  const chunks: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = {};
  let currentBytes = 0;
  for (const [key, value] of entries) {
    const entryBytes = encoder.encode(JSON.stringify({ [key]: value })).length;
    if (entryBytes > maxBytes) {
      throw new Error(
        `chunkPropertiesByBytes: プロパティ「${key}」が上限 ${maxBytes} バイトを超えています (${entryBytes} バイト)`
      );
    }
    if (Object.keys(current).length > 0 && currentBytes + entryBytes > maxBytes) {
      chunks.push(current);
      current = {};
      currentBytes = 0;
    }
    current[key] = value;
    currentBytes += entryBytes;
  }
  chunks.push(current);
  return chunks;
}

/**
 * 行を新規作成する。プロパティが 1 要求に収まらない場合は最初の断片で
 * ページを作り、残りを PATCH で追い足す (500KB/要求上限対策)。
 */
export async function createSupplementRow(
  dbId: string,
  input: SupplementRowInput,
  evidence: unknown | null | undefined,
  journal: SupplementPublicationJournal
): Promise<string> {
  if (!journal || typeof journal.assertReady !== "function" || typeof journal.reserveCreate !== "function") throw new NotionConfigError("補足createのdurable journalがありません");
  journal.assertReady();
  if (typeof dbId !== "string" || dbId.length === 0 || typeof input.stockCode !== "string" || input.stockCode.length === 0 ||
      !(input.docId === null || typeof input.docId === "string" && input.docId.length > 0)) throw new NotionConfigError("補足createのDB/銘柄/原文書資格がありません");
  if (evidence !== undefined && evidence !== null) evidenceValue(evidence);
  const props = buildSupplementProperties(input);
  const [first, ...rest] = chunkPropertiesByBytes(props);
  const body: Record<string, unknown> = {
    parent: { database_id: dbId },
    properties: first ?? {},
  };
  if (evidence !== undefined && evidence !== null) {
    body.children = [evidence];
  }
  const target = { ...body, properties: props };
  const publication = journal.reserveCreate({ dbId, stockCode: input.stockCode, nextDocId: input.docId,
    snapshot: JSON.stringify(canonicalizeForHash(target)) });
  try {
    const created = await notionRequest<{ id: string }>("POST", "/pages", body, { singleAttempt: true });
    if (typeof created.id !== "string" || created.id.length === 0) throw new Error("補足create ACKのIDがありません");
    for (const part of rest) await notionRequest("PATCH", `/pages/${created.id}`, { properties: part }, { singleAttempt: true });
    const after = await evidencePage(created.id);
    const parent = (after as unknown as { parent?: { database_id?: string } }).parent;
    if (typeof parent?.database_id !== "string" || parent.database_id.replaceAll("-", "").toLowerCase() !== dbId.replaceAll("-", "").toLowerCase()) throw new Error("補足createのDB読戻し不一致");
    for (const [name, expected] of Object.entries(props)) if (JSON.stringify(propertyValue(after.properties[name])) !== JSON.stringify(propertyValue(expected))) throw new Error(`補足createの全文読戻し不一致: ${name}`);
    const children = await evidenceChildren(created.id);
    if (children.length !== (evidence === null || evidence === undefined ? 0 : 1) || children.some(child => JSON.stringify(evidenceValue(child)) !== JSON.stringify(evidenceValue(evidence)))) throw new Error("補足createの根拠読戻し不一致");
    publication.complete({ pageId: created.id, postPageSha256: await sha256Hex(JSON.stringify(canonicalizeForHash(after))) });
    return created.id;
  } catch (cause) {
    throw new NotionUnknownResultError("補足createの結果確認が未完。別PRE/新runで再作成せずintentと現値を照合してください", { cause });
  }
}

/** 既存行を更新する。プロパティが無ければ何もしない。 */
export async function updateSupplementRow(
  pageId: string,
  input: SupplementRowInput
): Promise<void> {
  const props = buildSupplementProperties(input);
  const chunks = chunkPropertiesByBytes(props);
  for (const part of chunks) {
    await notionRequest("PATCH", `/pages/${pageId}`, { properties: part });
  }
}

export const EVIDENCE_TITLE_PREFIX = "事業タグの根拠";

export type EvidenceItem = {
  labelJa: string;
  sentences: Array<{ text: string; sectionTitle: string }>;
} & ({ band: "yes" | "uncertain"; probability: number } | { band: "keyword" });
export interface EvidenceBlockInput {
  vocabVersion: string;
  docId: string;
  /** 例: "2025年3月期" */
  periodLabel: string;
  items: EvidenceItem[];
}

/** 1 根拠見出しに置ける quote 子ブロックの上限 (100 ブロック/追記の公式上限) */
const EVIDENCE_CHILDREN_MAX = 100;

/**
 * 行のページ本文に置く「事業タグの根拠」ブロックを組み立てる (純粋関数)。
 * トグル見出し (heading_3, is_toggleable) の下に語ごとの quote ブロック。
 */
export function buildEvidenceBlock(input: EvidenceBlockInput): unknown {
  if (input.items.length > EVIDENCE_CHILDREN_MAX) {
    throw new Error(
      `buildEvidenceBlock: 根拠の語数が ${EVIDENCE_CHILDREN_MAX} を超えます (${input.items.length} 件)`
    );
  }
  const heading = `${EVIDENCE_TITLE_PREFIX}（単語帳 ${input.vocabVersion}・有報 ${input.docId} ${input.periodLabel}）`;
  const children = input.items.map((item) => {
    const firstLine =
      item.band === "keyword"
        ? `${item.labelJa}（キーワード一致）`
        : item.band === "yes"
        ? `${item.labelJa}（はい ${item.probability.toFixed(2)}）`
        : `要確認: ${item.labelJa}（確認不能 ${item.probability.toFixed(2)}）`;
    const lines = [
      firstLine,
      ...item.sentences.map(
        (s) => `「${s.text}」 — 有報 ${input.docId} ${input.periodLabel}「${s.sectionTitle}」`
      ),
    ];
    return {
      object: "block",
      type: "quote",
      quote: { rich_text: splitRichText(lines.join("\n")) },
    };
  });
  return {
    object: "block",
    type: "heading_3",
    heading_3: {
      rich_text: [{ type: "text", text: { content: heading } }],
      is_toggleable: true,
      children,
    },
  };
}

interface ChildBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}
interface ChildrenResponse {
  results: ChildBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

async function evidenceChildren(parentId: string, depth = 0): Promise<ChildBlock[]> {
  if (depth > 4) throw new Error("事業タグ根拠の子階層が想定を超過 (旧根拠保持)");
  const out: ChildBlock[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const r = await notionRequest<ChildrenResponse>("GET", `/blocks/${parentId}/children${qs}`);
    if (!Array.isArray(r.results)) throw new Error("事業タグ根拠の読取形式が不正");
    for (const block of r.results) {
      const b = { ...block };
      if (b.has_children) {
        const body = b[b.type] as Record<string, unknown>;
        b[b.type] = { ...body, children: await evidenceChildren(b.id, depth + 1) };
      }
      out.push(b);
    }
    if (!r.has_more) break;
    assertCursorProgress(seen, r.next_cursor as string);
    cursor = r.next_cursor as string;
  }
  return out;
}

function richPlain(value: unknown): string {
  if (!Array.isArray(value)) throw new Error("事業タグのrich_textが欠落");
  return value.map((x: { plain_text?: unknown; text?: { content?: unknown } }) => {
    const text = typeof x.plain_text === "string" ? x.plain_text : x.text?.content;
    if (typeof text !== "string") throw new Error("事業タグのrich_textが不正");
    if (typeof x.plain_text === "string" && typeof x.text?.content === "string" && x.plain_text !== x.text.content) {
      throw new Error("事業タグのrich_textが不一致");
    }
    return text;
  }).join("");
}

function evidenceValue(block: unknown): unknown {
  const b = block as { type: string; [key: string]: unknown };
  if (b.type !== "heading_3" && b.type !== "quote") throw new Error("事業タグ根拠の種類が不正");
  const body = b[b.type] as { rich_text: unknown; is_toggleable?: boolean; children?: unknown[] };
  return { type: b.type, text: richPlain(body.rich_text),
    ...(b.type === "heading_3" ? { toggle: body.is_toggleable, children: (body.children === undefined ? [] : body.children).map(evidenceValue) } : {}) };
}

function propertyValue(property: unknown): unknown {
  if (property === null || typeof property !== "object") throw new Error("補足プロパティが欠落");
  const p = property as Record<string, unknown>;
  if ("rich_text" in p) return richPlain(p.rich_text);
  if ("title" in p) return richPlain(p.title);
  if ("select" in p) return p.select === null ? null : (p.select as { name: string }).name;
  if ("multi_select" in p) return (p.multi_select as { name: string }[]).map((v) => v.name).sort();
  if ("relation" in p) return (p.relation as { id: string }[]).map((v) => v.id.replaceAll("-", "").toLowerCase()).sort();
  if ("number" in p) return p.number;
  if ("date" in p) {
    if (p.date === null) return null;
    const d = (p.date as { start: string }).start;
    return d.includes("T") ? new Date(d).toISOString() : d;
  }
  throw new Error("補足プロパティの読戻し型が不正");
}

interface EvidencePage {
  id: string;
  request_id?: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  properties: Record<string, Record<string, unknown>>;
}

async function evidencePage(pageId: string, beforeRequest?: () => void): Promise<EvidencePage> {
  const page = await notionRequest<EvidencePage>("GET", `/pages/${pageId}`, undefined, { beforeRequest });
  // Notionの読取ごとに変わる通信ID。業務値・実編集メタデータは保持する。
  delete page.request_id;
  if (typeof page.id !== "string" || page.id.replaceAll("-", "").toLowerCase() !== pageId.replaceAll("-", "").toLowerCase() ||
      typeof page.last_edited_time !== "string" || page.archived === true || page.in_trash === true || !page.properties) {
    throw new Error("補足行のPRE/読戻しが不正");
  }
  for (const property of Object.values(page.properties)) {
    const kind = "rich_text" in property ? "rich_text" : "title" in property ? "title" : "relation" in property ? "relation" : null;
    if (kind === null || !Array.isArray(property[kind]) || ((property[kind] as unknown[]).length < 25 && property.has_more !== true)) continue;
    if (typeof property.id !== "string") throw new Error("補足の長いプロパティIDが欠落");
    const values: unknown[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const qs = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : "?page_size=100";
      const r = await notionRequest<{ results: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null }>(
        "GET", `/pages/${pageId}/properties/${encodeURIComponent(property.id)}${qs}`, undefined, { beforeRequest });
      if (!Array.isArray(r.results) || r.results.some((v) => !(kind in v))) throw new Error("補足の全プロパティ読取が不正");
      values.push(...r.results.map((v) => v[kind]));
      if (!r.has_more) break;
      assertCursorProgress(seen, r.next_cursor as string);
      cursor = r.next_cursor as string;
    }
    property[kind] = values;
  }
  return page;
}

/** 既存publisherと同じ長文paginationで現在39列を読む。時計だけで未変更とは判定しない。 */
export async function readSupplementRowFully(pageId: string, dbId: string, textColumns: string[], beforeRequest: () => void): Promise<SupplementRow> {
  const page = await evidencePage(pageId, beforeRequest);
  // evidencePageはhas_moreを含む全長propertyを最終cursorまで展開済み。旧publisherのPRE形は変えない。
  for (const property of Object.values(page.properties)) if (property.has_more === true) property.has_more = false;
  assertCompleteSupplementPage(page as unknown as NotionPage, dbId, textColumns);
  return parseSupplementRow(page as unknown as NotionPage, textColumns);
}

/** writeより前に資格/旧値の変更を検出。unknown mutationとは区別する。 */
export class SupplementWriteHeldError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SupplementWriteHeldError"; }
}

/** Node production supplies the same durable sink for every normal publisher call. */
export interface SupplementPublicationJournal {
  assertReady(): void;
  /** Explicit reconciliation additionally binds the normal planner's current source pointer. */
  bindSource?(input: { stockCode: string; docId: string | null; sourcePageId: string | null }): void;
  /** Creation has no previous page ID; bind the actual target before the first POST. */
  reserveCreate?(input: { dbId: string; stockCode: string; nextDocId: string | null; snapshot: string }): {
    complete(output: { pageId: string; postPageSha256: string }): void;
  };
  reserve(input: { pageId: string; nextDocId: string | null; archiveKey: string; snapshot: string }): {
    /** Explicit, once-only reconciliation of a PRE archive POST; never an unknown business write. */
    preArchive?: { pageId: string; createRequest: SupplementPreArchiveRequest; beforeWrite(): Promise<void> };
    complete(output: { archivePageId: string; postPageSha256: string }): void;
  };
}

export interface SupplementPreArchiveRequest {
  parent: { database_id: string };
  properties: Record<string, Record<string, unknown>>;
}

/** Read only: unique original key, exact submitted metadata and full physical PRE. No adoption/write. */
export async function verifySupplementPreArchive(pageId: string, archiveKey: string, snapshot: string, request: SupplementPreArchiveRequest): Promise<void> {
  const fail = (): never => { throw new SupplementWriteHeldError("明示PRE照合のkey/主体/metadata/実体が不一致。未閉鎖intentを保持"); };
  const query = await notionRequest<{ results: Array<{ id: string }>; has_more: boolean; next_cursor: string | null }>(
    "POST", `/databases/${request.parent.database_id}/query`, { filter: { property: "Key", title: { equals: archiveKey } }, page_size: 2 }, { singleAttempt: true });
  if (!Array.isArray(query.results) || query.has_more !== false || query.next_cursor !== null || query.results.length !== 1 || query.results[0].id !== pageId) fail();
  const page = await evidencePage(pageId) as EvidencePage & { parent: { database_id: string }; object: string };
  if (page.object !== "page" || page.archived !== false || page.in_trash !== false || page.parent.database_id.replaceAll("-", "") !== request.parent.database_id.replaceAll("-", "")) fail();
  for (const name of ["Key", "Service", "Source", "Status", "Metadata"]) {
    if (JSON.stringify(propertyValue(page.properties[name])) !== JSON.stringify(propertyValue(request.properties[name]))) fail();
  }
  if (propertyValue(page.properties.Key) !== archiveKey || propertyValue(page.properties.Service) !== "yuho-quant" || propertyValue(page.properties.Status) !== "recorded") fail();
  const submitted = Date.parse(propertyValue(request.properties["Fetched At"]) as string), current = Date.parse(propertyValue(page.properties["Fetched At"]) as string);
  if (!Number.isFinite(submitted) || !Number.isFinite(current) || current !== submitted && current !== Math.floor(submitted / 60_000) * 60_000) fail();
  const metadata = JSON.parse(propertyValue(page.properties.Metadata) as string);
  if (metadata.sha256 !== await sha256Hex(snapshot) || metadata.pageId === undefined || metadata.nextDocId === undefined ||
      metadata._fileManifest?.version !== 1 || typeof metadata._fileManifest.inputFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(metadata._fileManifest.inputFingerprint) ||
      !Array.isArray(metadata._fileManifest?.files) || metadata._fileManifest.files.length !== 1 ||
      metadata._fileManifest.files[0].originalFilename !== "biztag-pre.json" || metadata._fileManifest.files[0].uploadFilename !== "biztag-pre.json" ||
      metadata._fileManifest.files[0].originalMime !== "application/json" || metadata._fileManifest.files[0].uploadMime !== "application/json" || metadata._fileManifest.files[0].upload !== "uploaded" ||
      metadata._fileManifest.files[0].byteLength !== new TextEncoder().encode(snapshot).length ||
      metadata._fileManifest.files[0].sha256 !== metadata.sha256) fail();
  await verifyArchivedAttachments(pageId, [{ filename: "biztag-pre.json", bytes: new TextEncoder().encode(snapshot) }], "明示照合済み事業タグPRE");
}

/**
 * 既存行の根拠とpropertiesを二段階で置換する。全callerがこの順を共有する。
 * PRE物理保管→新根拠append/全文verify→properties PATCH/readback→旧根拠退役。
 * blockがundefinedなら根拠を保持して本文だけを同期、nullなら確定後に根拠を消す。
 * unknown時は再送・旧根拠削除をせず停止。最終PATCHは適用済みの可能性があるため
 * 「旧値不変」とは扱わず、PREと現値を照合してから再開する。
 */
export async function replaceEvidenceBlock(
  pageId: string,
  block: unknown | null,
  input: SupplementRowInput,
  expectedProperties: Record<string, unknown>,
  beforeWrite: () => Promise<void>,
  journal: SupplementPublicationJournal
): Promise<void> {
  if (!journal || typeof journal.assertReady !== "function" || typeof journal.reserve !== "function") throw new NotionConfigError("補足publisherのdurable journalがありません");
  journal.assertReady(); // Any unresolved prior operation stops before the first HTTP, even if PRE/page/source changed.
  const props = buildSupplementProperties(input);
  const chunks = chunkPropertiesByBytes(props);
  if (typeof beforeWrite !== "function" || Object.keys(expectedProperties).length === 0) throw new Error("補足の書込前guardがありません");
  if (block !== null && block !== undefined) evidenceValue(block); // 全組立をmutationより前に検証
  const before = await evidencePage(pageId);
  for (const [name, expected] of Object.entries(expectedProperties)) {
    if (JSON.stringify(propertyValue(before.properties[name])) !== JSON.stringify(propertyValue(expected))) {
      throw new SupplementWriteHeldError(`旧タグ・判定根拠がplan後に変更: ${name}。旧値を保持してHOLD`);
    }
  }
  if (block === undefined && Object.entries(props).every(([name, expected]) =>
    Object.hasOwn(before.properties, name) && JSON.stringify(propertyValue(before.properties[name])) === JSON.stringify(propertyValue(expected)))) {
    await beforeWrite();
    return; // 同じ39本文はPRE upload/根拠操作/properties PATCHを行わない。
  }
  const children = await evidenceChildren(pageId);
  const old = children.filter((b) => b.type === "heading_3" && richPlain((b.heading_3 as { rich_text: unknown }).rich_text).startsWith(EVIDENCE_TITLE_PREFIX));
  if (old.length > 1) throw new Error("複数の事業タグ根拠が存在。前回実行/PREを照合するまでHOLD");
  const reuseEvidence = block !== null && block !== undefined && old.length === 1 &&
    JSON.stringify(evidenceValue(old[0])) === JSON.stringify(evidenceValue(block));
  const snapshot = JSON.stringify(canonicalizeForHash({ page: before, children, expectedProperties: props, expectedEvidence: block }));
  const preSha = await sha256Hex(snapshot);
  // 推論確率・新根拠の揺れでunknownの再送ラッチを迂回させない。
  const executionKey = await sha256Hex(JSON.stringify(canonicalizeForHash({ previous: before, nextDocId: input.docId, judgeInput: input.judgeInput })));
  if (!(input.docId === null || typeof input.docId === "string" && input.docId.length > 0)) throw new NotionConfigError("補足publisherの原書類IDがありません");
  if (input.docId === null) {
    const allowed = new Set<string>([SUPPLEMENT_PROPS.name, SUPPLEMENT_PROPS.code, SUPPLEMENT_PROPS.master, SUPPLEMENT_PROPS.sector33, SUPPLEMENT_PROPS.docId]);
    if (block !== undefined || propertyValue(before.properties[SUPPLEMENT_PROPS.docId]) !== "" || Object.keys(props).some(name => !allowed.has(name))) {
      throw new NotionConfigError("原本文書なしのpublicationは基本メタだけ。旧本文/タグ/状態を保持します");
    }
  }
  const archiveKey = `biztag-pre/${pageId}/${executionKey}`;
  // Reserve before physical PRE archive calls: upload/page-create unknown is also sticky across runs.
  const publication = journal.reserve({ pageId, nextDocId: input.docId, archiveKey, snapshot });
  const filename = "biztag-pre.json";
  const file = { filename, bytes: new TextEncoder().encode(snapshot), contentType: "application/json" };
  let archivePageId: string;
  if (publication.preArchive !== undefined) {
    if (block !== undefined) throw new SupplementWriteHeldError("PRE保管照合の再開は機械的本文同期だけです");
    archivePageId = publication.preArchive.pageId;
    await verifySupplementPreArchive(archivePageId, archiveKey, snapshot, publication.preArchive.createRequest);
  } else {
    const stored = await recordPrimaryData({ service: "yuho-quant", key: archiveKey,
      source: `Notion supplement ${pageId}`, metadata: { pageId, sha256: preSha, nextDocId: input.docId }, files: [file] });
    if (stored.outcome === "skipped_existing") throw new NotionUnknownResultError(`同じPREの既存実行あり。自動再送せず照合してください。PRE=${stored.pageId}`);
    archivePageId = stored.pageId;
    await verifyArchivedAttachments(archivePageId, [file], "事業タグ更新前PRE");
  }
  const fresh = await evidencePage(pageId);
  if (JSON.stringify(canonicalizeForHash(fresh)) !== JSON.stringify(canonicalizeForHash(before))) throw new SupplementWriteHeldError("PRE保管中に補足が変更 (旧根拠保持・HOLD)");
  if (reuseEvidence && JSON.stringify(canonicalizeForHash(await evidenceChildren(pageId))) !== JSON.stringify(canonicalizeForHash(children))) {
    throw new SupplementWriteHeldError("PRE保管中に再利用する根拠/保持本文が変更 (全根拠保持・HOLD)");
  }
  if (publication.preArchive !== undefined && JSON.stringify(canonicalizeForHash(await evidenceChildren(pageId))) !== JSON.stringify(canonicalizeForHash(children))) {
    throw new SupplementWriteHeldError("PRE照合中に旧根拠が変更。未閉鎖intentを保持");
  }
  await beforeWrite(); // 対象1社のD1最新doc/pointer。ここまではbusiness write 0。
  if (publication.preArchive !== undefined) await publication.preArchive.beforeWrite();
  if (block !== null && block !== undefined && !reuseEvidence) {
    try {
      const appended = await notionRequest<{ results: ChildBlock[] }>("PATCH", `/blocks/${pageId}/children`, { children: [block] }, { singleAttempt: true });
      if (!Array.isArray(appended.results) || appended.results.length !== 1 || typeof appended.results[0].id !== "string") {
        throw new NotionUnknownResultError(`新根拠append ACKが不正。旧根拠保持、PRE=${archivePageId}`);
      }
      const got = await notionRequest<ChildBlock>("GET", `/blocks/${appended.results[0].id}`);
      if (got.id !== appended.results[0].id || got.archived === true || got.in_trash === true) throw new Error(`新根拠ID/状態の読戻し不一致。PRE=${archivePageId}`);
      if (got.has_children) {
        got[got.type] = { ...(got[got.type] as Record<string, unknown>), children: await evidenceChildren(got.id) };
      }
      if (JSON.stringify(evidenceValue(got)) !== JSON.stringify(evidenceValue(block))) {
        throw new Error(`新根拠の全文読戻し不一致 (旧根拠・旧properties保持)。PRE=${archivePageId}`);
      }
    } catch (cause) {
      throw new NotionUnknownResultError(`新根拠の結果確認が未完。再送せずPREと現値を照合してください。PRE=${archivePageId}`, { cause });
    }
  }
  let postPageSha256: string;
  try {
    for (const part of chunks) await notionRequest("PATCH", `/pages/${pageId}`, { properties: part }, { singleAttempt: true });
    const after = await evidencePage(pageId);
    for (const [name, expected] of Object.entries(props)) {
      if (JSON.stringify(propertyValue(after.properties[name])) !== JSON.stringify(propertyValue(expected))) {
        throw new Error(`補足の読戻し不一致: ${name}`);
      }
    }
    for (const [name, expected] of Object.entries(expectedProperties)) {
      if (!(name in props) && JSON.stringify(propertyValue(after.properties[name])) !== JSON.stringify(propertyValue(expected))) {
        throw new Error(`補足の保持対象が読戻し時に変更: ${name}`);
      }
    }
    if (reuseEvidence && JSON.stringify(canonicalizeForHash(await evidenceChildren(pageId))) !== JSON.stringify(canonicalizeForHash(children))) {
      throw new Error("再利用した根拠/保持本文の全文が読戻し時に変更");
    }
    if (publication.preArchive !== undefined || reuseEvidence) {
      for (const [name, expected] of Object.entries(before.properties)) {
        if (!(name in props) && JSON.stringify(propertyValue(after.properties[name])) !== JSON.stringify(propertyValue(expected))) throw new Error(`明示PRE再開の保持列が変更: ${name}`);
      }
      if (publication.preArchive !== undefined && JSON.stringify(canonicalizeForHash(await evidenceChildren(pageId))) !== JSON.stringify(canonicalizeForHash(children))) throw new Error("明示PRE再開の旧根拠が変更");
    }
    postPageSha256 = await sha256Hex(JSON.stringify(canonicalizeForHash(after)));
  } catch (cause) {
    throw new NotionUnknownResultError(`補足propertiesの結果確認が未完。再送・旧根拠削除を停止しPREと現値を照合してください。PRE=${archivePageId}`, { cause });
  }
  try {
    for (const previous of block === undefined || reuseEvidence ? [] : old) {
      const retired = await notionRequest<{ id: string; archived: boolean }>("DELETE", `/blocks/${previous.id}`, undefined, { singleAttempt: true });
      if (retired.id !== previous.id || retired.archived !== true) throw new NotionUnknownResultError(`旧根拠退役ACKが不正。PRE=${archivePageId}`);
      const check = await notionRequest<{ id: string; archived: boolean }>("GET", `/blocks/${previous.id}`);
      if (check.id !== previous.id || check.archived !== true) throw new NotionUnknownResultError(`旧根拠退役の読戻し不一致。PRE=${archivePageId}`);
    }
  } catch (cause) {
    throw new NotionUnknownResultError(`旧根拠退役の結果確認が未完。再送せずPREと現値を照合してください。PRE=${archivePageId}`, { cause });
  }
  publication.complete({ archivePageId, postPageSha256 });
}

export interface AppliedSupplementSnapshot {
  page: EvidencePage & { created_time: string; parent: unknown };
  children: ChildBlock[];
  expectedProperties: Record<string, unknown>;
  expectedEvidence: unknown;
}

/** Explicit recovery of ACKed properties/evidence only. Never append or PATCH again. */
export async function finishAppliedSupplementPublication(input: {
  snapshot: AppliedSupplementSnapshot; appliedPage: EvidencePage; newEvidenceId: string; recordedNewEvidence: unknown;
  archivePageId: string; archiveKey: string; archiveRequest: SupplementPreArchiveRequest;
  snapshotRaw: string; beforeWrite(): Promise<void>;
  complete(output: { archivePageId: string; postPageSha256: string }): void;
}): Promise<void> {
  const { snapshot } = input, same = (a: unknown, b: unknown) => JSON.stringify(canonicalizeForHash(a)) === JSON.stringify(canonicalizeForHash(b));
  const fail = (message: string): never => { throw new SupplementWriteHeldError(`適用済み補足の明示照合: ${message}。元intentを保持`); };
  const old = snapshot.children.filter(b => b.type === "heading_3" && richPlain((b.heading_3 as { rich_text: unknown }).rich_text).startsWith(EVIDENCE_TITLE_PREFIX));
  if (old.length !== 1 || snapshot.expectedEvidence === null || snapshot.expectedEvidence === undefined || old[0].id === input.newEvidenceId) fail("単一の旧/新根拠に束縛できません");
  if (!same(evidenceValue(input.recordedNewEvidence), evidenceValue(snapshot.expectedEvidence))) fail("保存ACKの新根拠全文が不一致");
  const verifyPage = (page: EvidencePage) => {
    const before = snapshot.page, full = page as EvidencePage & { created_time: string; parent: unknown };
    if (page.id !== before.id || full.created_time !== before.created_time || !same(full.parent, before.parent) || page.archived !== false || page.in_trash !== false ||
        !same(Object.keys(page.properties).sort(), Object.keys(before.properties).sort())) fail("対象行の主体/全列が変更");
    for (const [name, value] of Object.entries(page.properties)) {
      if (value.id !== before.properties[name].id || !same(propertyValue(value), propertyValue(Object.hasOwn(snapshot.expectedProperties, name) ? snapshot.expectedProperties[name] : before.properties[name]))) fail(`列${name}が変更`);
      if (!Object.hasOwn(snapshot.expectedProperties, name) && !same(value, before.properties[name])) fail(`保持列${name}が変更`);
    }
  };
  const verifyChildren = (children: ChildBlock[], oldPresent: boolean) => {
    const fresh = children.filter(b => b.id === input.newEvidenceId), previous = children.filter(b => b.id === old[0].id);
    if (fresh.length !== 1 || !same(evidenceValue(fresh[0]), evidenceValue(snapshot.expectedEvidence))) fail("既存の新根拠全文が変更");
    if (previous.length !== Number(oldPresent) || oldPresent && !same(previous[0], old[0]) ||
        !same(children.filter(b => b.id !== input.newEvidenceId && b.id !== old[0].id), snapshot.children.filter(b => b.id !== old[0].id))) fail("旧根拠/保持本文が変更");
  };
  verifyPage(input.appliedPage);
  const postPageSha256 = await sha256Hex(JSON.stringify(canonicalizeForHash(input.appliedPage)));
  await verifySupplementPreArchive(input.archivePageId, input.archiveKey, input.snapshotRaw, input.archiveRequest);
  const page = await evidencePage(snapshot.page.id), children = await evidenceChildren(snapshot.page.id);
  const previous = await notionRequest<ChildBlock & { archived: boolean; in_trash: boolean }>("GET", `/blocks/${old[0].id}`, undefined, { singleAttempt: true });
  if (previous.id !== old[0].id || typeof previous.archived !== "boolean" || typeof previous.in_trash !== "boolean" || !previous.archived && previous.in_trash) fail("旧根拠の状態不明");
  const rootBody = (block: ChildBlock) => { const root = { ...block }; delete root.request_id; const body = { ...(root[root.type] as Record<string, unknown>) }; delete body.children; root[root.type] = body; return root; };
  if (!previous.archived && !same(rootBody(previous), rootBody(old[0]))) fail("最後の旧根拠GETで本文/時計/全root内容が変更");
  verifyPage(page); verifyChildren(children, !previous.archived);
  if (!previous.archived && !same(page, input.appliedPage)) fail("適用後PRE時計/全対象内容が変更");
  await input.beforeWrite();
  if (!previous.archived) {
    try {
      const ack = await notionRequest<{ id: string; archived: boolean }>("DELETE", `/blocks/${old[0].id}`, undefined, { singleAttempt: true });
      if (ack.id !== old[0].id || ack.archived !== true) throw new Error("旧根拠退役ACKが不正");
    } catch (cause) { throw new NotionUnknownResultError("明示旧根拠退役が不明。元intent/一度だけの復旧claimを保持し再送しません", { cause }); }
  }
  const retired = await notionRequest<{ id: string; archived: boolean }>("GET", `/blocks/${old[0].id}`, undefined, { singleAttempt: true });
  if (retired.id !== old[0].id || retired.archived !== true) throw new NotionUnknownResultError("明示旧根拠退役の読戻し不明。完了記録を保留");
  verifyPage(await evidencePage(snapshot.page.id)); verifyChildren(await evidenceChildren(snapshot.page.id), false);
  await input.beforeWrite();
  // Match the normal publisher: hash the full page after property ACK, before old evidence retirement.
  input.complete({ archivePageId: input.archivePageId, postPageSha256 });
}
