/**
 * TDnet 適時開示バッチの取り込み (バックフィル / 日次キャッチアップ共用)。
 *
 * 流れ:
 *   1. TDnet items を取込の母集団 (src/shared/db/active-equity.ts の `loadIngestCodeToId`。
 *      core_stocks から非普通株と、区分が NULL の active 行を除いたもの) に絞る。
 *      ユニバース外 (ETF/REIT 等の非普通株・区分が NULL の active 行・core_stocks に無い
 *      コード) は正直に切り捨てる — 推測しない。is_active=0 (上場廃止など) の銘柄は取り込む
 *   2. タイトルを決定論的に分類 (classify)。未分類は tags=[] のまま
 *   3. ルール6: 取得バッチ単位の確定 JSON を「一次データ｜ir-catalog」へ
 *      物理アップロード (1 開示=1Notion 行にすると上限超過するため、
 *      高頻度・大量取得は「バッチ単位の確定ファイル」粒度で記録する —
 *      CLAUDE.md ルール6「高頻度・大量取得の境界」の帰結)。全添付を読戻し照合。
 *   4. ir_catalog.disclosures へ冪等 upsert (tdnet_id 一意)
 *   5. 高シグナル開示 (増配/上方修正/自社株買い 等) のみ人間可読な
 *      Notion 高シグナル DB へ冪等記録 (tag/コード/名称[バフェ・リンク]/
 *      発表日 列)
 *
 * 一次保管・読戻しの失敗は D1 書込前に throw。二次記録・D1 反映の
 * 例外も呼出元へ伝播し、CLI の失敗と後続取得の停止につなげる。
 */
import { and, asc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import {
  recordPrimaryData,
  verifyArchivedAttachments,
  upsertDisclosuresByStock,
  type ByStockRow,
  type PdfClassification,
} from "../../../../src/shared/notion-archive/index.js";
import {
  compareDisclosuresForArchive,
  logIrPdfIncident,
} from "../../../../src/shared/notion-archive/ir-pdf-incident.js";
import type { Database } from "../db/client.js";
import { disclosures, disclosureTexts } from "../db/schema.js";
import { loadIngestCodeToId } from "../../../../src/shared/db/active-equity.js";
import { classify, notionTagOptions, buffettCodeUrl } from "./classify.js";
import { companyCodeToTicker, type TdnetItemRaw } from "./tdnet/types.js";
import { classifyPdfSentimentWithText } from "./pdf-sentiment/index.js";

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
  /**
   * 二次データ投入の相対予算 (ms)。二次フェーズ開始時点から測る。
   * 絶対 deadline と違い D1 upsert 所要に食われない。両方指定時は
   * 早い方で打ち切る。日次 cron 用 (2026-06 以降、開始起点の絶対予算
   * 50s が D1 フェーズに食われて二次投入が常時 0 件だった問題の修正)。
   */
  notionByStockBudgetMs?: number;
  /**
   * notion_page_id が空の開示を、公開からこの日数以内まで D1 から足して
   * 二次投入する。日次 catchup が 7 日窓の外へ落ちた未保存を拾うために使う。
   * 予算ありの実行では、page id が既にある行は Notion 照会へ渡さない。
   */
  unsavedLookbackDays?: number;
  /**
   * code→id マップ (バックフィルで再取得を避けるため注入可)。注入するなら
   * src/shared/db/active-equity.ts の `loadIngestCodeToId` で作ること
   * (省略時もそれで作る。TDnet と EDINET の取込で母集団を揃えるため)。
   */
  codeToId?: Map<string, number>;
  /**
   * 既存 terminal (uploaded+hasFile) 行も Notion の保管済み PDF から再判定する。
   * 通常 backfill は false (冪等スキップ)。本フラグは新カラム反映用の段階的
   * 移行や Engine 改修後の再評価で使う。範囲を狭く (--ticker / --from / --to)
   * 絞ること。
   */
  rejudgePdfSentiment?: boolean;
}

export interface IngestResult {
  fetched: number;
  /** ユニバース内 (= 取込の母集団。src/shared/db/active-equity.ts の loadIngestCodeToId) に絞った件数 */
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

/**
 * (tdnet_id → 抽出テキスト) を `ir_disclosure_texts` へ冪等保存する。
 * テキストあり → upsert + pdf_text_status=ok。テキストなし (画像化/
 * 暗号化等で抽出 0 文字) → 行なし + pdf_text_status=no_text。
 * 保存結果不明や対応 D1 行の不存在は throw。別の状態を書いて成功にしない。
 */
async function persistPdfTexts(
  db: Database,
  pdfMap: Map<string, PdfClassification>
): Promise<void> {
  const entries = [...pdfMap.entries()].filter(
    ([k]) => typeof k === "string" && k.length > 0
  );
  if (entries.length === 0) return;
  for (const [tdnetId, c] of entries) {
    const hit = await db
      .select({ id: disclosures.id, status: disclosures.pdfTextStatus,
        text: disclosureTexts.text, charCount: disclosureTexts.charCount,
        textTdnetId: sql<string | null>`${disclosureTexts.tdnetId}`.as("textTdnetId") })
      .from(disclosures)
      .leftJoin(disclosureTexts, eq(disclosureTexts.disclosureId, disclosures.id))
      .where(eq(disclosures.tdnetId, tdnetId))
      .limit(1);
    if (hit.length !== 1) throw new Error(`PDF 本文の対応 D1 行がないため停止 tdnetId=${tdnetId}`);
    const disclosureId = hit[0]!.id;
    if (c.text === null || c.text === undefined || c.text.length === 0) {
      await db
        .update(disclosures)
        .set({ pdfTextStatus: "no_text" })
        .where(eq(disclosures.tdnetId, tdnetId));
      continue;
    }
    // 送信結果不明で中断しても、現在の全文を照合して同じ INSERT を繰り返さない。
    const current = hit[0]!;
    if (current.text !== c.text || current.charCount !== c.text.length || current.textTdnetId !== tdnetId) await db
      .insert(disclosureTexts)
      .values({
        disclosureId,
        tdnetId,
        text: c.text,
        charCount: c.text.length,
      })
      .onConflictDoUpdate({
        target: disclosureTexts.disclosureId,
        set: { text: c.text, charCount: c.text.length, tdnetId },
      });
    if (current.status !== "ok") await db
      .update(disclosures)
      .set({ pdfTextStatus: "ok" })
      .where(eq(disclosures.id, disclosureId));
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
 *  - ユニバース外 (ticker が codeToId に無い) / コード不正は正直に除外
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
  const codeToId = opts.codeToId ?? (await loadIngestCodeToId(db));
  const prepared = prepareRows(items, codeToId);

  const byPrimaryTag: Record<string, number> = {};
  let unclassified = 0;
  for (const p of prepared) {
    if (p.primaryTag === null) unclassified++;
    else byPrimaryTag[p.primaryTag] = (byPrimaryTag[p.primaryTag] ?? 0) + 1;
  }

  // 確定 JSON の物理保管・全 bytes 照合が閉じるまで D1 は書かない。
  let notionArchive: IngestResult["notionArchive"] = null;
  if (opts.archiveToNotion) {
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
      }))
    );
    const files = [{
      bytes: new TextEncoder().encode(fileJson),
      filename: `${opts.batchKey}.json`,
      contentType: "application/json",
    }];
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
      files,
    });
    if (r.fileTooLarge) throw new Error("TDnet 一次データが容量上限で未保管のため停止");
    await verifyArchivedAttachments(r.pageId, files, "TDnet 確定バッチ");
    notionArchive = { outcome: r.outcome, fileTooLarge: r.fileTooLarge };
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
        // 差分更新: 変わっていない行の UPDATE を省く (L-49)。TDnet 7 日窓の
        // 再取込は既存行の再 upsert が大半で、実測 15,774 行中 2,406 行だけが
        // 新規だった。比較は 4 列 (title/tags/primary_tag/document_url)。
        // IS NOT は NULL 安全 (両 NULL は「変化なし」になる)。
        setWhere: sql`
          "ir_disclosures"."title" IS NOT excluded.title
          OR "ir_disclosures"."tags" IS NOT excluded.tags
          OR "ir_disclosures"."primary_tag" IS NOT excluded.primary_tag
          OR "ir_disclosures"."document_url" IS NOT excluded.document_url
        `,
      });
    upserted += slice.length;
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

  const notionByStock = await archiveDisclosuresByStock(db, byStockRows, {
    ...opts,
    codeToId,
  });

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

/** 保存済み D1 入力から二次保管を再開する。TDnet 一覧は再取得しない。 */
export async function resumeNotionByStock(
  db: Database, from: Date, toExclusive: Date
): Promise<IngestResult["notionByStock"]> {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime())
    || from >= toExclusive) throw new Error("TDnet 再開期間が不正です。");
  const stored = await db.select().from(disclosures)
    .where(and(gte(disclosures.pubdate, from), lt(disclosures.pubdate, toExclusive)))
    .orderBy(disclosures.pubdate, disclosures.tdnetId);
  const codeToId = await loadIngestCodeToId(db);
  const rows: ByStockRow[] = stored.map((p) => {
    const ticker = companyCodeToTicker(p.companyCode);
    if (ticker === null || codeToId.get(ticker) !== p.stockId) {
      throw new Error(`TDnet 保存行の銘柄対応が不一致: ${p.tdnetId}`);
    }
    return {key: p.tdnetId, ticker, companyName: p.companyName,
      companyUrl: buffettCodeUrl(ticker), tags: p.tags, primaryTag: p.primaryTag,
      pubdate: p.pubdate.toISOString(), title: p.title,
      documentUrl: p.documentUrl, markets: p.marketsString};
  });
  console.info(`[ir-tdnet] 保存済み二次入力 ${rows.length}件（一覧取得0）`);
  return archiveDisclosuresByStock(db, rows, {notionByStock: true});
}

const EMPTY_NOTION_BY_STOCK = {
  stocksTouched: 0,
  created: 0,
  updated: 0,
  skippedExisting: 0,
  skippedNoFile: 0,
  rejudged: 0,
  rowErrors: 0,
  reachedDeadline: false,
} as const;

function hasArchivedPage(pageId: string | null | undefined): boolean {
  return typeof pageId === "string" && pageId.length > 0;
}

/**
 * 予算付きの二次投入で Notion へ渡す行。
 * page id がある行は照会しない。遡及で得た未保存は、今回バッチより古くても足す。
 * 再判定 (rejudge) のときはバッチをそのまま渡す（保存済み PDF の再読が目的）。
 */
export function selectNotionArchiveRows(input: {
  batchRows: readonly ByStockRow[];
  archivedKeys: ReadonlySet<string>;
  olderUnsaved: readonly ByStockRow[];
  limitToUnsaved: boolean;
}): { rows: ByStockRow[]; excludedArchivedKeys: string[] } {
  if (!input.limitToUnsaved) {
    return { rows: [...input.batchRows], excludedArchivedKeys: [] };
  }
  const byKey = new Map<string, ByStockRow>();
  for (const row of input.olderUnsaved) {
    if (input.archivedKeys.has(row.key)) continue;
    byKey.set(row.key, row);
  }
  const excludedArchivedKeys: string[] = [];
  for (const row of input.batchRows) {
    if (input.archivedKeys.has(row.key)) {
      excludedArchivedKeys.push(row.key);
      continue;
    }
    if (!byKey.has(row.key)) byKey.set(row.key, row);
  }
  return {
    rows: [...byKey.values()].sort(compareDisclosuresForArchive),
    excludedArchivedKeys,
  };
}

async function loadUnsavedDisclosures(
  db: Database,
  codeToId: Map<string, number>,
  lookbackDays: number,
  nowMs: number
): Promise<ByStockRow[]> {
  if (!Number.isInteger(lookbackDays) || lookbackDays <= 0) {
    throw new Error(`未保存IRの遡及日数が不正です: ${String(lookbackDays)}`);
  }
  const cutoff = new Date(nowMs - lookbackDays * 86_400_000);
  const stored = await db
    .select()
    .from(disclosures)
    .where(
      and(
        gte(disclosures.pubdate, cutoff),
        or(isNull(disclosures.notionPageId), eq(disclosures.notionPageId, ""))
      )
    )
    .orderBy(asc(disclosures.pubdate), asc(disclosures.tdnetId));
  const rows: ByStockRow[] = [];
  const outsideUniverse: string[] = [];
  for (const p of stored) {
    const ticker = companyCodeToTicker(p.companyCode);
    if (ticker === null) {
      throw new Error(`未保存IRの銘柄コードが不正です: ${p.tdnetId}`);
    }
    const stockId = codeToId.get(ticker);
    if (stockId === undefined) {
      outsideUniverse.push(p.tdnetId);
      continue;
    }
    if (stockId !== p.stockId) {
      throw new Error(`未保存IRの銘柄対応が不一致: ${p.tdnetId}`);
    }
    rows.push({
      key: p.tdnetId,
      ticker,
      companyName: p.companyName,
      companyUrl: buffettCodeUrl(ticker),
      tags: p.tags,
      primaryTag: p.primaryTag,
      pubdate: p.pubdate.toISOString(),
      title: p.title,
      documentUrl: p.documentUrl,
      markets: p.marketsString,
    });
  }
  logIrPdfIncident("universe-excluded", outsideUniverse);
  return rows;
}

async function archiveDisclosuresByStock(
  db: Database, byStockRows: ByStockRow[],
  opts: Pick<IngestOptions, "notionByStock" | "notionByStockBudgetMs" | "notionByStockDeadlineMs" | "rejudgePdfSentiment" | "unsavedLookbackDays" | "codeToId">
): Promise<IngestResult["notionByStock"]> {
  let notionByStock: IngestResult["notionByStock"] = null;
  const wantsNotion = opts.notionByStock === true
    && (byStockRows.length > 0 || opts.unsavedLookbackDays !== undefined);
  if (wantsNotion) {
    if (opts.rejudgePdfSentiment === true && opts.unsavedLookbackDays !== undefined) {
      throw new Error("PDF再判定と未保存IRの遡及は同時に指定できません");
    }
    const limitToUnsaved = opts.rejudgePdfSentiment !== true
      && (opts.notionByStockBudgetMs !== undefined || opts.unsavedLookbackDays !== undefined);
    const current = byStockRows.length === 0 ? [] : await db.select({ key: disclosures.tdnetId, pageId: disclosures.notionPageId,
      status: disclosures.pdfTextStatus, textId: disclosureTexts.id })
      .from(disclosures).leftJoin(disclosureTexts, eq(disclosureTexts.disclosureId, disclosures.id))
      .where(sql`${disclosures.tdnetId} IN (SELECT value FROM json_each(${JSON.stringify(byStockRows.map(r => r.key))}))`);
    const currentByKey = new Map(current.map(r => [r.key, r]));
    let olderUnsaved: ByStockRow[] = [];
    if (opts.unsavedLookbackDays !== undefined) {
      if (opts.codeToId === undefined) {
        throw new Error("未保存IRの遡及には codeToId が必要です");
      }
      olderUnsaved = await loadUnsavedDisclosures(
        db,
        opts.codeToId,
        opts.unsavedLookbackDays,
        Date.now()
      );
    }
    const archivedKeys = new Set(
      [...currentByKey.entries()]
        .filter(([, row]) => hasArchivedPage(row.pageId))
        .map(([key]) => key)
    );
    const selected = selectNotionArchiveRows({
      batchRows: byStockRows,
      archivedKeys,
      olderUnsaved,
      limitToUnsaved,
    });
    logIrPdfIncident("archived-skipped-notion-query", selected.excludedArchivedKeys);
    if (selected.rows.length === 0) {
      return { ...EMPTY_NOTION_BY_STOCK };
    }
    const sentKeys = new Set(selected.rows.map((row) => row.key));
    const recoverPdfTextKeys = new Set(current.filter(r => sentKeys.has(r.key) && (r.status === null || r.status === "pending" ||
      (r.status === "ok" && r.textId === null))).map(r => r.key));
    // ファイルプロキシ用に (tdnet_id → notion_page_id) を収集して Postgres
    // に書き戻す。upsertDisclosuresByStock は行を create/PATCH した直後に
    // onPagePersisted を呼ぶので、ここで Map に貯めて末尾でバルク UPDATE。
    const pageIdMap = new Map<string, string>();
    const pdfMap = new Map<string, PdfClassification>();
    // 相対予算はこのフェーズ開始から測る (D1 フェーズの所要に依らない)。
    // 絶対 deadline 併用時は早い方を採用する。
    const phaseDeadline =
      opts.notionByStockBudgetMs !== undefined
        ? opts.notionByStockDeadlineMs !== undefined
          ? Math.min(
              Date.now() + opts.notionByStockBudgetMs,
              opts.notionByStockDeadlineMs
            )
          : Date.now() + opts.notionByStockBudgetMs
        : opts.notionByStockDeadlineMs;
    const r = await upsertDisclosuresByStock({
      service: "ir-catalog",
      tagOptions: notionTagOptions(),
      rows: selected.rows,
      deadlineMs: phaseDeadline,
      onPagePersisted: (key, pageId) => {
        if (currentByKey.get(key)?.pageId !== pageId) pageIdMap.set(key, pageId);
      },
      // PDF 本文を OSS 軽量実装 (数値ルール + 東北大極性辞書) で判定し、
      // Notion 列 + PG 4 列に反映。失敗時は呼ばれた側で unknown を返す
      // (バッチを止めない — ルール2)。抽出テキストも添えて返し、D1 の
      // `ir_disclosure_texts` へ保存する (同じ bytes を使い回し二重取得なし)。
      classifyPdf: async (bytes, primaryTag) => {
        const { result, text } = await classifyPdfSentimentWithText(
          bytes,
          primaryTag
        );
        return { ...result, text };
      },
      onPdfClassified: (key, c) => pdfMap.set(key, c),
      rejudgePdf: opts.rejudgePdfSentiment ?? false,
      recoverPdfTextKeys,
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
    if (pageIdMap.size > 0) {
      await persistNotionPageIds(db, pageIdMap);
    }
    if (pdfMap.size > 0) {
      await persistPdfSentiments(db, pdfMap);
      await persistPdfTexts(db, pdfMap);
    }
  } else if (opts.notionByStock) {
    notionByStock = { ...EMPTY_NOTION_BY_STOCK };
  }

  return notionByStock;
}
