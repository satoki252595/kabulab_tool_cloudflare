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
import { findBackupChildByTitle } from "./archive.js";
import { notionRequest } from "./client.js";
import type { NotionSelectColor } from "./dataset.js";
import { notionEnv } from "./env.js";
import { RICH_TEXT_MAX, joinRichText, splitRichText } from "./rich-text.js";

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
  themes: "投資テーマ",
  uncertain: "要確認タグ",
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
    [SUPPLEMENT_PROPS.themes]: {
      multi_select: { options: toOptions(spec.themeOptions) },
    },
    [SUPPLEMENT_PROPS.uncertain]: { rich_text: {} },
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
 * 「足りない列だけ足す」差分パッチを作る。
 * - 列自体が無ければ丸ごと追加。
 * - select/multi_select は既存の選択肢を保ったまま、無い選択肢だけ追加する
 *   (既存の選択肢は絶対に消さない — 運用者が Notion 上で使っている値を壊さない)。
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
    const created = await notionRequest<DbSchemaResponse>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_STOCK_INFO_PAGE_ID() },
      title: [{ type: "text", text: { content: SUPPLEMENT_DB_TITLE } }],
      properties: want,
    });
    cachedDbId = created.id;
    return { dbId: created.id, created: true, propertyIds: extractIds(created.properties) };
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
  attempts: number | null;
  nextRetryAt: string | null;
  error: string | null;
  upstream: string[];
  downstream: string[];
  themes: string[];
  uncertain: string | null;
  masterLinked: boolean;
  /** 要求した開示テキスト列だけ (呼び出し側が `opts.textColumns` で指定した分) */
  texts: Record<string, string>;
}

interface NotionPageProperty {
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
    attempts: readNumber(p[SUPPLEMENT_PROPS.attempts]),
    nextRetryAt: readDate(p[SUPPLEMENT_PROPS.nextRetryAt]),
    error: readRich(p[SUPPLEMENT_PROPS.error]) || null,
    upstream: readMultiSelect(p[SUPPLEMENT_PROPS.upstream]),
    downstream: readMultiSelect(p[SUPPLEMENT_PROPS.downstream]),
    themes: readMultiSelect(p[SUPPLEMENT_PROPS.themes]),
    uncertain: readRich(p[SUPPLEMENT_PROPS.uncertain]) || null,
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
  opts?: { textColumns?: string[]; codes?: string[] }
): Promise<SupplementRow[]> {
  const textColumns = opts?.textColumns ?? [];
  const columnNames = [...Object.values(SUPPLEMENT_PROPS), ...textColumns];
  const qs = buildFilterPropertiesQs(propertyIds, columnNames);

  const rows: SupplementRow[] = [];
  const codeToPageIds = new Map<string, string[]>();
  let cursor: string | undefined;
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
      body
    );
    for (const page of res.results) {
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

export async function loadStockMasterIndex(): Promise<StockMasterIndex> {
  const dbId = notionEnv.NOTION_DB_STOCK_MASTER();
  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const entry = Object.entries(schema.properties).find(([name]) => name === "銘柄コード");
  if (!entry) {
    throw new Error(
      `loadStockMasterIndex: 銘柄マスタ DB に「銘柄コード」列が見つかりません (dbId=${dbId})`
    );
  }
  const [, propDef] = entry;
  const qs = `filter_properties=${encodeURIComponent(propDef.id)}`;

  const pagesByCode = new Map<string, string[]>();
  let cursor: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<QueryResponse>(
      "POST",
      `/databases/${dbId}/query?${qs}`,
      body
    );
    for (const page of res.results) {
      const prop = page.properties["銘柄コード"];
      const code = readRich(prop) || readTitle(prop);
      if (!code) continue;
      const pages = pagesByCode.get(code);
      if (pages) pages.push(page.id);
      else pagesByCode.set(code, [page.id]);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
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
  /** 列名(開示テキスト項目名) → 全文。null または "" はクリア */
  texts?: Record<string, string | null>;
  upstream?: string[];
  downstream?: string[];
  themes?: string[];
  uncertain?: string | null;
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

function assertNoComma(name: string, columnLabel: string): void {
  if (name.includes(",") || name.includes("，") || name.includes("、")) {
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
 */
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
  if (input.textStatus !== undefined) {
    props[SUPPLEMENT_PROPS.textStatus] = selectValue(
      SUPPLEMENT_PROPS.textStatus,
      input.textStatus
    );
  }
  if (input.texts !== undefined) {
    for (const [col, value] of Object.entries(input.texts)) {
      props[col] = clearableRichText(value, col);
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
  if (input.themes !== undefined) {
    props[SUPPLEMENT_PROPS.themes] = multiSelectValue(SUPPLEMENT_PROPS.themes, input.themes);
  }
  if (input.uncertain !== undefined) {
    props[SUPPLEMENT_PROPS.uncertain] = clearableRichText(
      input.uncertain,
      SUPPLEMENT_PROPS.uncertain
    );
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
  if (input.candidateCount !== undefined) {
    props[SUPPLEMENT_PROPS.candidateCount] = numberValue(input.candidateCount);
  }
  if (input.judgeInput !== undefined) {
    props[SUPPLEMENT_PROPS.judgeInput] = clearableRichText(
      input.judgeInput,
      SUPPLEMENT_PROPS.judgeInput
    );
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
  evidence?: unknown | null
): Promise<string> {
  const props = buildSupplementProperties(input);
  const [first, ...rest] = chunkPropertiesByBytes(props);
  const body: Record<string, unknown> = {
    parent: { database_id: dbId },
    properties: first ?? {},
  };
  if (evidence !== undefined && evidence !== null) {
    body.children = [evidence];
  }
  const created = await notionRequest<{ id: string }>("POST", "/pages", body);
  for (const part of rest) {
    await notionRequest("PATCH", `/pages/${created.id}`, { properties: part });
  }
  return created.id;
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

export interface EvidenceItem {
  labelJa: string;
  band: "yes" | "uncertain";
  probability: number;
  sentences: Array<{ text: string; sectionTitle: string }>;
}
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
      item.band === "yes"
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
  heading_3?: { rich_text?: Array<{ plain_text?: string }> };
}
interface ChildrenResponse {
  results: ChildBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * 行のページ本文にある既存の「事業タグの根拠」ブロックを削除し、新しい
 * ブロックに置き換える (判定し直すとき)。`block === null` なら削除のみ
 * (根拠なし = 判定不能・本文なし等)。
 */
export async function replaceEvidenceBlock(
  pageId: string,
  block: unknown | null
): Promise<void> {
  const toDelete: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await notionRequest<ChildrenResponse>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    for (const b of res.results) {
      if (b.type !== "heading_3") continue;
      const text = joinRichText(b.heading_3?.rich_text);
      if (text.startsWith(EVIDENCE_TITLE_PREFIX)) toDelete.push(b.id);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  for (const id of toDelete) {
    await notionRequest("DELETE", `/blocks/${id}`);
  }
  if (block !== null) {
    await notionRequest("PATCH", `/blocks/${pageId}/children`, { children: [block] });
  }
}
