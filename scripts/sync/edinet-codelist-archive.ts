/**
 * EDINET コードリストの原本 custody 薄 CLI。
 * Python の sector33_sync が subprocess で呼ぶ 1 経路。
 * shared recordPrimaryData (force:false) → unique + physical/full-bytes-SHA
 * verify が成功した場合のみ D1 writer へ進んでよい。
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
import { listPageFiles } from "../../src/shared/notion-archive/page-file.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";

export interface ArchiveFileRef {
  name: string;
  kind: string;
  url: string;
}

export interface ArchiveDeps {
  record: typeof recordPrimaryData;
  findDb: (service: string) => Promise<string | null>;
  queryUnique: (dbId: string, key: string) => Promise<{ id: string } | null>;
  listFiles: (pageId: string) => Promise<readonly ArchiveFileRef[]>;
  download: (url: string) => Promise<Uint8Array>;
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
  files?: { name: string; bytes: number; sha256: string }[];
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
  const hosted = await deps.listFiles(row.id);
  const want = new Map([
    [input.zipName, input.zipBytes],
    [input.manifestName, input.manifestBytes],
  ]);
  if (hosted.length !== want.size) {
    return fail(`添付 ${hosted.length} 件 ≠ 記録 ${want.size} 件`);
  }
  const verified: { name: string; bytes: number; sha256: string }[] = [];
  for (const h of hosted) {
    const expected = want.get(h.name);
    if (!expected) return fail(`想定外の添付「${h.name}」`);
    if (h.kind !== "file") return fail(`「${h.name}」が hosted 添付ではない`);
    let bytes: Uint8Array;
    try {
      bytes = await deps.download(h.url);
    } catch (e) {
      return fail(`「${h.name}」の再取得に失敗: ${e instanceof Error ? e.message : e}`);
    }
    if (bytes.length !== expected.length) {
      return fail(`「${h.name}」のバイト長 ${bytes.length} ≠ ${expected.length}`);
    }
    const [got, wantSha] = await Promise.all([
      sha256HexBytes(Uint8Array.from(bytes)),
      sha256HexBytes(Uint8Array.from(expected)),
    ]);
    if (got !== wantSha) return fail(`「${h.name}」の SHA256 不一致`);
    verified.push({ name: h.name, bytes: bytes.length, sha256: got });
  }
  return { ok: true, outcome: rec.outcome, pageId: rec.pageId, verified: true, files: verified };
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
  listFiles: (pageId) => listPageFiles(pageId, "Files"),
  download: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status=${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
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
