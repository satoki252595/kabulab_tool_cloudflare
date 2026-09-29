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
  /** 日足のみ。使用/保存する adj の実値も検査する (5m には無い)。 */
  adj?: number | null;
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
    // 高安逆転のみ見る。終値の高安レンジ外は checkBarSelf と同じく正当
    // (Yahoo の丸め・取引時間差。7112 の high 700/low 698/close 697 例)。
    if (Number.isFinite(b.h) && Number.isFinite(b.l) && b.h < b.l) {
      reasons.push("range:inverted");
    }
    // adj: 実在値の非有限・非正を検査する。欠落 null は c 代用の対象で
    // あり異常ではないが、保存直前の整形済みバーに null が残るのは異常。
    if (b.adj !== undefined) {
      if (b.adj === null) reasons.push("adj:missing");
      else if (!Number.isFinite(b.adj)) reasons.push("adj:non-finite");
      else if (b.adj <= 0) reasons.push("adj:non-positive");
    }
    if (reasons.length > 0) out.push({ index, reasons });
  });
  return out;
}

/**
 * 取込 run の終了コード。errors/invalid/rateLimited のいずれかがあれば
 * 非0 (当該銘柄 PUT0 は呼び出し側で確定済み)。aborted は 2 のまま。
 * 単発 rate-limit (MAX_RL 未達) も成功扱いしない。
 */
export function resolveExitCode(counts: {
  aborted: boolean;
  errors: number;
  invalid: number;
  rateLimited: number;
}): 0 | 1 | 2 {
  if (counts.aborted) return 2;
  if (counts.errors > 0 || counts.invalid > 0 || counts.rateLimited > 0) {
    return 1;
  }
  return 0;
}

/**
 * run 識別子。同日再 run の key 衝突 (skipped_existing) を避ける。
 * Actions では GITHUB_RUN_ID(.attempt)、手元では random 8hex。
 */
export function resolveRunId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env.GITHUB_RUN_ID;
  if (id && /^\d+$/.test(id)) {
    const attempt = env.GITHUB_RUN_ATTEMPT;
    return attempt && /^\d+$/.test(attempt) ? `${id}.${attempt}` : id;
  }
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `local-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type IngestRunStats = {
  kind: "daily" | "intra";
  range: string;
  runId: string;
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
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/.test(stats.runId)) {
    throw new Error(`runId 形状不正: ${stats.runId}`);
  }
  const body = JSON.stringify({ ...stats, day });
  return {
    service: "vwap-analysis",
    key: `vwap-ingest-${stats.kind}-${day}-${stats.runId}`,
    source: `vwap-ingest ${stats.kind} run summary (${stats.range})`,
    fetchedAt: stats.finishedAt,
    metadata: {
      kind: stats.kind,
      range: stats.range,
      runId: stats.runId,
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
        filename: `vwap-ingest-${stats.kind}-${day}-${stats.runId}.json`,
        contentType: "application/json",
      },
    ],
  };
}
