// JPX 信用残高 (日次 mtall PDF) → Notion 一次データ保管 → R2 保存。
// 週次版は公表廃止のため通常取込では使わない (旧 R2 オブジェクトは残すが読まない)。
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  listPageFiles,
  recordPrimaryData,
} from "../../src/shared/notion-archive/index.js";
import {
  dailyMarginArchiveInput,
  fetchDailyMargin,
} from "../../services/vwap-analysis/lib/margin.js";
import { validateDailyMarginSnapshot } from "../../services/vwap-analysis/lib/margin-daily.js";
import { r2Get, r2GetVersion, r2Put } from "./lib/r2.js";
import { sanitizeLogText } from "./lib/ingest-guard.js";

/** `--date=YYYYMMDD` (基準日) をパースする純関数。未指定なら undefined (最新)。 */
export function parseDateArg(argv: readonly string[]): string | undefined {
  const arg = argv.find((a) => a.startsWith("--date="));
  if (arg === undefined) return undefined;
  const value = arg.slice("--date=".length);
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`margin --date の形式が不正です (YYYYMMDD): ${value}`);
  }
  return value;
}

/**
 * 基準日リスト (`margin/dates.json`) へ今回分を追加する純関数。
 * 形式不正の日付が混ざっていたら throw する (黙って落とさない)。
 */
export function mergeDailyMarginDates(saved: readonly string[], current: string): string[] {
  const fmt = /^\d{4}-\d{2}-\d{2}$/;
  if (!fmt.test(current)) throw new Error(`margin 基準日の形式が不正です (YYYY-MM-DD): ${current}`);
  for (const d of saved) {
    if (!fmt.test(d)) throw new Error(`margin dates.json の日付形式が不正です (YYYY-MM-DD): ${d}`);
  }
  return [...new Set([...saved, current])].sort();
}

/**
 * 保管済み PDF 実体の fullDL 検証 (first/再入共通)。
 * 既存 shared (listPageFiles) を reuse し、Files 添付が今回期待の 1 件
 * (Notion-hosted・同名) と exact 一致することを要求してから実体を落とし、
 * バイト数・SHA256 が今回取得分と一致しなければ throw する。
 * 再入時はこの検証が安全 skip の根拠になる (無限 force/reupload はしない)。
 * 過去に metadata-only で残った保管もここで STOP する (添付なし)。
 * 複数添付・外部リンク・不正添付は STOP する (先頭 1 件だけ見て通さない)。
 */
export async function verifyCustodyEntity(
  pageId: string,
  filename: string,
  expected: Uint8Array,
  expectedSha256: string
): Promise<void> {
  const refs = await listPageFiles(pageId, "Files");
  if (refs.length !== 1) {
    throw new Error(
      `margin custody 添付数が異常です: page=${pageId} の Files が ${refs.length} 件 (1 件であるべき) のため STOP`
    );
  }
  const ref = refs[0] as { name: string; url: string; kind: "file" | "external" };
  if (ref.kind !== "file") {
    throw new Error(`margin custody 外部添付のため STOP します: page=${pageId} name=${ref.name}`);
  }
  if (ref.name !== filename) {
    throw new Error(`margin custody 添付不一致: 期待=${filename} 実際=${ref.name} (page=${pageId})`);
  }
  const buf = await (await fetch(ref.url)).arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength !== expected.byteLength) {
    throw new Error(
      `margin custody サイズ不一致: 期待=${expected.byteLength} 実際=${bytes.byteLength} (page=${pageId})`
    );
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== expectedSha256) {
    throw new Error(`margin custody SHA 不一致: 期待=${expectedSha256} 実際=${sha} (page=${pageId})`);
  }
}

/**
 * PUT 計画の純関数。同値スナップショット + 同値 index は PUT0
 * (祝日の同原本再入)。部分一致は差分だけ PUT する。
 */
export function planDailyMarginPuts(
  existingSnapshot: string | null,
  snapshotJson: string,
  saved: readonly string[],
  merged: readonly string[]
): { putSnapshot: boolean; putDates: boolean } {
  return {
    putSnapshot: existingSnapshot !== snapshotJson,
    putDates: JSON.stringify(saved) !== JSON.stringify(merged),
  };
}

export async function main(): Promise<void> {
  const requested = parseDateArg(process.argv.slice(2));
  const data = await fetchDailyMargin(requested);
  // 全 PUT (R2) より前に検証する — 保管失敗時の部分保存を防ぐため。
  validateDailyMarginSnapshot(data.snapshot);
  const basis = data.snapshot.basisDate;

  // dates.json を snapshot 含む全 PUT より前に read/validate する。
  const datesVersion = await r2GetVersion("margin/dates.json");
  const savedRaw = datesVersion === null ? null : datesVersion.body;
  const saved: unknown = savedRaw === null ? [] : JSON.parse(savedRaw);
  if (!Array.isArray(saved)) {
    throw new Error(`margin dates.json の形状が不正です (配列でない): ${(savedRaw ?? "").slice(0, 80)}`);
  }
  const merged = mergeDailyMarginDates(saved, basis);

  const input = dailyMarginArchiveInput(data);
  const archived = await recordPrimaryData(input);
  // first は完全保管を要求する。metadata-only (上限超過) は STOP。
  if (archived.fileTooLarge) {
    throw new Error(
      `margin custody 不完全: ${input.key} は上限超過で metadata-only のため STOP (page=${archived.pageId})`
    );
  }
  await verifyCustodyEntity(
    archived.pageId,
    input.files[0].filename,
    data.pdfBytes,
    data.snapshot.rawSha256
  );

  const snapshotKey = `margin/daily/${basis}.json`;
  const snapshotJson = JSON.stringify({ ...data.snapshot, rawPageId: archived.pageId });
  const snapshotVersion = await r2GetVersion(snapshotKey);
  const existingSnapshot = snapshotVersion === null ? null : snapshotVersion.body;
  const { putSnapshot, putDates } = planDailyMarginPuts(existingSnapshot, snapshotJson, saved, merged);
  if (!putSnapshot && !putDates) {
    console.info(
      `margin daily ingest: basis=${basis} 同値再入のため PUT0 (rows=${data.snapshot.rows.length} page=${archived.pageId})`
    );
    return;
  }
  if (putSnapshot) {
    await r2Put(snapshotKey, snapshotJson, snapshotVersion === null ? null : snapshotVersion.etag);
    const readback = await r2Get(snapshotKey);
    if (readback !== snapshotJson) {
      throw new Error(`margin R2 readback 不一致: ${snapshotKey}`);
    }
  }
  if (putDates) {
    const datesJson = JSON.stringify(merged);
    await r2Put("margin/dates.json", datesJson, datesVersion === null ? null : datesVersion.etag);
    const datesReadback = await r2Get("margin/dates.json");
    if (datesReadback !== datesJson) {
      throw new Error("margin dates.json readback 不一致");
    }
  }
  console.info(
    `margin daily ingest: basis=${basis} pub=${data.snapshot.publicationDate} rows=${data.snapshot.rows.length} page=${archived.pageId}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    // 生 SDK cause (URL 等) を出さず sanitized のみ。
    const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`ingest-margin fatal: ${sanitizeLogText(text).slice(0, 300)}`);
    process.exit(1);
  });
}
