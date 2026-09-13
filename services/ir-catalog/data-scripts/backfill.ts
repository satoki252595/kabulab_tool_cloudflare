/**
 * TDnet 適時開示 全履歴バックフィル (一回限り・手動。cron 非対象)。
 *
 * 月単位で新しい順に遡り、各月の全開示を取得 → 取込の母集団 (日次キャッチアップと同じ)
 * だけに絞って ir_catalog.disclosures へ冪等 upsert。さらにルール6 に従い
 * 「取得バッチ (= 月) 単位の確定 JSONL」を Notion 一次データへ実体
 * アップロードし、高シグナル開示は人間可読 Notion DB へ冪等記録する。
 *
 * 設計 (CLAUDE.md):
 *   - 冪等/再開可能: tdnet_id 一意 + Notion key 冪等。途中で止めても再実行で続き。
 *     既に Notion へ確定済みの過去月は API を叩かずスキップ (サイト負荷回避)。
 *   - フォールバック禁止: 分類不能は tags=[] のまま (捏造しない)。
 *   - レート配慮: client が全 TDnet 通信を直列化 + 最小間隔を強制。
 *   - 全履歴: 過去へ遡り、空月が EMPTY_STOP_MONTHS 連続したら開始点に達した
 *     と判断して停止 (推測でなく「データが無い」事実で止める)。FLOOR で下限。
 *
 * 実行例:
 *   pnpm ir:backfill                       # 全履歴 (今月→過去、空月連続で停止)
 *   pnpm ir:backfill -- --from=2023-01 --to=2024-12
 *   pnpm ir:backfill -- --ticker=7203      # 動作確認 (1 社のみ DB 反映)
 *   pnpm ir:backfill -- --no-archive        # Notion 一次データ .json を作らない
 *   pnpm ir:backfill -- --no-notion-by-stock# 銘柄別二次データを投入しない
 *   pnpm ir:backfill -- --notion-deadline-hours=3
 *       # 二次データ投入の上限時間。Notion エッジ遮断が広域継続した際の
 *       # 時間膨張を防ぐ。超過で正直に打ち切り → 再実行で収束 (冪等)
 *   pnpm ir:backfill -- --refetch-archived  # 確定済み過去月も再取得 (訂正反映)
 *
 * ADR-0001 (Neon → D1) 後の接続:
 *   D1 はバインディング経由でのみ触れるが、本 CLI は PDF センチメントが
 *   kuromoji (Node 専用) 依存で Worker 化できない。そこで日次キャッチアップ
 *   (scripts/sync/ir-tdnet.ts) と**同じ** createD1HttpDb (drizzle sqlite-proxy /
 *   D1 REST) で書く。必要 env は CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID /
 *   D1_DATABASE_ID (未設定なら sharedEnv の required で throw)。
 */
import "dotenv/config";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as irSchema from "../src/db/schema.js";
import type { Database } from "../src/db/client.js";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { isArchived } from "../../../src/shared/notion-archive/index.js";
import { listRange } from "../src/services/tdnet/client.js";
import { ingestBatch } from "../src/services/ingest.js";

/** 空月がこれだけ連続したらデータ開始点に達したとみなし停止 */
const EMPTY_STOP_MONTHS = 12;
/** 下限 (TDnet/yanoshin にこれ以前のデータは無い前提のハードフロア) */
const FLOOR = { y: 2008, m: 1 };

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=")[1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function ymParts(s: string): { y: number; m: number } {
  const mm = /^(\d{4})-(\d{2})$/.exec(s);
  if (!mm) throw new Error(`--from/--to は YYYY-MM 形式で指定してください: ${s}`);
  return { y: Number(mm[1]), m: Number(mm[2]) };
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function cmp(a: { y: number; m: number }, b: { y: number; m: number }): number {
  return a.y !== b.y ? a.y - b.y : a.m - b.m;
}

async function main(): Promise<void> {
  // sqlite-proxy (D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ (共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  // scripts/sync/ir-tdnet.ts と同じ形。
  const db = createD1HttpDb(irSchema) as unknown as Database;

  // 既定の「今月」は JST 基準 (TDnet の開示日は JST。月末深夜の UTC ずれ防止)
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const to = arg("to")
    ? ymParts(arg("to")!)
    : { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1 };
  const from = arg("from") ? ymParts(arg("from")!) : FLOOR;
  const tickerFilter = arg("ticker");
  const archiveToNotion = !hasFlag("no-archive");
  const notionByStock = !hasFlag("no-notion-by-stock");
  const refetchArchived = hasFlag("refetch-archived");
  /**
   * 既存 terminal (uploaded+hasFile) 行に対しても PDF を再 fetch して再判定
   * + Notion `PDF判定` 列を PATCH。pdf-sentiment 機能の新規導入時や Engine
   * 改修後の段階的反映で使う。`--ticker` / `--from` / `--to` で範囲を絞ること。
   * PDF 入手不能 (TDnet purge ≥31日 / transient) はスキップ。
   */
  const rejudgePdfSentiment = hasFlag("rejudge-pdf-sentiment");
  // 任意の上限時間。Notion エッジ遮断が広域継続したとき無制限に時間が
  // 膨張するのを防ぐ。超過後は各月 byStock が即 reachedDeadline で
  // no-op になり正直に打ち切り → 再実行で error/未添付行から収束する。
  const ndh = arg("notion-deadline-hours");
  const notionDeadlineMs =
    ndh !== undefined && ndh !== ""
      ? Date.now() + Math.max(0.1, Number(ndh)) * 3600_000
      : undefined;

  // 母集団は日次キャッチアップ (src/cron/ir-catalog-tdnet.ts) と同じ取込の母集団。
  // 非普通株と、区分が NULL の active 行の開示は取り込まない。is_active=0 の銘柄 (東証の
  // 上場廃止。地域取引所にだけ上場を続ける会社を含む) の開示は取り込む
  // (理由は src/shared/db/active-equity.ts の ingestUniverseCondition)。
  const codeToId = await loadIngestCodeToId(db);
  console.info(
    `[ir:backfill] core_stocks (取込の母集団) ${codeToId.size} 社 / ${pad(from.m)}/${from.y}〜${pad(
      to.m
    )}/${to.y}` +
      (tickerFilter ? ` / ticker=${tickerFilter} (DB 反映を1社に限定)` : "") +
      ` / archive=${archiveToNotion} byStock=${notionByStock}` +
      (rejudgePdfSentiment ? ` / rejudge-pdf-sentiment=true (既存 terminal 行も再判定)` : "")
  );

  // 「今月」と「先月」は開示が増え続けるので常に再取得 (確定スキップ対象外)
  const liveBoundary = {
    y: to.m === 1 ? to.y - 1 : to.y,
    m: to.m === 1 ? 12 : to.m - 1,
  };

  let consecutiveEmpty = 0;
  let totalUpserted = 0;
  let totalInUniverse = 0;
  const tagAgg: Record<string, number> = {};

  const cur = { ...to };
  while (cmp(cur, from) >= 0) {
    if (cur.y < FLOOR.y || (cur.y === FLOOR.y && cur.m < FLOOR.m)) break;

    const monthKey = `${cur.y}-${pad(cur.m)}`;
    const batchKey = `tdnet-${monthKey}`;
    const isPast = cmp(cur, liveBoundary) < 0;

    // 確定済み過去月は API を叩かずスキップ (サイト負荷回避・再開高速化)
    if (archiveToNotion && isPast && !refetchArchived) {
      if (await isArchived("ir-catalog", batchKey)) {
        console.info(`[ir:backfill] ${monthKey} 確定済 (Notion) — スキップ`);
        // 過去の確定済み月が続く間は空月カウンタをリセット (停止判定は
        // 「実取得して 0 件」の連続でのみ行う)
        consecutiveEmpty = 0;
        if (cur.m === 1) {
          cur.y--;
          cur.m = 12;
        } else {
          cur.m--;
        }
        continue;
      }
    }

    const range = `${cur.y}${pad(cur.m)}01-${cur.y}${pad(cur.m)}${pad(
      lastDay(cur.y, cur.m)
    )}`;

    let items;
    try {
      items = await listRange(range);
    } catch (e) {
      // 一過性の可能性。握り潰さず記録し、この月は次回再実行で拾う
      console.error(
        `[ir:backfill] ${monthKey} 取得失敗: ${(e as Error).message} — この月は次回再実行で回収`
      );
      if (cur.m === 1) {
        cur.y--;
        cur.m = 12;
      } else {
        cur.m--;
      }
      continue;
    }

    if (items.length === 0) {
      consecutiveEmpty++;
      console.info(
        `[ir:backfill] ${monthKey} 0 件 (空月 ${consecutiveEmpty}/${EMPTY_STOP_MONTHS})`
      );
      if (!arg("from") && consecutiveEmpty >= EMPTY_STOP_MONTHS) {
        console.info(
          `[ir:backfill] 空月 ${EMPTY_STOP_MONTHS} 連続 — データ開始点に到達と判断し停止`
        );
        break;
      }
      if (cur.m === 1) {
        cur.y--;
        cur.m = 12;
      } else {
        cur.m--;
      }
      continue;
    }
    consecutiveEmpty = 0;

    const targetItems = tickerFilter
      ? items.filter((it) => it.company_code.slice(0, 4) === tickerFilter)
      : items;

    const r = await ingestBatch(db, targetItems, {
      batchKey,
      source: `yanoshin TDnet WebAPI /tdnet/list/{YYYYMMDD}.json 1日ずつ全件 (範囲 ${range})`,
      archiveToNotion,
      notionByStock,
      notionByStockDeadlineMs: notionDeadlineMs,
      codeToId,
      rejudgePdfSentiment,
    });
    totalUpserted += r.upserted;
    totalInUniverse += r.inUniverse;
    for (const [k, v] of Object.entries(r.byPrimaryTag))
      tagAgg[k] = (tagAgg[k] ?? 0) + v;

    const bs = r.notionByStock;
    console.info(
      `[ir:backfill] ${monthKey} 取得=${r.fetched} ユニバース内=${r.inUniverse} upsert=${r.upserted} 未分類=${r.unclassified}` +
        ` notion=${
          r.notionArchive
            ? "outcome" in r.notionArchive
              ? r.notionArchive.outcome
              : `ERR:${r.notionArchive.error}`
            : "-"
        }` +
        ` byStock=${
          bs
            ? "created" in bs
              ? `${bs.stocksTouched}社 +${bs.created}/upd${bs.updated}/skip${bs.skippedExisting}/skipNF${bs.skippedNoFile}/rej${bs.rejudged}/err${bs.rowErrors}${bs.reachedDeadline ? "(打切)" : ""}`
              : `ERR:${bs.error}`
            : "-"
        }`
    );

    if (cur.m === 1) {
      cur.y--;
      cur.m = 12;
    } else {
      cur.m--;
    }
  }

  console.info("\n[ir:backfill] 完了");
  console.info(
    `  ユニバース内 取得=${totalInUniverse} upsert=${totalUpserted}`
  );
  console.info("  primaryTag 内訳:");
  for (const [k, v] of Object.entries(tagAgg).sort((a, b) => b[1] - a[1])) {
    console.info(`    ${k.padEnd(18)} ${v}`);
  }
}

main().catch((e) => {
  console.error("[ir:backfill] 致命的エラー:", e);
  process.exit(1);
});
