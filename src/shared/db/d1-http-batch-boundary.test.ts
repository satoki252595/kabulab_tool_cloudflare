/**
 * `createD1HttpDb` (sqlite-proxy / D1 REST) の **batch 境界**ガード。
 * batch callback を渡していないため `db.batch()` は実行時に落ちる。
 * **型では捕まらない** (Node スクリプトは `as unknown as Database` で渡す定型)。
 *
 * 機械的に見る 4 つ:
 *   1. 同じ形で組むと `db.batch()` が本当に落ちること (batch 対応になったら畳む)
 *   2. batch 依存の ingest 定義が今も `db.batch()` を使うこと
 *      (Worker 経路。表が古くなったらここから外す)
 *   3. createD1HttpDb 経由で batch 依存の ingest を呼ぶスクリプトは、呼び出しに
 *      明示の `d1HttpBatch` (createD1HttpBatchSender) を渡すこと。かつては
 *      `assert...Supported()` の無条件 throw で止めていたが、共有 ingest が
 *      明示 sender + 入口 preflight + upsert 内包の単一 batch になったため、
 *      静的ガードも「sender 指定の存在」へ畳んだ (指定忘れは実行時にも
 *      preflight が書込前に止める二重化)。
 *   4. backfill-overseas の D1 書込は全て d1HttpBatch 経由で、逐次の
 *      `await db.update/insert/delete` は無いこと (UPDATE 後に落ちると
 *      status だけ埋まる同根因。ビルダの構築自体は await 無しなので可)。
 *   5. backfill-text-sections / backfill-missing-docs の DELETE・INSERT は
 *      全て d1HttpBatch 経由で、逐次の `await db.delete/insert` は無いこと。
 *      Notion 確定後のポインタ単行 UPDATE (別境界) だけは await 書込として
 *      残る。status の batch 内包は実 SQLite テスト (backfill-atomic) が担う。
 *      missing-docs の batch 呼出は lib/missing-backfill.ts processMissingDoc
 *      に委譲されており、script は委譲呼出のみ・lib を同基準で検査する。
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

  it("backfill-overseas の D1 書込は全て d1HttpBatch 経由 (逐次 await 書込なし)", () => {
    const path = join(ROOT, "services/yuho-quant/data-scripts/backfill-overseas.ts");
    const src = stripComments(readFileSync(path, "utf-8"));
    // await 付きの直接書込だけを違反とする。toD1BatchStatements へ渡す
    // ビルダ構築 (await 無し) は正規の形なので拾わない。
    const sequential = src.match(/await\s+db\s*\.\s*(update|insert|delete|batch)\s*\(/g);
    expect(
      sequential ?? [],
      "backfill-overseas は 1 文書ぶんを d1HttpBatch の単一 batch で送る。" +
        " 逐次 await 書込は status だけ埋まる同根因になるため禁止"
    ).toEqual([]);
    expect(src).toMatch(/await\s+d1HttpBatch\s*\(\s*toD1BatchStatements\s*\(/);
  });

  it("backfill-text-sections / backfill-missing-docs の DELETE・INSERT は d1HttpBatch 経由", () => {
    for (const rel of [
      "services/yuho-quant/data-scripts/backfill-text-sections.ts",
      "services/yuho-quant/data-scripts/backfill-missing-docs.ts",
    ]) {
      const src = stripComments(
        readFileSync(join(ROOT, rel), "utf-8")
      );
      // DELETE/INSERT の逐次 await は全面禁止 (単一 batch へ同梱が正規)。
      // Notion 確定後のポインタ単行 UPDATE は別境界として残るため対象外。
      const sequential = src.match(/await\s+db\s*\.\s*(insert|delete)\s*\(/g);
      expect(
        sequential ?? [],
        `${rel} の DELETE・INSERT は d1HttpBatch の単一 batch で送ること`
      ).toEqual([]);
    }
    const textSrc = stripComments(
      readFileSync(
        join(ROOT, "services/yuho-quant/data-scripts/backfill-text-sections.ts"),
        "utf-8"
      )
    );
    expect(textSrc).toMatch(/await\s+d1HttpBatch\s*\(\s*toD1BatchStatements\s*\(/);
    // missing-docs は lib の processMissingDoc に委譲する (二重実装なし)。
    const missingSrc = stripComments(
      readFileSync(
        join(ROOT, "services/yuho-quant/data-scripts/backfill-missing-docs.ts"),
        "utf-8"
      )
    );
    expect(missingSrc).toMatch(/await\s+processMissingDoc\s*\(/);
    // lib 側も同基準: 逐次 await の insert/delete なし + 単一 batch 呼出あり。
    const libSrc = stripComments(
      readFileSync(
        join(ROOT, "services/yuho-quant/data-scripts/lib/missing-backfill.ts"),
        "utf-8"
      )
    );
    const libSequential = libSrc.match(/await\s+db\s*\.\s*(insert|delete)\s*\(/g);
    expect(
      libSequential ?? [],
      "lib/missing-backfill.ts の DELETE・INSERT は d1HttpBatch の単一 batch で送ること"
    ).toEqual([]);
    expect(libSrc).toMatch(
      /await\s+deps\.d1HttpBatch\s*\(\s*toD1BatchStatements\s*\(/
    );
  });
});
