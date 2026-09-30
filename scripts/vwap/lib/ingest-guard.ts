/**
 * VWAP 取込の保存前妥当性 + run 粒度バッチ保管の入力 builder (純関数)。
 *
 * - findInvalidBars: R2 PUT 前の invalid-price STOP 判定。壊れた実値
 *   (非有限・非正・出来高負・高安逆転) を欠落と混ぜず数える。呼び出し側は
 *   invalid 行ありの銘柄を書かず invalid 計数へ回す (黙って落とさない)。
 * - buildIngestSummary: run 粒度のバッチ保管入力。per-stock 鏡像は作らない
 *   (CLAUDE 高頻度ポーリング則)。summary JSON 自体を 1 ファイル添付する。
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

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
 * fatalUnknown (R2 PUT unknown/rejected・R2 GET fault) は 2。
 * ワークフローは exit 2 で後続 intra を走らせない。
 */
export function resolveExitCode(counts: {
  aborted: boolean;
  fatalUnknown: boolean;
  errors: number;
  invalid: number;
  rateLimited: number;
}): 0 | 1 | 2 {
  if (counts.aborted || counts.fatalUnknown) return 2;
  if (counts.errors > 0 || counts.invalid > 0 || counts.rateLimited > 0) {
    return 1;
  }
  return 0;
}

/** ログ文面の sanitizer。URL・secret 代入値を落とす。 */
export function sanitizeLogText(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/secret\s*=\s*\S+/gi, "secret=<redacted>");
}

export type ArchiveResult = { code: 0 | 2; reason: string | null };

/**
 * run 粒度バッチ保管の実行 + 終了コード解決。recorded 以外・fileTooLarge・
 * 例外はすべて 2 (fatal)。呼び出し側は exit 2 で後続を止める。
 * ワークフローは daily の exit 2 で intra を走らせない。
 * 失敗理由は sanitized で reason に載せ、呼び出し側が receipt ログへ出す。
 * source archive の証拠を握り潰さない。
 */
export async function archiveSummaryOrFatal(
  record: () => Promise<{ outcome: string; fileTooLarge: boolean }>
): Promise<ArchiveResult> {
  let r: { outcome: string; fileTooLarge: boolean };
  try {
    r = await record();
  } catch (e) {
    const name = e instanceof Error ? e.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    return { code: 2, reason: `exception:${name}: ${sanitizeLogText(msg).slice(0, 200)}` };
  }
  if (r.fileTooLarge) return { code: 2, reason: `fileTooLarge outcome=${r.outcome}` };
  if (r.outcome !== "recorded") return { code: 2, reason: `outcome=${r.outcome}` };
  return { code: 0, reason: null };
}

/**
 * 実行母集団の pin。sorted 結合の SHA256 + 件数。summary が「何を回したか」
 * を証明する (financial 値なし)。
 */
export function universePin(codes: readonly string[]): { size: number; sha256: string } {
  const sorted = [...codes].sort();
  return {
    size: sorted.length,
    sha256: createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex"),
  };
}

/** PUT body の pin。何を書いたかの証跡 (financial 値なし)。 */
export function bodyPin(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export type SavedDaily = {
  code: string;
  bars: Array<Record<string, unknown>>;
  splits: Array<Record<string, unknown>>;
};

export type SavedIntra = {
  code: string;
  bars: Array<Record<string, unknown>>;
};

/** YYYY-MM-DD の暦妥当性 (存在する日付のみ)。 */
export function isCalendarDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === d;
}

/**
 * 保存済み R2 daily object の strict 検証。以下は throw する:
 * parse 不能・非 object・code 不一致 (cross-code 混入防止)・
 * bars/splits 非配列・bar の日付不正・重複日付・価格異常 (既存
 * findInvalidBars を reuse)・adj 欠落 (daily 保存バーは adj 必須)・
 * splits 要素の日付不正・ratio 非正有限。
 * `old.bars || []` の黙示補完は禁止 (新 valid が壊 old を温存して PUT
 * する根因になる)。呼び出し側は当該銘柄 PUT0・errors 計数へ。
 */
export function assertSavedDailyShape(raw: string, key: string, expectedCode: string): SavedDaily {
  let old: unknown;
  try {
    old = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`保存済み形状が不正です (parse 不能): ${key}`);
  }
  if (old === null || typeof old !== "object" || Array.isArray(old)) {
    throw new Error(`保存済み形状が不正です (object でない): ${key}`);
  }
  const o = old as Record<string, unknown>;
  if (typeof o.code !== "string" || o.code !== expectedCode) {
    throw new Error(`保存済み形状が不正です (code 不一致): ${key}`);
  }
  if (!Array.isArray(o.bars) || !Array.isArray(o.splits)) {
    throw new Error(`保存済み形状が不正です (bars/splits 非配列): ${key}`);
  }
  const seenDates = new Set<string>();
  for (const b of o.bars) {
    const r = b as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") {
      throw new Error(`保存済み形状が不正です (bars 要素非 object): ${key}`);
    }
    if (typeof r.date !== "string" || !isCalendarDate(r.date)) {
      throw new Error(`保存済み形状が不正です (bars 日付不正): ${key}`);
    }
    if (seenDates.has(r.date)) {
      throw new Error(`保存済み形状が不正です (bars 日付重複): ${key}`);
    }
    seenDates.add(r.date);
    if (r.adj === undefined) {
      throw new Error(`保存済み形状が不正です (bars adj 欠落): ${key}`);
    }
  }
  const bad = findInvalidBars(o.bars as unknown as PricedBar[]);
  if (bad.length > 0) {
    throw new Error(`保存済み形状が不正です (bars 価格異常 ${bad.length} 件): ${key}`);
  }
  for (const s of o.splits) {
    const r = s as Record<string, unknown> | null;
    if (
      r === null ||
      typeof r !== "object" ||
      typeof r.date !== "string" ||
      !isCalendarDate(r.date) ||
      typeof r.ratio !== "number" ||
      !Number.isFinite(r.ratio) ||
      r.ratio <= 0
    ) {
      throw new Error(`保存済み形状が不正です (splits 要素): ${key}`);
    }
  }
  return o as unknown as SavedDaily;
}

/**
 * 保存済み R2 intra object の strict 検証。daily と同一方針。
 * bars 要素は ts (有限正数値)・重複なし・価格妥当 (findInvalidBars reuse)。
 * adj は intra に無い (undefined のまま検査し、欠落扱いしない)。
 */
export function assertSavedIntraShape(raw: string, key: string, expectedCode: string): SavedIntra {
  let old: unknown;
  try {
    old = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`保存済み形状が不正です (parse 不能): ${key}`);
  }
  if (old === null || typeof old !== "object" || Array.isArray(old)) {
    throw new Error(`保存済み形状が不正です (object でない): ${key}`);
  }
  const o = old as Record<string, unknown>;
  if (typeof o.code !== "string" || o.code !== expectedCode) {
    throw new Error(`保存済み形状が不正です (code 不一致): ${key}`);
  }
  if (!Array.isArray(o.bars)) {
    throw new Error(`保存済み形状が不正です (bars 非配列): ${key}`);
  }
  const seenTs = new Set<number>();
  for (const b of o.bars) {
    const r = b as Record<string, unknown> | null;
    if (r === null || typeof r !== "object") {
      throw new Error(`保存済み形状が不正です (bars 要素非 object): ${key}`);
    }
    if (typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts <= 0) {
      throw new Error(`保存済み形状が不正です (bars ts 不正): ${key}`);
    }
    if (seenTs.has(r.ts)) {
      throw new Error(`保存済み形状が不正です (bars ts 重複): ${key}`);
    }
    seenTs.add(r.ts);
  }
  const bad = findInvalidBars(o.bars as unknown as PricedBar[]);
  if (bad.length > 0) {
    throw new Error(`保存済み形状が不正です (bars 価格異常 ${bad.length} 件): ${key}`);
  }
  return o as unknown as SavedIntra;
}

/**
 * same-cached-input 2回目の R2 PUT0 判定。揮発値 `updated` だけを除いた
 * 保存 object 全体が fresh object と同値なら true (PUT skip)。
 *
 * - 比較は stdlib `isDeepStrictEqual` (object のキー順は無視されるため、
 *   JSON key 順だけの差で不必要 PUT しない。配列順は bar/split の時系列
 *   正準なので順序差は PUT する)。
 * - 余分/欠落 field・形状不正 (不正 splits 等) は同値にしない。default []
 *   補完は禁止 — 壊れた既存を「等しい」と見なして schema 修復を skip
 *   する根因になるため、欠落・型違いは必ず PUT して正準形で上書きする。
 * - 既存なし・parse 不能・object 以外 → false (PUT する)。
 * - intra の range/keep 剪定で集合が変われば内容が変わるため PUT する
 *   (剪定変更を skip しない)。
 */
export function shouldSkipPut(
  existingRaw: string | null,
  fresh: Record<string, unknown>
): boolean {
  if (existingRaw == null) return false;
  let old: unknown;
  try {
    old = JSON.parse(existingRaw) as unknown;
  } catch {
    return false;
  }
  if (old === null || typeof old !== "object" || Array.isArray(old)) {
    return false;
  }
  const oldRest = { ...(old as Record<string, unknown>) };
  delete oldRest.updated;
  const freshRest = { ...fresh };
  delete freshRest.updated;
  return isDeepStrictEqual(oldRest, freshRest);
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

/**
 * 銘柄単位の確定 outcome。実行 codes 全件がちょうど 1 件ずつ載る
 * (notStarted 含め全件 accounting)。
 * - written/skipped/empty/error/unknown/notStarted の 6 値。
 * - latestSourceBar: 実応答の最新 source bar。daily は Yahoo timestamp
 *   由来の JST 日付 (YYYY-MM-DD)、intra は実 ts 秒。未 fetch は null。
 *   run day (UTC) は archive key 専用で、完了取引日の推定はしない。
 * - bodySha: written は送信 body、skipped は standing の既存 bytes、
 *   unknown/rejected は試行 body の SHA256。出力なしは null。
 *   financial 値は載せない。
 */
export type IngestOutcomeStatus =
  | "written"
  | "skipped"
  | "empty"
  | "error"
  | "unknown"
  | "notStarted";
export type IngestCodeOutcome = {
  status: IngestOutcomeStatus;
  latestSourceBar: string | number | null;
  bodySha: string | null;
};

export type IngestRunStats = {
  kind: "daily" | "intra";
  range: string;
  runId: string;
  skipped?: number;
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
  /** R2 結果不明の銘柄 (sorted)。適用有無は断定しない。 */
  unknown: string[];
  /** R2 明示拒否の銘柄 (sorted)。適用なし確定。 */
  rejected: string[];
  /** 実行母集団の pin (sorted SHA + 件数)。financial 値なし。 */
  universe: { size: number; sha256: string };
  /** 銘柄単位の確定 outcome (code → outcome)。全件 accounting。 */
  outcomes: Record<string, IngestCodeOutcome>;
};

/**
 * source 観測の集約。latestSourceBar 非 null の件数 + 日付/ts の最大。
 * summary は kind 単一のため daily は maxDate、intra は maxTs の片方のみ
 * 埋まる。empty/notStarted (null) は数えない。
 */
export function sourceObservedAggregate(
  outcomes: Record<string, IngestCodeOutcome>
): { count: number; maxDate: string | null; maxTs: number | null } {
  let count = 0;
  let maxDate: string | null = null;
  let maxTs: number | null = null;
  for (const code of Object.keys(outcomes)) {
    const v = outcomes[code].latestSourceBar;
    if (v === null || v === undefined) continue;
    count++;
    if (typeof v === "string") {
      if (maxDate === null || v > maxDate) maxDate = v;
    } else if (typeof v === "number") {
      if (maxTs === null || v > maxTs) maxTs = v;
    }
  }
  return { count, maxDate, maxTs };
}

/**
 * summary 本文 bytes の archive 前 durable 保持 (trust boundary)。
 * run 36698387232 の 413 UNKNOWN で原本 bytes が memory 内消失した再発防止。
 * dir 0700・file wx 0600 + fsync・既存衝突は拒否 (上書きなし)。
 * 書込失敗は呼び出し側が archive 前に fatal exit 2 (record 0。daily 2 で
 * intra 0)。「保存失敗でも archive 継続」の fallback は禁止。
 * dir 既定は `.vwap-summaries` (cwd 相対。テストは tmp へ chdir する)。
 */
export const SUMMARY_LOCAL_DIR = ".vwap-summaries";

export function writeSummaryLocal(
  summary: {
    key: string;
    files: Array<{ bytes: Uint8Array; filename: string; contentType: string }>;
  },
  dir: string = SUMMARY_LOCAL_DIR
): { ok: true; path: string } | { ok: false; reason: string } {
  try {
    if (summary.files.length !== 1) return { ok: false, reason: "files!=1" };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const path = `${dir}/${summary.files[0].filename}`;
    // writeSync は short count を返しうる。writeFileSync(fd) の full-write
    // で exact bytes を保証してから fsync する。
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, summary.files[0].bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return { ok: false, reason: "exists" };
    return {
      ok: false,
      reason: sanitizeLogText(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 120),
    };
  }
}

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
      skipped: stats.skipped ?? 0,
      codes: stats.codes,
      written: stats.written,
      empty: stats.empty,
      errors: stats.errors,
      invalid: stats.invalid,
      rateLimited: stats.rateLimited,
      backfilled: stats.backfilled ?? 0,
      aborted: stats.aborted,
      // per-code outcomes (3695 件級) と unknown/rejected 一覧は物理 JSON
      // 本文のみ。metadata に載せると Notion 上限 (rich_text 配列 ≤100・
      // text ≤2000・blocks ≤1000、超過 400) を超える。full JSON の SHA は
      // 共有 _fileManifest が運ぶ (archive 側の変更なし)。
      unknownCount: stats.unknown.length,
      rejectedCount: stats.rejected.length,
      universe: stats.universe,
      sourceObserved: sourceObservedAggregate(stats.outcomes),
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
