/**
 * 有価証券報告書 受注データ 5 年バックフィル (一回限り・手動。cron 非対象)。
 *
 * EDINET 書類一覧 API を日次で遡り、対象=取込の母集団 (日次キャッチアップと同じ) の
 * 有報 (docTypeCode 120/130) を見つけて ingestDocument で構造化・保存する。
 *
 * 設計 (CLAUDE.md):
 *   - 冪等/再開可能: 既存 docId は ingest 側でスキップ。途中で止めても再実行で続き。
 *   - フォールバック禁止: 構造化不能は parse_status に正直に記録 (数値捏造なし)。
 *   - レート配慮: 一覧は逐次 + ディレイ、取り込みは小さな並列度。
 *   - 取り込み範囲はユーザ選択どおり「受注 + 書類メタのみ」(ingest が CSV
 *     事前判定で受注なしは XBRL を落とさず meta だけ記録)。
 *
 * 実行例:
 *   pnpm yuho:backfill                 # 直近 5 年, 全 core.stocks
 *   pnpm yuho:backfill -- --years=5
 *   pnpm yuho:backfill -- --from=2020-06-01 --to=2020-06-30
 *   pnpm yuho:backfill -- --ticker=7011        # 動作確認用 (1 社)
 *   pnpm yuho:backfill -- --concurrency=3      # 取り込み並列度 (1〜4, 既定1)
 *   pnpm yuho:backfill -- --force              # 既存 docId も再取得
 *   pnpm yuho:backfill -- --reparse-unrecognized --no-archive --concurrency=3
 *       # パーサ改善反映: table_unrecognized/parse_error/orders_only だけ
 *       # force 再取込 (他は EDINET を叩かず skip)、Notion 再保存はしない
 *
 * ADR-0001 (Neon → D1) 後の接続:
 *   D1 はバインディング経由でのみ触れるが、本処理は Node 専用 (大量の EDINET
 *   取得 + ローカルパース) なので Worker 化できない。接続自体は
 *   backfill-overseas.ts / scripts/sync/ir-tdnet.ts と同じ createD1HttpDb
 *   (drizzle sqlite-proxy / D1 REST)。
 *
 * Node 実行のため D1 書込は `createD1HttpBatchSender()` を明示して
 * `ingestDocument` に渡す (入口 preflight が sender 無しの Node を書込前に
 * 止める)。sqlite-proxy の `db.batch` はメソッド自体は存在するが batch
 * callback 未配線で実行時 TypeError になるため、typeof 判定では足りない。
 * 必要 env は EDINET_API_KEY / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID /
 * D1_DATABASE_ID (未設定なら required で throw)。
 */
import "dotenv/config";
import {
  createD1HttpBatchSender,
  createD1HttpDb,
} from "../../../src/shared/db/d1-http-client.js";
import * as yuhoSchema from "../src/db/schema.js";
import type { Database } from "../src/db/client.js";
import { inArray } from "drizzle-orm";
import { loadIngestCodeToId } from "../../../src/shared/db/active-equity.js";
import { yuhoDocuments } from "../src/db/schema.js";
import { listDocuments } from "../src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
} from "../src/services/edinet/types.js";
import { ingestDocument } from "../src/services/ingest.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=")[1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function shiftYearsISO(iso: string, dy: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + dy);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  // sqlite-proxy (D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ (共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  // backfill-overseas.ts / scripts/sync/ir-tdnet.ts と同じ形。
  const db = createD1HttpDb(yuhoSchema) as unknown as Database;
  // D1 書込口の明示指定 (Node では必須。ingestDocument 入口 preflight が
  // 未指定を書込前に止める)。sender は無状態なので run 全体で 1 個を使い回す。
  const d1HttpBatch = createD1HttpBatchSender();

  const to = arg("to") ?? todayISO();
  const years = Number(arg("years") ?? "5");
  const from = arg("from") ?? shiftYearsISO(to, -years);
  const tickerFilter = arg("ticker");
  // --reparse-unrecognized: 既存 docId のうち parse_status が
  // table_unrecognized/parse_error/orders_only のものだけを force 再取込
  // (パーサ改善の反映用)。他 (ok_*/no_order_table) は EDINET を叩かず skip。
  const reparseUnrecognized = hasFlag("reparse-unrecognized");
  // --no-archive: write mode 未対応 (下で明示 STOP)。parse 再評価時は
  // archive 済み key が冪等スキップされるため再アップロード帯域は生じない。
  const archiveToNotion = !hasFlag("no-archive");
  // raw-before-DB 契約: 本スクリプトは常時 write のため --no-archive は
  // 未対応。ingest 側も archiveToNotion=false を DB 書込前に止める (二重明示)。
  if (hasFlag("no-archive")) {
    console.error(
      "[backfill] --no-archive は write mode 未対応のため STOP します (raw-before-DB 契約)"
    );
    process.exit(1);
  }
  const force = hasFlag("force") || reparseUnrecognized;

  // 再評価対象の docId 集合を事前ロード (EDINET を叩く前に絞り込む)
  const reparseSet = new Set<string>();
  if (reparseUnrecognized) {
    const rows = await db
      .select({
        docId: yuhoDocuments.docId,
        parseStatus: yuhoDocuments.parseStatus,
      })
      .from(yuhoDocuments)
      .where(
        inArray(yuhoDocuments.parseStatus, [
          "table_unrecognized",
          "parse_error",
          "orders_only",
        ])
      );
    for (const r of rows) reparseSet.add(r.docId);
    console.info(
      `[backfill] --reparse-unrecognized: 対象 docId ${reparseSet.size} 件 (table_unrecognized/parse_error/orders_only), archiveToNotion=${archiveToNotion}`
    );
  }
  // 同一日の有報は互いに独立なので小さな並列度で取り込み実時間を短縮
  // (EDINET は公開上限なしだが常識的レートに収めるため上限 4)。
  const concurrency = Math.min(4, Math.max(1, Number(arg("concurrency") ?? "1")));

  // code(4桁) → stockId マップ。母集団は日次キャッチアップ (src/cron/yuho-edinet.ts) と
  // 同じ取込の母集団 (非普通株と、区分が NULL の active 行を除く。理由は
  // src/shared/db/active-equity.ts の disclosureIngestCondition)。
  const codeToId = await loadIngestCodeToId(db);
  console.info(
    `[backfill] core_stocks (取込の母集団) ${codeToId.size} 社 / 期間 ${from}〜${to}` +
      (tickerFilter ? ` / ticker=${tickerFilter}` : "")
  );

  const stat: Record<string, number> = {};
  let scannedDays = 0;
  let matched = 0;
  let ingested = 0;
  let skipped = 0;

  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  // 長時間ジョブを運用者が「ハングか正常進行か」即判断できるよう、走査
  // 総日数と日次固定オーバーヘッド (list 後 180ms + 失敗時の sleep を除く)
  // による下限所要を開始時に明示する。実時間は取込件数 (Notion 往復) で増える。
  const totalDays =
    Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  console.info(
    `[backfill] 走査予定 ${totalDays} 日 (list+180ms の固定下限 ~${Math.ceil(
      (totalDays * 180) / 60000
    )} 分 + 取込件数×Notion 往復で増加)`
  );
  // 新しい日から過去へ (最近の年度を先に埋める)
  for (let d = new Date(end); d >= start; d.setUTCDate(d.getUTCDate() - 1)) {
    const date = d.toISOString().slice(0, 10);
    scannedDays++;
    let list;
    try {
      list = await listDocuments(date);
    } catch (e) {
      // 一覧取得失敗は一過性の可能性。握り潰さず記録して次の日へ
      console.error(`[backfill] list 失敗 ${date}: ${(e as Error).message}`);
      await sleep(1000);
      continue;
    }

    const targets = list.results.filter((doc) => {
      if (!isAnnualSecuritiesReport(doc)) return false;
      const t = secCodeToTicker(doc.secCode);
      if (t === null || !codeToId.has(t)) return false;
      if (tickerFilter && t !== tickerFilter) return false;
      return true;
    });

    matched += targets.length;
    // concurrency 件ずつのワーカープールで取り込み (順序非依存・冪等)
    let cursor = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const idx = cursor++;
        if (idx >= targets.length) return;
        const doc = targets[idx];
        const ticker = secCodeToTicker(doc.secCode)!;
        const stockId = codeToId.get(ticker)!;
        // 再評価モードでは対象 (未構造化) docId 以外は EDINET を叩かず skip
        if (reparseUnrecognized && !reparseSet.has(doc.docID)) {
          skipped++;
          continue;
        }
        try {
          const r = await ingestDocument(db, {
            stockId,
            stockCode: ticker,
            doc,
            force,
            archiveToNotion,
            d1HttpBatch,
          });
          stat[r.parseStatus] = (stat[r.parseStatus] ?? 0) + 1;
          if (r.outcome === "ingested") {
            ingested++;
            console.info(
              `[backfill] ${date} ${ticker} ${doc.filerName} FY${r.periodEnd ?? doc.periodEnd ?? "?"} → ${r.parseStatus} (facts=${r.factCount})`
            );
          } else {
            skipped++;
          }
        } catch (e) {
          // ネットワーク等の一過性失敗。記録して継続 (次回再実行で拾える)
          console.error(
            `[backfill] ingest 失敗 ${ticker} docID=${doc.docID}: ${(e as Error).message}`
          );
        }
        await sleep(300);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, targets.length || 1) }, worker)
    );
    if (scannedDays % 30 === 0) {
      console.info(
        `[backfill] 進捗: ${scannedDays}日走査 / matched=${matched} ingested=${ingested} skipped=${skipped}`
      );
    }
    await sleep(180);
  }

  console.info("\n[backfill] 完了");
  console.info(
    `  走査日数=${scannedDays} 対象有報=${matched} 取込=${ingested} 既存スキップ=${skipped}`
  );
  console.info("  parse_status 内訳:");
  for (const [k, v] of Object.entries(stat).sort((a, b) => b[1] - a[1])) {
    console.info(`    ${k.padEnd(20)} ${v}`);
  }
}

main().catch((e) => {
  console.error("[backfill] 致命的エラー:", e);
  process.exit(1);
});
