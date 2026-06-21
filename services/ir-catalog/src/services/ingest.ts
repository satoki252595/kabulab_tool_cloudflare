/**
 * TDnet 適時開示バッチの取り込み (バックフィル / 日次キャッチアップ共用)。
 *
 * 流れ:
 *   1. TDnet items を core.stocks に居る個別株だけに絞る (ユニバース外の
 *      ETF/REIT/非上場/上場廃止コードは正直に切り捨てる — 推測しない)
 *   2. タイトルを決定論的に分類 (classify)。未分類は tags=[] のまま
 *   3. ir_catalog.disclosures へ冪等 upsert (tdnet_id 一意)
 *   4. ルール6: 取得バッチ単位の確定 JSONL を「一次データ｜ir-catalog」へ
 *      物理アップロード (1 開示=1Notion 行にすると上限超過するため、
 *      高頻度・大量取得は「バッチ単位の確定ファイル」粒度で記録する —
 *      CLAUDE.md ルール6「高頻度・大量取得の境界」の帰結)
 *   5. 高シグナル開示 (増配/上方修正/自社株買い 等) のみ人間可読な
 *      Notion 高シグナル DB へ冪等記録 (tag/コード/名称[バフェ・リンク]/
 *      発表日 列)
 *
 * 失敗は握りつぶさない (ルール2): DB upsert 失敗は throw。Notion 記録は
 * DB 取込とは独立し、失敗しても DB 取込結果は返すが error を結果に載せて
 * 運用者が気づけるようにする (黙殺しない)。
 */
import { eq, sql } from "drizzle-orm";
import {
  recordPrimaryData,
  upsertDisclosuresByStock,
  type ByStockRow,
  type PdfClassification,
} from "../../../../src/shared/notion-archive/index.js";
import type { Database } from "../db/client.js";
import { disclosures } from "../db/schema.js";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { classify, notionTagOptions, buffettCodeUrl } from "./classify.js";
import { companyCodeToTicker, type TdnetItemRaw } from "./tdnet/types.js";
import { classifyPdfSentiment } from "./pdf-sentiment/index.js";

export interface IngestOptions {
  /** Notion 一次データの冪等キー (例 "tdnet-2024-04" / "tdnet-daily-2026-05-18") */
  batchKey: string;
  /** 取得元の説明 (Notion Source) */
  source: string;
  /** ルール6: バッチ確定 JSON を Notion 一次データへ実体アップロードする */
  archiveToNotion: boolean;
  /** 二次データ: 全 IR を Notion「銘柄一覧→銘柄別子DB」へ 1IR=1行で記録 */
  notionByStock: boolean;
  /** 二次データ投入の打ち切り絶対時刻 (epoch ms)。日次 cron 用。
   *  未指定 = 無制限 (backfill。再開可能) */
  notionByStockDeadlineMs?: number;
  /** core.stocks の code→id マップ (バックフィルで再取得を避けるため注入可) */
  codeToId?: Map<string, number>;
  /**
   * 既存 terminal (uploaded+hasFile) 行に対しても PDF を再 fetch + 再判定する。
   * 通常 backfill は false (冪等スキップ)。本フラグは新カラム反映用の段階的
   * 移行や Engine 改修後の再評価で使う。範囲を狭く (--ticker / --from / --to)
   * 絞ること。
   */
  rejudgePdfSentiment?: boolean;
}

export interface IngestResult {
  fetched: number;
  /** ユニバース内 (= core.stocks に居る) に絞った件数 */
  inUniverse: number;
  upserted: number;
  /** タグが 1 つも付かなかった (未分類) 件数 */
  unclassified: number;
  byPrimaryTag: Record<string, number>;
  notionArchive: { outcome: string; fileTooLarge: boolean } | { error: string } | null;
  notionByStock:
    | {
        stocksTouched: number;
        created: number;
        updated: number;
        skippedExisting: number;
        /** PDF を添付できず新規作成しなかった件数 (ユーザ指示の挿入抑止) */
        skippedNoFile: number;
        /** rejudgePdfSentiment=true で既存行を再判定 + PATCH した件数 */
        rejudged: number;
        rowErrors: number;
        reachedDeadline: boolean;
      }
    | { error: string }
    | null;
}

async function loadCodeToId(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: stocks.id, code: stocks.code })
    .from(stocks);
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.code, r.id);
  return m;
}

/**
 * (tdnet_id → notion_page_id) を Postgres に一括書き戻す。
 * 1 statement = チャンク(VALUES join) で効率化。冪等 (同じ pageId なら no-op
 * 相当・別 pageId なら最新で上書き)。捏造禁止 (ルール1) のため空文字や
 * NULL 文字列は除外し、純粋に「Notion から確定で受け取った page id」だけを
 * 書き戻す。
 */
async function persistNotionPageIds(
  db: Database,
  pageIdMap: Map<string, string>
): Promise<void> {
  const entries = [...pageIdMap.entries()].filter(
    ([k, v]) => typeof k === "string" && k.length > 0 && typeof v === "string" && v.length > 0
  );
  if (entries.length === 0) return;
  // D1 は PG の `UPDATE ... FROM (VALUES ...)` を使えないため drizzle の
  // per-row update（tdnet_id 等値）で冪等に書き戻す。
  for (const [tdnetId, pageId] of entries) {
    await db
      .update(disclosures)
      .set({ notionPageId: pageId })
      .where(eq(disclosures.tdnetId, tdnetId));
  }
}

/**
 * (tdnet_id → PDF 判定 4 値) を Postgres へバルク書き戻し。
 * `persistNotionPageIds` と同じチャンク VALUES パターン。
 * 判定時刻は実行時刻で統一 (sql`now()`) し再判定検出 (method='rule_v1'
 * AND pdf_sentiment_at < cutoff) のクエリを効かせる。
 */
async function persistPdfSentiments(
  db: Database,
  pdfMap: Map<string, PdfClassification>
): Promise<void> {
  const entries = [...pdfMap.entries()].filter(
    ([k]) => typeof k === "string" && k.length > 0
  );
  if (entries.length === 0) return;
  // D1: per-row update。判定時刻は実行時刻で統一（再判定検出クエリ用）。
  const now = new Date();
  for (const [tdnetId, c] of entries) {
    await db
      .update(disclosures)
      .set({
        pdfSentiment: c.sentiment,
        pdfSentimentMethod: c.method ?? null,
        pdfSentimentScore: c.score ?? null,
        pdfSentimentAt: now,
      })
      .where(eq(disclosures.tdnetId, tdnetId));
  }
}

interface PreparedRow {
  stockId: number;
  tdnetId: string;
  companyCode: string;
  companyName: string;
  title: string;
  pubdate: Date;
  documentUrl: string;
  xbrlUrl: string | null;
  marketsString: string | null;
  tags: string[];
  primaryTag: string | null;
  ticker: string;
}

/** "2026-05-18 20:00:00" (JST) を ISO に。形式が崩れていれば throw (捏造しない) */
function parsePubdate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`TDnet pubdate の形式が不正: "${s}"`);
  // TDnet の pubdate は JST。+09:00 を明示して保存する
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+09:00`
  );
}

/**
 * TDnet items を取り込み可能な行へ変換する純関数 (DB 非依存・テスト可能)。
 *
 *  - ユニバース外 (ticker が core.stocks に無い) / コード不正は正直に除外
 *  - tdnet_id で de-dupe (後勝ち)。TDnet は訂正再掲で同一 id を同一バッチに
 *    複数返すことがあり、その重複が 1 INSERT 内に入ると Postgres が
 *    「ON CONFLICT DO UPDATE command cannot affect row a second time」で
 *    バッチ全体を落とす。後勝ち = 配列で後に来た方を採用 (最新表記)。
 */
export function prepareRows(
  items: TdnetItemRaw[],
  codeToId: Map<string, number>
): PreparedRow[] {
  const byId = new Map<string, PreparedRow>();
  for (const it of items) {
    const ticker = companyCodeToTicker(it.company_code);
    if (ticker === null) continue;
    const stockId = codeToId.get(ticker);
    if (stockId === undefined) continue; // ユニバース外 — 正直に除外
    const { tags, primaryTag } = classify(it.title);
    byId.set(it.id, {
      stockId,
      tdnetId: it.id,
      companyCode: it.company_code,
      companyName: it.company_name,
      title: it.title,
      pubdate: parsePubdate(it.pubdate),
      documentUrl: it.document_url,
      xbrlUrl: it.url_xbrl,
      marketsString: it.markets_string,
      tags,
      primaryTag,
      ticker,
    });
  }
  return [...byId.values()];
}

export async function ingestBatch(
  db: Database,
  items: TdnetItemRaw[],
  opts: IngestOptions
): Promise<IngestResult> {
  const codeToId = opts.codeToId ?? (await loadCodeToId(db));
  const prepared = prepareRows(items, codeToId);

  const byPrimaryTag: Record<string, number> = {};
  let unclassified = 0;
  for (const p of prepared) {
    if (p.primaryTag === null) unclassified++;
    else byPrimaryTag[p.primaryTag] = (byPrimaryTag[p.primaryTag] ?? 0) + 1;
  }

  // DB へ冪等 upsert (tdnet_id 一意)。タイトル訂正等に追従するため
  // 内容列は更新、ingested_at は据え置き。D1 の bind 変数上限は 100 で、
  // 1 行 11 列なので 9 行(=99 bind)ずつに分割する(ADR-0001)。
  let upserted = 0;
  const CHUNK = 9;
  for (let i = 0; i < prepared.length; i += CHUNK) {
    const slice = prepared.slice(i, i + CHUNK);
    if (slice.length === 0) continue;
    await db
      .insert(disclosures)
      .values(
        slice.map((p) => ({
          stockId: p.stockId,
          tdnetId: p.tdnetId,
          companyCode: p.companyCode,
          companyName: p.companyName,
          title: p.title,
          pubdate: p.pubdate,
          documentUrl: p.documentUrl,
          xbrlUrl: p.xbrlUrl,
          marketsString: p.marketsString,
          tags: p.tags,
          primaryTag: p.primaryTag,
        }))
      )
      .onConflictDoUpdate({
        target: disclosures.tdnetId,
        set: {
          companyName: sql`excluded.company_name`,
          title: sql`excluded.title`,
          documentUrl: sql`excluded.document_url`,
          xbrlUrl: sql`excluded.xbrl_url`,
          marketsString: sql`excluded.markets_string`,
          tags: sql`excluded.tags`,
          primaryTag: sql`excluded.primary_tag`,
        },
      });
    upserted += slice.length;
  }

  // ルール6: バッチ確定 JSONL を Notion 一次データへ実体アップロード (冪等)
  let notionArchive: IngestResult["notionArchive"] = null;
  if (opts.archiveToNotion) {
    try {
      // Notion File Upload API は拡張子で検証し .jsonl を拒否するため、
      // 標準 JSON 配列 (.json) で確定バッチを実体保存する (再取込も容易)。
      const fileJson = JSON.stringify(
        prepared.map((p) => ({
          tdnet_id: p.tdnetId,
          ticker: p.ticker,
          company_code: p.companyCode,
          company_name: p.companyName,
          pubdate: p.pubdate.toISOString(),
          title: p.title,
          tags: p.tags,
          primary_tag: p.primaryTag,
          document_url: p.documentUrl,
          xbrl_url: p.xbrlUrl,
          markets: p.marketsString,
        })),
        null,
        0
      );
      const r = await recordPrimaryData({
        service: "ir-catalog",
        key: opts.batchKey,
        source: opts.source,
        metadata: {
          batchKey: opts.batchKey,
          fetched: items.length,
          inUniverse: prepared.length,
          unclassified,
          byPrimaryTag,
        },
        files: [
          {
            bytes: new TextEncoder().encode(fileJson),
            filename: `${opts.batchKey}.json`,
            contentType: "application/json",
          },
        ],
      });
      notionArchive = { outcome: r.outcome, fileTooLarge: r.fileTooLarge };
    } catch (e) {
      notionArchive = { error: (e as Error).message };
      console.error(`[ir-catalog] Notion 一次データ記録失敗 ${opts.batchKey}: ${(e as Error).message}`);
    }
  }

  // 二次データ: 全 IR を Notion「銘柄一覧→銘柄別子DB」へ 1IR=1行で冪等記録
  // (全タグ。一次データ Postgres 格納と同タイミング = TDnet へ追加負荷なし)
  const byStockRows: ByStockRow[] = prepared.map((p) => ({
    key: p.tdnetId,
    ticker: p.ticker,
    companyName: p.companyName,
    companyUrl: buffettCodeUrl(p.ticker),
    tags: p.tags,
    primaryTag: p.primaryTag,
    pubdate: p.pubdate.toISOString(),
    title: p.title,
    documentUrl: p.documentUrl,
    markets: p.marketsString,
  }));

  let notionByStock: IngestResult["notionByStock"] = null;
  if (opts.notionByStock && byStockRows.length > 0) {
    // ファイルプロキシ用に (tdnet_id → notion_page_id) を収集して Postgres
    // に書き戻す。upsertDisclosuresByStock は行を create/PATCH した直後に
    // onPagePersisted を呼ぶので、ここで Map に貯めて末尾でバルク UPDATE。
    const pageIdMap = new Map<string, string>();
    const pdfMap = new Map<string, PdfClassification>();
    try {
      const r = await upsertDisclosuresByStock({
        service: "ir-catalog",
        tagOptions: notionTagOptions(),
        rows: byStockRows,
        deadlineMs: opts.notionByStockDeadlineMs,
        onPagePersisted: (key, pageId) => pageIdMap.set(key, pageId),
        // PDF 本文を OSS 軽量実装 (数値ルール + 東北大極性辞書) で判定し、
        // Notion 列 + PG 4 列に反映。失敗時は呼ばれた側で unknown を返す
        // (バッチを止めない — ルール2)。
        classifyPdf: (bytes, primaryTag) =>
          classifyPdfSentiment(bytes, primaryTag),
        onPdfClassified: (key, c) => pdfMap.set(key, c),
        rejudgePdf: opts.rejudgePdfSentiment ?? false,
      });
      notionByStock = {
        stocksTouched: r.stocksTouched,
        created: r.created,
        updated: r.updated,
        skippedExisting: r.skippedExisting,
        skippedNoFile: r.skippedNoFile,
        rejudged: r.rejudged,
        rowErrors: r.rowErrors,
        reachedDeadline: r.reachedDeadline,
      };
    } catch (e) {
      notionByStock = { error: (e as Error).message };
      console.error(
        `[ir-catalog] Notion 銘柄別記録失敗 ${opts.batchKey}: ${(e as Error).message}`
      );
    }
    // 例外時も貯まった分は反映 (途中まで成功した行はリンクできる)
    if (pageIdMap.size > 0) {
      try {
        await persistNotionPageIds(db, pageIdMap);
      } catch (e) {
        console.error(
          `[ir-catalog] notion_page_id 反映失敗 ${opts.batchKey}: ${(e as Error).message}`
        );
      }
    }
    if (pdfMap.size > 0) {
      try {
        await persistPdfSentiments(db, pdfMap);
      } catch (e) {
        console.error(
          `[ir-catalog] pdf_sentiment 反映失敗 ${opts.batchKey}: ${(e as Error).message}`
        );
      }
    }
  } else if (opts.notionByStock) {
    notionByStock = {
      stocksTouched: 0,
      created: 0,
      updated: 0,
      skippedExisting: 0,
      skippedNoFile: 0,
      rejudged: 0,
      rowErrors: 0,
      reachedDeadline: false,
    };
  }

  return {
    fetched: items.length,
    inUniverse: prepared.length,
    upserted,
    unclassified,
    byPrimaryTag,
    notionArchive,
    notionByStock,
  };
}
