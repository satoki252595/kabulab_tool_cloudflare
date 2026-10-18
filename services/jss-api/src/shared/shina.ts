/** 定期producerが既に保管するJSF全体CSV。空欄/マスクを0にしない。 */
import { parseShina } from "./shina-parser";
export { assertShinaUnitNote, parseShina } from "./shina-parser";
import { boundedBytes } from "./jpx-margin";
import type { PrivateEnv } from "./types";

export async function shinaLatest(env: PrivateEnv): Promise<Record<string, unknown>[]> {
  const { results } = await env.DB.prepare("SELECT sha256, r2_bucket, r2_key, size_bytes, license_tag, ext, first_fetched_at, last_fetched_at, data_date FROM jss_raw_files WHERE source = ? AND datatype = ? AND scope = ? ORDER BY last_fetched_at DESC LIMIT 2").bind("日証金", "shina", "ALL").all<Record<string, unknown>>();
  if (!results.length) return [];
  const row = results[0]!;
  if (results.length > 1 && row.last_fetched_at === results[1]!.last_fetched_at) throw new Error("JSF shina最新原本が複数");
  if (row.r2_bucket !== "jp-stock-raw" || row.license_tag !== "personal-only" || row.ext !== "csv" || typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256) || typeof row.r2_key !== "string" || !/^raw\/_\/shina\/[0-9]{4}\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/ALL\/_\/[a-f0-9]{16}\.csv$/.test(row.r2_key) || typeof row.size_bytes !== "number" || !Number.isSafeInteger(row.size_bytes) || row.size_bytes <= 0 || row.size_bytes > 2 * 1024 ** 2 || typeof row.first_fetched_at !== "number" || !Number.isSafeInteger(row.first_fetched_at) || typeof row.last_fetched_at !== "number" || !Number.isSafeInteger(row.last_fetched_at) || row.first_fetched_at < 0 || row.first_fetched_at > row.last_fetched_at || row.last_fetched_at > 4102444800) throw new Error("JSF shina原本索引不正");
  const object = await env.RAW.get(row.r2_key);
  if (!object || object.size !== row.size_bytes) throw new Error("JSF shina原本実体不一致");
  const bytes = await boundedBytes(object, 2 * 1024 ** 2);
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
  if (sha !== row.sha256) throw new Error("JSF shina原本SHA不一致");
  const source = { raw_sha256: row.sha256, r2_key: row.r2_key, index_data_date: row.data_date, first_fetched_at: row.first_fetched_at, last_fetched_at: row.last_fetched_at };
  return parseShina(bytes).map(point => ({ ...point, source }));
}
