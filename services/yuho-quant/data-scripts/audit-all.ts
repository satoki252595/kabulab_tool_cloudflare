/**
 * 全数監査 (一回限り・cron非対象)。受注高が未取得の全上場銘柄について
 * 「本当に受注高の記載が無いか」を type=1 (XBRL本文) で確実に検証し、
 * 未対応の本物の受注表シグネチャをクラスタリングして追加パターン候補を出す。
 *
 * 判定 (1 銘柄=最新有報 docId 基準):
 *   REAL_UNHANDLED : 受注高 を含む実テーブル(数値行≥3)があるが parseOrderHtml が
 *                    ok_* を返さない = 取りこぼし → 追加パターン候補 (署名集計)
 *   PREFILTER_MISS : parse_status=no_order_table なのに本文に受注高実テーブルあり
 *                    = CSV事前判定の重大ミス (要修正・最優先)
 *   KEYWORD_ONLY   : 受注高 の語はあるが実テーブル無し (受注生産行わず 等) = 記載なし相当
 *   NO_ORDERS      : 本文に「受注高」文字列が一切無い = 確実に受注高記載なし
 *   NO_DOC         : 有報未取込 (別途 EDINET 取得可否を確認)
 *
 * 再開可能: tmp/audit/done.jsonl に1銘柄1行追記、再実行で既処理 code をスキップ。
 * 出力: tmp/audit/report.jsonl (全判定), tmp/audit/signatures.txt (新パターン候補)
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/audit-all.ts [--concurrency=2] [--limit=N]
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createDb } from "../src/db/client.js";
import { yuhoEnv } from "../src/env.js";
import { downloadDocument, EdinetNotFoundError } from "../src/services/edinet/client.js";
import { unzip } from "../src/services/edinet/zip.js";
import {
  extractTables,
  tableToGridExpanded,
  parseJpNumber,
} from "../src/services/edinet/html-table.js";
import { parseOrderHtml } from "../src/services/edinet/order-parser.js";

// ⚠️ ADR-0001: D1 移行に伴い本 CLI は無効化。createDb は D1 バインディングを要求し
// Node ローカルからは接続できず、db.execute / `core.stocks` 等の PG 構文も SQLite
// では無効。黙って壊れる代わりに fail-fast する (CLAUDE.md ルール2)。全数監査は
// Worker 取込・別途の検証手段へ置換予定。詳細は docs/adr/0001-neon-to-d1-r2-notion.md。
throw new Error(
  "ADR-0001: yuho 全数監査 CLI は D1 移行で無効化されています (Worker 取込へ移行予定)。"
);

const OUT = join(process.cwd(), "tmp", "audit");
mkdirSync(OUT, { recursive: true });
const DONE = join(OUT, "done.jsonl");
const REPORT = join(OUT, "report.jsonl");

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const concurrency = Math.min(3, Math.max(1, Number(arg("concurrency") ?? "2")));
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const db = createDb(yuhoEnv.DATABASE_URL());
const q = (s: any) => db.execute(s).then((r: any) => r.rows ?? r);

// 受注高 を1値でも構造化済みの stock_id (= 取得済み, 監査除外)
const haveOrders = new Set<number>(
  (
    await q(sql`select distinct stock_id from yuho_quant.order_facts
                where orders_received_yen is not null`)
  ).map((r: any) => r.stock_id)
);

// 監査対象 = active 銘柄の「最新有報 doc」 で 受注高未取得のもの
const rows: Array<{
  stock_id: number;
  code: string;
  name: string;
  sector: string | null;
  doc_id: string | null;
  parse_status: string | null;
  period_end: string | null;
}> = await q(sql`
  with latest as (
    select distinct on (d.stock_id) d.stock_id, d.doc_id, d.parse_status, d.period_end
    from yuho_quant.documents d order by d.stock_id, d.submitted_at desc
  )
  select s.id as stock_id, s.code, s.name, s.sector,
         l.doc_id, l.parse_status, l.period_end
  from core.stocks s
  left join latest l on l.stock_id = s.id
  where s.is_active = true
  order by s.code`);

const doneCodes = new Set<string>(
  existsSync(DONE)
    ? readFileSync(DONE, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).code)
    : []
);

const targets = rows
  .filter((r) => !haveOrders.has(r.stock_id) && !doneCodes.has(r.code))
  .slice(0, limit === Infinity ? undefined : limit);

console.info(
  `[audit] active=${rows.length} 受注高取得済=${haveOrders.size} 監査対象(未処理)=${targets.length} concurrency=${concurrency}`
);

const RX_ORDERS = /受注高/;
const RX_BACKLOG = /受注残高|期末受注残高|当期受注|繰越工事高|期末.{0,3}繰越|手持工事高|次期.{0,3}繰越/;

function classify(html: string): {
  verdict: "REAL_UNHANDLED" | "KEYWORD_ONLY" | "NO_ORDERS";
  sig: string | null;
} {
  if (!RX_ORDERS.test(html)) return { verdict: "NO_ORDERS", sig: null };
  // parseOrderHtml が ok を返すなら取りこぼしでない (= 取得済へ回るはず)
  const pr = parseOrderHtml(html, "2025-03-31");
  if (pr.status.startsWith("ok_")) return { verdict: "KEYWORD_ONLY", sig: null };
  // 受注高 を含む実テーブル (受注/繰越語 + 数値行≥3) を探す
  for (const t of extractTables(html)) {
    if (!RX_ORDERS.test(t)) continue;
    const g = tableToGridExpanded(t);
    const flat = g.map((x) => x.join("")).join("");
    if (!RX_ORDERS.test(flat) || !RX_BACKLOG.test(flat)) continue;
    const numRows = g.filter(
      (row) => row.slice(1).filter((c) => parseJpNumber(c) !== null).length >= 2
    ).length;
    if (numRows < 3) continue;
    const sig = g
      .filter((row) => row.slice(1).every((c) => parseJpNumber(c) === null))
      .slice(0, 3)
      .map((row) => row.join("|"))
      .join(" / ")
      .replace(/[\s\u30000-9,]/g, "")
      .slice(0, 200);
    return { verdict: "REAL_UNHANDLED", sig };
  }
  return { verdict: "KEYWORD_ONLY", sig: null };
}

let processed = 0;
let cursor = 0;
const tally: Record<string, number> = {};
const sigCount = new Map<string, { n: number; ex: string[] }>();

async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= targets.length) return;
    const r = targets[i];
    let verdict: string;
    let sig: string | null = null;
    let honbun: string | null = null;
    try {
      if (!r.doc_id) {
        verdict = "NO_DOC";
      } else {
        const zip = await downloadDocument(r.doc_id, 1);
        const e = unzip(zip);
        const names = [...e.keys()].filter(
          (n) =>
            /PublicDoc\//i.test(n) &&
            /honbun/i.test(n) &&
            /jpcrp030000-asr/i.test(n) &&
            /\.html?$/i.test(n)
        );
        const html = names
          .map((n) => e.get(n)!.toString("utf8"))
          .join("\n");
        honbun = names[0] ?? null;
        const c = classify(html);
        verdict = c.verdict;
        sig = c.sig;
        // CSV事前判定ミス検出: no_order_table なのに本物の受注表あり
        if (verdict === "REAL_UNHANDLED" && r.parse_status === "no_order_table") {
          verdict = "PREFILTER_MISS";
        }
      }
    } catch (err) {
      if (err instanceof EdinetNotFoundError) verdict = "NO_DOC";
      else {
        verdict = "ERROR";
        sig = (err as Error).message.slice(0, 120);
      }
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    if (sig && (verdict === "REAL_UNHANDLED" || verdict === "PREFILTER_MISS")) {
      const cur = sigCount.get(sig) ?? { n: 0, ex: [] };
      cur.n++;
      if (cur.ex.length < 6) cur.ex.push(r.code);
      sigCount.set(sig, cur);
    }
    const rec = {
      code: r.code,
      name: r.name,
      sector: r.sector,
      parse_status: r.parse_status,
      doc_id: r.doc_id,
      verdict,
      sig,
      honbun,
    };
    appendFileSync(REPORT, JSON.stringify(rec) + "\n");
    appendFileSync(DONE, JSON.stringify({ code: r.code, verdict }) + "\n");
    processed++;
    if (processed % 50 === 0) {
      console.info(
        `[audit] ${processed}/${targets.length} ` +
          Object.entries(tally)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
      );
    }
    await sleep(200);
  }
}

await Promise.all(
  Array.from({ length: Math.min(concurrency, targets.length || 1) }, () =>
    worker()
  )
);

const sigSorted = [...sigCount.entries()].sort((a, b) => b[1].n - a[1].n);
writeFileSync(
  join(OUT, "signatures.txt"),
  sigSorted
    .map(([s, v]) => `[${v.n}] ex=${v.ex.join(",")}  ${s}`)
    .join("\n")
);
console.info("\n[audit] 完了 判定内訳:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.info(`  ${k}: ${v}`);
}
console.info(
  `\n新パターン候補 (REAL_UNHANDLED/PREFILTER_MISS) 署名 TOP20 → tmp/audit/signatures.txt:`
);
for (const [s, v] of sigSorted.slice(0, 20)) {
  console.info(`  [${v.n}] ex=${v.ex.join(",")}  ${s}`);
}
