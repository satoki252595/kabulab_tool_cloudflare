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

/** D1 REST `/query` の `{batch: [...]}` の 1 要素。値は束縛変数で送る。 */
export type D1BatchStatement = {
  sql: string;
  params: ReadonlyArray<string | number | boolean | null>;
};

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
    const data = (await res.json()) as D1BatchResponse;
    if (!data.success) {
      throw new Error(`D1 HTTP error: ${JSON.stringify(data.errors)}`);
    }
    const entries = data.result ?? [];
    if (entries.length !== statements.length) {
      throw new Error(
        `D1 batch: 応答 ${entries.length} 件が送信 ${statements.length} 件と一致しません`
      );
    }
    for (const [i, e] of entries.entries()) {
      if (e && typeof e === "object" && e.success === false) {
        throw new Error(
          `D1 batch: ${i + 1} 件目の文が失敗しました: ${JSON.stringify(e.error ?? e)}`
        );
      }
    }
  };
}
