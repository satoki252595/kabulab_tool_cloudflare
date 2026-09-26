/**
 * 「株価の日次同期」の Notion 記録 (日次株価 sync の完了を取引日つきで残す)。
 * 設計: docs/005-yuho-quant-business-tags-contract.md の「株価の日次同期」節。
 *
 * 親は「株式情報」ページ (`NOTION_STOCK_INFO_PAGE_ID`)。**1 取引日 1 行**の
 * 単一 DB (CLAUDE.md ルール6: 銘柄別・日別に子ページ/子DBを量産しない)。
 * 発見順は `stock-supplement.ts` の `ensureSupplementDb` と同じ流儀
 * (固定 ID → Search 完全一致 (親ページ一致・最古優先) → 新規作成)。
 *
 * 取引日は「日次 sync が実際に書き込んだ最新の株価バーの日付」であり、
 * 呼び出し当日のカレンダー日ではない (`runDailySync` が
 * `rebuildMomentumProjection` の `sourceMaxDate` = swing_daily_ohlcv の
 * MAX(date) から渡す)。導出できない (= 実質全滅) ときは取引日を推測せず
 * `tradingDate: null` で呼び、本モジュールは必ず `状態=失敗` の行を作る
 * (ルール2: 黙って埋めない)。
 */
import { findBackupChildByTitle } from "./archive.js";
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import type { NotionSelectColor } from "./dataset.js";
import { splitRichText } from "./rich-text.js";

export const PRICE_SYNC_DB_TITLE = "株価の日次同期";

export type PriceSyncStatus = "完了" | "一部失敗" | "失敗";

const PRICE_SYNC_STATUS_VALUES: readonly PriceSyncStatus[] = ["完了", "一部失敗", "失敗"];
const PRICE_SYNC_STATUS_OPTIONS: Array<{ name: PriceSyncStatus; color: NotionSelectColor }> = [
  { name: "完了", color: "green" },
  { name: "一部失敗", color: "orange" },
  { name: "失敗", color: "red" },
];

/** 列キー (ドメイン語) → Notion 列名 (日本語)。 */
export const PRICE_SYNC_PROPS = {
  /** title。取引日が分かる行は "YYYY-MM-DD"、分からない行 (§失敗) は識別用の文言 */
  title: "取引日",
  /** date 型。取引日が分かる行のみ設定 (フィルタ・ソート用)。 */
  tradingDate: "取引日（日付）",
  status: "状態",
  completedAt: "完了日時",
  targetStocks: "対象銘柄数",
  updatedStocks: "更新銘柄数",
  failedStocks: "失敗銘柄数",
  runUrl: "実行URL",
  /** 失敗理由 (取引日が導出できなかった理由・例外メッセージ等)。成功時は空。 */
  reason: "失敗理由",
} as const;

function buildDbProperties(): Record<string, unknown> {
  return {
    [PRICE_SYNC_PROPS.title]: { title: {} },
    [PRICE_SYNC_PROPS.tradingDate]: { date: {} },
    [PRICE_SYNC_PROPS.status]: { select: { options: PRICE_SYNC_STATUS_OPTIONS } },
    [PRICE_SYNC_PROPS.completedAt]: { date: {} },
    [PRICE_SYNC_PROPS.targetStocks]: { number: {} },
    [PRICE_SYNC_PROPS.updatedStocks]: { number: {} },
    [PRICE_SYNC_PROPS.failedStocks]: { number: {} },
    [PRICE_SYNC_PROPS.runUrl]: { url: {} },
    [PRICE_SYNC_PROPS.reason]: { rich_text: {} },
  };
}

interface NotionPropertyDef {
  id: string;
  type: string;
}
interface DbSchemaResponse {
  id: string;
  properties: Record<string, NotionPropertyDef>;
}

/** プロセス内キャッシュ (探索コスト削減) */
let cachedDbId: string | null = null;

/**
 * 「株価の日次同期」DB を確保する (無ければ作成、あれば不足列だけ足す)。
 * 発見順: `NOTION_PRICE_SYNC_DB_ID` (固定) → Search 完全一致 → 新規作成
 * (`stock-supplement.ts` の `ensureSupplementDb` と同じ流儀)。
 */
export async function ensurePriceSyncDb(): Promise<{ dbId: string }> {
  if (cachedDbId) return { dbId: cachedDbId };
  const want = buildDbProperties();

  let dbId = notionEnv.NOTION_PRICE_SYNC_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_STOCK_INFO_PAGE_ID(),
      title: PRICE_SYNC_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const created = await notionRequest<DbSchemaResponse>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_STOCK_INFO_PAGE_ID() },
      title: [{ type: "text", text: { content: PRICE_SYNC_DB_TITLE } }],
      properties: want,
    });
    cachedDbId = created.id;
    return { dbId: created.id };
  }

  const schema = await notionRequest<DbSchemaResponse>("GET", `/databases/${dbId}`);
  const missing = Object.entries(want).filter(([name]) => !(name in schema.properties));
  if (missing.length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, {
      properties: Object.fromEntries(missing),
    });
  }
  cachedDbId = dbId;
  return { dbId };
}

export interface PriceSyncLogInput {
  /**
   * 取引日 (YYYY-MM-DD)。日次 sync が実際に書き込んだ最新バーの日付
   * (`swing_daily_ohlcv` の MAX(date) 等から導出)。導出できなければ
   * `null` (このとき `status` は必ず `"失敗"` でなければならない — 推測しない)。
   */
  tradingDate: string | null;
  status: PriceSyncStatus;
  /** ISO 8601 (時刻つき)。sync 完了 (または失敗検出) の時刻。 */
  completedAt: string;
  /**
   * 対象/更新/失敗の銘柄数。sync が母集団の読み込み前に例外で落ちた等、
   * 件数そのものが分かっていない場合は `null` (0 件だったと偽らない — ルール2)。
   */
  targetStocks: number | null;
  updatedStocks: number | null;
  failedStocks: number | null;
  /** GitHub Actions の run URL (ローカル実行等で無ければ null)。 */
  runUrl: string | null;
  /** 失敗理由 (取引日が導出できない理由・例外メッセージ等)。成功時は null。 */
  reason: string | null;
}

function richTextValue(value: string | null): { rich_text: unknown[] } {
  if (value === null || value === "") return { rich_text: [] };
  return { rich_text: splitRichText(value) };
}

function buildRowProperties(input: PriceSyncLogInput, titleText: string): Record<string, unknown> {
  return {
    [PRICE_SYNC_PROPS.title]: { title: splitRichText(titleText) },
    [PRICE_SYNC_PROPS.tradingDate]: {
      date: input.tradingDate === null ? null : { start: input.tradingDate },
    },
    [PRICE_SYNC_PROPS.status]: { select: { name: input.status } },
    [PRICE_SYNC_PROPS.completedAt]: { date: { start: input.completedAt } },
    [PRICE_SYNC_PROPS.targetStocks]: { number: input.targetStocks },
    [PRICE_SYNC_PROPS.updatedStocks]: { number: input.updatedStocks },
    [PRICE_SYNC_PROPS.failedStocks]: { number: input.failedStocks },
    [PRICE_SYNC_PROPS.runUrl]: { url: input.runUrl },
    [PRICE_SYNC_PROPS.reason]: richTextValue(input.reason),
  };
}

/** `PriceSyncLogInput` の整合を検査する (呼び出し側のバグを早期に落とす — ルール2)。 */
function assertValid(input: PriceSyncLogInput): void {
  if (!PRICE_SYNC_STATUS_VALUES.includes(input.status)) {
    throw new Error(`recordPriceSyncLog: 不正な状態です: ${input.status}`);
  }
  if (input.tradingDate === null && input.status !== "失敗") {
    throw new Error(
      `recordPriceSyncLog: 取引日が導出できていないのに status=${input.status} です` +
        ` (取引日不明は必ず 状態=失敗。推測して埋めない — ルール2)`
    );
  }
}

/** 取引日不明の失敗行に付けるタイトル (実行のたびに新しい行を作る。取引日と混同しない書式)。 */
function unresolvedTitle(completedAt: string): string {
  return `失敗（取引日不明）${completedAt}`;
}

interface QueryResponse {
  results: Array<{ id: string }>;
}

/** タイトル完全一致で既存行を探す (取引日が分かる行のみ冪等キーとして使う)。 */
async function findRowByTitle(dbId: string, title: string): Promise<string | null> {
  const res = await notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, {
    filter: { property: PRICE_SYNC_PROPS.title, title: { equals: title } },
    page_size: 1,
  });
  return res.results[0]?.id ?? null;
}

export interface RecordPriceSyncLogResult {
  pageId: string;
  outcome: "created" | "updated";
}

/**
 * 1 回の日次 sync 実行結果を「株価の日次同期」DB へ冪等記録する。
 *
 * - `tradingDate` が分かる行は取引日で upsert する (同じ取引日の再実行は
 *   同じ行を更新する。取引日は市場の暦日であり 1 日 1 回しか確定しないため、
 *   冪等キーとして安全)。
 * - `tradingDate` が `null` (導出不能な全滅) の行は upsert キーが無いため、
 *   実行のたびに新しい行を作る (取引日と紛れない書式のタイトルを使う。
 *   運営が個別に原因を追う想定で、同一実行の重複記録より見落としを避ける方を優先する)。
 */
export async function recordPriceSyncLog(
  dbId: string,
  input: PriceSyncLogInput
): Promise<RecordPriceSyncLogResult> {
  assertValid(input);
  const title = input.tradingDate ?? unresolvedTitle(input.completedAt);
  const props = buildRowProperties(input, title);

  const existing = input.tradingDate !== null ? await findRowByTitle(dbId, title) : null;
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
