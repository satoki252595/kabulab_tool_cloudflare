// TDnet 適時開示キャッチアップ CLI（Node 実行 + D1 HTTP API 書込）。
//
// ir-catalog の取込は PDF センチメントが kuromoji(Node 専用)依存で Worker 化不可。
// そこで Node で実行し、D1 へは D1 HTTP API(drizzle sqlite-proxy)で書く。読取は
// Worker のバインディングが担う。
//
// 必要env(.env): EDINET 不要 / CLOUDFLARE_API_TOKEN・CLOUDFLARE_ACCOUNT_ID・
//                D1_DATABASE_ID(D1書込) / NOTION_*(ルール6) / 取込元 TDnet は鍵不要。
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import * as irSchema from "../../services/ir-catalog/src/db/schema.js";
import { runIrCatalogCatchup } from "../../src/cron/ir-catalog-tdnet.js";
import { resumeNotionByStock } from "../../services/ir-catalog/src/services/ingest.js";
import type { Database } from "../../services/ir-catalog/src/db/client.js";
import { assertCatchupDeadline, installCatchupDeadline, validateCatchupLaunch } from "./catchup-launch.js";

export function parseTdnetResumeArgs(args: string[], nowMs = Date.now()): {
  from: Date; toExclusive: Date; exact?: { tdnetId: string; deadlineMs: number }
} | undefined {
  if (args.length === 0) return;
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--(resume-from|resume-to|resume-tdnet-id|deadline-at)=(.+)$/.exec(arg);
    if (match === null || values.has(match[1])) throw new Error("TDnet 再開の引数が不正/重複です。");
    values.set(match[1], match[2]);
  }
  const fromDay = values.get("resume-from");
  const toDay = values.get("resume-to");
  if (fromDay === undefined || toDay === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay)
      || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    throw new Error("再開は --resume-from=YYYY-MM-DD --resume-to=YYYY-MM-DD の両方が必要です。");
  }
  const from = new Date(`${fromDay}T00:00:00+09:00`);
  const to = new Date(`${toDay}T00:00:00+09:00`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to
      || new Date(from.getTime() + 9 * 3600_000).toISOString().slice(0, 10) !== fromDay
      || new Date(to.getTime() + 9 * 3600_000).toISOString().slice(0, 10) !== toDay) {
    throw new Error("TDnet 再開期間に存在しない日付/逆転があります。");
  }
  const tdnetId = values.get("resume-tdnet-id");
  const deadline = values.get("deadline-at");
  let exact;
  if (tdnetId !== undefined || deadline !== undefined) {
    const deadlineMs = deadline === undefined ? NaN : Date.parse(deadline);
    if (tdnetId === undefined || !/^[1-9]\d*$/.test(tdnetId) || deadline === undefined
        || !Number.isSafeInteger(deadlineMs) || new Date(deadlineMs).toISOString() !== deadline
        || deadlineMs <= nowMs || deadlineMs - nowMs > 60 * 60_000) {
      throw new Error("単一再開は --resume-tdnet-id と --deadline-at（1時間以内のUTC ISO時刻）の両方が必要です。");
    }
    exact = { tdnetId, deadlineMs };
  }
  return { from, toExclusive: new Date(to.getTime() + 86400_000), exact };
}

async function main(): Promise<void> {
  const resume = parseTdnetResumeArgs(process.argv.slice(2));
  let deadline = validateCatchupLaunch("tdnet");
  if (resume?.exact !== undefined) {
    deadline = deadline === undefined ? resume.exact.deadlineMs : Math.min(deadline, resume.exact.deadlineMs);
    installCatchupDeadline(deadline);
  }
  // sqlite-proxy(D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ(共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  const db = createD1HttpDb(irSchema) as unknown as Database;
  let r;
  if (resume !== undefined) {
    r = await resumeNotionByStock(db, resume.from, resume.toExclusive,
      resume.exact === undefined ? undefined : { ...resume.exact, deadlineMs: deadline! });
  } else {
    r = deadline === undefined ? await runIrCatalogCatchup(db) : await runIrCatalogCatchup(db, undefined, Date.now(), deadline);
  }
  assertCatchupDeadline(deadline);
  console.info("[ir-tdnet]", JSON.stringify(r));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error("[ir-tdnet] エラー:", e);
    process.exit(1);
  });
}
