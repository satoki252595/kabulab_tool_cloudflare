/** GH既存SecretsでD1索引済み原本1件だけGETする。Notion/source取得・mutationなし。 */
import "dotenv/config";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertD1SingleQueryResponse, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { sharedEnv } from "../../src/shared/env.js";
import { r2GetBytesVersion } from "../vwap/lib/r2.js";

export async function checkKnownRawObject() {
  if (sharedEnv.LOCAL_OUT() !== undefined) throw new Error("[raw-check] LOCAL_OUT previewはremote認証の証明にできません");
  const bucket = sharedEnv.R2_BUCKET_RAW(), start = performance.now();
  const response = await fetch(d1HttpQueryUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: "SELECT sha256,r2_key,size_bytes,r2_bucket FROM jss_raw_files WHERE r2_bucket=? AND size_bytes BETWEEN 1 AND 1048576 ORDER BY size_bytes ASC,sha256 ASC LIMIT 1", params: [bucket] }),
  });
  if (!response.ok) throw new Error(`[raw-check] D1 read HTTP ${response.status}`);
  const rows = assertD1SingleQueryResponse(await response.json());
  if (rows.length !== 1) throw new Error("[raw-check] 診断対象となる既存索引1件を確定できません");
  const row = rows[0]!;
  if (typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) ||
      typeof row.r2_key !== "string" || !row.r2_key.startsWith("raw/") || row.r2_bucket !== bucket ||
      typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > 1048576) {
    throw new Error("[raw-check] 既存原本索引の型/範囲が不正です");
  }
  const found = await r2GetBytesVersion(row.r2_key, bucket, { singleAttempt: true });
  if (found === null) throw new Error("[raw-check] 既存索引先のR2原本がありません");
  const digest = createHash("sha256").update(found.body).digest("hex");
  if (found.body.length !== row.size_bytes || digest !== row.sha256) throw new Error("[raw-check] 原本全文SHA/サイズが索引と不一致です");
  return { status: "verified", bytes: found.body.length, sha256: digest, sha256Matched: true,
    observedETagPresent: found.etag.length > 0, r2Gets: 1, d1RowsReturned: rows.length,
    sourceGets: 0, mutations: 0, elapsedMs: performance.now() - start };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkKnownRawObject().then((result) => console.info(JSON.stringify(result))).catch((error: unknown) => {
    // SDKの生message/causeにはendpointや資格情報が含まれ得る。固定診断文/型だけを出す。
    const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "unknown";
    const detail = error instanceof Error && error.message.startsWith("[raw-check]") ? error.message : name;
    console.error(JSON.stringify({ status: "failed", detail, sourceGets: 0, mutations: 0 }));
    process.exitCode = 1;
  });
}
