/** 公式日付一覧の原HTTP本文を保管し、SOURCE再GETなしで再開する。 */
import { gzipSync, gunzipSync } from "node:zlib";
import { z } from "../../../../../src/shared/zod-mini.js";
import { sha256HexBytes } from "../../../../../src/shared/sha256.js";
import { recordPrimaryData, listPageFiles, verifyArchivedAttachments } from "../../../../../src/shared/notion-archive/index.js";
import { observeDocuments } from "./client.js";
import { edinetListResponseSchema, type EdinetListResponse } from "./types.js";

export const listSnapshotSchema = z.object({
  date: z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)),
  pageId: z.string().check(z.regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)),
  filename: z.string(),
  gzipSha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  rawSha256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  rawBytes: z.number().check(z.int(), z.nonnegative()),
  httpStatus: z.number().check(z.int(), z.minimum(100), z.maximum(599)),
  qualified: z.boolean(),
  fetchedAt: z.string().check(z.iso.datetime()),
});
export type ListSnapshot = z.infer<typeof listSnapshotSchema>;
/** 原応答は物理保管済み、業務資格だけ未成立。次の定期runで一覧を再観測可能。 */
export class EdinetListQualificationError extends Error {
  constructor(public readonly snapshot: ListSnapshot) {super("EDINET日付一覧の資格未成立 (原応答保管済み)"); this.name = "EdinetListQualificationError";}
}

function parseOriginalList(raw: Uint8Array, date: string): EdinetListResponse {
  const json: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(raw));
  const source = z.object({metadata: z.object({parameter: z.object({date: z.string(), type: z.string()})})}).parse(json);
  const list = edinetListResponseSchema.parse(json);
  if (source.metadata.parameter.date !== date || source.metadata.parameter.type !== "2" ||
      list.metadata.status !== "200" || list.metadata.resultset.count !== list.results.length) {
    throw new Error("EDINET保存日付一覧のdate/type/件数が不一致");
  }
  return list;
}

export async function captureListSnapshot(date: string): Promise<{list: EdinetListResponse; snapshot: ListSnapshot}> {
  const observation = await observeDocuments(date);
  const rawSha256 = await sha256HexBytes(observation.bytes);
  const bytes = new Uint8Array(gzipSync(observation.bytes));
  const filename = `edinet-list-${date}.json.gz`;
  const file = {filename, bytes, contentType: "application/gzip"};
  const result = await recordPrimaryData({
    service: "yuho-quant",
    key: `edinet-list-${date}-${observation.fetchedAt}-${rawSha256}`,
    source: "EDINET API v2 documents.json type=2 (日付一覧・原HTTP本文)",
    fetchedAt: observation.fetchedAt,
    metadata: { date, rawBytes: observation.bytes.length, rawSha256, httpStatus: observation.httpStatus },
    files: [file],
    force: false,
  });
  if (result.fileTooLarge || result.manifestMatch === "unknown") {
    throw new Error("EDINET日付一覧の物理保管が未証明です。");
  }
  await verifyArchivedAttachments(result.pageId, [file], "EDINET日付一覧");
  const snapshot: ListSnapshot = {date, pageId: result.pageId, filename,
    gzipSha256: await sha256HexBytes(bytes), rawSha256, rawBytes: observation.bytes.length,
    fetchedAt: observation.fetchedAt, httpStatus: observation.httpStatus, qualified: false};
  let list: EdinetListResponse;
  try {
    if (observation.httpStatus !== 200) throw new Error("HTTP資格未成立");
    list = parseOriginalList(observation.bytes, date);
  } catch {
    throw new EdinetListQualificationError(snapshot);
  }
  return {list, snapshot: {...snapshot, qualified: true}};
}

export async function readListSnapshot(snapshot: ListSnapshot): Promise<EdinetListResponse> {
  const expected = listSnapshotSchema.parse(snapshot);
  if (!expected.qualified || expected.httpStatus !== 200) throw new Error("EDINET保存一覧は未資格の原応答");
  if (expected.filename !== `edinet-list-${expected.date}.json.gz`) throw new Error("EDINET保存日付一覧のファイル名が不一致");
  const files = await listPageFiles(expected.pageId, "Files");
  if (files.length !== 1 || files[0].kind !== "file" || files[0].name !== expected.filename) {
    throw new Error("EDINET日付一覧の実添付が不一致です。");
  }
  const response = await fetch(files[0].url, {redirect: "manual", signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error("EDINET保存日付一覧の取得に失敗しました (再送なし)。");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256HexBytes(bytes) !== expected.gzipSha256) throw new Error("EDINET日付一覧gzip SHA不一致。");
  const raw = gunzipSync(bytes);
  if (raw.length !== expected.rawBytes || await sha256HexBytes(raw) !== expected.rawSha256) {
    throw new Error("EDINET日付一覧原HTTP本文のbytes/SHA不一致。");
  }
  return parseOriginalList(raw, expected.date);
}
