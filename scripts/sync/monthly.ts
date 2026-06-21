/**
 * 月次 rebuild トリガ (CLI) — ADR-0001 Phase 3。
 *
 * 実体の再構築 (otakara_stock_financials / otakara_stock_scores を core_/swing_ から
 * 再生成) は Worker 上で実行する。本スクリプトは認証付きルート
 * POST /admin/sync-monthly を叩く薄いトリガ。通常運用は Workers Cron が毎月 1 日に
 * 自動発火する。
 *
 * 前提順序: 母集団 `pnpm sync:universe` → 優待スクレイプ/解釈 (data-scripts) →
 * 日次 sync (swing 指標) → 本 rebuild。is_yutai は rebuild 内で yutai_benefits から
 * 再導出される。
 *
 * 実行: pnpm sync:monthly
 */

import "dotenv/config";

async function main(): Promise<void> {
  const base = process.env.WORKER_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error("WORKER_BASE_URL が設定されていません (.env)");
  if (!secret) throw new Error("CRON_SECRET が設定されていません (.env)");

  const url = `${base.replace(/\/$/, "")}/admin/sync-monthly`;
  console.info(`[sync-monthly] POST ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  console.info("[sync-monthly] 完了:", body);
}

main().catch((e) => {
  console.error("[sync-monthly] エラー:", e);
  process.exit(1);
});
