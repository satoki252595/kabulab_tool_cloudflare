/**
 * overlay batch の test-only sender (本番 export 禁止)。
 * vitest の include (`*.test.ts`) に当たらない配置で共有する。
 * 本番 D1 REST batch の採用前提 (先頭 guard 失敗・途中失敗で全 rollback)
 * を node:sqlite の BEGIN/COMMIT/ROLLBACK で再現する。
 */
import type { DatabaseSync } from "node:sqlite";
import type { D1BatchStatement } from "../../shared/db/d1-http-client.js";
import type { OverlayBatchSender } from "../universe-overlay.js";

/** 送信回数を数える transactional sender。 */
export function makeTxBatchSender(
  sqlite: DatabaseSync,
  count: { sends: number }
): OverlayBatchSender {
  return async (statements: readonly D1BatchStatement[]) => {
    count.sends++;
    if (statements.length === 0) {
      throw new Error("test sender: 文が 0 件です");
    }
    sqlite.exec("BEGIN");
    try {
      for (const s of statements) {
        // node:sqlite は boolean を受けないため 0/1 化する (D1 側は数値)。
        const bind = s.params.map((p) =>
          typeof p === "boolean" ? (p ? 1 : 0) : p
        ) as (string | number | null)[];
        sqlite.prepare(s.sql).run(...bind);
      }
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  };
}

/** 実行せず記録だけする sender (fake DB 用。送信内容の検査に使う)。 */
export function makeRecordingSender(record: {
  batches: D1BatchStatement[][];
}): OverlayBatchSender {
  return async (statements: readonly D1BatchStatement[]) => {
    record.batches.push([...statements]);
  };
}

/** 呼ばれたら落とす sender (no-op 経路の未送信証明に使う)。 */
export function makeThrowingSender(): OverlayBatchSender {
  return async () => {
    throw new Error("test sender: 呼ばれてはならない");
  };
}
