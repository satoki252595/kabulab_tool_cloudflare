/**
 * 受注高/受注残高 の「非構造化データ」実地調査スクリプト (一回限り・cron 非対象)。
 *
 * 目的: パーサを書く前に、実際の有価証券報告書を EDINET からローカルに落とし、
 *       受注高/受注残高 が XBRL のどの要素・どんな HTML 表で開示されているかを
 *       入念に調べる (ユーザ指示: ローカルに対比させた非構造化データを精査)。
 *
 * 出力先: tmp/yuho-quant-investigation/ (.gitignore 済 — コミットされない)
 *   - raw/<ticker>-<docID>.zip        … 取得した CSV ZIP の原本
 *   - rows/<ticker>-<docID>.txt       … 受注を含む全行 (要素ID/項目名/文脈/単位)
 *   - blocks/<ticker>-<docID>-<n>.html… 受注を含むテキストブロックの HTML 原文
 *   - findings.json                   … 全社横断サマリ (要素ID 頻度・パターン)
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/investigate.ts
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { listDocuments } from "../src/services/edinet/client.js";
import { downloadDocument } from "../src/services/edinet/client.js";
import {
  isAnnualSecuritiesReport,
  secCodeToTicker,
} from "../src/services/edinet/types.js";
import { parseEdinetCsvZip } from "../src/services/edinet/csv.js";

// 受注生産型 (機械/重工/建設/電機/プラント) を中心に多様な開示パターンを収集
const TARGET_TICKERS = new Set([
  "7011", "7012", "7013", "7003", "7004", "7014", // 重工・造船
  "6301", "6326", "6361", "6367", "6383", "6273", // 機械
  "6501", "6502", "6503", "6504", "6701", "6702", "6841", "6845", // 電機/計装
  "1801", "1802", "1803", "1808", "1812", "1925", // 建設
  "5631", "6103", "6113", "6268", "6324", // 工作機械等
]);

const OUT_DIR = join(process.cwd(), "tmp", "yuho-quant-investigation");
const RX_ORDER = /受注/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function* dateRange(startISO: string, endISO: string): Generator<string> {
  const d = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

async function main(): Promise<void> {
  mkdirSync(join(OUT_DIR, "raw"), { recursive: true });
  mkdirSync(join(OUT_DIR, "rows"), { recursive: true });
  mkdirSync(join(OUT_DIR, "blocks"), { recursive: true });

  // 3 月決算企業の有報提出ピーク (FY2025/03 → 2025 年 6 月)
  const SCAN_START = "2025-06-13";
  const SCAN_END = "2025-07-01";

  const elementFreq = new Map<string, { itemName: string; count: number }>();
  const collected: Array<{
    ticker: string;
    filer: string | null;
    docID: string;
    period: string;
    orderElements: Array<{
      elementId: string;
      itemName: string;
      contextId: string;
      unit: string;
      valueLen: number;
      isHtml: boolean;
    }>;
  }> = [];
  const seenTickers = new Set<string>();

  for (const date of dateRange(SCAN_START, SCAN_END)) {
    const list = await listDocuments(date);
    const targets = list.results.filter((d) => {
      if (!isAnnualSecuritiesReport(d)) return false;
      const t = secCodeToTicker(d.secCode);
      return t !== null && TARGET_TICKERS.has(t) && !seenTickers.has(t);
    });
    console.info(
      `[investigate] ${date}: 全 ${list.results.length} 件, 対象有報 ${targets.length} 件`
    );

    for (const doc of targets) {
      const ticker = secCodeToTicker(doc.secCode)!;
      seenTickers.add(ticker);
      console.info(
        `  → ${ticker} ${doc.filerName} docID=${doc.docID} (${doc.periodStart}〜${doc.periodEnd})`
      );
      await sleep(300);

      const zip = await downloadDocument(doc.docID, 5);
      writeFileSync(join(OUT_DIR, "raw", `${ticker}-${doc.docID}.zip`), zip);

      const rows = parseEdinetCsvZip(zip);
      const orderRows = rows.filter(
        (r) => RX_ORDER.test(r.itemName) || RX_ORDER.test(r.value)
      );

      const rowLines = orderRows.map(
        (r) =>
          `[${r.elementId}] "${r.itemName}" ctx=${r.contextId} rel=${r.relativeYear} ` +
          `${r.consolidatedOrNonConsolidated} unit=${r.unit} valueLen=${r.value.length} ` +
          `head=${r.value.slice(0, 120).replace(/\n/g, " ")}`
      );
      writeFileSync(
        join(OUT_DIR, "rows", `${ticker}-${doc.docID}.txt`),
        `# ${ticker} ${doc.filerName}\n# docID=${doc.docID} period=${doc.periodStart}〜${doc.periodEnd}\n` +
          `# 受注関連行: ${orderRows.length} / 全 ${rows.length} 行\n\n` +
          rowLines.join("\n")
      );

      let blockN = 0;
      for (const r of orderRows) {
        const isHtml = /<[a-z]/i.test(r.value);
        if (isHtml && r.value.length > 200) {
          writeFileSync(
            join(OUT_DIR, "blocks", `${ticker}-${doc.docID}-${blockN}.html`),
            `<!-- elementId=${r.elementId} itemName=${r.itemName} ctx=${r.contextId} -->\n${r.value}`
          );
          blockN++;
        }
        const key = r.elementId;
        const cur = elementFreq.get(key);
        if (cur) cur.count++;
        else elementFreq.set(key, { itemName: r.itemName, count: 1 });
      }

      collected.push({
        ticker,
        filer: doc.filerName,
        docID: doc.docID,
        period: `${doc.periodStart}〜${doc.periodEnd}`,
        orderElements: orderRows.map((r) => ({
          elementId: r.elementId,
          itemName: r.itemName,
          contextId: r.contextId,
          unit: r.unit,
          valueLen: r.value.length,
          isHtml: /<[a-z]/i.test(r.value),
        })),
      });
    }
    await sleep(250);
  }

  const freqSorted = [...elementFreq.entries()]
    .map(([elementId, v]) => ({ elementId, ...v }))
    .sort((a, b) => b.count - a.count);

  writeFileSync(
    join(OUT_DIR, "findings.json"),
    JSON.stringify(
      { scanned: `${SCAN_START}〜${SCAN_END}`, elementFreq: freqSorted, collected },
      null,
      2
    )
  );

  console.info(
    `\n[investigate] 完了: ${collected.length} 社, ユニーク要素 ${freqSorted.length} 種`
  );
  console.info("受注関連 要素ID 頻度 TOP20:");
  for (const f of freqSorted.slice(0, 20)) {
    console.info(`  ${f.count.toString().padStart(3)}  ${f.elementId}  「${f.itemName}」`);
  }
  console.info(`\n出力: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("[investigate] エラー:", e);
  process.exit(1);
});
