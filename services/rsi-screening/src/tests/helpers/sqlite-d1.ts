/**
 * テスト用の D1 スタブ — `node:sqlite` の実 SQLite を D1 バインディング互換の
 * 形に被せる。
 *
 * これが必要な理由: 今回直したのは「`computed_at` を見ていなかった WHERE 句」で、
 * 検証したいのは **SQL が古い行を実際に落とすか** という 1 点。純関数だけを
 * テストすると境界計算しか確認できず、drizzle が epoch 秒へ変換する部分や
 * JOIN 条件の取り違えを取り逃がす。miniflare を足す案もあったが、依存が重く
 * (workerd を引く) CI の 15 分枠に見合わないので、Node 同梱の SQLite を使う。
 *
 * 注意: `raw()` は node:sqlite が列名付きオブジェクトしか返さないため
 * `Object.values` で位置配列に直す。同名カラムを二重射影した SELECT では
 * 位置がずれる (src/shared/db/d1-http-client.ts と同じ制約)。
 */
import { DatabaseSync } from "node:sqlite";

/** node:sqlite が bind 可能な値 */
type SqliteValue = null | number | bigint | string | Uint8Array;

function toSqliteParams(values: unknown[]): SqliteValue[] {
  return values.map((v) => {
    if (v === null || v === undefined) return null;
    if (
      typeof v === "number" ||
      typeof v === "bigint" ||
      typeof v === "string" ||
      v instanceof Uint8Array
    ) {
      return v;
    }
    // drizzle は boolean / Date を driver 値へ変換済みで渡すはず。
    // 変換漏れを黙って通すとテストが嘘をつくので落とす (ルール2)。
    throw new Error(
      `node:sqlite に渡せない bind 値です: ${typeof v} ${String(v)}`
    );
  });
}

/** DDL を適用した SQLite を D1 バインディング互換オブジェクトとして返す */
export function createSqliteD1(ddl: string): {
  db: D1Database;
  sqlite: DatabaseSync;
  close: () => void;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(ddl);

  const makeStatement = (sql: string, params: unknown[]) => {
    const bound = () => toSqliteParams(params);
    const statement = {
      bind: (...values: unknown[]) => makeStatement(sql, values),
      first: async (colName?: string) => {
        const row = sqlite.prepare(sql).get(...bound()) as
          | Record<string, unknown>
          | undefined;
        if (!row) return null;
        return colName === undefined ? row : (row[colName] ?? null);
      },
      run: async () => {
        sqlite.prepare(sql).run(...bound());
        return { success: true, meta: {}, results: [] };
      },
      all: async () => {
        const results = sqlite.prepare(sql).all(...bound());
        return { success: true, meta: {}, results };
      },
      raw: async () => {
        const rows = sqlite.prepare(sql).all(...bound()) as Record<
          string,
          unknown
        >[];
        return rows.map((r) => Object.values(r));
      },
    };
    return statement as unknown as D1PreparedStatement;
  };

  const db = {
    prepare: (sql: string) => makeStatement(sql, []),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
    batch: async () => {
      throw new Error("テストスタブは batch を実装していません");
    },
    dump: async () => {
      throw new Error("テストスタブは dump を実装していません");
    },
  } as unknown as D1Database;

  return { db, sqlite, close: () => sqlite.close() };
}
