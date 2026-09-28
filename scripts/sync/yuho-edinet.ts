// 有報(EDINET)キャッチアップ — Worker 取込ルートを叩く薄いトリガ。
//
// D1 はバインディング経由でのみアクセスできるため、取込は Node ローカルでは
// なく **Worker 上** で実行する。本 CLI はデプロイ済み Worker の認証付きルート
// (POST /yuho-quant/admin/catchup) を叩くだけ。shard 指定は `--part=0 --of=8`。
//
// 必要env(.env): WORKER_BASE_URL（例 https://kabulab-cf.<sub>.workers.dev）, CRON_SECRET
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { sharedEnv } from "../../src/shared/env.js";

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

/**
 * 再試行の待ち (初回失敗後 10 秒・2 回目失敗後 30 秒)。
 * catchup は 1 要求で最大 ~5 分かかる長時間要求で、一過性の切断
 * (ECONNRESET) や応答遅延による headers timeout で落ちることがある (#98)。
 * 取込自体は docId/Notion 冪等で再開可能なので、切り直せば続きから進む。
 * 待ちは切断の自然解消と、まだ生きているかもしれない Worker 側の
 * 実行との重なりを減らすための最小限の間隔である。
 */
const RETRY_DELAYS_MS = [10_000, 30_000];

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export interface PostCatchupOpts {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** テスト用の待ち差し替え (既定は RETRY_DELAYS_MS)。 */
  delaysMs?: readonly number[];
}

/**
 * Worker の catchup ルートを叩き、応答本文を返す。
 *
 * fetch 自体の throw (ネットワーク切断・タイムアウト等) に限り、限定回数だけ
 * 再試行する (jev クライアントと同じ有界リトライ方式)。HTTP 応答が返った場合
 * (5xx 含む) は再試行せず即 throw する (従来どおり)。使い切っても失敗すれば
 * 最後のエラーをそのまま投げる — 成功扱いにしない (ルール2)。
 * エラー文に URL・認証情報を含めない (API キーの漏洩防止)。
 */
export async function postCatchup(
  url: URL,
  secret: string,
  opts: PostCatchupOpts = {}
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const delaysMs = opts.delaysMs ?? RETRY_DELAYS_MS;
  const maxAttempts = delaysMs.length + 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await sleep(delaysMs[attempt - 1]!);
        continue;
      }
      throw new Error(
        `catchup 失敗: ネットワークエラーで ${maxAttempts} 回試行後も失敗: ` +
          `${e instanceof Error ? e.message : String(e)}`,
        { cause: e }
      );
    }
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`catchup 失敗: HTTP ${res.status} ${body}`);
    }
    return body;
  }
  // attempts >= 1 のため到達しない。型の完全性のための throw (値は捏造しない)。
  throw lastError instanceof Error
    ? lastError
    : new Error(`catchup 失敗: 不明なエラー (${String(lastError)})`);
}

async function main(): Promise<void> {
  const base = sharedEnv.WORKER_BASE_URL();
  const secret = sharedEnv.CRON_SECRET();
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");

  const u = new URL(`${base.replace(/\/$/, "")}/yuho-quant/admin/catchup`);
  const part = arg("part");
  const of = arg("of");
  if (part !== undefined) u.searchParams.set("part", part);
  if (of !== undefined) u.searchParams.set("of", of);

  const body = await postCatchup(u, secret);
  console.info("[yuho-edinet]", body);
}

// CLI として直接実行された場合のみ main() を走らせる (import だけでは走らない —
// テストがこのモジュールを安全に import できるようにするためのガード。
// scripts/moneyflow/ingest.ts と同じ方式)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[yuho-edinet] エラー:", e);
    process.exit(1);
  });
}
