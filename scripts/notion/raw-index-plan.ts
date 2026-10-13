/** Read-only T-RAW受入計画。例:
 * pnpm exec tsx scripts/notion/raw-index-plan.ts --raw-dir=<既存data/raw> --limit=50 --max-bytes=67108864 --out=<未作成jsonl>
 * 原本の再取得、Notion/R2/D1のmutation、派生ファイル追加は行わない。
 */
import "dotenv/config";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { assertD1SingleQueryResponse, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { sharedEnv } from "../../src/shared/env.js";
import { findCanonicalRawFiles, type CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";
import { notionStats } from "../../src/shared/notion-archive/client.js";
import { r2GetBytesVersion } from "../vwap/lib/r2.js";

export interface LocalRawSample { filename: string; sha256: string; sizeBytes: number }
type IndexRow = { sha256: string; r2_bucket: string; r2_key: string; size_bytes: number; source: string; datatype: string; scope: string; data_date: string | null; license_tag: string };
export interface RawPlanDeps {
  bucket: string;
  find: typeof findCanonicalRawFiles;
  index: (shas: string[]) => Promise<IndexRow[]>;
  get: typeof r2GetBytesVersion;
}
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");

/** SQLite-proxyのdb.all()はtupleを返す。共有REST envelope検査でobject行を確定する。 */
export async function readD1RawIndexes(shas: string[]): Promise<IndexRow[]> {
  if (shas.length < 1 || shas.length > 100 || shas.some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error("D1 SHA限定読取の引数が不正です");
  const response = await fetch(d1HttpQueryUrl(), {
    method: "POST", headers: { Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: `SELECT sha256,r2_bucket,r2_key,size_bytes,source,datatype,scope,data_date,license_tag FROM jss_raw_files WHERE sha256 IN (${shas.map(() => "?").join(",")})`, params: shas }),
  });
  if (!response.ok) throw new Error(`D1原本索引読取 HTTP ${response.status}`);
  const rows = assertD1SingleQueryResponse(await response.json());
  for (const row of rows) {
    if (["sha256", "r2_bucket", "r2_key", "source", "datatype", "scope", "license_tag"].some((key) => typeof row[key] !== "string" || row[key] === "") ||
        typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 ||
        (row.data_date !== null && typeof row.data_date !== "string")) throw new Error("D1原本索引行の型/完全性が不正です");
  }
  return rows as IndexRow[];
}

/** 既存Python keys.raw_keyの命名を保持。日付欠測は架空の取得日で埋めない。 */
export function canonicalRawKey(raw: CanonicalRawFile, docId: string | null): string {
  if (raw.dataDate === null) throw new Error("⑤原本の基準日が欠測しています。キー日付を捏造せず停止");
  const source: Record<string, string> = { EDINET: "edinet", TDnet: "tdnet", yfinance: "yfinance", stooq: "stooq", JPX: "jpx", "日証金": "_", "計算": "_" };
  const ext = path.extname(raw.filename).slice(1).toLowerCase();
  if (!source[raw.source] || [raw.datatype, raw.scope, ext, ...(docId === null ? [] : [docId])].some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error("⑤原本のキーmetadataが不正です");
  return `raw/${source[raw.source]}/${raw.datatype.toLowerCase()}/${raw.dataDate.slice(0, 4)}/${raw.dataDate}/${raw.scope}/${docId === null ? "_" : docId}/${raw.sha256.slice(0, 16)}.${ext}`;
}

function verifiedDocId(raw: CanonicalRawFile): string | null {
  if (raw.source !== "EDINET" || raw.sourceUrl === null) return null;
  const url = new URL(raw.sourceUrl);
  const match = /^\/api\/v2\/documents\/(S[0-9A-Z]+)$/.exec(url.pathname);
  return url.protocol === "https:" && url.hostname === "api.edinet-fsa.go.jp" && !url.username && !url.password && match ? match[1]! : null;
}

/** 先頭limit件のcanonical primaryだけを一度ずつ読む。総bytes予算は標本選定だけの上限。 */
export async function localRawSamples(rawDir: string, limit: number, maxBytes: number, prefix?: string): Promise<LocalRawSample[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024) throw new Error("dry標本は1〜100件、総bytesは1〜512MiBを明示してください");
  if (prefix !== undefined && !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error("標本prefixが不正です");
  const entries = (await fs.readdir(rawDir, { withFileTypes: true })).filter((entry) => entry.isFile() && !entry.name.includes("_converted.") && (prefix === undefined || entry.name.startsWith(prefix))).sort((a, b) => a.name.localeCompare(b.name));
  const samples: LocalRawSample[] = [], seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (samples.length === limit) break;
    const handle = await fs.open(path.join(rawDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("local原本が通常ファイルではありません");
      if (total + stat.size > maxBytes) continue;
      const body = await handle.readFile();
      if (body.length !== stat.size) throw new Error("local原本が読取中に変化しました");
      const digest = sha(body);
      if (seen.has(digest)) continue; // 同bytesは⑤のSHA一意キーの同じ標本。新原本として二重計数しない。
      seen.add(digest);
      samples.push({ filename: entry.name, sizeBytes: body.length, sha256: digest });
      total += body.length;
    } finally { await handle.close(); }
  }
  if (samples.length !== limit) throw new Error("件数/bytes予算内で指定数のcanonical primary標本を選べません");
  return samples;
}

export async function planRawIndex(samples: LocalRawSample[], deps: RawPlanDeps, emit: (record: object) => Promise<void>) {
  if (samples.length === 0 || samples.length > 100 || new Set(samples.map((s) => s.sha256)).size !== samples.length) throw new Error("dry標本のSHAは一意な1〜100件が必要です");
  const canonicals = new Map<string, CanonicalRawFile>();
  for (let offset = 0; offset < samples.length; offset += 50) {
    for (const [digest, raw] of await deps.find(samples.slice(offset, offset + 50).map((s) => s.sha256))) canonicals.set(digest, raw);
  }
  for (const sample of samples) {
    const found = canonicals.get(sample.sha256);
    if (found) {
      const { sourceUrl: _sourceUrl, ...safeMetadata } = found;
      await emit({ phase: "notion_metadata", ...safeMetadata, localFilename: sample.filename });
    } else await emit({ phase: "notion_metadata_missing", ...sample });
  }
  const indexes = await deps.index(samples.map((s) => s.sha256));
  if (new Set(indexes.map((i) => i.sha256)).size !== indexes.length || indexes.some((i) => !samples.some((s) => s.sha256 === i.sha256))) throw new Error("D1原本索引に未知/重複行があります");
  let r2Reads = 0, remoteBytes = 0, wouldPutBytes = 0;
  const counts = { already_complete: 0, would_index_existing: 0, would_put_and_index: 0 };
  for (const sample of samples) {
    const started = performance.now(), raw = canonicals.get(sample.sha256), index = indexes.find((i) => i.sha256 === sample.sha256);
    if (!raw) throw new Error(`⑤に同SHAの原本がありません（保管済と認定せず停止）: ${sample.filename}`);
    if (raw.filename !== sample.filename || raw.sizeBytes !== sample.sizeBytes) throw new Error(`⑤原本とlocalの名前/サイズが不一致: local=${sample.filename}/${sample.sizeBytes} notion=${raw.filename}/${raw.sizeBytes}`);
    if (index && (index.r2_bucket !== deps.bucket || index.size_bytes !== raw.sizeBytes || index.source !== raw.source || index.datatype !== raw.datatype || index.scope !== raw.scope || index.data_date !== raw.dataDate || index.license_tag !== raw.licenseTag)) throw new Error(`D1索引metadataが⑤原本と不一致: ${sample.filename}`);
    const docId = verifiedDocId(raw);
    let key = index ? index.r2_key : canonicalRawKey(raw, docId);
    const read = async () => { r2Reads++; return deps.get(key, deps.bucket); };
    let existing = await read();
    if (!existing && !index && docId !== null) {
      const legacy = canonicalRawKey(raw, null);
      key = legacy;
      existing = await read();
      if (existing === null) key = canonicalRawKey(raw, docId);
    }
    if (index && existing === null) throw new Error(`D1索引先のR2原本がありません: ${sample.filename}`);
    if (existing && (existing.body.length !== raw.sizeBytes || sha(existing.body) !== raw.sha256)) throw new Error(`R2原本の全文SHA/サイズが不一致: ${sample.filename}`);
    const outcome = index ? "already_complete" : existing ? "would_index_existing" : "would_put_and_index";
    counts[outcome]++;
    if (existing) remoteBytes += existing.body.length; else wouldPutBytes += raw.sizeBytes;
    // signed URL/添付bodyは保存しない。hosted確認と物理bytes照合を別々に明記する。
    await emit({ phase: "sample", ...sample, notionPageId: raw.pageId, hostedAttachments: raw.hostedAttachments,
      notionBodyDownloaded: false, localShaVerified: true, r2BodyVerified: existing !== null, bucket: deps.bucket, key,
      source: raw.source, datatype: raw.datatype, scope: raw.scope, dataDate: raw.dataDate, licenseTag: raw.licenseTag,
      docId, docIdReason: docId === null ? "⑤原本URLから文書IDを一意検証できない。SHA導線のみ計画" : "EDINET公式原本URLの文書IDを検証",
      outcome, elapsedMs: performance.now() - started });
  }
  return { counts, r2LogicalReads: r2Reads, r2BodyBytesDownloaded: remoteBytes, wouldPutBytes, upstreamDownloads: 0, notionBodyDownloads: 0, mutations: 0 };
}

async function main() {
  const args = new Map(process.argv.slice(2).map((value) => {
    const match = /^--(raw-dir|limit|max-bytes|out|prefix)=(.+)$/.exec(value);
    if (!match) throw new Error("引数は --raw-dir/limit/max-bytes/out と任意prefixのみです。writeモードはありません");
    return [match[1]!, match[2]!] as const;
  }));
  if (["raw-dir", "limit", "max-bytes", "out"].some((key) => !args.has(key)) || sharedEnv.LOCAL_OUT() !== undefined) throw new Error("必須4引数を明示し、LOCAL_OUTは設定しないでください（本番R2読取をpreviewと混同しない）");
  const rawDir = args.get("raw-dir")!, output = args.get("out")!, bucket = sharedEnv.R2_BUCKET_RAW();
  const limit = Number(args.get("limit")), maxBytes = Number(args.get("max-bytes"));
  const receipt = await fs.open(output, "wx", 0o600), start = performance.now(), before = notionStats();
  const emit = async (record: object) => { await receipt.write(`${JSON.stringify(record)}\n`); await receipt.sync(); };
  try {
    await emit({ phase: "started", at: new Date().toISOString(), scope: "local canonical primary sample only", rawDir, prefix: args.get("prefix"), limit, maxBytes, writesAllowed: false });
    const samples = await localRawSamples(rawDir, limit, maxBytes, args.get("prefix"));
    const result = await planRawIndex(samples, { bucket, find: findCanonicalRawFiles, get: r2GetBytesVersion, index: readD1RawIndexes }, emit);
    const after = notionStats();
    await emit({ phase: "complete", ...result, localFilesRead: samples.length, localBytesHashed: samples.reduce((sum, s) => sum + s.sizeBytes, 0), notionRequests: after.requests - before.requests, elapsedMs: performance.now() - start });
    console.info(JSON.stringify(result));
  } catch (error) {
    await emit({ phase: "stopped", elapsedMs: performance.now() - start, detail: error instanceof Error ? error.message : "unknown error", mutations: 0 });
    throw error;
  } finally { await receipt.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error("raw-index-plan stopped; receiptを確認してください（再送/書込なし）"); process.exitCode = 1; });
}
