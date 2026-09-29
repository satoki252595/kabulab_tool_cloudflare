/**
 * `createD1HttpDb` (sqlite-proxy / D1 REST) の **batch 境界**ガード。
 * batch callback を渡していないため `db.batch()` は実行時に落ちる。
 * **型では捕まらない** (Node スクリプトは `as unknown as Database` で渡す定型)。
 *
 * 機械的に見る 3 つ:
 *   1. 同じ形で組むと `db.batch()` が本当に落ちること (batch 対応になったら畳む)
 *   2. batch 依存の ingest 定義が今も `db.batch()` を使うこと
 *      (Worker 経路。表が古くなったらここから外す)
 *   3. createD1HttpDb 経由で batch 依存の ingest を呼ぶスクリプトは、呼び出しに
 *      明示の `d1HttpBatch` (createD1HttpBatchSender) を渡すこと。かつては
 *      `assert...Supported()` の無条件 throw で止めていたが、共有 ingest が
 *      明示 sender + 入口 preflight + upsert 内包の単一 batch になったため、
 *      静的ガードも「sender 指定の存在」へ畳んだ (指定忘れは実行時にも
 *      preflight が書込前に止める二重化)。
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
 * `ingestDocument(db, { ... })` の引数ブロック内に明示の sender 指定があるか。
 * ブロックの対応括弧を数えて切り出す (近傍の無関係な言及を拾わないため)。
 * 文字列リテラル内の括弧は無視する。コメントは呼び出し側で除去済み。
 */
function callBlockHasSender(src: string, callAt: number): boolean {
  let i = src.indexOf("(", callAt);
  if (i === -1) return false;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  const block = src.slice(callAt, i + 1);
  // 省略形 (d1HttpBatch,) も明示形 (d1HttpBatch: x) も指定とみなす。
  return /\bd1HttpBatch\s*[:,}]/.test(block);
}

/**
 * 対象は Node 実行 (tsx) のスクリプトだけ。Worker 側 (`c.env.DB`
 * バインディング) は本物の `batch` を持つので対象外。
 */

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

  it("createD1HttpDb 経由で batch 依存の ingest を呼ぶスクリプトは明示 sender を渡す", () => {
    // sender 指定を外すと、ingestDocument の入口 preflight が実行時に止める
    // (二重化)。本テストは静的に同じことを見る。呼び出しブロック内に
    // d1HttpBatch: が無ければ違反。
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
      for (const { fn } of BATCH_DEPENDENT_INGEST) {
        const re = new RegExp(`\\b${fn}\\s*\\(\\s*db`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          if (!callBlockHasSender(src, m.index)) {
            offenders.push(`${rel}: ${fn} 呼び出しに d1HttpBatch 指定が無い`);
          }
        }
      }
    }
    expect(
      offenders,
      "createD1HttpDb (sqlite-proxy) は db.batch 非対応。" +
        " batch 依存の ingest を呼ぶなら明示 d1HttpBatch を渡すこと" +
        " (さもなくば入口 preflight が書込前に止める)"
    ).toEqual([]);
  });
});
