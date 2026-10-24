/** JPXの現在掲載版を発見・受領するだけ。株式種別・権利係数・価格適用は資格化しない。 */
import assert from "node:assert/strict";
import { assertPageTitle, extractTables, parseIsoDate } from "./official-html.js";
import { ScheduledSourceDeadlineError } from "../scheduled-admission.js";

export const EX_RIGHTS_LIMITS = Object.freeze({ sources: 6, versions: 5, indexBytes: 1024 ** 2, xlsBytes: 4 * 1024 ** 2, timeoutMs: 30_000 });
export interface ExRightsVersion { announcedDate: string; url: string }
export interface ExRightsSource {
  url: string;
  announcedDate: string | null;
  fetchedAt: string;
  status: number | null;
  contentType: string | null;
  lastModified: string | null;
  /** 受領したprefixも破棄しない。complete=falseなら全原本とは扱わない。 */
  bytes: Uint8Array | null;
  complete: boolean;
  failure: "not-started" | "transport" | "body-limit" | "http" | "format" | null;
}

/** 実HTMLの唯一component-file/2列表だけ。リンク0・重複・未来日・推定URLを許さない。 */
export function assertExRightsIndexUrl(input: string): void {
  const url = new URL(input);
  assert.equal(url.origin, "https://www.jpx.co.jp");
  assert.equal(url.pathname, "/listing/others/ex-rights/index.html");
  assert.equal(url.search, ""); assert.equal(url.hash, ""); assert.equal(url.username, ""); assert.equal(url.password, "");
  assert.equal(url.href, input);
}

export function parseExRightsIndex(bytes: Uint8Array, fetchedDateJST: string, indexUrl: string): ExRightsVersion[] {
  assertExRightsIndexUrl(indexUrl);
  assert.equal(parseIsoDate(fetchedDateJST), fetchedDateJST);
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertPageTitle(html, "配当落・権利落等情報", "JPX ex-rights");
  const components = [...html.matchAll(/<div\b[^>]*class="component-file"[^>]*>([\s\S]*?)<\/div\s*>/gi)];
  assert.equal(components.length, 1, "権利落情報の添付表が唯一ではありません");
  const tables = extractTables(components[0][1]); assert.equal(tables.length, 1);
  const rows = [...tables[0].head, ...tables[0].body];
  assert(rows.length >= 1 && rows.length <= EX_RIGHTS_LIMITS.versions);
  const versions = rows.map(row => {
    assert.equal(row.length, 2);
    const date = /^(\d{4})年(\d{1,2})月(\d{1,2})日公表分$/.exec(row[0].text); assert(date);
    const announcedDate = `${date[1]}-${date[2].padStart(2, "0")}-${date[3].padStart(2, "0")}`;
    assert.equal(parseIsoDate(announcedDate), announcedDate); assert(announcedDate <= fetchedDateJST);
    const anchors = [...row[1].html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a\s*>/gi)]; assert.equal(anchors.length, 1);
    const url = new URL(anchors[0][1], indexUrl);
    assert.equal(url.origin, "https://www.jpx.co.jp"); assert.equal(url.search, ""); assert.equal(url.hash, "");
    assert.equal(url.username, ""); assert.equal(url.password, "");
    assert.match(url.pathname, /^\/listing\/others\/ex-rights\/[a-z0-9]+-att\/\d{8}\.xls$/);
    assert(url.pathname.endsWith(`/${announcedDate.replaceAll("-", "")}.xls`));
    return { announcedDate, url: url.href };
  });
  assert.equal(new Set(versions.map(v => v.announcedDate)).size, versions.length);
  assert.equal(new Set(versions.map(v => v.url)).size, versions.length);
  for (let i = 1; i < versions.length; i++) assert(versions[i - 1].announcedDate > versions[i].announcedDate);
  return versions;
}

/** 既存Notion clientの外で行う公式source GET。最大6件・直列・各30秒・redirect/retry0。 */
export async function fetchExRightsSource(indexUrl: string, version: ExRightsVersion | null, beforeSourceRequest?: () => void): Promise<ExRightsSource> {
  assertExRightsIndexUrl(indexUrl);
  const url = version === null ? indexUrl : version.url;
  if (version !== null) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, new URL(indexUrl).origin);
    assert.equal(parsed.username, ""); assert.equal(parsed.password, "");
    assert.equal(parsed.search, ""); assert.equal(parsed.hash, "");
    assert.equal(parseIsoDate(version.announcedDate), version.announcedDate);
    assert.match(parsed.pathname, /^\/listing\/others\/ex-rights\/[a-z0-9]+-att\/\d{8}\.xls$/);
    assert(parsed.pathname.endsWith(`/${version.announcedDate.replaceAll("-", "")}.xls`));
  }
  const out: ExRightsSource = { url, announcedDate: version === null ? null : version.announcedDate,
    fetchedAt: new Date().toISOString(), status: null, contentType: null, lastModified: null, bytes: null, complete: false, failure: null };
  const maximum = version === null ? EX_RIGHTS_LIMITS.indexBytes : EX_RIGHTS_LIMITS.xlsBytes;
  const parts: Uint8Array[] = []; let retained = 0;
  try { beforeSourceRequest?.(); }
  catch (error) {
    if (!(error instanceof ScheduledSourceDeadlineError)) throw error;
    out.failure = "not-started";
    return out;
  }
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(EX_RIGHTS_LIMITS.timeoutMs),
      headers: { "user-agent": "kabulab-rights-custody/1.0" } });
    out.status = response.status; out.contentType = response.headers.get("content-type"); out.lastModified = response.headers.get("last-modified");
    const reader = response.body?.getReader();
    if (reader !== undefined) {
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          const room = maximum - retained;
          if (part.value.length > room) { parts.push(part.value.slice(0, room)); retained += room; out.failure = "body-limit"; await reader.cancel(); break; }
          parts.push(part.value); retained += part.value.length;
        }
      } finally { reader.releaseLock(); }
    }
    out.bytes = new Uint8Array(retained); let offset = 0;
    for (const part of parts) { out.bytes.set(part, offset); offset += part.length; }
    if (out.failure !== null) return out;
    out.complete = true;
    if (response.status !== 200) { out.failure = "http"; return out; }
    const mime = out.contentType === null ? null : out.contentType.split(";")[0].trim().toLowerCase();
    if (version === null ? mime !== "text/html" : mime !== "application/vnd.ms-excel" ||
        ![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, i) => out.bytes![i] === value)) out.failure = "format";
  } catch {
    // bodyの無いtransport failureと、受領途中のprefixを区別する。
    if (out.status !== null) { out.bytes = new Uint8Array(retained); let offset = 0; for (const part of parts) { out.bytes.set(part, offset); offset += part.length; } }
    if (out.failure !== "body-limit") out.failure = "transport";
  }
  return out;
}
