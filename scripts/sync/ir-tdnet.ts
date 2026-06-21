// TDnet 適時開示キャッチアップ — Worker 取込ルートを叩く薄いトリガ（ADR-0001）。
//
// D1 はバインディング経由でのみアクセスできるため取込は Worker 上で実行する。
// 本 CLI はデプロイ済み Worker の認証付きルート (POST /ir-catalog/admin/catchup)
// を叩くだけ。
//
// 必要env(.env): WORKER_BASE_URL（例 https://kabulab-cf.<sub>.workers.dev）, CRON_SECRET
import "dotenv/config";

async function main(): Promise<void> {
  const base = process.env.WORKER_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error("WORKER_BASE_URL が設定されていません (.env)");
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");

  const res = await fetch(`${base.replace(/\/$/, "")}/ir-catalog/admin/catchup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`catchup 失敗: HTTP ${res.status} ${body}`);
  console.info("[ir-tdnet]", body);
}

main().catch((e) => {
  console.error("[ir-tdnet] エラー:", e);
  process.exit(1);
});
