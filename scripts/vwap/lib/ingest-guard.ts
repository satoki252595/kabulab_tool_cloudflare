/**
 * VWAP 取込の保存前妥当性 + run 粒度バッチ保管の入力 builder (純関数)。
 *
 * - findInvalidBars: R2 PUT 前の invalid-price STOP 判定。壊れた実値
 *   (非有限・非正・出来高負・高安逆転) を欠落と混ぜず数える。呼び出し側は
 *   invalid 行ありの銘柄を書かず invalid 計数へ回す (黙って落とさない)。
 * - buildIngestSummary: run 粒度のバッチ保管入力。per-stock 鏡像は作らない
 *   (CLAUDE 高頻度ポーリング則)。summary JSON 自体を 1 ファイル添付する。
 */
export type PricedBar = {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type InvalidBar = { index: number; reasons: string[] };

export function findInvalidBars(bars: readonly PricedBar[]): InvalidBar[] {
  const out: InvalidBar[] = [];
  bars.forEach((b, index) => {
    const reasons: string[] = [];
    for (const k of ["o", "h", "l", "c"] as const) {
      const v = b[k];
      if (!Number.isFinite(v)) reasons.push(`${k}:non-finite`);
      else if (v <= 0) reasons.push(`${k}:non-positive`);
    }
    if (!Number.isFinite(b.v)) reasons.push("v:non-finite");
    else if (b.v < 0) reasons.push("v:negative");
    if (
      Number.isFinite(b.h) &&
      Number.isFinite(b.l) &&
      Number.isFinite(b.o) &&
      Number.isFinite(b.c) &&
      (b.h < b.l || b.h < b.o || b.h < b.c || b.l > b.o || b.l > b.c)
    ) {
      reasons.push("range:inverted");
    }
    if (reasons.length > 0) out.push({ index, reasons });
  });
  return out;
}

export type IngestRunStats = {
  kind: "daily" | "intra";
  range: string;
  codes: number;
  written: number;
  empty: number;
  errors: number;
  invalid: number;
  rateLimited: number;
  backfilled?: number;
  keepDays?: number;
  aborted: boolean;
  startedAt: string;
  finishedAt: string;
};

export function buildIngestSummary(stats: IngestRunStats): {
  service: string;
  key: string;
  source: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
  files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
} {
  const day = stats.finishedAt.slice(0, 10).replaceAll("-", "");
  if (!/^\d{8}$/.test(day)) {
    throw new Error(`finishedAt から日付キー不能: ${stats.finishedAt}`);
  }
  const body = JSON.stringify({ ...stats, day });
  return {
    service: "vwap-analysis",
    key: `vwap-ingest-${stats.kind}-${day}`,
    source: `vwap-ingest ${stats.kind} run summary (${stats.range})`,
    fetchedAt: stats.finishedAt,
    metadata: {
      kind: stats.kind,
      range: stats.range,
      codes: stats.codes,
      written: stats.written,
      empty: stats.empty,
      errors: stats.errors,
      invalid: stats.invalid,
      rateLimited: stats.rateLimited,
      backfilled: stats.backfilled ?? 0,
      aborted: stats.aborted,
    },
    files: [
      {
        bytes: new TextEncoder().encode(body),
        filename: `vwap-ingest-${stats.kind}-${day}.json`,
        contentType: "application/json",
      },
    ],
  };
}
