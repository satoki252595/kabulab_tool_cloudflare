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
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import { NotionFileTooLargeError, uploadFile } from "./file-upload.js";
import { findBackupChildByTitle } from "./archive.js";

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
   * 投入を打ち切る絶対時刻 (epoch ms)。日次 catchup が NOTION_BUDGET_MS
   * 内に収めるため指定する。超過時は残りを作らず中断 (D1 が正本・
   * WINDOW 重なりと TDnet ID 冪等で翌日以降が回収する)。backfill は
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
   * 既に terminal (uploaded+hasFile) な行に対しても PDF を再 fetch して
   * 再判定する。`classifyPdf` が指定されている時のみ有効。判定対象は
   * 「現在 terminal の行」で、PDF 入手不能 (TDnet purge 等) はスキップ。
   * 既存添付ファイルは再アップロードしない (PATCH は PDF判定 列のみ)。
   * デフォルト false: 通常 backfill では既存 terminal 行は冪等スキップ。
   */
  rejudgePdf?: boolean;
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
  for (;;) {
    const qs = cursor
      ? `?start_cursor=${cursor}&page_size=100`
      : "?page_size=100";
    const res: BlockChildren = await notionRequest<BlockChildren>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
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
  const created = await notionRequest<{ id: string }>("POST", "/databases", {
    parent: { type: "page_id", page_id: backup },
    title: [{ type: "text", text: { content: title } }],
    properties: {
      銘柄コード: { title: {} },
      銘柄名: { rich_text: {} },
      コード: { select: {} },
    },
  });
  // tagOptions は子 DB で使う (親では未使用) — 受け取りは API 一貫性のため
  void tagOptions;
  parentDbCache.set(service, created.id);
  return created.id;
}

/** 親 DB から ticker の銘柄ページを取得 (無ければ作成) */
async function ensureStockPage(
  parentDbId: string,
  row: ByStockRow
): Promise<string> {
  const res = await notionRequest<{ results: Array<{ id: string }> }>(
    "POST",
    `/databases/${parentDbId}/query`,
    {
      filter: { property: "銘柄コード", title: { equals: row.ticker } },
      page_size: 1,
    }
  );
  if (res.results[0]) return res.results[0].id;

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
  const existing = await findChildDatabase(stockPageId, title);
  if (existing) {
    const db = await notionRequest<{
      properties: Record<string, { type: string }>;
      is_inline?: boolean;
    }>("GET", `/databases/${existing}`);
    const want = childProperties(tagOptions);
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
  const created = await notionRequest<{ id: string }>("POST", "/databases", {
    parent: { type: "page_id", page_id: stockPageId },
    title: [{ type: "text", text: { content: title } }],
    // is_inline:true で銘柄ページの本文中に展開される (リンク表示でなく
    // 開いた瞬間に IR テーブルが見える)。
    is_inline: true,
    properties: childProperties(tagOptions),
  });
  return created.id;
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

/**
 * TDnet が開示 PDF をサイト上で保持する公称期間 (日)。
 * release.tdnet.info は公開から ~31 日で原本を purge するため、それより
 * 古い開示は yanoshin リダイレクト経由でも 404 になる (= unavailable 終端)。
 * 過去月バックフィルでこの fetch を毎回試みると yanoshin/tdnet への
 * 無駄な GET が発生するので、`isPdfLikelyPurged` で先に弾く。
 */
const TDNET_PDF_PURGE_DAYS = 31;

/**
 * pubdate が TDnet purge 期間より古い (PDF 取得を試みる価値が無い) か。
 * 形式不正は安全側で false (= fetch を試みる) を返す。
 */
function isPdfLikelyPurged(pubdate: string, now: Date = new Date()): boolean {
  const t = Date.parse(pubdate);
  if (!Number.isFinite(t)) return false;
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays > TDNET_PDF_PURGE_DAYS;
}

function safeName(s: string): string {
  return s.replace(/[^0-9A-Za-z._-]/g, "");
}

type PdfFile = { bytes: Uint8Array; filename: string; contentType: string };
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
  baseName: string
): Promise<PdfFetch> {
  let res: Response;
  try {
    // タイムアウト必須: 応答が吊られると行ループ先頭の deadline ガードを
    // 跨いで無期限ブロックし日次 cron 予算が無力化する。timeout/network は
    // 一過性として正直に扱う (捏造しない — ルール2)。
    res = await fetch(documentUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": "kabulab-ir-catalog/1.0 (+https://kabulab-cf.satoki252595.workers.dev/ir-catalog/)",
      },
    });
  } catch (e) {
    console.warn(
      `[ir-pdf] 取得失敗(一過性) ${documentUrl}: ${(e as Error).message}`
    );
    return "transient";
  }
  if (!res.ok) {
    // 5xx/429 は一過性 → 再実行で再挑戦。4xx(404等)は恒久不在。
    const transient = res.status >= 500 || res.status === 429;
    console.warn(
      `[ir-pdf] 取得失敗${transient ? "(一過性)" : ""} ${documentUrl} status=${res.status}`
    );
    return transient ? "transient" : "unavailable";
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isPdf =
    bytes.length > 5 && PDF_HEADER.every((b, i) => bytes[i] === b);
  if (!isPdf) {
    console.warn(
      `[ir-pdf] PDF ではない応答 ${documentUrl} (${bytes.length}B) — 添付しない`
    );
    return "unavailable";
  }
  return {
    bytes,
    filename: `${safeName(baseName)}.pdf`,
    contentType: "application/pdf",
  };
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
  let rowErrors = 0;
  let reachedDeadline = false;
  let stocksTouched = 0;
  const overDeadline = () =>
    input.deadlineMs !== undefined && Date.now() > input.deadlineMs;

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
    };
  }

  // 銘柄ごとに rows をまとめる (子 DB 単位で既存判定/書き込みを行う)
  const byTicker = new Map<string, ByStockRow[]>();
  for (const r of input.rows) {
    const arr = byTicker.get(r.ticker);
    if (arr) arr.push(r);
    else byTicker.set(r.ticker, [r]);
  }

  for (const [, rows] of byTicker) {
    if (overDeadline()) {
      reachedDeadline = true;
      break;
    }

    // 親 DB の銘柄ページ + その下の子 DB を確保 (プロセス内キャッシュで
    // 全実行を通じて 1 銘柄あたり 1 回だけ解決)
    let childDbId: string;
    try {
      ({ childDbId } = await resolveStock(
        parentDbId,
        rows[0],
        input.tagOptions
      ));
    } catch (e) {
      // この銘柄のページ/子DB 解決が失敗したらその銘柄分の rows を行
      // 単位エラーとして計上し、他銘柄へ継続 (バッチを落とさない)
      rowErrors += rows.length;
      console.error(
        `[notion-bystock] 銘柄解決失敗 ${rows[0].ticker} (rows=${rows.length}): ${(e as Error).message}`
      );
      continue;
    }
    // 銘柄解決成功後にカウント (= 実際に書き込み試行へ到達した銘柄数)
    stocksTouched++;

    let minISO = rows[0].pubdate;
    let maxISO = rows[0].pubdate;
    for (const r of rows) {
      if (r.pubdate < minISO) minISO = r.pubdate;
      if (r.pubdate > maxISO) maxISO = r.pubdate;
    }
    const existing = await loadExistingInRange(childDbId, minISO, maxISO);

    for (const row of rows) {
      const ex = existing.byKey.get(row.key);
      if (ex && isTerminal(ex)) {
        // `rejudgePdf=true` モード: 既存 terminal 行に対して PDF を再 fetch し
        // 本文を再判定 → Notion `PDF判定` 列のみ PATCH + onPdfClassified で PG
        // へ書き戻す。既存添付ファイル (IR資料) は触らない (差分最小化)。
        // PDF 入手不能 (TDnet purge ≥31日 / transient) はスキップして既存行を
        // そのまま残す。判定済の skipped/uploaded を上書きしないため、
        // 呼び出し側で対象範囲を絞ること (--from/--to/--ticker)。
        if (input.rejudgePdf && input.classifyPdf) {
          const rejudgePdfFetch = await fetchIrPdf(
            row.documentUrl,
            `${row.ticker}_${row.pubdate.slice(0, 10)}_${row.key}`
          );
          if (
            rejudgePdfFetch !== "unavailable" &&
            rejudgePdfFetch !== "transient"
          ) {
            try {
              const cls = await input.classifyPdf(
                rejudgePdfFetch.bytes,
                row.primaryTag
              );
              await notionRequest("PATCH", `/pages/${ex.pageId}`, {
                properties: {
                  PDF判定: { select: { name: cls.sentiment } },
                },
              });
              input.onPdfClassified?.(row.key, cls);
              rejudged++;
            } catch (e) {
              console.error(
                `[pdf-sentiment rejudge] ${row.ticker} ${row.key} 失敗: ${(e as Error).message}`
              );
            }
          }
        }
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
      if (overDeadline()) {
        reachedDeadline = true;
        break;
      }

      // 新規行で発表日が TDnet purge 期間 (~31日) より古い場合は、PDF を
      // 取りに行っても 404 確定 → 無駄な GET を避けて即 skip (cost 最適化)。
      // 既存行 (ex) は引き続き fetch して error→uploaded の昇格を試みる。
      if (!ex && isPdfLikelyPurged(row.pubdate)) {
        skippedNoFile++;
        continue;
      }

      // 開示 PDF を実体取得して添付 (ルール6)。取得不可/非PDF/上限超過/
      // インフラ失敗は捏造せず添付なし + 状態列に正直記録し、行は作成/
      // 更新を継続 (資料URL列で出典担保・1 行の失敗でバッチ全体を落と
      // さない — ルール1/2)。一過性失敗は error にして再実行で収束。
      const pdf = await fetchIrPdf(
        row.documentUrl,
        `${row.ticker}_${row.pubdate.slice(0, 10)}_${row.key}`
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
      if (pdf === "unavailable") {
        irStatus = "unavailable";
      } else if (pdf === "transient") {
        irStatus = "error";
      } else {
        try {
          const id = await uploadFile(pdf);
          irFile = [
            { name: pdf.filename, type: "file_upload", file_upload: { id } },
          ];
          irStatus = "uploaded";
          pdfBytesForClassify = pdf.bytes;
        } catch (e) {
          if (e instanceof NotionFileTooLargeError) {
            console.warn(`[ir-pdf] WS 上限超過で添付不可: ${pdf.filename}`);
            irStatus = "too_large";
          } else {
            console.error(
              `[ir-pdf] アップロード失敗 ${row.key} ${pdf.filename}: ${(e as Error).message}`
            );
            irStatus = "error";
          }
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

      // 1 行の記録失敗 (ページ作成/更新の恒久エラー等) でバッチ全体を
      // 落とさない。握りつぶさず console.error + rowErrors で可視化し
      // 次行へ継続 (再実行で未作成/未添付行から収束 — ルール2)。
      try {
        let pageId: string;
        if (ex) {
          await notionRequest("PATCH", `/pages/${ex.pageId}`, { properties });
          updated++;
          pageId = ex.pageId;
        } else {
          const createdPage = await notionRequest<{ id: string }>(
            "POST",
            "/pages",
            { parent: { database_id: childDbId }, properties }
          );
          created++;
          pageId = createdPage.id;
        }
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
      } catch (e) {
        rowErrors++;
        console.error(
          `[notion-bystock] 行記録失敗 ${row.ticker} ${row.key}: ${(e as Error).message}`
        );
      }
    }
    if (reachedDeadline) break;
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
  };
}
