/**
 * `createD1HttpDb` (drizzle sqlite-proxy / D1 REST) の **batch 境界**ガード。
 *
 * `createD1HttpDb` は `drizzle(callback, { schema })` の形で呼んでおり、
 * sqlite-proxy の第 2 引数 (batch callback) を渡していない。そのため
 * `db.batch()` は実行時に `TypeError: this.batchCLient is not a function` で
 * 落ちる (session が `this.batchCLient(...)` を直呼びする)。
 *
 * **型では捕まらない。** Node 側の取込スクリプトは `createD1HttpDb(...)` を
 * `as unknown as Database` (= D1 バインディング版) へキャストして
 * サービス共通の ingest 関数へ渡すのが定型で、その `Database` は `batch` を
 * 持つ。つまり「batch を使う ingest 関数を sqlite-proxy 経由で呼ぶ」誤配線は
 * tsc も eslint も緑にする。
 *
 * 壊れ方が悪いのは、`db.batch()` を使う ingest が **batch の手前で
 * 親行 (yuho_documents) をコミットしている**こと。落ちた時点で
 * 「parse_status は ok_* なのに facts が 0 件」の行が本番 D1 に残り、
 * 次回実行は既存 docId として `skipped_existing` になるので二度と埋まらない
 * (CLAUDE.md ルール2 の「黙って壊れる」)。
 *
 * そこで 2 つを機械的に見る:
 *   1. sqlite-proxy を createD1HttpDb と同じ形で組むと `db.batch()` が
 *      本当に落ちること (前提そのもの。drizzle 側や createD1HttpDb が
 *      batch 対応になったらここが落ちるので、その時はこのガードを畳む)
 *   2. `createD1HttpDb` を使う Node スクリプトが batch 依存の ingest 関数を
 *      呼ぶなら、**書き込みの前に fail-fast すること**
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { sqliteTable, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** コメントを除いた実コード。説明文の `db.batch()` を実装と数えないため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * `db.batch()` を内部で使う ingest 関数。**定義側に `db.batch(` が実在するか**も
 * 併せて検査するので、実装が per-statement 化されたらこの表が黙って古くなる
 * ことはない (その時はここから外し、呼び出し側の fail-fast も畳める)。
 */
const BATCH_DEPENDENT_INGEST = [
  {
    fn: "ingestDocument",
    definedIn: "services/yuho-quant/src/services/ingest.ts",
  },
] as const;

/**
 * fail-fast の形。`assert...Supported()` の**呼び出し**を探す。
 *
 * 「ファイルのどこかに throw がある」では不足で、**ingest の呼び出しより手前**に
 * 無ければ意味がない (親行のコミット後に落ちるのが問題なので)。位置も見る。
 *
 * Worker 側 (`c.env.DB` バインディング) は本物の `batch` を持つので対象外。
 * 対象は Node 実行 (tsx) のスクリプトだけ。
 */
const FAIL_FAST_CALL = /\bassert\w*Supported\s*\(\s*\)\s*;/;

describe("createD1HttpDb の batch 境界", () => {
  it("createD1HttpDb と同じ組み方の sqlite-proxy は db.batch() で落ちる", async () => {
    // createD1HttpDb は drizzle(callback, { schema }) — batch callback を渡さない。
    const t = sqliteTable("t", { id: integer("id").primaryKey() });
    const db = drizzle(async () => ({ rows: [] }), { schema: { t } });
    await expect(
      (db as unknown as { batch: (q: unknown[]) => Promise<unknown> }).batch([
        db.delete(t).where(eq(t.id, 1)),
      ])
    ).rejects.toThrow(/batchCLient|batch/i);
  });

  it.each(BATCH_DEPENDENT_INGEST)(
    "$fn の定義は今も db.batch() を使っている (表が古くなっていない)",
    ({ definedIn }) => {
      const path = join(ROOT, definedIn);
      expect(existsSync(path), `${definedIn} が無い`).toBe(true);
      expect(stripComments(readFileSync(path, "utf-8"))).toMatch(/db\.batch\(/);
    }
  );

  it("createD1HttpDb 経由で batch 依存の ingest を呼ぶスクリプトは fail-fast する", () => {
    // このファイルが「接続できるようになったから有効化しよう」で fail-fast を
    // 外されると、本番 D1 に parse_status だけ埋まった行が残る。形で止める。
    const suspects = [
      "services/yuho-quant/data-scripts/backfill.ts",
      "services/yuho-quant/data-scripts/backfill-overseas.ts",
    ];
    const offenders: string[] = [];
    for (const rel of suspects) {
      const path = join(ROOT, rel);
      if (!existsSync(path)) continue;
      const src = stripComments(readFileSync(path, "utf-8"));
      if (!/createD1HttpDb\s*\(/.test(src)) continue;
      const callsBatchIngest = BATCH_DEPENDENT_INGEST.some(({ fn }) =>
        new RegExp(`\\b${fn}\\s*\\(`).test(src)
      );
      if (!callsBatchIngest) continue;
      const guardAt = src.search(FAIL_FAST_CALL);
      const ingestAt = Math.min(
        ...BATCH_DEPENDENT_INGEST.map(({ fn }) => {
          const i = src.search(new RegExp(`\\b${fn}\\s*\\(\\s*db`));
          return i === -1 ? Number.POSITIVE_INFINITY : i;
        })
      );
      if (guardAt === -1 || guardAt > ingestAt) offenders.push(rel);
    }
    expect(
      offenders,
      "createD1HttpDb (sqlite-proxy) は db.batch 非対応。" +
        " batch 依存の ingest を呼ぶなら書き込み前に throw すること" +
        " (さもなくば親行だけコミットされ facts が永久に欠ける)"
    ).toEqual([]);
  });
});
