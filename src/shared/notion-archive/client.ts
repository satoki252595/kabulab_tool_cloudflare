/**
 * Notion REST クライアント (依存ゼロ・fetch 直叩き)。
 *
 * Notion のハードリミットを尊重する設計 (CLAUDE.md ルール6。
 * 値の根拠は公式 /reference/request-limits):
 *   - レート制限: 接続あたり Business 以上 600 req/min・それ以外 180 req/min
 *     (平均 10/s・3/s) + ワークスペース共有枠。プロセス内で全リクエストを
 *     単一キューに直列化し最小間隔 380ms (~2.6 req/s) を強制 (全プラン安全側)。
 *     429/529 は Retry-After を必ず尊重。
 *   - 一過性失敗 (429 / 529 / 5xx / ネットワーク) は指数バックオフで再試行。
 *     恒久的失敗 (4xx。ただし 403 はブロック上限の可能性あり) は throw して
 *     呼び出し側に判断を委ねる (ルール2: 既定値で握りつぶさない)。
 *   - 要求サイズ: 100 ブロック/追記・rich_text 2000 文字・1 要求 500KB。
 *     呼び出し側 (archive.ts / stock-text.ts) が事前に分割する。
 *
 * file_uploads の送信 (multipart/form-data) もこのキューを通し、レート枠を
 * 共有する。`@notionhq/client` は使わない — リポジトリ方針 (自前 ZIP リーダ
 * 同様、薄い自前実装で挙動を完全制御) に合わせる。
 */
import { NotionConfigError, notionEnv } from "./env.js";

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
/** 平均 3 req/s 制限に対し安全側 (~2.6 req/s) */
const MIN_INTERVAL_MS = 380;
const MAX_RETRY = 6;

let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface NotionStats {
  /** 実際に発行した fetch() の総数 (再試行を含む累積) */
  requests: number;
  /** 429 (rate_limited) / 529 (service_overload) の応答を受けた回数 */
  rateLimited: number;
  /** それ以外の一過性失敗 (5xx・非JSON 4xx・ネットワーク例外) で再試行した回数 */
  transientRetries: number;
}

/**
 * 実行サマリ用の通信カウンタ (設計書 §9「Notion のリクエスト数と 429 回数」)。
 * プロセス起動 (モジュール初期化) からの累積で、`resetNotionStats()` を呼ぶ
 * まで保持する。挙動は一切変えない計測専用の追加 (副作用なし)。
 */
let stats: NotionStats = { requests: 0, rateLimited: 0, transientRetries: 0 };

/** 現在までの累積カウンタのコピーを返す (呼び出し側からの変更で汚染されない) */
export function notionStats(): NotionStats {
  return { ...stats };
}

/** カウンタを 0 に戻す (実行単位でサマリを取りたい CLI が呼ぶ) */
export function resetNotionStats(): void {
  stats = { requests: 0, rateLimited: 0, transientRetries: 0 };
}

/** 全 Notion 通信を直列化 + 最小間隔を強制するゲート */
function schedule<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return task();
  });
  // キューは失敗しても止めない (次タスクへ繋ぐ)
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function authHeaders(version: string = NOTION_VERSION): Record<string, string> {
  return {
    Authorization: `Bearer ${notionEnv.NOTION_TOKEN()}`,
    "Notion-Version": version,
  };
}

interface NotionErrorBody {
  object?: string;
  status?: number;
  code?: string;
  message?: string;
}

/**
 * 非冪等 create (POST /pages・POST /databases) の結果不明エラー。
 * network 例外・529・5xx・非JSON 4xx は送信成否が不明のため内部再送せず、
 * この型で即 throw する。呼び出し側は full query で確認し、あれば回収
 * (adopt)、無ければ停止する (自動再 create しない)。型で識別するため
 * message ではなく instanceof で判定すること。
 */
export class NotionUnknownResultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NotionUnknownResultError";
  }
}

/**
 * その 4xx が「恒久的エラー」か判定する。
 *
 * Notion API 本体の 4xx は必ず JSON エラー (`{object:"error",code,...}`) を
 * 返す。一方、前段の CDN/WAF (Cloudflare 等) が高頻度アクセスを弾くときは
 * **HTML body の 403/401/503 等** を返す。これは一過性のエッジ遮断であり、
 * Notion 認可エラーではない (実測: 同条件の単発アップロードは 100% 成功)。
 * これを恒久扱いで即 throw すると 1 回の一過性 403 が数千行のバッチ全体を
 * 巻き添えにする (ルール2: 一過性失敗は握りつぶさず再試行で吸収する)。
 *
 * 判定: body が Notion エラー JSON (object==="error" もしくは code を持つ)
 * なら恒久。非 JSON (HTML/空) の 4xx はエッジ起因の一過性として再試行。
 * 429 は呼び出し側で別途 Retry-After 処理するためここには来ない。
 */
function isPermanent(status: number, body: string): boolean {
  if (status < 400 || status >= 500 || status === 429) return false;
  try {
    const j = JSON.parse(body) as NotionErrorBody;
    // 真正 Notion エラー JSON のみ恒久 (認可/検証エラーは即surface)
    if (j && (j.object === "error" || typeof j.code === "string")) return true;
  } catch {
    /* 非 JSON = エッジ遮断の疑い → 一過性扱い (下で再試行) */
  }
  return false;
}

/**
 * `makeInit` は呼び出し毎に新しい RequestInit を生成する。再試行時に body
 * (特に FormData/Blob ストリーム — undici では一度消費すると再送不可) を
 * 毎回作り直し、multi_part アップロードの 5xx/429 再試行を冪等にする。
 */
async function doFetch(
  url: string,
  makeInit: () => RequestInit,
  label: string,
  isNonIdempotentCreate = false
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      const init = makeInit();
      stats.requests++;
      res = await fetch(url, init);
    } catch (e) {
      // 設定起因 (env 未設定/ID 不正) は恒久エラー。一過性扱いで backoff
      // すると 1 リクエストで ~61 秒固まる (過去事例: kabulab に NOTION_TOKEN
      // 未設定のまま /file proxy を踏んで 63 秒応答)。型で識別して即 throw。
      if (e instanceof NotionConfigError) throw e;
      // 非冪等 create (POST /pages・POST /databases) は結果不明のまま内部
      // 再送すると同一 helper 内で二重作成し得る。network 例外は送信成否不明
      // のため再送せず即 throw し、呼び出し側の full query 回収 (0=STOP/
      // 1=回収/複数=STOP) に委ねる。
      if (isNonIdempotentCreate) {
        throw new NotionUnknownResultError(
          `Notion 非冪等create (${label}) の結果不明のため再送しません (network): ${(e as Error).message}。full query で確認してください`,
          { cause: e }
        );
      }
      if (attempt > MAX_RETRY) {
        throw new Error(
          `Notion 通信失敗 (${label}) ${MAX_RETRY} 回再試行後も失敗: ${(e as Error).message}`,
          { cause: e }
        );
      }
      stats.transientRetries++;
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res;

    // 429 (rate_limited) と 529 (service_overload) は公式通り Retry-After を
    // 尊重して再試行 (/reference/request-limits)。529 に Retry-After が無い
    // 場合は指数バックオフに倒す。
    // ただし非冪等 create の 529 は結果不明 (過負荷応答でも作成済みの可能性)
    // のため再送しない。明示 429 は拒否 (未作成確定) のため create でも再送可。
    if (res.status === 429 || res.status === 529) {
      if (isNonIdempotentCreate && res.status === 529) {
        throw new NotionUnknownResultError(
          `Notion 非冪等create (${label}) の結果不明のため再送しません (529)。full query で確認してください`
        );
      }
      stats.rateLimited++;
      const header = res.headers.get("Retry-After");
      const ra = header === null ? NaN : Number(header);
      const waitMs = Number.isFinite(ra)
        ? ra * 1000 + 250
        : Math.min(30_000, 500 * 2 ** attempt);
      if (attempt > MAX_RETRY) {
        throw new Error(
          `Notion レート制限/過負荷 (${label}) ${MAX_RETRY} 回再試行後も ${res.status}`
        );
      }
      await sleep(waitMs);
      continue;
    }

    const text = await res.text().catch(() => "");
    // 非冪等 create の 5xx・非JSON 4xx (エッジ遮断) は結果不明のため再送禁止。
    // 真正 JSON 4xx (恒久・未作成確定) は下の既存分岐で即 throw する。
    if (isNonIdempotentCreate && !isPermanent(res.status, text)) {
      throw new NotionUnknownResultError(
        `Notion 非冪等create (${label}) の結果不明のため再送しません (status=${res.status})。full query で確認してください`
      );
    }
    if (isPermanent(res.status, text) || attempt > MAX_RETRY) {
      const parsed = ((): NotionErrorBody | null => {
        try {
          return JSON.parse(text) as NotionErrorBody;
        } catch {
          return null;
        }
      })();
      throw new Error(
        `Notion API エラー (${label}) status=${res.status} code=${parsed?.code ?? "?"} message=${parsed?.message ?? text.slice(0, 300)}`
      );
    }
    stats.transientRetries++;
    // 5xx および 非JSON(エッジ遮断)4xx は一過性とみなし指数バックオフ再試行
    await sleep(Math.min(30_000, 500 * 2 ** attempt));
  }
}

export interface NotionRequestOptions {
  /**
   * この呼び出しだけ既定 (`NOTION_VERSION` = 2022-06-28) と異なる
   * Notion-Version を使う。ページ/DB 移動 API 等、新しいデータソース
   * モデル (2025-09-03 以降) でのみ提供される機能を叩くときに使う。
   * 通常呼び出しは省略して既定バージョンのまま (挙動を変えない)。
   */
  notionVersion?: string;
}

/**
 * read-list 系の endpoint family。query string 除外後の path + method で
 * 判定する。`data_sources` 系は実 caller が無いため対象外。
 */
type ReadListFamily =
  | "search"
  | "database-query"
  | "block-children"
  | "page-property";

function readListFamily(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string
): ReadListFamily | null {
  const bare = path.split("?", 1)[0] ?? path;
  if (method === "POST" && bare === "/search") return "search";
  if (method === "POST" && /^\/databases\/[^/]+\/query$/.test(bare)) {
    return "database-query";
  }
  if (method === "GET" && /^\/blocks\/[^/]+\/children$/.test(bare)) {
    return "block-children";
  }
  if (
    method === "GET" &&
    /^\/pages\/[^/]+\/properties\/[^/]+$/.test(bare)
  ) {
    return "page-property";
  }
  return null;
}

/**
 * read-list 系 envelope の strict guard (#199 の共通根因対策)。
 * 全 collector が `!has_more || !next_cursor` の truthiness 終了に依存して
 * おり、`res.json() as T` の無検証が共通根因だった。検証は入口 1 箇所で
 * 完結し、各 collector の改造・新 iterator は設けない:
 *   - own `results` + 配列
 *   - own `has_more` + boolean
 *   - own `next_cursor` + null/非空文字列 (空白のみ拒否)
 *   - pairing: true→文字列・false→null
 * `results` 要素の意味は既存 collector の担当 (触らない)。
 * page-property は object 判別: `list` なら同 guard、
 * `property_item` (singular) は許容、それ以外は reject。
 * 不正は `NotionConfigError` で即 STOP (retry 対象外。doFetch ループの外で
 * 検証するため再試行に入らない)。エラー文は endpoint family + field のみ
 * (ID/cursor/body 値は出さない)。
 */
function assertListEnvelope(body: unknown, family: ReadListFamily): void {
  const where = `Notion list 応答が不正 (endpoint=${family})`;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new NotionConfigError(`${where} field=response: object ではない`);
  }
  const b = body as Record<string, unknown>;
  if (family === "page-property") {
    if (!Object.hasOwn(b, "object")) {
      throw new NotionConfigError(`${where} field=object: 判別子が無い`);
    }
    if (b["object"] === "property_item") return;
    if (b["object"] !== "list") {
      throw new NotionConfigError(`${where} field=object: 不正な判別子`);
    }
  }
  if (!Object.hasOwn(b, "results") || !Array.isArray(b["results"])) {
    throw new NotionConfigError(`${where} field=results: 配列ではない`);
  }
  if (!Object.hasOwn(b, "has_more") || typeof b["has_more"] !== "boolean") {
    throw new NotionConfigError(`${where} field=has_more: boolean ではない`);
  }
  const hasMore = b["has_more"] as boolean;
  if (!Object.hasOwn(b, "next_cursor")) {
    throw new NotionConfigError(`${where} field=next_cursor: キーが無い`);
  }
  const nextCursor = b["next_cursor"];
  const cursorOk =
    nextCursor === null ||
    (typeof nextCursor === "string" &&
      nextCursor.length > 0 &&
      nextCursor.trim().length > 0);
  if (!cursorOk) {
    throw new NotionConfigError(
      `${where} field=next_cursor: null/非空文字列ではない`
    );
  }
  if (hasMore && typeof nextCursor !== "string") {
    throw new NotionConfigError(
      `${where} field=next_cursor: has_more=true だが文字列ではない`
    );
  }
  if (!hasMore && nextCursor !== null) {
    throw new NotionConfigError(
      `${where} field=next_cursor: has_more=false だが null ではない`
    );
  }
}

/**
 * pagination cursor の前進表明 (#199 の兄弟穴対策。各列挙の局所 Set 用)。
 * envelope の型・pairing は入口 guard 済みの前提で、反復 (same・A→B→A)
 * だけを追加 GET 前に止める。global 状態・cursor cache は持たない
 * (呼び出し側が列挙ごとに Set を作る)。エラー文に値を含めない。
 */
export function assertCursorProgress(
  seen: Set<string>,
  nextCursor: string
): void {
  if (seen.has(nextCursor)) {
    throw new NotionConfigError(
      "Notion list 応答が不正: next_cursor の反復 (追加取得前に停止)"
    );
  }
  seen.add(nextCursor);
}

/** JSON API 呼び出し (GET/POST/PATCH/DELETE)。非 2xx は throw (ルール2)。 */
export async function notionRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  opts?: NotionRequestOptions
): Promise<T> {
  // POST /pages (ページ作成) と POST /databases (DB 作成) を非冪等 create
  // として結果不明再送を禁止する。POST /databases/{id}/query (読取)・
  // PATCH・GET・DELETE・/pages/{id}/move は既存 retry を維持する。
  const isCreate = method === "POST" && (path === "/pages" || path === "/databases");
  return schedule(async () => {
    const res = await doFetch(
      `${API_BASE}${path}`,
      () => ({
        method,
        headers: {
          ...authHeaders(opts?.notionVersion),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      `${method} ${path}`,
      isCreate
    );
    const family = readListFamily(method, path);
    if (family === null) {
      try {
        return (await res.json()) as T;
      } catch (cause) {
        if (method !== "GET") {
          throw new NotionUnknownResultError(`Notion ${method} ${path}: 成功応答を読めず結果不明のため再送しません`, { cause });
        }
        throw cause;
      }
    }
    // read-list のみ strict guard (doFetch retry ループの外。fetch 1 回で即 STOP)。
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new NotionConfigError(
        `Notion list 応答が不正 (endpoint=${family}) field=response: JSON decode 失敗`
      );
    }
    assertListEnvelope(parsed, family);
    return parsed as T;
  });
}

/**
 * ページ/データベース移動 API (POST /v1/pages/{id}/move, PATCH
 * /v1/databases/{id} の parent 変更) 用の Notion-Version。
 *
 * 2025-09-03 でデータソースモデルが導入され、ページ移動 API
 * (`/pages/{id}/move`) が追加された。本値はユーザが実 API で
 * 動作確認済み (2026-09-25。ページ移動で 1 リクエスト完結・page id/
 * プロパティ/本文ブロック保持を確認)。データベース側の `parent`
 * 変更 (PATCH /databases/{id}) が同バージョンで有効かは公式ドキュメント
 * 記載を根拠にした未検証の推測 — 呼び出し側 (移行スクリプト) は
 * 失敗を握りつぶさず「API 非対応 → 手動移動が必要」と正直に報告すること。
 */
const MOVE_NOTION_VERSION = "2025-09-03";

export type MovePageParent =
  | { type: "page_id"; page_id: string }
  | { type: "data_source_id"; data_source_id: string };

interface MoveResult {
  id: string;
  parent?: unknown;
}

/**
 * ページを別の親 (ページ or データソース=DB) へ移動する。ページ ID・
 * プロパティ・本文ブロックは維持される (D1 の notion_doc_page_id 等の
 * 外部参照が壊れない — ルール6 の窓口。api.notion.com を
 * notion-archive/ 外から直叩きしない)。
 */
export async function movePage(
  pageId: string,
  parent: MovePageParent
): Promise<MoveResult> {
  return notionRequest<MoveResult>(
    "POST",
    `/pages/${pageId}/move`,
    { parent },
    { notionVersion: MOVE_NOTION_VERSION }
  );
}

/**
 * データベースを別の親ページへ移動する。公式ドキュメント (2026-03-11 時点の
 * Update a database リファレンス) は PATCH /v1/databases/{id} の `parent`
 * フィールドでページ間移動をサポートすると記載しているが、本リポジトリでは
 * 実 API での動作は未検証 (`ページ移動` は検証済・`DB 移動` は未検証)。
 * 恒久的 4xx (未対応 API 等) は notionRequest がそのまま throw するので
 * 握りつぶさず、呼び出し側 (移行スクリプト) が「手動で移動してください」と
 * 正直に報告すること (ルール2)。
 */
export async function moveDatabase(
  databaseId: string,
  targetPageId: string
): Promise<MoveResult> {
  return notionRequest<MoveResult>(
    "PATCH",
    `/databases/${databaseId}`,
    { parent: { type: "page_id", page_id: targetPageId } },
    { notionVersion: MOVE_NOTION_VERSION }
  );
}

/**
 * file_uploads の送信エンドポイントへ multipart/form-data を POST。
 * Content-Type は fetch に境界を生成させる (手動指定しない)。
 */
export async function notionSendFilePart(
  fileUploadId: string,
  part: { bytes: Uint8Array; filename: string; contentType: string; partNumber?: number }
): Promise<unknown> {
  // Uint8Array(ArrayBufferLike) を ArrayBuffer 裏付けに正規化 (Blob 化時の
  // SharedArrayBuffer 型差異回避 + 部分ビューの確実なコピー)。バイト列は
  // 不変なので 1 度だけ作り、FormData は再試行毎に作り直す (下記)。
  const ab = part.bytes.buffer.slice(
    part.bytes.byteOffset,
    part.bytes.byteOffset + part.bytes.byteLength
  ) as ArrayBuffer;
  return schedule(async () => {
    const res = await doFetch(
      `${API_BASE}/file_uploads/${fileUploadId}/send`,
      () => {
        // FormData/Blob は単回消費。再試行毎に新規生成しないと 2 回目以降
        // の send が空 body になり multi_part が壊れる。
        const form = new FormData();
        form.append(
          "file",
          new Blob([ab], { type: part.contentType }),
          part.filename
        );
        if (part.partNumber !== undefined) {
          form.append("part_number", String(part.partNumber));
        }
        return { method: "POST", headers: authHeaders(), body: form };
      },
      `SEND file_upload ${fileUploadId}${part.partNumber ? ` part ${part.partNumber}` : ""}`
    );
    return res.json();
  });
}

export { API_BASE, NOTION_VERSION };
