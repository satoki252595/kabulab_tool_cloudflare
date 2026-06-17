/**
 * 優待データ検証スクリプト
 * 主要銘柄のデータを公知情報と突き合わせて検証する
 */

const API = "https://kabulab.vercel.app/api";

// 検証用の正解データ（公式IR・複数サイトで確認済みの情報）
const EXPECTED = [
  {
    code: "2702",
    name: "日本マクドナルドホールディングス",
    months: [6, 12],
    sharesTiers: [100, 300, 500],
    keyContent: "バーガー類",
  },
  {
    code: "3197",
    name: "すかいらーくホールディングス",
    months: [6, 12],
    sharesTiers: [100, 300, 500, 1000],
    keyContent: "カード" , // 優待カード
  },
  {
    code: "9202",
    name: "ＡＮＡホールディングス",
    months: [3, 9],
    sharesTiers: [100, 200, 300, 400],
    keyContent: "割引",
  },
  {
    code: "9020",
    name: "東日本旅客鉄道",
    months: [3],
    sharesTiers: [100],
    keyContent: "割引",
  },
  {
    code: "8267",
    name: "イオン",
    months: [2, 8],
    sharesTiers: [100, 500, 1000, 3000],
    keyContent: "キャッシュバック",
  },
  {
    code: "2897",
    name: "日清食品ホールディングス",
    months: [3, 9],
    sharesTiers: [100, 300, 500, 1000, 3000],
    keyContent: "製品",
  },
  {
    code: "9861",
    name: "吉野家ホールディングス",
    months: [2, 8],
    sharesTiers: [100, 200, 1000, 2000],
    keyContent: "サービス券",
  },
  {
    code: "4661",
    name: "オリエンタルランド",
    months: [3, 9],
    sharesTiers: [100, 400, 800, 1200, 1600, 2400],
    keyContent: "パスポート",
  },
  {
    code: "7412",
    name: "アトム",
    months: [3, 9],
    sharesTiers: [100, 500, 1000],
    keyContent: "ポイント",
  },
  {
    code: "3543",
    name: "コメダホールディングス",
    months: [2, 8],
    sharesTiers: [100, 300, 500, 1000],
    keyContent: "KOMECA",
  },
];

type Benefit = {
  recordMonth: number;
  minShares: number;
  description: string;
  genre: { name: string; slug: string } | null;
};

type StockDetail = {
  code: string;
  name: string;
  benefits: Benefit[];
  error?: string;
};

async function verify() {
  console.log("🔍 優待データの正確性検証を開始します\n");
  console.log("=" .repeat(70));

  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  const issues: string[] = [];

  for (const expected of EXPECTED) {
    console.log(`\n📋 ${expected.name} (${expected.code})`);
    console.log("-".repeat(60));

    try {
      const res = await fetch(`${API}/stocks/${expected.code}`);
      const data: StockDetail = await res.json();

      if (data.error) {
        console.log(`  ❌ API error: ${data.error}`);
        issues.push(`${expected.code}: APIエラー`);
        failedChecks++;
        continue;
      }

      // 1. 銘柄名チェック
      totalChecks++;
      const nameOk = data.name.includes(expected.name.substring(0, 4)) ||
                       expected.name.includes(data.name.substring(0, 4));
      if (nameOk) {
        console.log(`  ✅ 名前: ${data.name}`);
        passedChecks++;
      } else {
        console.log(`  ❌ 名前: ${data.name} (期待: ${expected.name})`);
        issues.push(`${expected.code}: 名前不一致 「${data.name}」≠「${expected.name}」`);
        failedChecks++;
      }

      // 2. 権利月チェック
      totalChecks++;
      const actualMonths = [...new Set(data.benefits.map(b => b.recordMonth))].sort((a, b) => a - b);
      const monthsMatch = JSON.stringify(actualMonths) === JSON.stringify(expected.months);
      if (monthsMatch) {
        console.log(`  ✅ 権利月: ${actualMonths.join("月, ")}月`);
        passedChecks++;
      } else {
        console.log(`  ❌ 権利月: ${actualMonths.join("月, ")}月 (期待: ${expected.months.join("月, ")}月)`);
        issues.push(`${expected.code} ${data.name}: 権利月不一致 [${actualMonths}] ≠ [${expected.months}]`);
        failedChecks++;
      }

      // 3. 株数条件チェック
      totalChecks++;
      const actualShares = [...new Set(data.benefits.map(b => b.minShares))].sort((a, b) => a - b);
      // 少なくとも期待する株数の一部が含まれているか
      const sharesOverlap = expected.sharesTiers.filter(s => actualShares.includes(s));
      const sharesOk = sharesOverlap.length >= Math.min(2, expected.sharesTiers.length);
      if (sharesOk) {
        console.log(`  ✅ 株数条件: ${actualShares.join(", ")}株`);
        passedChecks++;
      } else {
        console.log(`  ❌ 株数条件: ${actualShares.join(", ")}株 (期待: ${expected.sharesTiers.join(", ")}株)`);
        issues.push(`${expected.code} ${data.name}: 株数条件不一致 [${actualShares}] ≠ [${expected.sharesTiers}]`);
        failedChecks++;
      }

      // 4. 優待内容にキーワードが含まれるか
      totalChecks++;
      const allDesc = data.benefits.map(b => b.description).join(" ");
      const contentOk = allDesc.includes(expected.keyContent);
      if (contentOk) {
        console.log(`  ✅ 内容: 「${expected.keyContent}」を含む`);
        passedChecks++;
      } else {
        console.log(`  ❌ 内容: 「${expected.keyContent}」が見つからない`);
        console.log(`    実際: ${data.benefits[0]?.description.substring(0, 100)}`);
        issues.push(`${expected.code} ${data.name}: キーワード「${expected.keyContent}」なし`);
        failedChecks++;
      }

      // 5. 優待レコード数の妥当性
      const expectedCount = expected.months.length * expected.sharesTiers.length;
      const actualCount = data.benefits.length;
      console.log(`  📊 レコード数: ${actualCount}件 (期待: ${expectedCount}件)`);

    } catch (e) {
      console.log(`  ❌ 取得失敗:`, e instanceof Error ? e.message : e);
      issues.push(`${expected.code}: 取得失敗`);
      failedChecks++;
      totalChecks++;
    }
  }

  // 全体統計
  console.log("\n" + "=".repeat(70));
  console.log("📊 検証結果サマリー");
  console.log("=".repeat(70));
  console.log(`  合計チェック: ${totalChecks}`);
  console.log(`  ✅ PASS: ${passedChecks}`);
  console.log(`  ❌ FAIL: ${failedChecks}`);
  console.log(`  合格率: ${((passedChecks / totalChecks) * 100).toFixed(1)}%`);

  if (issues.length > 0) {
    console.log("\n⚠️  問題一覧:");
    for (const issue of issues) {
      console.log(`  - ${issue}`);
    }
  } else {
    console.log("\n🎉 全チェックPASS!");
  }

  // ランダムサンプル20件の基本チェック
  console.log("\n\n📋 ランダムサンプル検証 (20銘柄)");
  console.log("-".repeat(60));

  const stocksRes = await fetch(`${API}/stocks?limit=100`);
  const stocksData = await stocksRes.json() as { stocks: any[]; total: number };

  // ランダムに20件選択
  const shuffled = stocksData.stocks.sort(() => Math.random() - 0.5).slice(0, 20);
  let sampleIssues = 0;

  for (const s of shuffled) {
    const detailRes = await fetch(`${API}/stocks/${s.code}`);
    const detail: StockDetail = await detailRes.json();

    if (detail.error) {
      console.log(`  ❌ ${s.code}: APIエラー`);
      sampleIssues++;
      continue;
    }

    const problems: string[] = [];

    // 名前が「銘柄XXXX」でないか
    if (detail.name.startsWith("銘柄")) problems.push("名前未修正");

    // 権利月が1-12の範囲か
    const months = [...new Set(detail.benefits.map(b => b.recordMonth))];
    if (months.some(m => m < 1 || m > 12)) problems.push("権利月異常");
    if (months.length === 0) problems.push("権利月なし");

    // 株数が正の数か
    const shares = [...new Set(detail.benefits.map(b => b.minShares))];
    if (shares.some(s => s <= 0)) problems.push("株数異常");

    // 説明が空でないか
    if (detail.benefits.some(b => !b.description || b.description === "株主優待")) problems.push("説明不足");

    if (problems.length > 0) {
      console.log(`  ❌ ${detail.name} (${s.code}): ${problems.join(", ")}`);
      sampleIssues++;
    } else {
      console.log(`  ✅ ${detail.name} (${s.code}): ${months.map(m=>m+"月").join(",")} / ${shares.join(",")}株`);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nサンプル結果: ${20 - sampleIssues}/20 OK`);
}

verify().catch(e => { console.error(e); process.exit(1); });
