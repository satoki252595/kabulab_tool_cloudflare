async function main() {
  const res = await fetch("https://minkabu.jp/stock/2702/yutai", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  const html = await res.text();

  // 権利月
  const monthPatterns = [
    /優待権利確定月<\/th>\s*<td[^>]*>([^<]+)/i,
    /優待権利確定月：<span[^>]*>([^<]+)/i,
  ];
  for (const pat of monthPatterns) {
    const m = html.match(pat);
    if (m) { console.log("Month:", m[1]); break; }
  }

  // テーブル
  const tableMatch = html.match(/<table[^>]*class="md_table vborder"[^>]*>([\s\S]*?)<\/table>/i)
    ?? html.match(/<table[^>]*class="md_table"[^>]*>([\s\S]*?)<\/table>/i);
  if (tableMatch) {
    const rows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<br\s*\/?>/gi, " | ").replace(/<[^>]*>/g, "").trim());
      if (cells[0]?.includes("株")) {
        console.log(`  ${cells[0]} → ${cells[1]?.substring(0, 80)}`);
      }
    }
  }
}
main();
