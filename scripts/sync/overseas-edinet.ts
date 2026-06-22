// 海外売上高(EDINET 有報) キャッチアップ — Worker 取込ルートを叩く薄いトリガ。
//
// 005 yuho-quant と同型。D1 はバインディング経由のみのため、取込は Worker 上で
// 実行する。本 CLI はデプロイ済み Worker の認証ルート
// (POST /overseas-sales/admin/catchup) を叩くだけ。shard 指定は `--part=0 --of=8`。
//
// 必要env(.env): WORKER_BASE_URL, CRON_SECRET
import "dotenv/config";

function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}

async function main(): Promise<void> {
  const base = process.env.WORKER_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error("WORKER_BASE_URL が設定されていません (.env)");
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");

  const u = new URL(`${base.replace(/\/$/, "")}/overseas-sales/admin/catchup`);
  const part = arg("part");
  const of = arg("of");
  if (part !== undefined) u.searchParams.set("part", part);
  if (of !== undefined) u.searchParams.set("of", of);

  const res = await fetch(u, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`catchup 失敗: HTTP ${res.status} ${body}`);
  }
  console.info("[overseas-edinet]", body);
}

main().catch((e) => {
  console.error("[overseas-edinet] エラー:", e);
  process.exit(1);
});
