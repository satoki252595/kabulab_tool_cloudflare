/**
 * 調査フェーズ第2弾: iXBRL (type=1 ZIP) 内の HTML で 受注高/受注残高 が
 * どんな <table> 構造で開示されているかを精査する (一回限り)。
 *
 * CSV(type=5) はテキストブロックを平坦テキスト化してセル境界を失うため、
 * セグメント別の受注高/受注残高を確実に取るには iXBRL の表構造が要る。
 *
 * 出力: tmp/yuho-quant-investigation/ixbrl/<ticker>-<docID>-<n>.html
 *        受注高/受注残高 を含む <table> を前後文脈ごと切り出して保存。
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { downloadDocument } from "../src/services/edinet/client.js";
import { unzip } from "../src/services/edinet/zip.js";

const OUT = join(process.cwd(), "tmp", "yuho-quant-investigation", "ixbrl");

// 受注高/受注残高 を確実に開示する企業 (建設=建築/土木別, 重工=セグメント別)
const TARGETS: Array<{ ticker: string; docID: string }> = [
  { ticker: "1803", docID: "S100W7C5" }, // 清水建設 (建設)
  { ticker: "1812", docID: "S100W14C" }, // 鹿島建設 (建設)
  { ticker: "7012", docID: "S100VWDC" }, // 川崎重工 (重工)
  { ticker: "7013", docID: "S100W1K1" }, // IHI (重工)
  { ticker: "7011", docID: "S100W6XE" }, // 三菱重工 (重工)
  { ticker: "6501", docID: "S100W56G" }, // 日立 (電機)
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTML から 受注高|受注残高 を含む <table>...</table> を粗く切り出す */
function extractOrderTables(html: string): string[] {
  const out: string[] = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/受注高|受注残高|受注実績|受注工事高|繰越工事高/.test(m[0])) {
      out.push(m[0]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const { ticker, docID } of TARGETS) {
    console.info(`[investigate2] ${ticker} docID=${docID} type=1 取得`);
    const zip = await downloadDocument(docID, 1);
    const entries = unzip(zip);
    const htmlNames = [...entries.keys()].filter(
      (n) =>
        /PublicDoc\//i.test(n) && (n.endsWith(".htm") || n.endsWith(".html"))
    );
    let n = 0;
    let totalTables = 0;
    for (const name of htmlNames) {
      const html = entries.get(name)!.toString("utf8");
      const tables = extractOrderTables(html);
      for (const t of tables) {
        writeFileSync(
          join(OUT, `${ticker}-${docID}-${n}.html`),
          `<!-- src=${name} -->\n${t}`
        );
        n++;
        totalTables++;
      }
    }
    console.info(
      `  htmlファイル ${htmlNames.length} 件, 受注表 ${totalTables} 件抽出`
    );
    await sleep(400);
  }
  console.info(`\n出力: ${OUT}`);
}

main().catch((e) => {
  console.error("[investigate2] エラー:", e);
  process.exit(1);
});
