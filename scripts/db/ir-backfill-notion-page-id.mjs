/**
 * 既存の ir_catalog.disclosures 行に対し、Notion 子DB上の page id
 * (`notion_page_id` 列) を埋め直す一回限り運用スクリプト。
 *
 * 経緯: ファイルプロキシ (`/ir-catalog/file/:tdnetId`) 実装で
 * notion_page_id 列を新設したが、それ以前に投入した ~12k 行には埋まって
 * いない。本スクリプトが Notion を列挙して (tdnet_id → page_id) を
 * 引いて Postgres を一括 UPDATE する。
 *
 * 走査:
 *   1. NOTION_BACKUP_PAGE_ID 配下の親「銘柄一覧｜ir-catalog」DB を取得
 *   2. 親DB の全行 (= 銘柄ページ) を page_size=100 でページング
 *   3. 各銘柄ページ配下の子 DB「適時開示｜<ticker>」を block children から探す
 *   4. その子DBを page_size=100 でページングし、各行から
 *      - properties["TDnet ID"].rich_text の plain_text 連結
 *      - page id
 *      を収集
 *   5. CHUNK 件ずつ Postgres を `UPDATE ... FROM (VALUES ...)` で一括反映
 *
 * 冪等: 同 tdnet_id に同 page_id を書き戻しても無害。中断しても再実行で
 * 残りを処理。Notion 通信は最小間隔 380ms (~2.6req/s) でレート制限を
 * 守る (notion-archive と同じ方針)。
 *
 * 使い方:
 *   node --env-file=.env scripts/db/ir-backfill-notion-page-id.mjs
 *
 * オプション (環境変数):
 *   IR_BACKFILL_DRY=1   実 UPDATE を打たず件数だけ出力
 */
import { neon } from "@neondatabase/serverless";

const TOK = process.env.NOTION_TOKEN;
const PARENT_PAGE = process.env.NOTION_BACKUP_PAGE_ID;
const DBURL = process.env.DATABASE_URL;
if (!TOK || !PARENT_PAGE || !DBURL) {
  throw new Error(
    "NOTION_TOKEN / NOTION_BACKUP_PAGE_ID / DATABASE_URL を .env で設定して下さい"
  );
}
const DRY = process.env.IR_BACKFILL_DRY === "1";

const sql = neon(DBURL);
const H = {
  Authorization: `Bearer ${TOK}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};
const MIN_INTERVAL = 380;
let lastStart = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gate() {
  const w = MIN_INTERVAL - (Date.now() - lastStart);
  if (w > 0) await sleep(w);
  lastStart = Date.now();
}
async function nreq(method, path, body) {
  await gate();
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: H,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if (res.status === 429) {
      const ra = Number(res.headers.get("Retry-After") ?? "1");
      await sleep((Number.isFinite(ra) ? ra : 1) * 1000 + 250);
      continue;
    }
    const text = await res.text().catch(() => "");
    // JSON エラーなら恒久 / 非JSON(エッジ遮断)なら一過性 (notion-archive と同方針)
    let isPermanent = false;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      try {
        const j = JSON.parse(text);
        if (j && (j.object === "error" || typeof j.code === "string"))
          isPermanent = true;
      } catch {
        /* 非JSON: 一過性として再試行 */
      }
    }
    if (isPermanent || attempt > 6) {
      throw new Error(`Notion ${method} ${path} status=${res.status} ${text.slice(0, 300)}`);
    }
    await sleep(Math.min(30_000, 500 * 2 ** attempt));
  }
}

async function findChildDb(parentId, title) {
  let cursor;
  for (;;) {
    const r = await nreq(
      "GET",
      `/blocks/${parentId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`
    );
    for (const b of r.results) {
      if (b.type === "child_database" && b.child_database?.title === title) {
        return b.id;
      }
    }
    if (!r.has_more) return null;
    cursor = r.next_cursor;
  }
}

async function* queryAll(dbId) {
  let cursor;
  for (;;) {
    const r = await nreq("POST", `/databases/${dbId}/query`, {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const p of r.results) yield p;
    if (!r.has_more) return;
    cursor = r.next_cursor;
  }
}

async function persistChunk(pairs) {
  if (pairs.length === 0) return;
  if (DRY) {
    console.log(`  [DRY] would UPDATE ${pairs.length} rows`);
    return;
  }
  // VALUES list 単発 UPDATE
  const values = pairs
    .map(([k, v]) => `('${k.replace(/'/g, "''")}','${v.replace(/'/g, "''")}')`)
    .join(",");
  await sql.query(
    `UPDATE ir_catalog.disclosures AS d
       SET notion_page_id = v.page_id
       FROM (VALUES ${values}) AS v(tdnet_id, page_id)
       WHERE d.tdnet_id = v.tdnet_id`
  );
}

async function main() {
  console.log(`[ir-backfill-page-id] DRY=${DRY ? "yes" : "no"} 開始`);
  const parentDb = await findChildDb(PARENT_PAGE, "銘柄一覧｜ir-catalog");
  if (!parentDb) {
    console.error("親DB 銘柄一覧｜ir-catalog が見つかりません");
    process.exit(1);
  }
  console.log("親DB id =", parentDb);

  // 1. 銘柄ページ一覧 (ticker + page_id) を全取得
  const stocks = [];
  for await (const sp of queryAll(parentDb)) {
    const ticker =
      (sp.properties?.銘柄コード?.title ?? [])
        .map((t) => t.plain_text)
        .join("") || null;
    if (ticker) stocks.push({ ticker, pageId: sp.id });
  }
  console.log("銘柄ページ件数 =", stocks.length);

  // 2. 銘柄ごとに子DB → 行を列挙、(tdnet_id, row page_id) を Postgres に
  //    UPDATE。CHUNK 件貯まる度にフラッシュ。
  const CHUNK = 200;
  let buf = [];
  let totalCollected = 0;
  let stocksScanned = 0;
  let stocksWithoutChildDb = 0;
  const t0 = Date.now();
  for (const { ticker, pageId } of stocks) {
    stocksScanned++;
    const childTitle = `適時開示｜${ticker}`;
    const childDb = await findChildDb(pageId, childTitle);
    if (!childDb) {
      stocksWithoutChildDb++;
      continue;
    }
    for await (const row of queryAll(childDb)) {
      const tid = (row.properties?.["TDnet ID"]?.rich_text ?? [])
        .map((t) => t.plain_text)
        .join("");
      if (!tid) continue;
      buf.push([tid, row.id]);
      totalCollected++;
      if (buf.length >= CHUNK) {
        await persistChunk(buf);
        buf = [];
      }
    }
    if (stocksScanned % 100 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `  [進捗] ${stocksScanned}/${stocks.length} 銘柄走査 / 収集 ${totalCollected} 件 / ${elapsed}s`
      );
    }
  }
  await persistChunk(buf);
  buf = [];

  console.log(
    `\n完了: 銘柄=${stocksScanned} 子DB無=${stocksWithoutChildDb} 反映=${totalCollected} 経過=${((Date.now() - t0) / 1000).toFixed(0)}s`
  );
  if (!DRY) {
    const stat = await sql.query(
      "SELECT count(*) FILTER (WHERE notion_page_id IS NOT NULL)::int AS filled, count(*)::int AS total FROM ir_catalog.disclosures"
    );
    console.log(
      `Postgres 状況: notion_page_id 充足 = ${stat[0].filled} / ${stat[0].total}`
    );
  }
}

main().catch((e) => {
  console.error("[ir-backfill-page-id] 致命的エラー:", e);
  process.exit(1);
});
