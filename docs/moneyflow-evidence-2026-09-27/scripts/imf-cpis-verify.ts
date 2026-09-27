/**
 * 一時検証スクリプト (このワークツリーにはコミットしない)。
 * imf-cpis.ts のパーサを、いま実際に取得した DBnomics API 応答に通し、
 * 原本 (公表サイト等) の数値と突き合わせる。
 */
import {
  parseImfCpisResponse,
  buildImfCpisSeriesCode,
  buildImfCpisUrl,
  isImfCpisPeriodPublished,
  latestImfCpisPeriod,
  IMF_CPIS_INDICATORS,
  IMF_CPIS_USER_AGENT,
  type ImfCpisRecord,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-14/services/moneyflow/lib/sources/imf-cpis.ts";

async function main() {
  // (1) 日本→米国, 日本→ケイマン, 日本→世界計 (Total), 米国→日本 (Liabilities, Derived),
  //     加えて 日本→米国の equity/debt 分解も同時取得して内部整合性を見る。
  const codes = [
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "US" }),
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "KY" }),
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "W00" }),
    buildImfCpisSeriesCode({ direction: "world_holds_jp", assetClass: "total", counterpartArea: "US" }),
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "equity", counterpartArea: "US" }),
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "debt", counterpartArea: "US" }),
    buildImfCpisSeriesCode({ direction: "world_holds_jp", assetClass: "equity", counterpartArea: "US" }),
    buildImfCpisSeriesCode({ direction: "world_holds_jp", assetClass: "debt", counterpartArea: "US" }),
    // 追加突合用: 中国 (CN) → 日本の資産, および 日本→フランス (FR)
    buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "FR" }),
    buildImfCpisSeriesCode({ direction: "world_holds_jp", assetClass: "total", counterpartArea: "CN" }),
  ];
  const url = buildImfCpisUrl(codes);
  console.log("### fetch url:", url);

  const res = await fetch(url, {
    headers: { "User-Agent": IMF_CPIS_USER_AGENT, Accept: "application/json" },
  });
  console.log("### http status:", res.status);
  const json = await res.json();

  const records: ImfCpisRecord[] = parseImfCpisResponse(json);
  console.log("### total records parsed:", records.length);

  const latest = latestImfCpisPeriod(records.map((r) => r.period));
  console.log("### latest period across fetched series:", latest);

  function show(direction: string, assetClass: string, area: string, period: string) {
    const r = records.find(
      (x) => x.direction === direction && x.assetClass === assetClass && x.counterpartArea === area && x.period === period
    );
    console.log(`${direction}/${assetClass}/${area}/${period} =`, r?.valueUsd, "seriesCode=", r?.seriesCode, "indicatorKey=", r?.indicatorKey);
    return r?.valueUsd;
  }

  console.log("\n--- 2024-S1 ---");
  const usTotal = show("jp_holds_abroad", "total", "US", "2024-S1");
  const kyTotal = show("jp_holds_abroad", "total", "KY", "2024-S1");
  const w00Total = show("jp_holds_abroad", "total", "W00", "2024-S1");
  const usLiabTotal = show("world_holds_jp", "total", "US", "2024-S1");
  const usEquity = show("jp_holds_abroad", "equity", "US", "2024-S1");
  const usDebt = show("jp_holds_abroad", "debt", "US", "2024-S1");
  const usLiabEquity = show("world_holds_jp", "equity", "US", "2024-S1");
  const usLiabDebt = show("world_holds_jp", "debt", "US", "2024-S1");
  const frTotal = show("jp_holds_abroad", "total", "FR", "2024-S1");
  const cnLiabTotal = show("world_holds_jp", "total", "CN", "2024-S1");

  console.log("\n--- internal consistency: equity+debt vs total ---");
  if (usEquity !== undefined && usDebt !== undefined && usTotal !== undefined) {
    console.log("jp_holds_abroad US equity+debt =", usEquity + usDebt, "vs total =", usTotal, "diff=", (usEquity + usDebt) - usTotal);
  }
  if (usLiabEquity !== undefined && usLiabDebt !== undefined && usLiabTotal !== undefined) {
    console.log("world_holds_jp US equity+debt =", usLiabEquity + usLiabDebt, "vs total =", usLiabTotal, "diff=", (usLiabEquity + usLiabDebt) - usLiabTotal);
  }

  console.log("\n--- all periods available (US total, jp_holds_abroad), last 6 ---");
  const usSeries = records
    .filter((r) => r.direction === "jp_holds_abroad" && r.assetClass === "total" && r.counterpartArea === "US")
    .sort((a, b) => a.period.localeCompare(b.period));
  console.log(usSeries.slice(-6).map((r) => [r.period, r.valueUsd]));

  console.log("\n--- isImfCpisPeriodPublished checks ---");
  console.log("2024-S1 published?", isImfCpisPeriodPublished(records, "2024-S1"));
  console.log("2025-S2 published?", isImfCpisPeriodPublished(records, "2025-S2"));
  console.log("2026-S1 published?", isImfCpisPeriodPublished(records, "2026-S1"));

  console.log("\n--- indicator defs (spot check labels) ---");
  for (const d of IMF_CPIS_INDICATORS) {
    console.log(d.key, "|", d.displayName);
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
