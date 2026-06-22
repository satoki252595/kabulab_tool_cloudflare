/**
 * 全銘柄「答え合わせ」監査 (一回限り・cron非対象)。
 *
 * 005 yuho-quant が EDINET から既に発見・記録した有報 (yuho_documents) を
 * コーパスとして、各銘柄の **最新有報** を type=1(XBRL) で取得し、海外売上高
 * パーサ (parseOverseasHtml) が地域別売上を構造化できるかを検証する。
 *
 * 判定 (1 銘柄=最新有報 docId 基準):
 *   OK_*           : 構造化成功 (海外売上高比率を記録)
 *   REAL_UNHANDLED : 日本(本邦)+海外地域+売上/収益 の実テーブル(数値行≥3)が
 *                    あるのにパーサが ok を返さない = 取りこぼし → 署名集計
 *   NO_OVERSEAS    : 地域別売上の開示が無い (内需企業 等) = 構造化対象外
 *   NO_DOC / ERROR : 有報未取込 / 取得失敗
 *
 * 再開可能: tmp/oseas-audit/done.jsonl に1銘柄1行追記、再実行で既処理 code を
 * スキップ。XBRL 本文は tmp/oseas-cache/<docId>.html にキャッシュ (パーサ反復で
 * 再ダウンロード不要)。出力: report.jsonl (全判定) / signatures.txt (取りこぼし署名)。
 *
 * 必要env(.env): EDINET_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
 *               D1_DATABASE_ID (yuho_documents コーパス読取に使用)。
 *
 * 実行: D1_DATABASE_ID=<id> pnpm exec tsx services/overseas-sales/data-scripts/audit-all.ts [--limit=N] [--concurrency=2] [--offset=N]
 */
import "dotenv/config";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sharedEnv } from "../../../src/shared/env.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../../yuho-quant/src/services/edinet/client.js";
import { unzip } from "../../yuho-quant/src/services/edinet/zip.js";
import {
  tableToGridExpanded,
  parseJpNumber,
} from "../../yuho-quant/src/services/edinet/html-table.js";
import { parseOverseasHtml } from "../src/services/overseas-parser.js";

const OUT = join(process.cwd(), "tmp", "oseas-audit");
mkdirSync(OUT, { recursive: true });
const CACHE = join(process.cwd(), "tmp", "oseas-cache");
mkdirSync(CACHE, { recursive: true });
const DONE = join(OUT, "done.jsonl");
const REPORT = join(OUT, "report.jsonl");

const arg = (n: string) =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const limit = arg("limit") ? Number(arg("limit")) : Infinity;
const offset = arg("offset") ? Number(arg("offset")) : 0;
const concurrency = Math.min(3, Math.max(1, Number(arg("concurrency") ?? "2")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** D1 REST 直クエリ (読取専用・コーパス取得)。型付き env 経由 (ルール3)。 */
async function d1Query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const acct = sharedEnv.CLOUDFLARE_ACCOUNT_ID();
  const tok = sharedEnv.CLOUDFLARE_API_TOKEN();
  const db = sharedEnv.D1_DATABASE_ID();
  const url = `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database/${db}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ sql }),
  });
  if (!res.ok) throw new Error(`D1 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { success: boolean; result?: Array<{ results?: T[] }>; errors?: unknown };
  if (!j.success) throw new Error(`D1 error: ${JSON.stringify(j.errors)}`);
  return j.result?.[0]?.results ?? [];
}

const RX_OVERSEAS_REGION =
  /北米|南米|中南米|北中米|米州|米国|アメリカ|欧州|ヨーロッパ|欧米|アジア|オセアニア|大洋州|アフリカ|中東|中国|中華圏|香港|韓国|台湾|タイ|ベトナム|インド|シンガポール|ドイツ|英国|豪州|海外/;

/** 全ネスト階層 table 抽出 (見出し付き・パーサと同方針) */
function allTables(h: string): Array<{ table: string; heading: string }> {
  const out: Array<{ table: string; heading: string }> = [];
  const re = /<\/?table\b[^>]*>/gi;
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(h)) !== null) {
    if (m[0][1] === "/") {
      const s = stack.pop();
      if (s === undefined) continue;
      const before = h.slice(Math.max(0, s - 400), s);
      const heading = before.replace(/<[^>]+>/g, " ").replace(/[\s\u3000]+/g, " ").trim().slice(-120);
      out.push({ table: h.slice(s, re.lastIndex), heading });
    } else stack.push(m.index);
  }
  return out;
}

interface Classified {
  verdict: "OK" | "REAL_UNHANDLED" | "NO_OVERSEAS";
  status: string;
  ratio: number | null;
  sig: string | null;
}

function classify(html: string, periodEnd: string): Classified {
  const r = parseOverseasHtml(html, periodEnd);
  if (r.status.startsWith("ok_")) {
    const ovt = r.facts.find((f) => f.regionKind === "overseas_total");
    const tot = r.facts.find((f) => f.regionKind === "total");
    const ratio =
      ovt?.salesAmount != null && tot?.salesAmount
        ? +((ovt.salesAmount / tot.salesAmount) * 100).toFixed(1)
        : null;
    return { verdict: "OK", status: r.status, ratio, sig: null };
  }
  // 取りこぼし候補: 日本(本邦)+海外地域+売上/収益 の実テーブルを探す
  for (const { table, heading } of allTables(html)) {
    const g = tableToGridExpanded(table);
    if (g.length < 3) continue;
    const flat = g.map((x) => x.join("")).join("");
    if (!/日本|本邦/.test(flat) || !RX_OVERSEAS_REGION.test(flat)) continue;
    if (!/売上|収益/.test(flat + heading)) continue;
    const numRows = g.filter((x) => x.slice(1).filter((c) => parseJpNumber(c) !== null).length >= 1).length;
    if (numRows < 3) continue;
    // 署名 = 見出しキーワード + 非数値ラベル行 (先頭3) を圧縮
    const headKw =
      (heading.match(/地域ごとの情報|主たる地域市場|所在地別|地域別|海外売上高|国又は地域|顧客との契約から生じる収益/) ?? ["?"])[0];
    const labelRows = g
      .filter((row) => row.slice(1).every((c) => parseJpNumber(c) === null) && row[0])
      .slice(0, 4)
      .map((row) => row.map((c) => c.replace(/[\s\u3000\d,]/g, "")).filter(Boolean).join("/"))
      .join(" | ")
      .slice(0, 160);
    return { verdict: "REAL_UNHANDLED", status: r.status, ratio: null, sig: `[${headKw}] ${labelRows}` };
  }
  return { verdict: "NO_OVERSEAS", status: r.status, ratio: null, sig: null };
}

async function getXbrlHtml(docId: string): Promise<string | null> {
  const cf = join(CACHE, `${docId}.html`);
  if (existsSync(cf)) return readFileSync(cf, "utf8");
  let zip: Buffer;
  try {
    zip = await downloadDocument(docId, 1);
  } catch (e) {
    if (e instanceof EdinetNotFoundError) return null;
    throw e;
  }
  const entries = unzip(zip);
  const names = [...entries.keys()].filter(
    (n) => /PublicDoc\//i.test(n) && /honbun/i.test(n) && /jpcrp030000-asr/i.test(n) && /\.html?$/i.test(n)
  );
  const html = names.map((n) => entries.get(n)!.toString("utf8")).join("\n");
  writeFileSync(cf, html);
  return html;
}

// --- コーパス: 各銘柄の最新有報 (yuho_documents) ---
const corpus = await d1Query<{ code: string; doc_id: string; period_end: string }>(`
  select s.code, d.doc_id, d.period_end
  from core_stocks s
  join (
    select stock_id, doc_id, period_end,
           row_number() over (partition by stock_id order by submitted_at desc) rn
    from yuho_documents
  ) d on d.stock_id = s.id and d.rn = 1
  where s.is_active = 1
  order by s.code`);

const doneCodes = new Set<string>(
  existsSync(DONE)
    ? readFileSync(DONE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).code)
    : []
);
const targets = corpus
  .filter((r) => !doneCodes.has(r.code))
  .slice(offset, offset + (limit === Infinity ? corpus.length : limit));

console.info(`[oseas-audit] corpus=${corpus.length} 既処理=${doneCodes.size} 今回対象=${targets.length} conc=${concurrency}`);

const tally: Record<string, number> = {};
const statusTally: Record<string, number> = {};
const sigCount = new Map<string, { n: number; ex: string[] }>();
const ratios: number[] = [];
let cursor = 0;
let processed = 0;

async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= targets.length) return;
    const r = targets[i];
    let verdict: string;
    let status = "";
    let ratio: number | null = null;
    let sig: string | null = null;
    try {
      const html = await getXbrlHtml(r.doc_id);
      if (!html) {
        verdict = "NO_DOC";
      } else {
        const c = classify(html, /^\d{4}-\d{2}-\d{2}$/.test(r.period_end) ? r.period_end : "2025-03-31");
        verdict = c.verdict;
        status = c.status;
        ratio = c.ratio;
        sig = c.sig;
      }
    } catch (e) {
      verdict = "ERROR";
      sig = (e as Error).message.slice(0, 100);
    }
    tally[verdict] = (tally[verdict] ?? 0) + 1;
    if (status) statusTally[status] = (statusTally[status] ?? 0) + 1;
    if (ratio !== null) ratios.push(ratio);
    if (sig && verdict === "REAL_UNHANDLED") {
      const cur = sigCount.get(sig) ?? { n: 0, ex: [] };
      cur.n++;
      if (cur.ex.length < 8) cur.ex.push(`${r.code}:${r.doc_id}`);
      sigCount.set(sig, cur);
    }
    appendFileSync(REPORT, JSON.stringify({ code: r.code, doc_id: r.doc_id, verdict, status, ratio, sig }) + "\n");
    appendFileSync(DONE, JSON.stringify({ code: r.code, verdict }) + "\n");
    processed++;
    if (processed % 50 === 0) {
      console.info(`[oseas-audit] ${processed}/${targets.length} ` + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
    }
    await sleep(180);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, targets.length || 1) }, () => worker()));

const sigSorted = [...sigCount.entries()].sort((a, b) => b[1].n - a[1].n);
writeFileSync(join(OUT, "signatures.txt"), sigSorted.map(([s, v]) => `[${v.n}] ex=${v.ex.join(",")}\n   ${s}`).join("\n\n"));

const okCount = tally["OK"] ?? 0;
const realUnhandled = tally["REAL_UNHANDLED"] ?? 0;
const coverage = okCount + realUnhandled > 0 ? ((okCount / (okCount + realUnhandled)) * 100).toFixed(1) : "n/a";
ratios.sort((a, b) => a - b);
const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;

console.info("\n[oseas-audit] 判定内訳:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.info(`  ${k}: ${v}`);
console.info(`\nok status 内訳: ${JSON.stringify(statusTally)}`);
console.info(`構造化カバレッジ (OK / (OK+取りこぼし)) = ${coverage}%  海外比率中央値=${median}%`);
console.info(`取りこぼし署名 TOP → tmp/oseas-audit/signatures.txt (${sigSorted.length} 種)`);
for (const [s, v] of sigSorted.slice(0, 12)) console.info(`  [${v.n}] ${s.slice(0, 110)}`);
