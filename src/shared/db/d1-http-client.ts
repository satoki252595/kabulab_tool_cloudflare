/**
 * Node 実行から D1 へ書き込むための D1 HTTP クライアント（ADR-0001 / 共通化 P1）。
 *
 * D1 は Worker バインディング経由でのみ触れるが、kuromoji（ir-catalog の PDF
 * センチメント）や otakara 優待のスクレイプ・要約取り込みなど **Node で動かす**取込は
 * Worker に載せられない。そこで drizzle-orm/sqlite-proxy を Cloudflare D1 REST API
 * (`/accounts/:acct/d1/database/:id/query`) に接続し、Node プロセスから D1 へ直接
 * 書けるようにする。読取は Worker のバインディングで足りるので、これは取込専用。
 *
 * 認証は `CLOUDFLARE_API_TOKEN`(D1 edit) を型付きアクセサ経由で取得（ルール3）。
 *
 * 注意（survey 指摘）: sqlite-proxy はトランザクション/`db.batch()` 非対応のため、
 * 取込は **冪等 upsert / per-row update** 前提で書くこと（delete+insert の原子置換が
 * 必要な経路は対象外）。bind 100 / 1文100KB / 1invocation 1000query の上限は
 * 呼出側のチャンク分割で守る（ir/yuho の取込は分割済み）。
 * 同一リクエスト内の原子性が要る経路だけ `createD1HttpBatchSender` (下) を使う。
 */
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "./core-schema.js";
import { sharedEnv } from "../env.js";

interface D1QueryResponse {
  success: boolean;
  errors?: unknown;
  result?: Array<{ results?: Record<string, unknown>[] }>;
}

/**
 * 束縛値の private 検証 (converter と sender が共用。public API なし)。
 * null/真偽値/文字列/有限数のみ許可。NaN/Infinity は JSON 化で null に
 * 変質し、undefined/object は形が崩れるため送らず止める。
 */
function assertBindableParams(params: readonly unknown[]): void {
  for (const p of params) {
    if (p === null || typeof p === "string" || typeof p === "boolean") continue;
    if (typeof p === "number") {
      if (!Number.isFinite(p)) {
        throw new Error(
          `[d1-http] batch に非有限の束縛値 (${String(p)})。書込の前に止めます。`
        );
      }
      continue;
    }
    throw new Error(
      `[d1-http] batch に対象外の束縛値 (${typeof p})。書込の前に止めます。`
    );
  }
}

/** D1 REST `/query` の `{batch: [...]}` の 1 要素。値は束縛変数で送る。 */
export type D1BatchStatement = {
  sql: string;
  params: ReadonlyArray<string | number | boolean | null>;
};

/**
 * drizzle 書込ビルダ列を D1 REST `{batch}` 送信用に変換する。
 * `toSQL()` の SQL 文字列 + 束縛値をそのまま載せる。束縛値に対象外の型
 * (object 等) が混ざったら送らず throw する — 書く前に止めるための安全弁で、
 * 呼び出し側で握り潰さないこと。per-statement フォールバックはしない
 * (送るなら全文、送らないなら無送信)。
 */
export function toD1BatchStatements(
  builders: Array<{ toSQL: () => { sql: string; params: unknown[] } }>
): D1BatchStatement[] {
  return builders.map((b) => {
    const q = b.toSQL();
    assertBindableParams(q.params);
    return {
      sql: q.sql,
      params: q.params as (string | number | boolean | null)[],
    };
  });
}

interface D1BatchResultEntry {
  success?: boolean;
  error?: unknown;
  meta?: unknown;
  results?: unknown;
}

interface D1BatchResponse {
  success: boolean;
  errors?: unknown;
  result?: D1BatchResultEntry[];
}

/** 単発と batch で同じ `/query` URL を使う (資格も同じ型付きアクセサ)。 */
function d1HttpQueryUrl(): string {
  const accountId = sharedEnv.CLOUDFLARE_ACCOUNT_ID();
  const databaseId = sharedEnv.D1_DATABASE_ID();
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

/**
 * 共有 core_* スキーマ + 渡したサービススキーマを束ねた、D1 HTTP 経由の
 * drizzle クライアントを返す。返り値は SqliteRemoteDatabase で、バインディング版
 * (DrizzleD1Database) と同じ async SQLite クエリビルダ API を持つ。
 */
export function createD1HttpDb<TSchema extends Record<string, unknown>>(
  schema: TSchema
) {
  const token = sharedEnv.CLOUDFLARE_API_TOKEN();
  const url = d1HttpQueryUrl();

  return drizzle(
    async (sqlStr, params, method) => {
      assertBindableParams(params as readonly unknown[]);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ sql: sqlStr, params }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`D1 HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      // 実測 schema の厳密検証: top.success===true / result 配列 len1 /
      // entry object success===true / results 配列 / 全行 object。
      // 欠落・null・文字列・非 object は outcome-unknown で throw し再送しない。
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new Error(
          "D1 query: 応答の形が不明です (再送なし。手動確認が必要)。"
        );
      }
      const top = data as { success?: unknown; result?: unknown; errors?: unknown };
      if (top.success === false) {
        throw new Error(`D1 HTTP error: ${JSON.stringify((data as D1QueryResponse).errors)}`);
      }
      if (top.success !== true) {
        throw new Error(
          "D1 query: 応答 top の成否が不明です (再送なし。手動確認が必要)。"
        );
      }
      if (!Array.isArray(top.result) || top.result.length !== 1) {
        throw new Error(
          "D1 query: 応答 result が len1 配列ではありません (再送なし。手動確認が必要)。"
        );
      }
      const entry: unknown = top.result[0];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(
          "D1 query: 応答 entry が object ではありません (再送なし。手動確認が必要)。"
        );
      }
      const entryRec = entry as { success?: unknown; results?: unknown; error?: unknown };
      if (entryRec.success === false) {
        throw new Error(`D1 HTTP error: ${JSON.stringify(entryRec.error ?? entry)}`);
      }
      if (entryRec.success !== true) {
        throw new Error(
          "D1 query: 応答 entry の成否が不明です (再送なし。手動確認が必要)。"
        );
      }
      if (!Array.isArray(entryRec.results)) {
        throw new Error(
          "D1 query: 応答 results が配列ではありません (再送なし。手動確認が必要)。"
        );
      }
      for (const [i, row] of (entryRec.results as unknown[]).entries()) {
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          throw new Error(
            `D1 query: 応答 ${i + 1} 行目が object ではありません (再送なし。手動確認が必要)。`
          );
        }
      }
      // D1 /query は results をオブジェクト配列(SELECT 列順)で返す。sqlite-proxy は
      // 位置配列を期待するので Object.values で列順の配列に変換する。
      // 前提: SELECT が同名カラムを二重射影しないこと(同名キーは Object.values で
      // 1 つに潰れ位置がずれる)。drizzle のカラム選択は重複しないため通常問題ない。
      // results[] 空 (SELECT 0 行・書込) は正規。get の空 rows[0] ?? [] は
      // 上の schema 検証の後でのみ適用する。
      const rows = (entryRec.results as Record<string, unknown>[]).map((o) =>
        Object.values(o)
      );
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema: { ...coreSchema, ...schema } }
  );
}

/**
 * D1 REST `/query` へ `{batch: [{sql, params}, ...]}` を 1 リクエストで送る窓口。
 * sqlite-proxy が `db.batch()` 非対応のため、同一銘柄の複数 UPDATE を 1 リクエストに
 * 束ねたい経路 (優待の要約取込) だけが使う。BEGIN/COMMIT は送らない
 * (D1 REST が受け付けないため)。
 *
 * 原子性の根拠は観測事実: 隔離の一時 D1 で `{batch}` 形と複文 SQL 形のどちらも、
 * 途中の文の失敗で全文ロールバック・成功で全適用を確認した (実証後に一時 D1 は
 * 削除済み。公式 REST 文書に rollback の明文は無く、binding `DB.batch` にだけ
 * 明文がある)。この関数は実証時と同一の envelope (`{batch}`) と束縛変数 SQL で
 * 送り、応答の件数と各文の成否を検査する — 名前だけで原子性を主張しない。
 * 失敗時は throw し、呼び出し側は止めて同引数の再実行 (冪等) で回復する。
 */
export function createD1HttpBatchSender(): (
  statements: readonly D1BatchStatement[]
) => Promise<void> {
  const token = sharedEnv.CLOUDFLARE_API_TOKEN();
  const url = d1HttpQueryUrl();
  return async (statements) => {
    if (statements.length === 0) {
      throw new Error("D1 batch: 文が 0 件です (呼び出し側のバグ)");
    }
    // 直接組立の文 (converter 経由でない経路) も JSON/fetch の前に全検証する。
    for (const s of statements) {
      assertBindableParams(s.params);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        batch: statements.map((s) => ({ sql: s.sql, params: [...s.params] })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`D1 HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data: unknown = await res.json();
    // 成否は厳密判定のみ通す。truthy 文字列・欠落・非 object は全て
    // outcome-unknown で throw し、再送しない (結果不明のまま触らない)。
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(
        "D1 batch: 応答の形が不明です (再送なし。手動確認が必要)。"
      );
    }
    const top = data as { success?: unknown; result?: unknown; errors?: unknown };
    if (top.success === false) {
      throw new Error(`D1 HTTP error: ${JSON.stringify((data as D1BatchResponse).errors)}`);
    }
    if (top.success !== true) {
      throw new Error(
        "D1 batch: 応答 top の成否が不明です (再送なし。手動確認が必要)。"
      );
    }
    if (!Array.isArray(top.result)) {
      throw new Error(
        "D1 batch: 応答 result が配列ではありません (再送なし。手動確認が必要)。"
      );
    }
    const entries: unknown[] = top.result;
    if (entries.length !== statements.length) {
      throw new Error(
        `D1 batch: 応答 ${entries.length} 件が送信 ${statements.length} 件と一致しません`
      );
    }
    for (const [i, e] of entries.entries()) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        throw new Error(
          `D1 batch: ${i + 1} 件目の応答が object ではありません (再送なし。手動確認が必要)。`
        );
      }
      const s = (e as { success?: unknown }).success;
      if (s === false) {
        throw new Error(
          `D1 batch: ${i + 1} 件目の文が失敗しました: ${JSON.stringify((e as D1BatchResultEntry).error ?? e)}`
        );
      }
      if (s !== true) {
        throw new Error(
          `D1 batch: ${i + 1} 件目の成否が不明です (再送なし。手動確認が必要)。`
        );
      }
    }
  };
}
