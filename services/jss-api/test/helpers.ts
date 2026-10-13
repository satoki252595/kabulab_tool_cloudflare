/** D1 / R2 の最小スタブ。実通信はしない。 */

export interface StubRow {
  [key: string]: unknown;
}

/** 試験専用の条件DTO。掲載文や実企業の制度を表すfixtureではない。 */
export const yutaiFacts = {
  version: 1, sourceGroup: "a".repeat(16), holding: true, holdingPeriods: ["5年以上"],
  choice: false, lottery: false, application: false, combination: "unverified",
  valueStatus: "source_amount_qualified", qualifiedAmount: 3000,
  valueReasons: ["qualified_company_per_grant"],
  source: { listingUrl: "https://minkabu.jp/stock/7203/yutai", fetchedAt: "2026-10-13T15:00:00.000Z",
    batchFetchedAt: null, officialStatus: "not_verified", officialUrl: null, verifiedAt: null },
};

export function stubD1(handler: (sql: string, params: unknown[]) => StubRow[]) {
  return {
    prepare(sql: string) {
      const params: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          params.push(...args);
          return stmt;
        },
        async all() {
          return { results: handler(sql, params) };
        },
        async first() {
          return handler(sql, params)[0] ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

export function stubR2(objects: Record<string, unknown>) {
  return {
    async get(key: string) {
      if (!(key in objects)) return null;
      const value = objects[key];
      const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
      return {
        size: bytes.byteLength,
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
        async json() {
          return value;
        },
        body: new Blob([bytes]).stream(),
        httpMetadata: { contentType: "application/json" },
      };
    },
  } as unknown as R2Bucket;
}
