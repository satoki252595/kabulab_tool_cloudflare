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

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${notionEnv.NOTION_TOKEN()}`,
    "Notion-Version": NOTION_VERSION,
  };
}

interface NotionErrorBody {
  object?: string;
  status?: number;
  code?: string;
  message?: string;
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
  label: string
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await fetch(url, makeInit());
    } catch (e) {
      // 設定起因 (env 未設定/ID 不正) は恒久エラー。一過性扱いで backoff
      // すると 1 リクエストで ~61 秒固まる (過去事例: kabulab に NOTION_TOKEN
      // 未設定のまま /file proxy を踏んで 63 秒応答)。型で識別して即 throw。
      if (e instanceof NotionConfigError) throw e;
      if (attempt > MAX_RETRY) {
        throw new Error(
          `Notion 通信失敗 (${label}) ${MAX_RETRY} 回再試行後も失敗: ${(e as Error).message}`,
          { cause: e }
        );
      }
      await sleep(Math.min(30_000, 500 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res;

    // 429 (rate_limited) と 529 (service_overload) は公式通り Retry-After を
    // 尊重して再試行 (/reference/request-limits)。529 に Retry-After が無い
    // 場合は指数バックオフに倒す。
    if (res.status === 429 || res.status === 529) {
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
    // 5xx および 非JSON(エッジ遮断)4xx は一過性とみなし指数バックオフ再試行
    await sleep(Math.min(30_000, 500 * 2 ** attempt));
  }
}

/** JSON API 呼び出し (GET/POST/PATCH)。非 2xx は throw (ルール2)。 */
export async function notionRequest<T = unknown>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<T> {
  return schedule(async () => {
    const res = await doFetch(
      `${API_BASE}${path}`,
      () => ({
        method,
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      `${method} ${path}`
    );
    return (await res.json()) as T;
  });
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
