/**
 * UI 用クエリ (検索 / 銘柄タイムライン)。
 *
 * ヒット 0 件は「該当なし」を呼び出し側で正直に表示する (架空候補を作らない
 * — ルール1)。期間指定が無い場合の既定は直近 24 か月。
 */
import { and, desc, eq, gte, like, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { disclosures } from "../db/schema.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { rowSentiments } from "./sentiment.js";

export interface StockHit {
  code: string;
  name: string;
  market: string;
  disclosureCount: number;
  latestPubdate: string | null;
}

/** コード前方一致 or 名称部分一致。開示が 1 件以上ある銘柄のみ返す */
export async function searchStocks(
  db: Database,
  q: string,
  limit = 40
): Promise<StockHit[]> {
  const term = q.trim();
  if (term === "") return [];
  const rows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
      disclosureCount: sql<number>`count(${disclosures.id})`,
      // pubdate は epoch 秒 integer。max() は epoch 秒(number)を返す。
      latestPubdate: sql<number | null>`max(${disclosures.pubdate})`,
    })
    .from(stocks)
    .innerJoin(disclosures, eq(disclosures.stockId, stocks.id))
    .where(or(like(stocks.code, `${term}%`), like(stocks.name, `%${term}%`)))
    .groupBy(stocks.id, stocks.code, stocks.name, stocks.market)
    .orderBy(desc(sql`max(${disclosures.pubdate})`))
    .limit(limit);
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    market: r.market,
    disclosureCount: r.disclosureCount,
    latestPubdate:
      r.latestPubdate != null
        ? new Date(Number(r.latestPubdate) * 1000).toISOString()
        : null,
  }));
}

export interface DisclosureRow {
  tdnetId: string;
  title: string;
  pubdate: string;
  documentUrl: string;
  tags: string[];
  primaryTag: string | null;
  /**
   * PDF 本文から判定したセンチメント。判定は backfill/日次 cron の中で
   * 行われる (UI ondemand では計算しない)。
   * NULL = 未判定 (まだ走っていない / TDnet purge 済等)
   */
  pdfSentiment: string | null;
  pdfSentimentMethod: string | null;
  pdfSentimentScore: number | null;
}

export interface StockTimeline {
  code: string;
  name: string;
  market: string;
  /** 集計対象期間の開始 (ISO date) */
  since: string;
  /** 月数 */
  months: number;
  /** 表示対象 (タグ絞り込み適用後) */
  disclosures: DisclosureRow[];
  /** primaryTag ごとの件数。期間内・絞り込み前 (未分類は "_unclassified") */
  tagCounts: Record<string, number>;
  /**
   * 期間内・絞り込み前のセンチメント別件数。
   * ポジ/ネガが両方含まれる開示は両カウントに加算する (`rowSentiments` 仕様)。
   * neutral は表示しないので未集計。
   */
  sentimentCounts: { positive: number; negative: number };
  /**
   * 期間内・絞り込み前の PDF 判定件数 (title 判定とは別軸)。
   * pdf_sentiment が positive/negative の行を別カウント (mixed/unknown/skipped 除外)。
   */
  pdfSentimentCounts: { positive: number; negative: number };
  /** 期間内の総数 (絞り込み前) */
  periodTotal: number;
  /** 期間に依らない総開示数 (DB 全体) */
  totalAllTime: number;
  /** 絞り込み中のタグ (なければ null) */
  activeTag: string | null;
}

/**
 * 4 桁ティッカーで銘柄のタイムラインを引く。銘柄が core.stocks に無ければ
 * null (見つからないものを捏造しない)。
 */
export async function getStockTimeline(
  db: Database,
  code: string,
  months = 24,
  tagFilter: string | null = null
): Promise<StockTimeline | null> {
  const st = await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      market: stocks.market,
    })
    .from(stocks)
    .where(eq(stocks.code, code))
    .limit(1);
  if (st.length === 0) return null;
  const stock = st[0];

  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const rows = await db
    .select({
      tdnetId: disclosures.tdnetId,
      title: disclosures.title,
      pubdate: disclosures.pubdate,
      documentUrl: disclosures.documentUrl,
      tags: disclosures.tags,
      primaryTag: disclosures.primaryTag,
      pdfSentiment: disclosures.pdfSentiment,
      pdfSentimentMethod: disclosures.pdfSentimentMethod,
      pdfSentimentScore: disclosures.pdfSentimentScore,
    })
    .from(disclosures)
    .where(
      and(
        eq(disclosures.stockId, stock.id),
        gte(disclosures.pubdate, since)
      )
    )
    .orderBy(desc(disclosures.pubdate));

  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(disclosures)
    .where(eq(disclosures.stockId, stock.id));

  // 件数は「期間内・絞り込み前」で集計 (クリックできる内訳の母数にする)。
  // 絞り込みは表示リストにのみ適用する。
  const tagCounts: Record<string, number> = {};
  const sentimentCounts = { positive: 0, negative: 0 };
  const pdfSentimentCounts = { positive: 0, negative: 0 };
  const all: DisclosureRow[] = rows.map((r) => {
    const key = r.primaryTag ?? "_unclassified";
    tagCounts[key] = (tagCounts[key] ?? 0) + 1;
    // tags 配列全体を見てセンチメント判定 (primaryTag が中立でも tags 内に
    // ポジ/ネガが含まれていれば検出される設計)。
    const s = rowSentiments(r.tags);
    if (s.has("positive")) sentimentCounts.positive++;
    if (s.has("negative")) sentimentCounts.negative++;
    if (r.pdfSentiment === "positive") pdfSentimentCounts.positive++;
    else if (r.pdfSentiment === "negative") pdfSentimentCounts.negative++;
    return {
      tdnetId: r.tdnetId,
      title: r.title,
      pubdate: new Date(r.pubdate).toISOString(),
      documentUrl: r.documentUrl,
      tags: r.tags,
      primaryTag: r.primaryTag,
      pdfSentiment: r.pdfSentiment,
      pdfSentimentMethod: r.pdfSentimentMethod,
      pdfSentimentScore: r.pdfSentimentScore,
    };
  });
  const list =
    tagFilter === null
      ? all
      : tagFilter === "_unclassified"
        ? all.filter((d) => d.tags.length === 0)
        : all.filter((d) => d.tags.includes(tagFilter));

  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    since: since.toISOString().slice(0, 10),
    months,
    disclosures: list,
    tagCounts,
    sentimentCounts,
    pdfSentimentCounts,
    periodTotal: all.length,
    totalAllTime: totalRow[0]?.n ?? 0,
    activeTag: tagFilter,
  };
}

/** ポータル/ホームの「最近の高シグナル開示」用 (期間内・高シグナルのみ) */
export async function recentHighSignal(
  db: Database,
  highSignalTags: readonly string[],
  limit = 30
): Promise<
  Array<{
    code: string;
    name: string;
    title: string;
    pubdate: string;
    primaryTag: string;
    tdnetId: string;
    documentUrl: string;
  }>
> {
  const rows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      title: disclosures.title,
      pubdate: disclosures.pubdate,
      primaryTag: disclosures.primaryTag,
      tdnetId: disclosures.tdnetId,
      documentUrl: disclosures.documentUrl,
    })
    .from(disclosures)
    .innerJoin(stocks, eq(stocks.id, disclosures.stockId))
    .where(inArray(disclosures.primaryTag, [...highSignalTags]))
    .orderBy(desc(disclosures.pubdate))
    .limit(limit);
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    title: r.title,
    pubdate: new Date(r.pubdate).toISOString(),
    primaryTag: r.primaryTag as string,
    tdnetId: r.tdnetId,
    documentUrl: r.documentUrl,
  }));
}
