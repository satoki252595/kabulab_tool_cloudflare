import "dotenv/config";
// Notion アーカイブ索引ページ (BACKUP 直下「アーカイブ索引」) を確保・更新する。
// 内容の正本は src/shared/notion-archive/map.ts。配置変更時に再実行する。
// 実行: pnpm notion:update-index
import { ensureIndexPage } from "../../src/shared/notion-archive/index.js";

async function main() {
  const r = await ensureIndexPage();
  console.info(JSON.stringify(r));
}
main();
