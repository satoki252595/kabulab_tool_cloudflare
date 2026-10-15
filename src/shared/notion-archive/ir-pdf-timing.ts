/**
 * INC-ir-pdf-502 計測専用。
 *
 * catchup の銘柄別 Notion 保管で、1 件の所要を 1 行に出す。間隔・再試行・
 * 呼び出し順・件数は変えない。コンテキストが無い呼び出しは記録しない。
 * 各フィールドは独立した経過時間で、合計の内訳として足し合わせない
 * (銘柄解決の中に Notion 呼び出しと queue 待ちが含まれる)。
 */

export const IR_PDF_TIMING_TAG = "[INC-ir-pdf-502-timing]";

export interface IrPdfTimedCall {
  kind: string;
  ms: number;
}

export interface IrPdfItemTiming {
  pdfFetchMs: number;
  pdfParseMs: number;
  readbackMs: number;
  stockResolveMs: number;
  queueWaitMs: number;
  calls: IrPdfTimedCall[];
}

export interface IrPdfNotionStatsSnapshot {
  requests: number;
  rateLimited: number;
  transientRetries: number;
}

let active: IrPdfItemTiming | null = null;

function roundMs(ms: number): number {
  return Math.round(ms);
}

export function beginIrPdfItemTiming(): IrPdfItemTiming {
  if (active !== null) {
    throw new Error("IR PDF item timing is already active");
  }
  active = {
    pdfFetchMs: 0,
    pdfParseMs: 0,
    readbackMs: 0,
    stockResolveMs: 0,
    queueWaitMs: 0,
    calls: [],
  };
  return active;
}

export function endIrPdfItemTiming(): void {
  active = null;
}

export function readIrPdfItemTiming(): IrPdfItemTiming | null {
  if (active === null) return null;
  return {
    pdfFetchMs: active.pdfFetchMs,
    pdfParseMs: active.pdfParseMs,
    readbackMs: active.readbackMs,
    stockResolveMs: active.stockResolveMs,
    queueWaitMs: active.queueWaitMs,
    calls: active.calls.map((call) => ({ kind: call.kind, ms: call.ms })),
  };
}

function current(): IrPdfItemTiming | null {
  return active;
}

export function recordIrPdfPdfFetch(ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.pdfFetchMs += roundMs(ms);
}

export function recordIrPdfPdfParse(ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.pdfParseMs += roundMs(ms);
}

export function recordIrPdfReadback(ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.readbackMs += roundMs(ms);
}

export function recordIrPdfStockResolve(ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.stockResolveMs += roundMs(ms);
}

export function recordIrPdfQueueWait(ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.queueWaitMs += roundMs(ms);
}

export function recordIrPdfCall(kind: string, ms: number): void {
  const timing = current();
  if (timing === null) return;
  timing.calls.push({ kind, ms: roundMs(ms) });
}

export async function measureIrPdfCall<T>(kind: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    recordIrPdfCall(kind, performance.now() - started);
  }
}

/** schedule に入る 1 回の Notion 呼び出しの種別。path の query は含めない。 */
export function notionTimingKind(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string
): string {
  const bare = path.split("?", 1)[0] ?? path;
  if (method === "POST" && bare === "/file_uploads") return "upload";
  if (method === "POST" && /^\/file_uploads\/[^/]+\/complete$/.test(bare)) return "complete";
  if (method === "POST" && bare === "/search") return "search";
  if (method === "POST" && /^\/databases\/[^/]+\/query$/.test(bare)) return "query";
  if (method === "GET") return "GET";
  if (method === "PATCH") return "PATCH";
  if (method === "DELETE") return "DELETE";
  return "POST";
}

export function formatIrPdfItemTimingLine(args: {
  tdnetId: string;
  totalMs: number;
  timing: IrPdfItemTiming;
  stockCache: string;
}): string {
  const timing = args.timing;
  const calls = timing.calls.length === 0
    ? "-"
    : timing.calls.map((call) => `${call.kind}:${call.ms}`).join(",");
  return (
    `${IR_PDF_TIMING_TAG} tdnetId=${args.tdnetId}` +
    ` totalMs=${args.totalMs}` +
    ` pdfFetchMs=${timing.pdfFetchMs}` +
    ` pdfParseMs=${timing.pdfParseMs}` +
    ` readbackMs=${timing.readbackMs}` +
    ` stockResolveMs=${timing.stockResolveMs}` +
    ` queueWaitMs=${timing.queueWaitMs}` +
    ` stockCache=${args.stockCache}` +
    ` calls=${calls}`
  );
}

export function formatIrPdfNotionStatsLine(
  end: IrPdfNotionStatsSnapshot,
  phase: IrPdfNotionStatsSnapshot
): string {
  return (
    `${IR_PDF_TIMING_TAG} phase=end` +
    ` requests=${end.requests}` +
    ` rateLimited=${end.rateLimited}` +
    ` transientRetries=${end.transientRetries}` +
    ` phaseRequests=${phase.requests}` +
    ` phaseRateLimited=${phase.rateLimited}` +
    ` phaseTransientRetries=${phase.transientRetries}`
  );
}
