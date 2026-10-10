/**
 * 二次データ (銘柄別 適時開示) の Notion 記録 (CLAUDE.md ルール6 の窓口拡張)。
 *
 * 構造 (ユーザ要件・再改訂): **銘柄ごと階層**
 *   親 DB  「銘柄一覧｜<service>」 (バックアップ配下) … 1 銘柄 = 1 ページ
 *     └ 子 DB 「適時開示｜<ticker>」 (銘柄ページ配下) … 1 IR = 1 行 (全タグ)
 *
 *   旧フラット DB「適時開示｜<service>」(暫定採用) は初回に自動で Notion
 *   ゴミ箱へ退避する (二次データは D1 から再生可能なため復元不要)。
 *
 * 一次データ本体 (`一次データ｜<service>` のバッチ確定ファイル) とは別の
 * **二次データ**。Notion 通信窓口を分散させない (= レート制御一元化) ため
 * 本モジュールも notion-archive 配下に置き、必ず rate-limited な
 * `notionRequest` を通す (ルール6: api.notion.com を直叩きしない)。DB は
 * 「一次データ保管」(`NOTION_ARCHIVE_PAGE_ID`) 配下の子 DB として自動生成
 * (一次データ DB の命名規約 `一次データ｜`/`ごみ｜` とは別 prefix で衝突なし)。
 *
 * 注意 (ルール6 境界の明示的逸脱): 「1 IR = 1 Notion 行」を全銘柄で行うのは
 * rule-6「高頻度・大量取得の境界」が個別大量生成を避ける根拠とした Notion
 * 上限/コストに直結する。ユーザが規模を明示了承したうえでの設計判断
 * (現運用は直近 ~1ヶ月)。冪等・再開可能にして、TDnet API へは追加負荷
 * を与えない (一次データ取得時の items を再利用)。
 *
 * 冪等: 親=ticker、子行=TDnet ID で既存判定。uploaded/unavailable/
 * too_large は終端 skip、error/未添付は PATCH 更新で再実行収束。
 * 捏造・既定値埋めはしない (ルール2)。
 */
import { assertCursorProgress, notionRequest, notionStats } from "./client.js";
import { notionEnv } from "./env.js";
import { NotionFileTooLargeError, uploadFile } from "./file-upload.js";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import { jpxPdfUrl, officialPdfId, type ArchivedPdfProvenance } from "../../../services/ir-catalog/src/services/official-pdf.js";
import { sha256HexBytes } from "../sha256.js";
import {
  IR_PDF_ARCHIVE_INCIDENT_TAG,
  compareDisclosuresForArchive,
  logIrPdfIncident,
} from "./ir-pdf-incident.js";
import {
  assertAdoptedDatabaseSchema,
  createDatabaseOrAdopt,
  findBackupChildByTitle,
  findUniqueBackupChildByTitle,
  findUniqueChildDatabaseForAdopt,
  queryUniqueRow,
} from "./archive.js";

export type NotionSelectColor =
  | "default"
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export interface ByStockRow {
  /** 冪等キー (TDnet 開示 ID) */
  key: string;
  /** 銘柄コード (4 桁/英数字ティッカー) */
  ticker: string;
  /** 銘柄名 */
  companyName: string;
  /** 銘柄名に貼るリンク (buffett-code 等) */
  companyUrl: string;
  /** 付与タグ全件 (ALL)。0 件 = 未分類 */
  tags: string[];
  /** 代表タグ (色分け用)。未分類は null (捏造しない) */
  primaryTag: string | null;
  /** IR 発表日時 (ISO 8601) */
  pubdate: string;
  /** 開示表題 */
  title: string;
  /** 開示資料 URL (document_url) */
  documentUrl: string;
  /** 上場市場文字列。欠落は null (ETF/投信等。捏造しない) */
  markets: string | null;
}

/** PDF 判定結果の Notion select 値域 (childProperties options と一致) */
export type PdfSentimentLabel =
  | "positive"
  | "negative"
  | "mixed"
  | "unknown"
  | "skipped";

export interface PdfClassification {
  sentiment: PdfSentimentLabel;
  /** rule_v1 / dict_v1 など。null は skipped/unknown 用 */
  method: string | null;
  /** -1.0 〜 +1.0 (rule_v1 は 1.0 or null) */
  score: number | null;
  /**
   * 抽出テキスト (呼び出し側が D1 保存用に添える任意 field)。
   * dataset 側は中身を見ず `onPdfClassified` へ素通しする。
   * null/省略 = テキストなし (抽出失敗など。本文保存対象外)。
   */
  text?: string | null;
}

export interface ByStockInput {
  service: string;
  /** multi_select / select の色定義 (全タグ分。色固定用) */
  tagOptions: Array<{ name: string; color: NotionSelectColor }>;
  rows: ByStockRow[];
  /**
   * 投入を打ち切る絶対時刻 (epoch ms)。日次 catchup が予算内に収めるため
   * 指定する。超過時は残りを作らず中断し、残った tdnet id をログに残す
   * (D1 が正本。未保存は遡及窓の次回実行が古い順に回収する)。backfill は
   * 未指定 = 無制限 (再開可能・数日級をユーザ了承済)。
   */
  deadlineMs?: number;
  /**
   * 行のページ作成/更新が成功した直後に呼ばれる。呼び出し側は (key,
   * pageId) を D1 に書き戻して `notion_page_id` を埋めるために使う
   * (ファイルプロキシで Notion から最新 signed URL を取得するための索引)。
   */
  onPagePersisted?: (key: string, pageId: string) => void;
  /**
   * PDF バイト列を受け取り、本文センチメントを判定する callback。
   * `irStatus === "uploaded"` の bytes 取得直後に同じ bytes を再利用して
   * 呼び出される (bytes 二重 fetch を回避)。失敗時は呼ぶ側で `unknown` を
   * 返す設計のため、ここでは throw されない想定。未指定なら呼ばない (=
   * 既存挙動: PDF判定 列は触らない)。
   */
  classifyPdf?: (
    bytes: Uint8Array,
    primaryTag: string | null
  ) => Promise<PdfClassification>;
  /**
   * PDF 判定結果を確定した直後に呼ばれる (D1 `pdf_sentiment*` 4 列の
   * バルク UPDATE 用)。`onPagePersisted` と同パターン。
   */
  onPdfClassified?: (key: string, c: PdfClassification) => void;
  /**
   * 既に terminal (uploaded+hasFile) な行も保管済み添付から再判定する。
   * `classifyPdf` が指定されている時のみ有効。原本サイトへは再取得しない。
   * 既存添付ファイルは再アップロードしない (PATCH は PDF判定 列のみ)。
   * デフォルト false: 通常 backfill では既存 terminal 行は冪等スキップ。
   */
  rejudgePdf?: boolean;
  /** D1 本文保存が未完了の既存添付を再抽出する。発行元 PDF は再取得しない。 */
  recoverPdfTextKeys?: ReadonlySet<string>;
}

export interface ByStockResult {
  /** 親「銘柄一覧」DB の id (確認用。ingest は未参照) */
  parentDbId: string;
  stocksTouched: number;
  created: number;
  /** 既存行 (error/未添付/旧行) を更新した数 (再実行収束用) */
  updated: number;
  skippedExisting: number;
  /**
   * 新規行で物理 PDF を添付できず作成しなかった件数。
   * - TDnet purge 済 (unavailable=終端) の過去開示
   * - 一過性失敗 (transient) で今回は PDF が取れなかった新規開示
   *   (次回再実行時に PDF が取れれば作成される)
   * ユーザ指示「PDF が無ければ意味ない」運用方針の可視化。
   */
  skippedNoFile: number;
  /**
   * `rejudgePdf=true` モードで既存 terminal 行に対して PDF 再 fetch + 再判定 +
   * PATCH (PDF判定 列のみ) が成功した件数。通常 backfill では 0。
   */
  rejudged: number;
  /** 1 行記録に失敗した数 (バッチは継続。再実行で収束) */
  rowErrors: number;
  /** deadline 超過で未処理を残して打ち切ったか (運用者が気づける) */
  reachedDeadline: boolean;
  /** deadline 時点で手を付けていない tdnet id（古い順）。ログにも残す */
  deadlineRemainderKeys: string[];
  /** PDF を添付できず新規行を作らなかった tdnet id。ログにも残す */
  skippedNoFileKeys: string[];
}

interface BlockChildren {
  results: Array<{
    id: string;
    type: string;
    child_database?: { title: string };
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

/** 親「銘柄一覧」DB ID (service 単位) */
const parentDbCache = new Map<string, string>();
/** ticker -> { stockPageId, childDbId } (プロセス内・全実行で再利用) */
const stockCache = new Map<
  string,
  { stockPageId: string; childDbId: string }
>();
/** 親 DB のタイトル (1 銘柄 = 1 ページ) */
function parentTitle(service: string): string {
  return `銘柄一覧｜${service}`;
}
/** 子 DB のタイトル (その銘柄の適時開示 1IR=1行) */
function childTitle(ticker: string): string {
  return `適時開示｜${ticker}`;
}

async function findChildDatabase(
  pageId: string,
  title: string
): Promise<string | null> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const qs = cursor
      ? `?start_cursor=${cursor}&page_size=100`
      : "?page_size=100";
    const res: BlockChildren = await notionRequest<BlockChildren>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    if (res.has_more === true) {
      assertCursorProgress(seen, res.next_cursor as string);
    }
    for (const b of res.results) {
      if (b.type === "child_database" && b.child_database?.title === title) {
        return b.id;
      }
    }
    if (!res.has_more || !res.next_cursor) return null;
    cursor = res.next_cursor;
  }
}

const STATUS_OPTS = [
  { name: "uploaded", color: "green" },
  { name: "unavailable", color: "red" },
  { name: "too_large", color: "orange" },
  { name: "error", color: "gray" },
] as const;

const STATUS_OPTS_LIST = [...STATUS_OPTS] as Array<{
  name: string;
  color: string;
}>;

/**
 * PDF 本文センチメント判定の Notion select options (色は classify.ts のチップと
 * 整合: positive=green / negative=red / mixed=orange / skipped=default)。
 */
const PDF_SENTIMENT_OPTS = [
  { name: "positive", color: "green" },
  { name: "negative", color: "red" },
  { name: "mixed", color: "orange" },
  { name: "unknown", color: "gray" },
  { name: "skipped", color: "default" },
] as const;

const PDF_SENTIMENT_OPTS_LIST = [...PDF_SENTIMENT_OPTS] as Array<{
  name: string;
  color: string;
}>;

/** 子 DB のスキーマ (1 IR = 1 行)。タイトル=開示表題、直後に タグ(色付き) */
function childProperties(
  tagOptions: ByStockInput["tagOptions"]
): Record<string, unknown> {
  return {
    開示表題: { title: {} },
    タグ: { multi_select: { options: tagOptions } },
    代表タグ: { select: { options: tagOptions } },
    IR発表日: { date: {} },
    市場: { rich_text: {} },
    資料: { url: {} },
    IR資料: { files: {} },
    IR取得来歴: { rich_text: {} },
    IR資料状態: { select: { options: STATUS_OPTS_LIST } },
    PDF判定: { select: { options: PDF_SENTIMENT_OPTS_LIST } },
    "TDnet ID": { rich_text: {} },
  };
}

/** 親「銘柄一覧」DB を確保 (無ければ作成)。BACKUP 直下の探索は
 *  Search 完全一致で行う (children 全走査は約1万件で打ち切られる実測)。 */
async function ensureParentDb(
  service: string,
  tagOptions: ByStockInput["tagOptions"]
): Promise<string> {
  const cached = parentDbCache.get(service);
  if (cached) return cached;

  const backup = notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const title = parentTitle(service);
  const existing = await findBackupChildByTitle({
    parentPageId: backup,
    title,
    kind: "database",
  });
  if (existing) {
    parentDbCache.set(service, existing);
    return existing;
  }
  const wantParentProps = {
    銘柄コード: { title: {} },
    銘柄名: { rich_text: {} },
    コード: { select: {} },
  };
  const res = await createDatabaseOrAdopt<{ id: string }>(
    {
      parent: { type: "page_id", page_id: backup },
      title: [{ type: "text", text: { content: title } }],
      properties: wantParentProps,
    },
    () => findUniqueBackupChildByTitle({ parentPageId: backup, title, kind: "database" })
  );
  // tagOptions は子 DB で使う (親では未使用) — 受け取りは API 一貫性のため
  void tagOptions;
  if (res.created) {
    parentDbCache.set(service, res.id);
    return res.id;
  }
  // adopted → cache 前に必須列の型を検証。型違い・不足は保全停止し、
  // 既存列を置換しない。
  const schema = await notionRequest<{ properties: Record<string, { type: string }> }>(
    "GET",
    `/databases/${res.id}`
  );
  assertAdoptedDatabaseSchema(schema.properties, wantParentProps, `銘柄別親DB「${title}」の回収`);
  parentDbCache.set(service, res.id);
  return res.id;
}

/** 親 DB から ticker の銘柄ページを取得 (無ければ作成) */
async function ensureStockPage(
  parentDbId: string,
  row: ByStockRow
): Promise<string> {
  const existing = await queryUniqueRow<{ id: string }>(
    parentDbId,
    { property: "銘柄コード", title: { equals: row.ticker } },
    `銘柄別データの親ページの重複 ticker=${row.ticker} を選ばず保全停止`
  );
  if (existing) return existing.id;

  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: parentDbId },
    properties: {
      銘柄コード: { title: [{ text: { content: row.ticker } }] },
      銘柄名: {
        rich_text: [
          {
            type: "text",
            text: {
              content: row.companyName.slice(0, 1900),
              link: { url: row.companyUrl },
            },
          },
        ],
      },
      コード: { select: { name: row.ticker } },
    },
  });
  return created.id;
}

/** 銘柄ページ配下に子「適時開示」DB を確保 (無ければ作成)。既存は
 *  不足プロパティを非破壊 PATCH (冪等)。 */
async function ensureChildDb(
  stockPageId: string,
  ticker: string,
  tagOptions: ByStockInput["tagOptions"]
): Promise<string> {
  const title = childTitle(ticker);
  let existing = await findChildDatabase(stockPageId, title);
  let adopted = false;
  if (!existing) {
    const res = await createDatabaseOrAdopt<{ id: string }>(
      {
        parent: { type: "page_id", page_id: stockPageId },
        title: [{ type: "text", text: { content: title } }],
        // is_inline:true で銘柄ページの本文中に展開される (リンク表示でなく
        // 開いた瞬間に IR テーブルが見える)。
        is_inline: true,
        properties: childProperties(tagOptions),
      },
      () => findUniqueChildDatabaseForAdopt(stockPageId, title)
    );
    if (res.created) return res.id;
    // adopted → 下の schema 検証へ進む (同名の古い DB かもしれないため)。
    existing = res.id;
    adopted = true;
  }
  const db = await notionRequest<{
    properties: Record<string, { type: string }>;
    is_inline?: boolean;
  }>("GET", `/databases/${existing}`);
  const want = childProperties(tagOptions);
  if (adopted) {
    // 回収 DB は PATCH/cache/return 前に必須列の型を検証する。
    // 型違い・不足は保全停止し、既存列を置換しない。
    assertAdoptedDatabaseSchema(db.properties, want, `適時開示子DB「${title}」の回収`);
  }
  const add: Record<string, unknown> = {};
  for (const k of Object.keys(want)) {
    if (!(k in db.properties)) add[k] = want[k];
  }
  // インライン化(銘柄ページを開いた瞬間にIR表が直接展開される。リンク
  // を開く操作が不要)。既存が full-page なら PATCH で inline に切替
  // (非破壊・冪等)。
  const patch: Record<string, unknown> = {};
  if (Object.keys(add).length > 0) patch.properties = add;
  if (db.is_inline !== true) patch.is_inline = true;
  if (Object.keys(patch).length > 0) {
    await notionRequest("PATCH", `/databases/${existing}`, patch);
  }
  return existing;
}

async function resolveStock(
  parentDbId: string,
  row: ByStockRow,
  tagOptions: ByStockInput["tagOptions"]
): Promise<{ stockPageId: string; childDbId: string }> {
  const cached = stockCache.get(row.ticker);
  if (cached) return cached;
  const stockPageId = await ensureStockPage(parentDbId, row);
  const childDbId = await ensureChildDb(stockPageId, row.ticker, tagOptions);
  const v = { stockPageId, childDbId };
  stockCache.set(row.ticker, v);
  return v;
}

const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

function safeName(s: string): string {
  return s.replace(/[^0-9A-Za-z._-]/g, "");
}

type PdfFile = { bytes: Uint8Array; filename: string; contentType: string;
  origin?: Pick<ArchivedPdfProvenance, "source" | "sourceUrl" | "officialDocumentId" | "retrievedAt" | "pdfSha256" | "pdfBytes"> };
/**
 * PDF 取得結果。
 *  - PdfFile        : 取得成功
 *  - "unavailable"  : 原本が無い/PDFでない (404 等・再取得しても不変=終端)
 *  - "transient"    : ネットワーク/タイムアウト/5xx/429 (一過性。再実行で
 *                     再挑戦すべき → 呼び出し側は status=error にする)
 * いずれも捏造せず、誤ファイル/ダミーで埋めない (ルール1/2)。
 */
type PdfFetch = PdfFile | "unavailable" | "transient";

/**
 * document_url (yanoshin リダイレクト) を辿って IR 開示 PDF を取得する。
 * 一過性失敗 (timeout/5xx/429/network) と恒久不在 (404/非PDF) を区別する
 * (一過性は再実行で収束、恒久は終端 skip)。
 */
async function fetchIrPdf(
  documentUrl: string,
  baseName: string,
  ticker: string
): Promise<PdfFetch> {
  let url = documentUrl;
  let transient = false;
  // The existing primary/archive size policy stays unchanged. The only extra
  // source is the same observed official filename under this issuer at JPX.
  for (let attempt = 0; attempt < 2; attempt++) {
    let observedUrl = url;
    try {
      const res = await fetch(url, {
        redirect: attempt === 0 ? "follow" : "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "kabulab-ir-catalog/1.0 (+https://kabulab-cf.satoki252595.workers.dev/ir-catalog/)" },
      });
      observedUrl = res.url || url;
      if (res.ok && (attempt === 0 || observedUrl === url)) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 5 && PDF_HEADER.every((b, i) => bytes[i] === b)) {
          const file: PdfFile = { bytes, filename: `${safeName(baseName)}.pdf`, contentType: "application/pdf" };
          if (attempt === 1) {
            const documentId = officialPdfId(observedUrl);
            if (documentId === null) throw new Error("source_identity_invalid");
            file.origin = { source: "jpx", sourceUrl: observedUrl, officialDocumentId: documentId,
              retrievedAt: new Date().toISOString(), pdfSha256: await sha256HexBytes(bytes), pdfBytes: bytes.byteLength };
          }
          return file;
        }
        console.warn(`[ir-pdf] ${baseName} source=${attempt === 0 ? "catalog" : "jpx"} code=not_pdf`);
      } else {
        await res.body?.cancel();
        transient ||= res.status >= 500 || res.status === 429;
        console.warn(`[ir-pdf] ${baseName} source=${attempt === 0 ? "catalog" : "jpx"} status=${res.status}`);
      }
    } catch {
      transient = true;
      console.warn(`[ir-pdf] ${baseName} source=${attempt === 0 ? "catalog" : "jpx"} code=network_or_read_failure`);
    }
    const jpx = jpxPdfUrl(ticker + "0", observedUrl);
    if (attempt !== 0 || jpx === null || jpx === url || jpx === observedUrl) break;
    url = jpx;
  }
  return transient ? "transient" : "unavailable";
}

/** 保存済み添付からの再開。添付の矛盾・取得失敗は発行元へ切り替えず停止する。 */
async function fetchArchivedIrPdf(pageId: string): Promise<Uint8Array> {
  const files = await listPageFiles(pageId, "IR資料");
  if (files.length !== 1 || files[0].kind !== "file") {
    throw new Error(`保管済み IR資料が単一の実添付ではありません: ${pageId}`);
  }
  const url = new URL(files[0].url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`保管済み IR資料の URL が不正です: ${pageId}`);
  }
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`保管済み IR資料の取得失敗: ${pageId} status=${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length <= 5 || !PDF_HEADER.every((b, i) => bytes[i] === b)) {
    throw new Error(`保管済み IR資料が PDF ではありません: ${pageId}`);
  }
  return bytes;
}


interface QueryPage {
  id: string;
  properties: {
    "TDnet ID"?: { rich_text?: Array<{ plain_text: string }> };
    IR資料状態?: { select?: { name?: string } | null };
    IR資料?: { files?: unknown[] };
    開示表題?: { title?: Array<{ plain_text: string }> };
    IR発表日?: { date?: { start?: string } | null };
  };
}

/** 既存行の冪等判定情報 */
interface ExistingRow {
  pageId: string;
  /** uploaded | unavailable | too_large | error | null(未設定/旧行) */
  status: string | null;
  /** IR資料 に実ファイルが付いているか */
  hasFile: boolean;
  /** 開示表題 (DB に保存されている値・最大 1900 字に切詰め済) */
  title: string;
  /** IR発表日 (Notion date.start 文字列・空なら "") */
  pubdate: string;
}

/**
 * (開示表題, IR発表日) を結合した重複判定キー。
 * 同一開示の再公開・補正で TDnet ID が変わるケース等を吸収するため、
 * TDnet ID とは別軸の二次冪等キーとして使う (ユーザ指示)。
 * 書込時 `row.title.slice(0, 1900)` と整合させるため同じ切詰めを適用。
 */
function titlePubdateKey(title: string, pubdate: string): string {
  return `${title.slice(0, 1900)}\t${pubdate}`;
}

/** loadExistingInRange の戻り値: TDnet ID キーと (表題+発表日) キーの双方を返す */
interface ExistingIndex {
  byKey: Map<string, ExistingRow>;
  byTitlePubdate: Map<string, ExistingRow>;
}

/**
 * 子 DB の発表日レンジ内 既存行を一括取得 (per-row equals query を撲滅し
 * 再開を高速化)。status/hasFile も返し、再実行で「PDF 未添付/error 行は
 * 作り直さず更新」できるようにする (= 一過性失敗後の再実行で PDF
 * カバレッジが収束する)。
 */
async function loadExistingInRange(
  databaseId: string,
  minISO: string,
  maxISO: string
): Promise<ExistingIndex> {
  const byKey = new Map<string, ExistingRow>();
  const byTitlePubdate = new Map<string, ExistingRow>();
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const res = await notionRequest<{
      results: QueryPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>("POST", `/databases/${databaseId}/query`, {
      filter: {
        and: [
          { property: "IR発表日", date: { on_or_after: minISO } },
          { property: "IR発表日", date: { on_or_before: maxISO } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    if (res.has_more === true) {
      assertCursorProgress(seen, res.next_cursor as string);
    }
    for (const p of res.results) {
      const txt = (p.properties["TDnet ID"]?.rich_text ?? [])
        .map((t) => t.plain_text)
        .join("");
      const title = (p.properties.開示表題?.title ?? [])
        .map((t) => t.plain_text)
        .join("");
      const pubdate = p.properties.IR発表日?.date?.start ?? "";
      const ex: ExistingRow = {
        pageId: p.id,
        status: p.properties.IR資料状態?.select?.name ?? null,
        hasFile: (p.properties.IR資料?.files?.length ?? 0) > 0,
        title,
        pubdate,
      };
      if (txt) byKey.set(txt, ex);
      if (title && pubdate)
        byTitlePubdate.set(titlePubdateKey(title, pubdate), ex);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return { byKey, byTitlePubdate };
}

/**
 * 既存行を「完了済 (再処理不要)」とみなすか。
 * - uploaded: PDF 添付済 → スキップ
 * - unavailable / too_large: 終端 (原本 purge / WS 上限。再取得しても不変)
 *   → スキップ
 * - error / 状態なし / ファイルなしの uploaded 矛盾: 一過性失敗や旧行
 *   → 再処理 (PDF 取得を再試行しページを更新)
 */
function isTerminal(ex: ExistingRow): boolean {
  if (ex.status === "uploaded" && ex.hasFile) return true;
  if (ex.status === "unavailable" || ex.status === "too_large") return true;
  return false;
}

/**
 * 銘柄別 適時開示を Notion へ冪等記録する。全タグ・全 IR が対象 (1IR=1行)。
 * 既存 TDnet ID はスキップ。失敗 (恒久エラー) は notionRequest が throw する
 * ので握りつぶさない (ルール2)。
 */
export async function upsertDisclosuresByStock(
  input: ByStockInput
): Promise<ByStockResult> {
  const parentDbId = await ensureParentDb(input.service, input.tagOptions);
  let created = 0;
  let updated = 0;
  let skippedExisting = 0;
  let skippedNoFile = 0;
  let rejudged = 0;
  const rowErrors = 0;
  let reachedDeadline = false;
  let stocksTouched = 0;
  const overDeadline = () =>
    input.deadlineMs !== undefined && Date.now() > input.deadlineMs;

  const skippedNoFileKeys: string[] = [];
  let deadlineRemainderKeys: string[] = [];

  if (input.rows.length === 0) {
    return {
      parentDbId,
      stocksTouched: 0,
      created,
      updated,
      skippedExisting,
      skippedNoFile,
      rejudged,
      rowErrors,
      reachedDeadline,
      deadlineRemainderKeys,
      skippedNoFileKeys,
    };
  }

  // 公開が古い行から処理する。銘柄単位にまとめると、新しい開示が多い銘柄が
  // 窓から抜けかけの他銘柄より先に予算を使い切る。
  const ordered = [...input.rows].sort(compareDisclosuresForArchive);
  const rowsByTicker = new Map<string, ByStockRow[]>();
  for (const r of ordered) {
    const arr = rowsByTicker.get(r.ticker);
    if (arr) arr.push(r);
    else rowsByTicker.set(r.ticker, [r]);
  }
  const sessions = new Map<
    string,
    { childDbId: string; existing: ExistingIndex }
  >();

  try {
  for (let index = 0; index < ordered.length; index++) {
    if (overDeadline()) {
      reachedDeadline = true;
      deadlineRemainderKeys = ordered.slice(index).map((r) => r.key);
      logIrPdfIncident("deadline-remainder", deadlineRemainderKeys);
      break;
    }
    const row = ordered[index];
    let session = sessions.get(row.ticker);
    if (session === undefined) {
      const tickerRows = rowsByTicker.get(row.ticker);
      if (tickerRows === undefined || tickerRows.length === 0) {
        throw new Error(`銘柄 ${row.ticker} の開示行がありません`);
      }
      // 親 DB の銘柄ページ + その下の子 DB を確保 (プロセス内キャッシュで
      // 全実行を通じて 1 銘柄あたり 1 回だけ解決)。子 DB の既存照会も
      // その銘柄の最古行に到達したとき 1 回だけ。
      const resolved = await resolveStock(parentDbId, row, input.tagOptions);
      stocksTouched++;
      let minISO = tickerRows[0].pubdate;
      let maxISO = tickerRows[0].pubdate;
      for (const r of tickerRows) {
        if (r.pubdate < minISO) minISO = r.pubdate;
        if (r.pubdate > maxISO) maxISO = r.pubdate;
      }
      session = {
        childDbId: resolved.childDbId,
        existing: await loadExistingInRange(
          resolved.childDbId,
          minISO,
          maxISO
        ),
      };
      sessions.set(row.ticker, session);
    }
    const { childDbId, existing } = session;
      const ex = existing.byKey.get(row.key);
      if (ex && isTerminal(ex)) {
        // 本文保存の中断と再判定は、既に物理保管した同じ PDF から再開する。
        if (ex.status === "uploaded" && ex.hasFile && input.classifyPdf &&
          (input.rejudgePdf || input.recoverPdfTextKeys?.has(row.key))) {
          const bytes = await fetchArchivedIrPdf(ex.pageId);
          const cls = await input.classifyPdf(bytes, row.primaryTag);
          if (input.rejudgePdf) {
            await notionRequest("PATCH", `/pages/${ex.pageId}`, {
              properties: { PDF判定: { select: { name: cls.sentiment } } },
            });
            rejudged++;
          }
          input.onPdfClassified?.(row.key, cls);
        }
        // 終端の既存行も D1 の参照へ戻す。再開時の未観測と区別する。
        input.onPagePersisted?.(row.key, ex.pageId);
        skippedExisting++;
        continue;
      }
      // (表題, 発表日) 一致の既存行があれば挿入不要 (TDnet ID が異なる
      // 再公開/補正で同一開示が二重登録されるのを防ぐ — ユーザ指示)。
      // TDnet ID で既に同一行が引けている場合 (ex) はそちらを正とする。
      if (!ex) {
        const tpHit = existing.byTitlePubdate.get(
          titlePubdateKey(row.title, row.pubdate)
        );
        if (tpHit) {
          // 新しい TDnet ID も既存ページに紐づける (ファイルプロキシが
          // disclosures.notion_page_id 経由で最新 signed URL を引けるよう
          // にする — 紐づけないと過渡的に新 ID 側だけ page_id 空になる)。
          input.onPagePersisted?.(row.key, tpHit.pageId);
          skippedExisting++;
          continue;
        }
      }
      // 発表日の古さでは取得を省かない。TDnet の原本保持は固定日数ではなく
      // (2026-10-08 実測: 公開後 37 日は残存、41 日は 404)、未取得のまま
      // 捨てると原本が消えたあと 502 になる。404 は fetch の結果で判定する。

      // 開示 PDF を実体取得して添付 (ルール6)。取得不可/非PDF/上限超過/
      // インフラ失敗は捏造せず添付なし + 状態列に正直記録し、行は作成/
      // 更新を継続 (資料URL列で出典担保・1 行の失敗でバッチ全体を落と
      // さない — ルール1/2)。一過性失敗は error にして再実行で収束。
      const pdf = await fetchIrPdf(
        row.documentUrl,
        `${row.ticker}_${row.pubdate.slice(0, 10)}_${row.key}`,
        row.ticker
      );
      let irFile: Array<{
        name: string;
        type: "file_upload";
        file_upload: { id: string };
      }> = [];
      // uploaded=添付成功 / unavailable=原本恒久不在(404/非PDF・終端) /
      // too_large=WS上限(終端) / error=一過性失敗(再実行で再挑戦・収束)
      let irStatus: "uploaded" | "unavailable" | "too_large" | "error";
      // 取得した PDF バイト列を一度だけ保持し、後段 PDF センチメント判定で
      // 再 fetch せず再利用する (二重取得回避 — cost/通信節約)。
      let pdfBytesForClassify: Uint8Array | null = null;
      // この開示の Notion 呼び出し数 (upload〜readback)。notionStats は
      // プロセス累積なので、行の直前との差をログする。
      let notionBefore: number | undefined;
      if (pdf === "unavailable") {
        irStatus = "unavailable";
      } else if (pdf === "transient") {
        irStatus = "error";
      } else {
        notionBefore = notionStats().requests;
        try {
          const id = await uploadFile(pdf);
          irFile = [
            { name: pdf.filename, type: "file_upload", file_upload: { id } },
          ];
          irStatus = "uploaded";
          pdfBytesForClassify = pdf.bytes;
        } catch (e) {
          console.info(
            `${IR_PDF_ARCHIVE_INCIDENT_TAG} notion-calls tdnetId=${row.key} requests=${notionStats().requests - notionBefore} outcome=error`
          );
          if (!(e instanceof NotionFileTooLargeError)) throw e;
          console.warn(`[ir-pdf] WS 上限超過で添付不可: ${pdf.filename}`);
          irStatus = "too_large";
        }
      }

      // 新規行は PDF を添付できる時だけ作成する (ユーザ指示)。
      // - unavailable (TDnet purge 等の終端) は意味のある行が作れない
      // - error (一過性) は次回再実行で PDF が取れれば作成される
      // - too_large は WS 上限による終端
      // 既存行 (ex) は引き続き更新する: error → uploaded への昇格や
      // status の正直記録を維持して再実行収束を壊さないため。
      if (!ex && irStatus !== "uploaded") {
        skippedNoFile++;
        skippedNoFileKeys.push(row.key);
        continue;
      }

      // PDF 本文センチメント判定 (ユーザ指示「title だけで判断できない開示
      // を PDF から判定」)。callback 未指定 (= 既存挙動) なら呼ばない。
      // bytes が取れた (= uploaded) ときだけ実行する。判定中の例外は
      // 握りつぶさず unknown を返す側責務 (ルール2)。
      let pdfClassification: PdfClassification | null = null;
      if (input.classifyPdf && pdfBytesForClassify !== null) {
        try {
          pdfClassification = await input.classifyPdf(
            pdfBytesForClassify,
            row.primaryTag
          );
        } catch (e) {
          console.error(
            `[pdf-sentiment] 判定例外 ${row.ticker} ${row.key}: ${(e as Error).message}`
          );
          pdfClassification = {
            sentiment: "unknown",
            method: null,
            score: null,
          };
        }
      }

      // 列順 = childProperties 宣言順 (タイトル=開示表題 / 直後にタグ)。
      // 子DB行は銘柄が文脈で確定するため 銘柄コード/銘柄名 列は持たない。
      const properties: Record<string, unknown> = {
        開示表題: { title: [{ text: { content: row.title.slice(0, 1900) } }] },
        タグ: { multi_select: row.tags.map((name) => ({ name })) },
        IR発表日: { date: { start: row.pubdate } },
        資料: { url: row.documentUrl },
        IR資料状態: { select: { name: irStatus } },
        "TDnet ID": { rich_text: [{ text: { content: row.key } }] },
      };
      let originText: string | undefined;
      if (irStatus === "uploaded" && typeof pdf === "object" && pdf.origin !== undefined) {
        const origin: ArchivedPdfProvenance = { schema: "ir-pdf-archive-provenance-v1", catalogId: row.key,
          companyCode: row.ticker + "0", publishedAt: row.pubdate, ...pdf.origin };
        originText = JSON.stringify(origin);
        if (originText.length > 1900) throw new Error("archive_provenance_invalid");
        properties["IR取得来歴"] = { rich_text: [{ text: { content: originText } }] };
      }
      if (irFile.length > 0) properties["IR資料"] = { files: irFile };
      if (row.primaryTag) {
        properties["代表タグ"] = { select: { name: row.primaryTag } };
      }
      if (row.markets) {
        properties["市場"] = {
          rich_text: [{ text: { content: row.markets } }],
        };
      }
      if (pdfClassification !== null) {
        properties["PDF判定"] = {
          select: { name: pdfClassification.sentiment },
        };
      }

      // 記録失敗は後続 PDF 取得へ進まず呼出元へ伝播する。
      let pageId: string;
      if (ex) {
        await notionRequest("PATCH", `/pages/${ex.pageId}`, { properties });
        pageId = ex.pageId;
      } else {
        const createdPage = await notionRequest<{ id: string }>(
          "POST",
          "/pages",
          { parent: { database_id: childDbId }, properties }
        );
        pageId = createdPage.id;
      }
      if (pdfBytesForClassify !== null) {
        await verifyArchivedAttachments(
          pageId,
          [{ filename: irFile[0].name, bytes: pdfBytesForClassify }],
          "TDnet 開示 PDF",
          "IR資料"
        );
      }
      if (originText !== undefined) {
        const readback = await notionRequest<{ properties: Record<string, { type: string;
          rich_text?: Array<{ plain_text: string }> }> }>("GET", `/pages/${pageId}`);
        const saved = readback.properties["IR取得来歴"];
        if (saved?.type !== "rich_text" || saved.rich_text?.map((part) => part.plain_text).join("") !== originText) {
          throw new Error("archive_provenance_readback_mismatch");
        }
      }
      if (notionBefore !== undefined && irStatus === "uploaded") {
        console.info(
          `${IR_PDF_ARCHIVE_INCIDENT_TAG} notion-calls tdnetId=${row.key} requests=${notionStats().requests - notionBefore} outcome=ok`
        );
      }
      if (ex) updated++;
      else created++;
      const writtenTitle = row.title.slice(0, 1900);
      const persisted: ExistingRow = {
        pageId,
        status: irStatus,
        hasFile: irFile.length > 0,
        title: writtenTitle,
        pubdate: row.pubdate,
      };
      existing.byKey.set(row.key, persisted);
      existing.byTitlePubdate.set(
        titlePubdateKey(writtenTitle, row.pubdate),
        persisted
      );
      // 呼び出し側 (ingest) が (tdnet_id → page_id) を Postgres へ
      // 書き戻すための通知。ファイルプロキシ endpoint が page_id 経由で
      // Notion から最新 signed URL を取得するための索引になる。
      input.onPagePersisted?.(row.key, pageId);
      // PDF 判定結果が確定したら ingest 側で Postgres 4 列へバルク反映する
      // ための通知 (skipped/unknown も正直に書き戻す — ルール2)。
      if (pdfClassification !== null) {
        input.onPdfClassified?.(row.key, pdfClassification);
      }
  }
  } finally {
    logIrPdfIncident("skippedNoFile", skippedNoFileKeys);
  }

  return {
    parentDbId,
    stocksTouched,
    created,
    updated,
    skippedExisting,
    skippedNoFile,
    rejudged,
    rowErrors,
    reachedDeadline,
    deadlineRemainderKeys,
    skippedNoFileKeys,
  };
}
