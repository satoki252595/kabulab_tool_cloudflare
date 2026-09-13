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
 * 共有 core_* スキーマ + 渡したサービススキーマを束ねた、D1 HTTP 経由の
 * drizzle クライアントを返す。返り値は SqliteRemoteDatabase で、バインディング版
 * (DrizzleD1Database) と同じ async SQLite クエリビルダ API を持つ。
 */
export function createD1HttpDb<TSchema extends Record<string, unknown>>(
  schema: TSchema
) {
  const token = sharedEnv.CLOUDFLARE_API_TOKEN();
  const accountId = sharedEnv.CLOUDFLARE_ACCOUNT_ID();
  const databaseId = sharedEnv.D1_DATABASE_ID();
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

  return drizzle(
    async (sqlStr, params, method) => {
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
      const data = (await res.json()) as D1QueryResponse;
      if (!data.success) {
        throw new Error(`D1 HTTP error: ${JSON.stringify(data.errors)}`);
      }
      // D1 /query は results をオブジェクト配列(SELECT 列順)で返す。sqlite-proxy は
      // 位置配列を期待するので Object.values で列順の配列に変換する。
      // 前提: SELECT が同名カラムを二重射影しないこと(同名キーは Object.values で
      // 1 つに潰れ位置がずれる)。drizzle のカラム選択は重複しないため通常問題ない。
      const objs = data.result?.[0]?.results ?? [];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema: { ...coreSchema, ...schema } }
  );
}
