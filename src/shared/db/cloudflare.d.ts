/**
 * Cloudflare ランタイム型のローカル宣言（ADR-0001）。
 *
 * `@cloudflare/workers-types` を依存に加えず、本リポジトリで実際に使う最小限の
 * グローバル型のみを宣言する（vwap-analysis が R2 BUCKET を構造的にインライン
 * 宣言しているのと同じ方針）。形は公式 workers-types の D1 / scheduled に準拠。
 *
 * drizzle-orm/d1 は global の `D1Database` / `D1Result` / `D1PreparedStatement`
 * を参照するため、ここで宣言しておく必要がある。
 *
 * ⚠️ 移行条件: 将来 `@cloudflare/workers-types` を tsconfig.json の
 *    compilerOptions.types に追加する場合は、**本ファイルを必ず削除**して公式型へ
 *    一本化すること。両方が global 宣言すると同名 interface の二重定義で衝突する
 *    (特に D1Result の構造差)。どちらか一方だけを正とする。
 */

interface D1Meta {
  duration: number;
  size_after: number;
  rows_read: number;
  rows_written: number;
  last_row_id: number;
  changed_db: boolean;
  changes: number;
}

interface D1Response {
  success: true;
  meta: D1Meta & Record<string, unknown>;
  error?: never;
}

interface D1Result<T = unknown> extends D1Response {
  results: T[];
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

/** Cron Trigger（scheduled handler）— Worker 側の取込エントリで使う */
interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
