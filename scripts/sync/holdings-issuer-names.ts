/** 通常price window用。保存issuer有報だけを読み、同runの未知結果は再読しない。 */
import assert from "node:assert/strict";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import * as schema from "../../services/yuho-quant/src/db/schema.js";
import { selectLatestHoldingsDocuments } from "../../services/yuho-quant/data-scripts/lib/shareholdings-backfill.js";
import { readSavedHoldingsZip } from "../../src/shared/notion-archive/shareholdings.js";
import { qualifyOfficialIssuerEnglishName, type OfficialIssuerEnglishName } from "../../services/yuho-quant/src/services/edinet/shareholdings-issuer-names.js";
import { exactLegalName, type ListedIdentity } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
export interface OfficialNameTarget { identity: ListedIdentity; priceCapturedAt: string;
  /** Canonical split diagnostics may reuse a verified run-cache entry, never start issuer reads. */
  cacheOnly?: true }
type Latest = Awaited<ReturnType<typeof selectLatestHoldingsDocuments>>["rows"][number];
type Held = { status: "held"; reasonCode: "budget_exhausted" | "issuer_source_unavailable"; reason: string };
export function createHoldingOfficialNamesLoader() {
  let db: ReturnType<typeof createD1HttpDb<typeof schema>> | undefined;
  const cache = new Map<string, Promise<{ status: "verified"; evidence: OfficialIssuerEnglishName; latest: Latest } | Held>>();
  const latest = async (identity: ListedIdentity): Promise<Latest | undefined> => {
    db ??= createD1HttpDb(schema);
    const found = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 1, onlyCode: identity.code });
    assert.ok(found.rows.length <= 1);
    return found.rows[0];
  };
  return async (targets: readonly OfficialNameTarget[], budget: { remainingBytes: number }, shouldStop?: () => boolean): Promise<
    { status: "ready"; names: Map<string, OfficialIssuerEnglishName>; checkCurrent: () => Promise<{ status: "verified" } | Held> } | Held
  > => {
    const timeLimit = (): Held | undefined => shouldStop?.() ? { status: "held", reasonCode: "budget_exhausted", reason: "公式英字名の保存原本照合に使う実時間予算を使い切りました" } : undefined;
    const records: Array<{ evidence: OfficialIssuerEnglishName; latest: Latest; identity: ListedIdentity }> = [];
    for (const target of targets) {
      const key = `${target.identity.code}/${target.priceCapturedAt}`;
      let saved = cache.get(key);
      if (target.cacheOnly && saved === undefined) continue;
      if (saved === undefined) {
        const stopped = timeLimit(); if (stopped) return stopped;
        saved = (async () => {
          const row = await latest(target.identity);
          if (row === undefined || row.edinetCode !== target.identity.edinetCode || exactLegalName(row.ownerName) !== exactLegalName(target.identity.legalName)) return { status: "held" as const, reasonCode: "issuer_source_unavailable" as const, reason: "公式英字名の最新issuer/証券主体が一致しません" };
          const source = { docId: row.docId, stockCode: row.stockCode, edinetCode: row.edinetCode, fiscalYearEnd: row.fiscalYearEnd };
          const stopped = timeLimit(); if (stopped) return stopped;
          const archived = await readSavedHoldingsZip(source, budget);
          if (archived.status === "held") return { status: "held" as const, reasonCode: archived.reasonCode === "budget_exhausted" ? "budget_exhausted" as const : "issuer_source_unavailable" as const, reason: archived.reason };
          const name = qualifyOfficialIssuerEnglishName({ identity: target.identity, source, ownerName: row.ownerName,
            archived: { ...archived, filename: `${source.docId}_xbrl.zip` }, metadata: archived.metadata, fetchedAt: archived.fetchedAt, priceCapturedAt: target.priceCapturedAt });
          if (name.status === "held") return { status: "held" as const, reasonCode: "issuer_source_unavailable" as const, reason: name.reason };
          return { status: "verified" as const, evidence: name.evidence, latest: row };
        })();
        cache.set(key, saved);
      }
      const value = await saved;
      if (target.cacheOnly && value.status === "held") continue; // No verified evidence; retain unknown basis without a new read.
      if (value.status === "held") { if (value.reasonCode === "budget_exhausted") cache.delete(key); return value; }
      records.push({ ...value, identity: target.identity });
    }
    return { status: "ready", names: new Map(records.map(record => [record.identity.code, record.evidence])), checkCurrent: async () => {
      for (const record of records) {
        const stopped = timeLimit(); if (stopped) return stopped;
        const current = await latest(record.identity);
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(record.latest)) return { status: "held", reasonCode: "issuer_source_unavailable", reason: "公式英字名の最新issuer有報/主体が開始時から変化しました" };
      }
      const stopped = timeLimit(); if (stopped) return stopped;
      return { status: "verified" };
    } };
  };
}
