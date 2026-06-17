/**
 * 有価証券報告書 1 通を取り込む共通ロジック (backfill と daily cron が共用)。
 *
 * 流れ: 書類取得 API type=5(CSV)/type=1(XBRL) ZIP → parseOrderData で受注を
 *       構造化 → yuho_quant.documents / order_facts に冪等 upsert →
 *       (archiveToNotion 時) 物理 ZIP とメタを Notion へ冪等記録 (ルール6)。
 *
 * CLAUDE.md ルール準拠:
 *   - docId 一意で冪等 (再実行・再シャードでも二重計上しない)
 *   - 構造化不能/パース失敗は parse_status に正直に記録し、数値は捏造しない
 *   - ネットワーク等の一過性失敗は throw して上位でリトライ判断 (握りつぶさない)
 *   - 金額欠損は NULL のまま (0 で埋めない)。filer_name/period_end が無い
 *     有報は異常データとして throw
 *   - ルール6: API/ファイル取得物は Notion「バックアップ」配下の一次データ
 *     DB に冪等記録し、物理ファイルは実体アップロードする
 */
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { yuhoDocuments, orderFacts } from "../db/schema.js";
import {
  recordPrimaryData,
  isArchived,
} from "../../../../src/shared/notion-archive/index.js";
import { downloadDocument, EdinetNotFoundError } from "./edinet/client.js";
import { parseEdinetCsvZip } from "./edinet/csv.js";
import {
  parseOrderData,
  RX_ORDER_KEYWORD,
  type ParseStatus,
} from "./edinet/order-parser.js";
import { resolveReportPeriodEnd, type EdinetDoc } from "./edinet/types.js";

// 受注開示判定の語はパーサと単一定義を共有 (RX_ORDER_KEYWORD)。CSV(type=5)
// は全テキストブロックを平坦化して含むので、受注が開示されていれば必ず
// この語が現れる。出なければ重い XBRL を落とさず「受注開示なし」と確定
// できる (推測ではなく CSV 全文判定)。建設業の列名揺れにも追随する。

export type IngestOutcome =
  | "ingested"
  | "archived_only"
  | "skipped_existing"
  | "skipped_no_period"
  | "skipped_invalid_meta";

/** 005 のサービス識別子 (Notion アーカイブのサービス別 DB 名に使う) */
const NOTION_SERVICE = "yuho-quant";

export interface IngestResult {
  outcome: IngestOutcome;
  parseStatus: ParseStatus | "parse_error";
  factCount: number;
  /** 確定した会計期末 (訂正有報は docDescription から導出)。不明時 null */
  periodEnd: string | null;
}

/** "2024-06-27 15:30" / "2024-06-27" を Date 化 (JST 表記をそのまま) */
function parseSubmitDateTime(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`submitDateTime 形式が不正: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0));
}

function toYen(raw: number | null, factor: number): number | null {
  if (raw === null) return null;
  return Math.round(raw * factor);
}

/**
 * @param force          true なら既存 docId でも再取得・再構造化して上書き
 * @param archiveToNotion true なら有報の物理ファイル(XBRL+CSV ZIP)とメタを
 *        Notion「バックアップ」配下の一次データ DB に冪等記録 (CLAUDE.md
 *        ルール6)。Notion 記録は docId 一意で冪等・再開可能。DB 取込済でも
 *        Notion 未記録なら本関数はファイルを取得して Notion へ記録する。
 */
export async function ingestDocument(
  db: Database,
  args: {
    stockId: number;
    doc: EdinetDoc;
    force?: boolean;
    archiveToNotion?: boolean;
  }
): Promise<IngestResult> {
  const { stockId, doc, force = false, archiveToNotion = false } = args;

  const existing = await db
    .select({ id: yuhoDocuments.id })
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.docId, doc.docID))
    .limit(1);
  const existsInDb = existing.length > 0;

  // Notion 記録は DB 取込とは独立に冪等。DB は取込済でも Notion 未記録なら
  // 物理ファイルを取得して記録する (ルール6: API 取得物は必ず Notion へ)。
  const notionPresent =
    archiveToNotion && !force
      ? await isArchived(NOTION_SERVICE, doc.docID)
      : false;
  const needDbWork = !existsInDb || force;
  const needArchive = archiveToNotion && (!notionPresent || force);

  if (!needDbWork && !needArchive) {
    return {
      outcome: "skipped_existing",
      parseStatus: "no_order_table",
      factCount: 0,
      periodEnd: doc.periodEnd ?? null,
    };
  }

  // 有報として最低限必要なメタが欠ける異常エントリは、捏造せず明示スキップ
  // (ルール2: 埋めない。throw でバッチを汚さず outcome で運用者に可視化)。
  if (
    !doc.filerName ||
    !doc.docTypeCode ||
    !doc.edinetCode ||
    !doc.submitDateTime
  ) {
    console.warn(
      `[ingest] skip(meta-missing) docID=${doc.docID} filer=${doc.filerName} type=${doc.docTypeCode} edinet=${doc.edinetCode}`
    );
    return {
      outcome: "skipped_invalid_meta",
      parseStatus: "no_order_table",
      factCount: 0,
      periodEnd: null,
    };
  }
  // 訂正有報(130)は一覧の periodEnd が null。docDescription 記載の対象期間
  // (EDINET 自身の記載) から会計期末を確定する。確定不能なら明示スキップ。
  const periodEnd = resolveReportPeriodEnd(doc);
  if (!periodEnd) {
    console.warn(
      `[ingest] skip(period-unknown) docID=${doc.docID} ${doc.filerName} desc="${doc.docDescription ?? ""}"`
    );
    return {
      outcome: "skipped_no_period",
      parseStatus: "no_order_table",
      factCount: 0,
      periodEnd: null,
    };
  }

  // 1) 軽量な CSV で受注開示の有無を確定。無ければ重い XBRL を落とさない。
  let parseStatus: ParseStatus | "parse_error";
  let honbunFile: string | null = null;
  let facts: ReturnType<typeof parseOrderData>["facts"] = [];

  const csvZip = await downloadDocument(doc.docID, 5);
  let hasOrderKeyword = false;
  let csvError = false;
  try {
    const rows = parseEdinetCsvZip(csvZip);
    hasOrderKeyword = rows.some(
      (r) => RX_ORDER_KEYWORD.test(r.itemName) || RX_ORDER_KEYWORD.test(r.value)
    );
  } catch (e) {
    // CSV 解析自体が壊れたら事実として記録 (捏造しない)
    csvError = true;
    console.warn(
      `[ingest] csv parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
    );
  }

  // XBRL(type=1) は「受注ありで構造化が要る」か「Notion へ物理保存する
  // (ルール6: 有報自体をアップロード)」のいずれかで取得する。受注なし且つ
  // Notion 保存不要なら従来どおり重い XBRL を落とさない (帯域節約)。
  let xbrlZip: Buffer | null = null;
  let xbrlUnavailable = false;
  const wantXbrl = (!csvError && hasOrderKeyword) || needArchive;
  if (wantXbrl) {
    try {
      xbrlZip = await downloadDocument(doc.docID, 1);
    } catch (e) {
      if (e instanceof EdinetNotFoundError) {
        // type=1 未提供は事実として記録 (捏造しない・ルール2)
        xbrlUnavailable = true;
        console.warn(
          `[ingest] xbrl unavailable docID=${doc.docID} ${doc.filerName}`
        );
      } else {
        throw e;
      }
    }
  }

  if (csvError) {
    parseStatus = "parse_error";
  } else if (!hasOrderKeyword) {
    parseStatus = "no_order_table";
  } else if (!xbrlZip) {
    // 受注語ありだが XBRL 未提供 → 構造化不能を正直に記録
    parseStatus = "parse_error";
  } else {
    // 2) 受注ありと確定 → XBRL(type=1) で表構造を構造化
    try {
      const ex = parseOrderData(xbrlZip, periodEnd);
      parseStatus = ex.status;
      honbunFile = ex.honbunFile;
      facts = ex.facts;
    } catch (e) {
      parseStatus = "parse_error";
      honbunFile = null;
      facts = [];
      console.warn(
        `[ingest] parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
      );
    }
  }

  // 安全弁: 同一 (会計期末, セグメント名) の重複は order_facts の一意制約に
  // 反し 1 件でもあると企業全体の insert が落ちる。万一パーサが重複を出して
  // も会社単位で取りこぼさないよう、先頭を採用し重複は警告して落とす
  // (黙殺せずログ可視化 = ルール2)。dedup は DB 取込/Notion メタ双方で使う
  // ので needDbWork に依らず先に計算する。
  const deduped: typeof facts = [];
  const seenKeys = new Set<string>();
  for (const f of facts) {
    const fk = `${f.fiscalYearEnd} ${f.segmentName}`;
    if (seenKeys.has(fk)) {
      console.warn(
        `[ingest] dup-seg-skip docID=${doc.docID} fy=${f.fiscalYearEnd} seg=${f.segmentName}`
      );
      continue;
    }
    seenKeys.add(fk);
    deduped.push(f);
  }

  if (needDbWork) {
    const [docRow] = await db
      .insert(yuhoDocuments)
      .values({
        stockId,
        edinetCode: doc.edinetCode,
        docId: doc.docID,
        docTypeCode: doc.docTypeCode,
        filerName: doc.filerName,
        periodStart: doc.periodStart,
        periodEnd,
        submittedAt: parseSubmitDateTime(doc.submitDateTime),
        parseStatus,
        honbunFile,
      })
      .onConflictDoUpdate({
        target: yuhoDocuments.docId,
        set: {
          parseStatus,
          honbunFile,
          submittedAt: parseSubmitDateTime(doc.submitDateTime),
          periodStart: doc.periodStart,
          periodEnd,
        },
      })
      .returning({ id: yuhoDocuments.id });

    // 再取り込み (force) 時は当該書類の旧 facts を破棄してから入れ直す
    await db.delete(orderFacts).where(eq(orderFacts.documentId, docRow.id));

    if (deduped.length > 0) {
      await db.insert(orderFacts).values(
        deduped.map((f) => ({
          documentId: docRow.id,
          stockId,
          fiscalYearEnd: f.fiscalYearEnd,
          segmentName: f.segmentName,
          segmentKind: f.segmentKind,
          isConsolidated: f.isConsolidated,
          unitLabel: f.unitLabel,
          ordersReceivedRaw: f.ordersReceived,
          orderBacklogRaw: f.orderBacklog,
          ordersReceivedYen: toYen(f.ordersReceived, f.unitYenFactor),
          orderBacklogYen: toYen(f.orderBacklog, f.unitYenFactor),
          pattern:
            parseStatus === "ok_pattern_b"
              ? "pattern_b"
              : parseStatus === "ok_pattern_c"
                ? "pattern_c"
                : parseStatus === "ok_total_only"
                  ? "total_only"
                  : "pattern_a",
        }))
      );
    }
  }

  // ルール6: 有報の物理ファイル(CSV+XBRL ZIP)とメタデータを Notion へ
  // 冪等記録。docId をキーに既存ならスキップ (再開可能)。XBRL 未提供
  // (type=1 なし) は CSV のみ記録し xbrlUnavailable=true を残す (捏造しない)。
  if (needArchive) {
    const files = [
      {
        bytes: new Uint8Array(csvZip),
        filename: `${doc.docID}_csv.zip`,
        contentType: "application/zip",
      },
      ...(xbrlZip
        ? [
            {
              bytes: new Uint8Array(xbrlZip),
              filename: `${doc.docID}_xbrl.zip`,
              contentType: "application/zip",
            },
          ]
        : []),
    ];
    await recordPrimaryData({
      service: NOTION_SERVICE,
      key: doc.docID,
      source: `EDINET API v2 /documents/${doc.docID} (type=1 XBRL / type=5 CSV)`,
      fetchedAt: parseSubmitDateTime(doc.submitDateTime).toISOString(),
      metadata: {
        docID: doc.docID,
        edinetCode: doc.edinetCode,
        secCode: doc.secCode,
        filerName: doc.filerName,
        docTypeCode: doc.docTypeCode,
        docDescription: doc.docDescription,
        periodStart: doc.periodStart,
        periodEnd,
        submitDateTime: doc.submitDateTime,
        parseStatus,
        honbunFile,
        factCount: deduped.length,
        xbrlUnavailable,
      },
      files,
      force,
    });
  }

  return {
    outcome: needDbWork ? "ingested" : "archived_only",
    parseStatus,
    factCount: deduped.length,
    periodEnd,
  };
}
