/**
 * 有価証券報告書 1 通を取り込む共通ロジック (backfill と daily cron が共用)。
 *
 * 流れ: 書類取得 API type=5(CSV)/type=1(XBRL) ZIP → 受注・海外売上を
 *       構造化 + CSV 行から定性セクション (事業の内容・リスク等) を抽出 →
 *       物理 ZIP とメタを Notion へ冪等記録 (ルール6。DB batch より先。
 *       raw-before-DB) → yuho_documents / order_facts / overseas_facts /
 *       text_sections に冪等 upsert → 定性テキスト本文のみ DBid 解決後に保管。
 *       custody 完備でも DB 書込ありなら parser 使用 bytes の同一確認を
 *       既存 physical へ通す (strict byte guard。重複 mutation なし)。
 *
 * CLAUDE.md ルール準拠:
 *   - docId 一意で冪等 (再実行・再シャードでも二重計上しない)
 *   - 構造化不能/パース失敗は parse_status に正直に記録し、数値は捏造しない
 *   - 取得・保管・DB の例外は throw して停止。自動再送せず、不明時は読取照合
 *   - 金額欠損は NULL のまま (0 で埋めない)。filer_name/period_end が無い
 *     有報は異常データとして throw
 *   - ルール6: API/ファイル取得物は Notion「一次データ保管」配下の一次データ
 *     DB に冪等記録し、物理ファイルは実体アップロードする
 */
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import type { createD1HttpBatchSender } from "../../../../src/shared/db/d1-http-client.js";
import { toD1BatchStatements } from "../../../../src/shared/db/d1-http-client.js";
import {
  yuhoDocuments,
  orderFacts,
  overseasSalesFacts,
  textSections,
} from "../db/schema.js";
import { backupDocTextToNotion } from "./text-backup.js";
import { downloadDocument, EdinetNotFoundError } from "./edinet/client.js";
import {
  assertNoMetadataOnly,
  checkDocCustody,
  recordEdinetZip,
  type DocCustody,
} from "./edinet/archive.js";
import { parseEdinetCsvZip } from "./edinet/csv.js";
import {
  parseOrderData,
  RX_ORDER_KEYWORD,
  type ParseStatus,
} from "./edinet/order-parser.js";
import {
  parseOverseasData,
  RX_OVERSEAS_KEYWORD,
  validateOverseasSaveSet,
  type OverseasParseStatus,
} from "./overseas-parser.js";
import {
  extractTextSections,
  type TextParseStatus,
} from "./edinet/text-sections.js";
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
  /** 海外売上の構造化結果 (同じ有報から並行構造化)。 */
  overseasParseStatus: OverseasParseStatus | "parse_error";
  overseasFactCount: number;
  /** 定性セクションの抽出結果 (CSV のみ・追加ダウンロードなし)。 */
  textParseStatus: TextParseStatus | "parse_error";
  textSectionCount: number;
  /** 確定した会計期末 (訂正有報は docDescription から導出)。不明時 null */
  periodEnd: string | null;
}

// 保存行変換は共有正準 (overseas-save-rows.ts) を使用する。
// (toYen は orders 系が共用。orders の振舞い変更なし。)
import { toYen, toOverseasSaveRows } from "./overseas-save-rows.js";

/** "2024-06-27 15:30" / "2024-06-27" を Date 化 (JST 表記をそのまま) */
function parseSubmitDateTime(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`submitDateTime 形式が不正: ${s}`);
  const [, y, mo, d, hh, mm] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, hh ? +hh : 0, mm ? +mm : 0));
}


/** 配列を size 件ずつに分割する（D1 の bind 変数上限対策） */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * D1(SQLite over Workers RPC) の 1 文あたり bind 変数上限は 100。order_facts は
 * 12 列/行なので、1 つの INSERT に詰められるのは最大 8 行（8×12=96 ≤ 100）。
 * 建設業など 9 セグメント超の有報は 1 通で 10+ ファクトを持つため、単一 INSERT
 * だと bind 上限超過で取込が落ちる（ADR-0001 §6）。
 */
const MAX_FACT_ROWS_PER_STMT = 8;

/**
 * @param force          true なら既存 docId でも再取得・再構造化して上書き
 * @param archiveToNotion 有報の物理ファイル(XBRL+CSV ZIP)とメタを
 *        Notion「一次データ保管」配下の一次データ DB に type 別 key で冪等
 *        記録 (CLAUDE.md ルール6)。type 毎の有無で判定し再開可能。DB 取込済
 *        でも Notion 未記録の type があればファイルを取得して記録する。
 *        既定 true。false の明示指定は DB 書込の前に明示 STOP する
 *        (raw-before-DB 契約。未対応)。
 */
export async function ingestDocument(
  db: Database,
  args: {
    stockId: number;
    /** 証券コード4桁 (例 "7203") — Notion 銘柄親ページのキー */
    stockCode: string;
    doc: EdinetDoc;
    force?: boolean;
    archiveToNotion?: boolean;
    /**
     * 呼び出し側で日/run ごとに一括取得済みの type 保管完成。
     * 指定時は内部の Notion 照会を省略する (FIFO の 300 秒予算対策)。
     * 未指定時は単通照会する (backfill.ts 等)。
     */
    custody?: DocCustody;
    /**
     * Node (sqlite-proxy) での D1 書込口。`createD1HttpBatchSender()` の
     * 戻り値をそのまま渡す。sqlite-proxy は `db.batch` メソッドを持つが
     * batch callback 未配線で実行時 TypeError になるため、typeof 判定では
     * 足りず明示指定が必須。Worker (D1 バインディング) では未指定のまま
     * 既存 `db.batch` を使う。両方の指定は sender 曖昧として止める。
     */
    d1HttpBatch?: ReturnType<typeof createD1HttpBatchSender>;
  }
): Promise<IngestResult> {
  const { stockId, stockCode, doc, force = false, archiveToNotion = true } = args;

  // Shared entrance preflight: 書込 backend の確定は fetch/remote save より前。
  // sqlite-proxy の db.batch はメソッド自体は存在するが batch callback 未配線
  // (drizzle(callback, { schema }) の第2引数は config 扱い) のため実行時に
  // TypeError になる。$client の有無だけでは足りず (null/{} も「有り」になる)、
  // 実 D1 binding の有限 shape — $client が prepare/batch 呼び出し可能 かつ
  // db.batch 呼び出し可能 (D1Database の公開 API。実行時 probe で確認) — と
  // 明示 HTTP sender の排他で判定する。未知 backend は書く前に止める。
  const d1HttpBatch = args.d1HttpBatch;
  const rawClient = (db as unknown as { $client?: unknown }).$client;
  const hasBindingBatch =
    typeof db.batch === "function" &&
    typeof rawClient === "object" &&
    rawClient !== null &&
    typeof (rawClient as { prepare?: unknown }).prepare === "function" &&
    typeof (rawClient as { batch?: unknown }).batch === "function";
  if (d1HttpBatch !== undefined && hasBindingBatch) {
    throw new Error(
      "[ingest] D1 書込 backend が二重指定です (d1HttpBatch と binding)。同一入力の sender は 1 つにしてください。"
    );
  }
  if (d1HttpBatch === undefined && !hasBindingBatch) {
    throw new Error(
      "[ingest] D1 batch backend がありません: Node (sqlite-proxy) では d1HttpBatch (createD1HttpBatchSender) を明示してください。書込の前に止めます。"
    );
  }

  const existing = await db
    .select({
      id: yuhoDocuments.id,
      textParseStatus: yuhoDocuments.textParseStatus,
      notionDocPageId: yuhoDocuments.notionDocPageId,
    })
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.docId, doc.docID))
    .limit(1);
  const existsInDb = existing.length > 0;

  // Notion 記録は DB 取込とは独立に冪等。DB は取込済でも Notion 未記録なら
  // 物理ファイルを取得して記録する (ルール6: API 取得物は必ず Notion へ)。
  // type 保管の完成は実 Files 物理添付で判定する (key 存在だけでは
  // metadata-only 行を成功扱いする)。呼び出し側の一括取得があれば再利用する。
  const custody: DocCustody | undefined =
    archiveToNotion && !force
      ? (args.custody ?? (await checkDocCustody(NOTION_SERVICE, doc.docID)))
      : undefined;
  if (custody) assertNoMetadataOnly(custody, doc.docID);
  const t1Done = custody !== undefined && custody.t1 !== "missing";
  const t5Done = custody !== undefined && custody.t5 !== "missing";
  // 本文 parse 済み (ok) なのに Notion 行ポインタが無い通は、raw 保管が
  // 揃っていても未完了として本文回収フローへ回す (skipped_existing にしない)。
  // D1 書込は docId 冪等 (onConflictDoUpdate + 文書単位 delete→insert) のため
  // 同一 key の再実行で安全にポインタを完成できる。
  const existingRow = existing[0];
  const textPointerMissing =
    existingRow !== undefined &&
    existingRow.textParseStatus === "ok" &&
    existingRow.notionDocPageId === null;
  const needDbWork = !existsInDb || force || textPointerMissing;
  const needT1 = archiveToNotion && (!t1Done || force);
  const needT5 = archiveToNotion && (!t5Done || force);
  const needArchive = needT1 || needT5;

  if (!needDbWork && !needArchive) {
    return {
      outcome: "skipped_existing",
      parseStatus: "no_order_table",
      overseasParseStatus: "no_overseas_table",
      textParseStatus: "no_text_sections",
      factCount: 0,
      overseasFactCount: 0,
      textSectionCount: 0,
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
      overseasParseStatus: "no_overseas_table",
      textParseStatus: "no_text_sections",
      factCount: 0,
      overseasFactCount: 0,
      textSectionCount: 0,
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
      overseasParseStatus: "no_overseas_table",
      textParseStatus: "no_text_sections",
      factCount: 0,
      overseasFactCount: 0,
      textSectionCount: 0,
      periodEnd: null,
    };
  }

  // raw-before-DB 契約: archiveToNotion=false は未対応。DB 書込の前に明示
  // STOP する (書込も fetch もしない)。既存 cache の早期 skip・meta 不備・
  // period 不明は上で return 済みのためここには来ない。
  if (!archiveToNotion && needDbWork) {
    throw new Error(
      `[ingest] archiveToNotion=false は未対応のため DB 書込の前に STOP します (raw-before-DB 契約): docID=${doc.docID}`
    );
  }

  // 1) 軽量な CSV で受注・海外売上 開示の有無を確定。どちらも無ければ重い XBRL を
  //    落とさない (帯域節約)。CSV は全テキストブロックを平坦化して含むので、開示が
  //    あれば必ず語が現れる (推測ではなく CSV 全文判定)。
  let parseStatus: ParseStatus | "parse_error";
  let honbunFile: string | null = null;
  let facts: ReturnType<typeof parseOrderData>["facts"] = [];
  let overseasParseStatus: OverseasParseStatus | "parse_error";
  let overseasHonbunFile: string | null = null;
  let overseasFacts: ReturnType<typeof parseOverseasData>["facts"] = [];
  let overseasProof: ReturnType<typeof parseOverseasData>["proof"];

  const csvZip = await downloadDocument(doc.docID, 5);
  let hasOrderKeyword = false;
  let hasOverseasKeyword = false;
  let csvError = false;
  let csvRows: ReturnType<typeof parseEdinetCsvZip> | null = null;
  try {
    const rows = parseEdinetCsvZip(csvZip);
    csvRows = rows;
    hasOrderKeyword = rows.some(
      (r) => RX_ORDER_KEYWORD.test(r.itemName) || RX_ORDER_KEYWORD.test(r.value)
    );
    hasOverseasKeyword = rows.some(
      (r) =>
        RX_OVERSEAS_KEYWORD.test(r.itemName) || RX_OVERSEAS_KEYWORD.test(r.value)
    );
  } catch (e) {
    // CSV 解析自体が壊れたら事実として記録 (捏造しない)
    csvError = true;
    console.warn(
      `[ingest] csv parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
    );
  }

  // XBRL(type=1) は「受注 or 海外売上 ありで構造化が要る」か「Type1 の
  // Notion 物理保存が要る (ルール6)」のいずれかで取得する。どちらの開示も
  // 無く Type1 保存不要 (Type5 のみ欠け) なら重い XBRL を落とさない
  // (帯域節約)。1 通の XBRL を 1 回だけ取得し、受注と海外売上を並行して
  // 構造化する (二重ダウンロードしない)。
  let xbrlZip: Buffer | null = null;
  let xbrlUnavailable = false;
  const wantXbrl =
    (!csvError && (hasOrderKeyword || hasOverseasKeyword)) || needT1;
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

  // 2') 同じ XBRL から海外（地域別）売上を並行構造化する (受注とは独立)。
  if (csvError) {
    overseasParseStatus = "parse_error";
  } else if (!hasOverseasKeyword) {
    overseasParseStatus = "no_overseas_table";
  } else if (!xbrlZip) {
    overseasParseStatus = "parse_error";
  } else {
    try {
      const ex = parseOverseasData(xbrlZip, periodEnd);
      overseasParseStatus = ex.status;
      overseasHonbunFile = ex.honbunFile;
      overseasFacts = ex.facts;
      overseasProof = ex.proof;
    } catch (e) {
      overseasParseStatus = "parse_error";
      overseasHonbunFile = null;
      overseasFacts = [];
      console.warn(
        `[ingest] overseas parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
      );
    }
  }

  // 2'') CSV 行から定性セクション (事業の内容・リスク等) を並行抽出する。
  // CSV は既に取得済みで追加ダウンロードは一切ない。XBRL の有無に依らない。
  let textParseStatus: TextParseStatus | "parse_error";
  let sections: ReturnType<typeof extractTextSections> = [];
  if (csvError || !csvRows) {
    textParseStatus = "parse_error";
  } else {
    try {
      sections = extractTextSections(csvRows);
      textParseStatus = sections.length > 0 ? "ok" : "no_text_sections";
    } catch (e) {
      textParseStatus = "parse_error";
      sections = [];
      console.warn(
        `[ingest] text parse_error docID=${doc.docID} ${doc.filerName}: ${(e as Error).message}`
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

  // 海外売上ファクトは保存前検証を通す。違反があれば parse_error + 空保存
  // (先頭行 dedup で回復させない = aggregate-before-dedup の再発防止)。
  try {
    validateOverseasSaveSet(overseasFacts, overseasProof);
  } catch (e) {
    console.warn(
      `[ingest] overseas save-set invalid; downgrade to parse_error docID=${doc.docID}: ${(e as Error).message}`
    );
    overseasParseStatus = "parse_error";
    overseasFacts = [];
  }

  // ルール6 + raw-before-DB + strict byte guard (Root 原本 mandatory):
  // DB batch の前に type ごと最大 1 回 recordEdinetZip を通す。
  // - custody 欠落 type (needT5/needT1): 新規記録
  // - custody 完備でも needDbWork (parser が bytes 使用): 同一 bytes/SHA
  //   確認を既存 physical へ通す。通常枝 (force=false) では
  //   recordPrimaryData は skipped_existing で重複 mutation なし →
  //   unique physical + full-bytes SHA verify。force=true は既存契約
  //   どおり args.force を透過する (再記録の枝)。旧 plan-gated 経路
  //   (custody 完備で無検証のまま DB 到達) はこの guard が塞ぐ。
  // needDbWork=false (archived_only 等) は欠落 type のみ従来通り。
  // 記録失敗は throw が伝播し DB は旧値のまま (再実行可)。
  // metadata は DBid 非依存 (text ポインタのみ DBid 解決後)。
  if (archiveToNotion) {
    const fetchedAt = parseSubmitDateTime(doc.submitDateTime).toISOString();
    const metadata = {
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
      overseasParseStatus,
      overseasHonbunFile,
      overseasFactCount: overseasFacts.length,
      textParseStatus,
      textSectionCount: sections.length,
      xbrlUnavailable,
    };
    // csvZip は取得失敗時 throw のためここでは非 null。xbrlZip は未提供で
    // null の場合 type1 を記録しない (無い物の記録は捏造。ルール1)。
    if (needT5 || needDbWork) {
      await recordEdinetZip({
        service: NOTION_SERVICE,
        docID: doc.docID,
        type: 5,
        zip: csvZip,
        source: `EDINET API v2 /documents/${doc.docID}?type=5`,
        fetchedAt,
        metadata,
        force,
      });
    }
    if (xbrlZip && (needT1 || needDbWork)) {
      await recordEdinetZip({
        service: NOTION_SERVICE,
        docID: doc.docID,
        type: 1,
        zip: xbrlZip,
        source: `EDINET API v2 /documents/${doc.docID}?type=1`,
        fetchedAt,
        metadata,
        force,
      });
    }
  }

  if (needDbWork) {
    // 文書 upsert 自体を facts/text 置換と同一 batch に入れる。以前は upsert
    // を先行コミットして返却 id を facts に流していたため、後続 batch の失敗
    // で「メタだけ埋まって facts 0 件」の部分行が残り、次回以降
    // skipped_existing で永久に埋まらなかった (Node sqlite-proxy の
    // db.batch 未配線で確定発症)。facts/text の documentId は同一 batch 内
    // の upsert 行を docId サブクエリで参照し、事前 upsert/id 取得の 2 往復
    // を排除する。行 id は batch から取り出さない (両 backend で同一動作)。
    const docUpsert = db
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
        overseasParseStatus,
        overseasHonbunFile,
        textParseStatus,
      })
      .onConflictDoUpdate({
        target: yuhoDocuments.docId,
        set: {
          parseStatus,
          honbunFile,
          overseasParseStatus,
          overseasHonbunFile,
          textParseStatus,
          submittedAt: parseSubmitDateTime(doc.submitDateTime),
          periodStart: doc.periodStart,
          periodEnd,
        },
      });

    // 同一 batch 内の upsert 行を指す docId サブクエリ。facts/text の
    // documentId はこれで束縛する (JS 側で id を受け渡さない)。1 行あたりの
    // bind 数は変わらない (id 値の束縛が docID 文字列の束縛に置き換わるだけ)。
    const docIdSubquery = sql`(select ${yuhoDocuments.id} from ${yuhoDocuments} where ${yuhoDocuments.docId} = ${doc.docID})`;

    // 再取り込み (force) 時は当該書類の旧 facts を破棄してから入れ直す。
    // D1 の bind 上限 (100) を超えないよう insert を 8 行ずつに分割し、
    // upsert・delete・全 insert を同一 batch で原子的に置換する (Neon 版の
    // delete→insert と等価以上の一貫性)。送信口は入口 preflight で確定済み:
    // Worker は既存 db.batch、Node は明示 d1HttpBatch (同一 builders を
    // toSQL 化して送る。per-statement フォールバックはしない)。
    const factRows = deduped.map((f) => ({
      documentId: docIdSubquery,
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
    }));

    // 海外売上ファクト (yuho_overseas_facts) も同じ docId サブクエリを親に
    // 置換する。11 列/行 → D1 bind 上限 100 に対し 8 行/文 (8×11=88) で分割。
    const overseasRows = toOverseasSaveRows(overseasFacts, overseasParseStatus).map((o) => ({
      documentId: docIdSubquery,
      stockId,
      ...o,
    }));

    // 定性セクション索引 (yuho_text_sections) も同じ docId サブクエリを親に
    // 置換する。本文は Notion のみ (P4)。8 列/行 → D1 bind 上限 100 に対し
    // 8 行/文 (8×8=64)。抽出器が 1 セクション 1 行に確定済みなので重複は出ない。
    const sectionRows = sections.map((s) => ({
      documentId: docIdSubquery,
      stockId,
      fiscalYearEnd: periodEnd,
      sectionKey: s.sectionKey,
      elementId: s.elementId,
      itemName: s.itemName,
      contextId: s.contextId,
      charCount: s.charCount,
    }));

    const statements = [
      docUpsert,
      db.delete(orderFacts).where(eq(orderFacts.documentId, docIdSubquery)),
      ...chunk(factRows, MAX_FACT_ROWS_PER_STMT).map((rows) =>
        db.insert(orderFacts).values(rows)
      ),
      db
        .delete(overseasSalesFacts)
        .where(eq(overseasSalesFacts.documentId, docIdSubquery)),
      ...chunk(overseasRows, MAX_FACT_ROWS_PER_STMT).map((rows) =>
        db.insert(overseasSalesFacts).values(rows)
      ),
      db.delete(textSections).where(eq(textSections.documentId, docIdSubquery)),
      ...chunk(sectionRows, MAX_FACT_ROWS_PER_STMT).map((rows) =>
        db.insert(textSections).values(rows)
      ),
    ];
    if (d1HttpBatch !== undefined) {
      // 同一 builders を toSQL 化して送る (対象外の束縛値は送らず throw)。
      // per-statement フォールバックはしない。
      await d1HttpBatch(toD1BatchStatements(statements));
    } else {
      // db.batch の受け口は非空タプル要求。先頭 upsert の存在を
      // 実行時に強制する (chunk が空でも upsert+delete 3 文は残る)。
      const [first, ...rest] = statements;
      if (first === undefined) {
        throw new Error(
          "[ingest] D1 batch 文が 0 件です (upsert 先頭の不変条件違反)。書込の前に止めます。"
        );
      }
      await db.batch([first, ...rest]);
    }
  }

  // 定性テキスト本文の Notion 保管 (D1 10GB 上限対策。D1 には索引 + 行 ID)。
  // needDbWork の有無に依らず手元の本文があれば保管し、行 ID を D1 へ
  // 書き戻す。本文あり (sections>0) なのにポインタが残らない状態は成功に
  // しない: 保管失敗・行なし・行 ID 未取得は throw し、呼び出し側
  // (日次は通単位で失敗計上して継続) が未完了として扱う。既存行がある
  // 場合は backupDocTextToNotion が既存行 ID を返して回収する
  // (skipped_existing)。回収は backfill-text-sections --doc --force が担う。
  // セクション 0 件は保管対象外 (textParseStatus が D1 側に残り「未保管」と区別できる)。
  if (sections.length > 0) {
    // D1 行 id は batch から取り出さない (両 backend で同一動作にするため、
    // upsert に .returning を付けない)。docId 冪等 SELECT で解決する
    // (従来のフォールバックを正規化。PK 1 件読み)。
    const found = await db
      .select({ id: yuhoDocuments.id })
      .from(yuhoDocuments)
      .where(eq(yuhoDocuments.docId, doc.docID))
      .limit(1);
    const id = found[0]?.id ?? null;
    if (id === null) {
      throw new Error(
        `[ingest] notion text backup 失敗(行なし) docID=${doc.docID}: D1 行が無いのに本文セクションが ${sections.length} 件あります`
      );
    }
    const r = await backupDocTextToNotion({
      stockCode,
      docId: doc.docID,
      d1DocumentId: id,
      fiscalYearEnd: periodEnd,
      textParseStatus,
      sections,
      force,
    });
    if (!r.rowPageId) {
      throw new Error(
        `[ingest] notion text backup 失敗(行 ID 未取得) docID=${doc.docID}: outcome=${r.outcome}`
      );
    }
    await db
      .update(yuhoDocuments)
      .set({ notionDocPageId: r.rowPageId })
      .where(eq(yuhoDocuments.id, id));
  }

  return {
    outcome: needDbWork ? "ingested" : "archived_only",
    parseStatus,
    factCount: deduped.length,
    overseasParseStatus,
    overseasFactCount: overseasFacts.length,
    textParseStatus,
    textSectionCount: sections.length,
    periodEnd,
  };
}
