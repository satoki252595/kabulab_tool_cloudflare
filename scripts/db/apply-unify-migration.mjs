/**
 * public.stocks → core.stocks 統一マイグレーションを Neon に適用する。
 *
 * Neon HTTP driver は BEGIN/COMMIT や DO $$ ... $$ などの複合文を 1 回の
 * query で送れないため、各ステップを個別に実行して途中で検証を入れる。
 *
 * 中断時のリカバリ: 各 ALTER は冪等に書いているため、途中で失敗しても
 * 再実行で続きから適用できるようにしている。
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = neon(url);

async function run(stmt, descr) {
  const preview = (descr ?? stmt).replace(/\s+/g, " ").slice(0, 100);
  try {
    await sql.query(stmt);
    console.log(`  OK: ${preview}`);
  } catch (e) {
    console.error(`  FAIL: ${preview}`);
    console.error(`    ${e.message}`);
    throw e;
  }
}

async function count(stmt) {
  const r = await sql.query(stmt);
  return Number(r[0].cnt ?? r[0].count ?? 0);
}

console.log("=== public.stock_financials ===");
// 1) new_stock_id 列を追加 (既存なら skip)
await run(`ALTER TABLE public.stock_financials ADD COLUMN IF NOT EXISTS new_stock_id integer`);
// 2) code マッピングで埋める
await run(
  `UPDATE public.stock_financials sf
     SET new_stock_id = cs.id
     FROM public.stocks ps, core.stocks cs
    WHERE sf.stock_id = ps.id AND ps.code = cs.code AND sf.new_stock_id IS NULL`,
  "UPDATE public.stock_financials set new_stock_id"
);
// 3) マッピング失敗の検証
{
  const missing = await count(
    `SELECT COUNT(*)::int AS cnt FROM public.stock_financials WHERE new_stock_id IS NULL`
  );
  if (missing > 0) throw new Error(`public.stock_financials: new_stock_id NULL が ${missing} 件`);
  console.log(`  VERIFY: new_stock_id 100% populated`);
}
// 4) 旧 FK / unique を drop
await run(
  `ALTER TABLE public.stock_financials DROP CONSTRAINT IF EXISTS stock_financials_stock_id_stocks_id_fk`
);
await run(
  `ALTER TABLE public.stock_financials DROP CONSTRAINT IF EXISTS stock_financials_stock_id_unique`
);
await run(`DROP INDEX IF EXISTS public.stock_financials_stock_id_unique`);
// 5) stock_id 列を付け替え
await run(`ALTER TABLE public.stock_financials DROP COLUMN IF EXISTS stock_id`);
await run(
  `ALTER TABLE public.stock_financials RENAME COLUMN new_stock_id TO stock_id`
);
await run(
  `ALTER TABLE public.stock_financials ALTER COLUMN stock_id SET NOT NULL`
);
await run(
  `ALTER TABLE public.stock_financials ADD CONSTRAINT stock_financials_stock_id_core_fk FOREIGN KEY (stock_id) REFERENCES core.stocks(id)`
);
await run(
  `ALTER TABLE public.stock_financials ADD CONSTRAINT stock_financials_stock_id_unique UNIQUE (stock_id)`
);

console.log("\n=== public.stock_scores ===");
await run(`ALTER TABLE public.stock_scores ADD COLUMN IF NOT EXISTS new_stock_id integer`);
await run(
  `UPDATE public.stock_scores ss
     SET new_stock_id = cs.id
     FROM public.stocks ps, core.stocks cs
    WHERE ss.stock_id = ps.id AND ps.code = cs.code AND ss.new_stock_id IS NULL`,
  "UPDATE public.stock_scores set new_stock_id"
);
{
  const missing = await count(
    `SELECT COUNT(*)::int AS cnt FROM public.stock_scores WHERE new_stock_id IS NULL`
  );
  if (missing > 0) throw new Error(`public.stock_scores: new_stock_id NULL が ${missing} 件`);
  console.log(`  VERIFY: new_stock_id 100% populated`);
}
await run(
  `ALTER TABLE public.stock_scores DROP CONSTRAINT IF EXISTS stock_scores_stock_id_stocks_id_fk`
);
await run(
  `ALTER TABLE public.stock_scores DROP CONSTRAINT IF EXISTS stock_scores_stock_id_unique`
);
await run(`DROP INDEX IF EXISTS public.stock_scores_stock_id_unique`);
await run(`ALTER TABLE public.stock_scores DROP COLUMN IF EXISTS stock_id`);
await run(`ALTER TABLE public.stock_scores RENAME COLUMN new_stock_id TO stock_id`);
await run(`ALTER TABLE public.stock_scores ALTER COLUMN stock_id SET NOT NULL`);
await run(
  `ALTER TABLE public.stock_scores ADD CONSTRAINT stock_scores_stock_id_core_fk FOREIGN KEY (stock_id) REFERENCES core.stocks(id)`
);
await run(
  `ALTER TABLE public.stock_scores ADD CONSTRAINT stock_scores_stock_id_unique UNIQUE (stock_id)`
);

console.log("\n=== public.yutai_benefits ===");
await run(`ALTER TABLE public.yutai_benefits ADD COLUMN IF NOT EXISTS new_stock_id integer`);
await run(
  `UPDATE public.yutai_benefits yb
     SET new_stock_id = cs.id
     FROM public.stocks ps, core.stocks cs
    WHERE yb.stock_id = ps.id AND ps.code = cs.code AND yb.new_stock_id IS NULL`,
  "UPDATE public.yutai_benefits set new_stock_id"
);
{
  const missing = await count(
    `SELECT COUNT(*)::int AS cnt FROM public.yutai_benefits WHERE new_stock_id IS NULL`
  );
  if (missing > 0) throw new Error(`public.yutai_benefits: new_stock_id NULL が ${missing} 件`);
  console.log(`  VERIFY: new_stock_id 100% populated`);
}
await run(
  `ALTER TABLE public.yutai_benefits DROP CONSTRAINT IF EXISTS yutai_benefits_stock_id_stocks_id_fk`
);
await run(`DROP INDEX IF EXISTS public.idx_yutai_benefits_stock_id`);
await run(`ALTER TABLE public.yutai_benefits DROP COLUMN IF EXISTS stock_id`);
await run(`ALTER TABLE public.yutai_benefits RENAME COLUMN new_stock_id TO stock_id`);
await run(`ALTER TABLE public.yutai_benefits ALTER COLUMN stock_id SET NOT NULL`);
await run(
  `ALTER TABLE public.yutai_benefits ADD CONSTRAINT yutai_benefits_stock_id_core_fk FOREIGN KEY (stock_id) REFERENCES core.stocks(id)`
);
await run(
  `CREATE INDEX IF NOT EXISTS idx_yutai_benefits_stock_id ON public.yutai_benefits(stock_id)`
);

console.log("\n=== final DROP public.stocks ===");
await run(`DROP TABLE public.stocks`);

console.log("\nDone.");
