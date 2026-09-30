/**
 * EDINET コードリストの原本 custody 薄 CLI。
 * Python の sector33_sync が subprocess で呼ぶ 1 経路。
 * shared recordPrimaryData (force:false) → 既存 queryUnique (unique) →
 * 既存 verifyArchivedAttachments (unique filename + full bytes) が成功した
 * 場合のみ D1 writer へ進んでよい。自前の list/download/SHA ループは持たない。
 * stdout は結果 JSON の 1 行のみ。診断は stderr。成功で exit 0、 else exit 1。
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sha256HexBytes } from "../../src/shared/sha256.js";
import {
  findBackupChildByTitle,
  queryUniqueRow,
  recordPrimaryData,
} from "../../src/shared/notion-archive/archive.js";
import { verifyArchivedAttachments } from "../../src/shared/notion-archive/readback.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";

export interface ArchiveDeps {
  record: typeof recordPrimaryData;
  findDb: (service: string) => Promise<string | null>;
  queryUnique: (dbId: string, key: string) => Promise<{ id: string } | null>;
}

export interface ArchiveInput {
  key: string;
  source: string;
  service: string;
  zipName: string;
  zipBytes: Uint8Array;
  manifestName: string;
  manifestBytes: Uint8Array;
  metadata: Record<string, unknown>;
}

export interface ArchiveResult {
  ok: boolean;
  outcome?: "recorded" | "skipped_existing";
  pageId?: string;
  verified: boolean;
  reason?: string;
}

const fail = (reason: string): ArchiveResult => ({ ok: false, verified: false, reason });

export async function archiveAndVerify(
  input: ArchiveInput,
  deps: ArchiveDeps
): Promise<ArchiveResult> {
  // record は 1 回だけ。再 POST・代替 key は作らない。
  let rec: Awaited<ReturnType<ArchiveDeps["record"]>>;
  try {
    rec = await deps.record({
      service: input.service,
      key: input.key,
      source: input.source,
      force: false,
      metadata: input.metadata,
      files: [
        { bytes: input.zipBytes, filename: input.zipName, contentType: "application/zip" },
        { bytes: input.manifestBytes, filename: input.manifestName, contentType: "application/json" },
      ],
    });
  } catch (e) {
    return fail(`record 失敗: ${e instanceof Error ? e.message : e}`);
  }
  if (rec.fileTooLarge) return fail("fileTooLarge (物理 custody 不完全)");
  let dbId: string | null;
  try {
    dbId = await deps.findDb(input.service);
  } catch (e) {
    return fail(`DB 解決に失敗: ${e instanceof Error ? e.message : e}`);
  }
  if (!dbId) return fail("service DB が無い");
  let row: { id: string } | null;
  try {
    row = await deps.queryUnique(dbId, input.key);
  } catch (e) {
    return fail(`unique 検証に失敗 (重複の疑い): ${e instanceof Error ? e.message : e}`);
  }
  if (!row) return fail("同 run で行を再取得できない");
  if (row.id !== rec.pageId) return fail("再取得した行が記録 page と不一致");
  try {
    await verifyArchivedAttachments(
      row.id,
      [
        { filename: input.zipName, bytes: input.zipBytes },
        { filename: input.manifestName, bytes: input.manifestBytes },
      ],
      "edinet-codelist-archive"
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return { ok: true, outcome: rec.outcome, pageId: rec.pageId, verified: true };
}

export function parseArchiveArgs(argv: readonly string[]): {
  key: string;
  source: string;
  service: string;
  zip: string;
  manifest: string;
  asOf: string;
  completedAt: string;
} {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };
  const key = get("key");
  const source = get("source");
  const zip = get("zip");
  const manifest = get("manifest");
  const asOf = get("as-of");
  const completedAt = get("completed-at");
  if (!key || !source || !zip || !manifest || !asOf || !completedAt) {
    throw new Error(
      "必須: --key= --source= --zip= --manifest= --as-of= --completed-at= (任意: --service=)"
    );
  }
  return { key, source, service: get("service") ?? "universe", zip, manifest, asOf, completedAt };
}

const realDeps: ArchiveDeps = {
  record: recordPrimaryData,
  findDb: (service) =>
    findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
      title: `一次データ｜${service}`,
      kind: "database",
    }),
  queryUnique: (dbId, key) =>
    queryUniqueRow<{ id: string }>(
      dbId,
      { property: "Key", title: { equals: key } },
      "edinet-codelist-archive: 同 run の unique 検証"
    ),
};

async function main(): Promise<number> {
  let result: ArchiveResult;
  try {
    const args = parseArchiveArgs(process.argv.slice(2));
    const zipBytes = new Uint8Array(readFileSync(args.zip));
    const manifestBytes = new Uint8Array(readFileSync(args.manifest));
    const zipName = args.zip.split("/").pop() ?? "Edinetcode.zip";
    const manifestName = args.manifest.split("/").pop() ?? "manifest.json";
    result = await archiveAndVerify(
      {
        key: args.key,
        source: args.source,
        service: args.service,
        zipName,
        zipBytes,
        manifestName,
        manifestBytes,
        metadata: {
          asOf: args.asOf,
          bytes: zipBytes.length,
          sha256: await sha256HexBytes(Uint8Array.from(zipBytes)),
          completedAt: args.completedAt,
        },
      },
      realDeps
    );
  } catch (e) {
    result = fail(e instanceof Error ? e.message : String(e));
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok && result.verified ? 0 : 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stdout.write(`${JSON.stringify(fail(e instanceof Error ? e.message : String(e)))}\n`);
      process.exit(1);
    }
  );
}
