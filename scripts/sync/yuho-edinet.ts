// 有報(EDINET)キャッチアップ — Worker 取込ルートを叩く薄いトリガ。
//
// D1 はバインディング経由でのみアクセスできるため、取込は Node ローカルでは
// なく **Worker 上** で実行する。本 CLI はデプロイ済み Worker の認証付きルート
// (POST /yuho-quant/admin/catchup) を叩くだけ。shard 指定は `--part=0 --of=8`。
//
// 必要env(.env): WORKER_BASE_URL（例 https://kabulab-cf.<sub>.workers.dev）, CRON_SECRET
import "dotenv/config";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { sharedEnv } from "../../src/shared/env.js";

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

/**
 * 要求全体（ヘッダ待ち＋本文受信）の明示の待機予算。catchup は 1 要求で
 * 数分かかる長時間要求で、取込予算 300 秒＋投影再生成＋Notion 遅延で 300 秒を
 * 超えることがある (#98 run36022119851 は undici 既定の headers 300 秒で切断)。
 * 600 秒は打ち切り線であり、Worker 完了の保証ではない。ジョブ枠 (60 分) より短い。
 */
const REQUEST_TIMEOUT_MS = 600_000;

export interface PostCatchupOpts {
  /** 要求全体の期限ms (既定は REQUEST_TIMEOUT_MS)。テストは短縮可。 */
  timeoutMs?: number;
  /** テスト用の信頼 CA (PEM)。省略時は既定の信頼storeを使う。 */
  tlsCaPem?: string;
}

/**
 * 外部エラーを URL・ホスト名・秘密を含まない形で要約する。
 * https 層の message はホスト名を埋め込むことがある
 * (例: `getaddrinfo ENOTFOUND <host>`) ため、code/name だけを使う。
 */
function describeError(e: unknown): string {
  if (e !== null && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && name !== "") return name;
  }
  return "unknown";
}

/**
 * Worker の catchup ルートへ POST を 1 回だけ送り、応答本文を返す。
 *
 * 単発要求であり、再送・リダイレクト追従は一切しない。Worker 側に永続
 * リース/要求冪等が無く (docId SELECT→取込・Notion key照会→作成は競合し得る、
 * D1 書込が先なので D1 存在は Notion 完了を証明しない)、二重 POST は二重
 * 取込・二重保管を起こし得るため (#98 修正方針)。
 *
 * 非 2xx・要求エラー・応答中断・不完全切断・期限切れはすべて throw する
 * (成功化しない — ルール2)。一過性切断 (ECONNRESET 等) も可視のまま残し、
 * 運用 (次回定期実行の 60 日窓による自己回収・手動再実行) に委ねる。
 * エラー文・cause に URL・認証情報・ヘッダを含めない。
 */
export async function postCatchup(
  url: URL,
  secret: string,
  opts: PostCatchupOpts = {}
): Promise<string> {
  if (url.protocol !== "https:") {
    throw new Error(
      `catchup 失敗: https のみ対応しています (protocol=${url.protocol})`
    );
  }
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // 期限はヘッダ待ちと本文受信の全体にかかる。undici の既定 (headers 300 秒)
  // を使わず node:https に明示期限を渡すことで、300 秒超の正当な応答を
  // 途中で捨てない。global dispatcher の変更・依存追加はしない。
  const signal = AbortSignal.timeout(timeoutMs);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      // cause を付けない: https 層の元エラーはホスト名等を埋め込むことがあり、
      // console.error での出力に混ざる。分類に要る code/name は文中に残す。
      reject(new Error(message));
    };
    const done = (body: string): void => {
      if (settled) return;
      settled = true;
      resolve(body);
    };

    const req = httpsRequest(
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
        // プール/keep-alive を使わず都度接続する (単発要求を他と混ぜない)。
        agent: false,
        signal,
        ...(opts.tlsCaPem !== undefined ? { ca: opts.tlsCaPem } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("aborted", () => {
          fail(
            signal.aborted
              ? `catchup 失敗: 期限切れ (${timeoutMs}ms) までに応答が完了しませんでした`
              : "catchup 失敗: 応答が中断されました (aborted)"
          );
        });
        res.on("error", (e: unknown) => {
          fail(
            signal.aborted
              ? `catchup 失敗: 期限切れ (${timeoutMs}ms) までに応答が完了しませんでした`
              : `catchup 失敗: 応答エラー (${describeError(e)})`
          );
        });
        res.on("end", () => {
          // 途中で切れた応答を完全な成功として扱わない。
          if (!res.complete) {
            fail("catchup 失敗: 応答が途中で切断されました (incomplete)");
            return;
          }
          const status = res.statusCode ?? 0;
          // 3xx も追従せず失敗にする (自動 repost/redirect しない)。
          // 本文は載せない: 上流の応答は untrusted で、秘密・URL が混ざり得る。
          if (status < 200 || status >= 300) {
            fail(`catchup 失敗: HTTP ${status}`);
            return;
          }
          done(Buffer.concat(chunks).toString("utf-8"));
        });
      }
    );
    req.on("error", (e: unknown) => {
      fail(
        signal.aborted
          ? `catchup 失敗: 期限切れ (${timeoutMs}ms) までに応答が完了しませんでした`
          : `catchup 失敗: 要求エラー (${describeError(e)})`
      );
    });
    // error/end のいずれも発火せず閉じた場合の取りこぼし防止。
    req.on("close", () => {
      if (!settled) fail("catchup 失敗: 応答なしに接続が閉じました (close)");
    });
    req.end();
  });
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
