/** One-off F-01/F-15 quarantine. Default is SELECT/GET only; never invent prices/EPS.
 * nix develop --command pnpm exec tsx --env-file=.env scripts/sync/repair-market-20260928.ts --plan=/private/tmp/<dir>/plan.json
 * After review, --apply reuses that private plan. --verify performs fresh reads only.
 * Pause source sync/VWAP writers before apply; resume only after the shared Yahoo guards deploy.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq, getTableColumns, isNull } from "drizzle-orm";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import { stocks, stockFinancials } from "../../src/shared/db/core-schema.js";
import { momentumProjection } from "../../src/shared/db/projection-schema.js";
import { stockIndicators } from "../../services/swing-trading/src/db/schema.js";
import { stockRsiPercentile } from "../../services/rsi-screening/src/db/schema.js";
import {
  listPageFiles,
  moveToTrash,
  recordPrimaryData,
} from "../../src/shared/notion-archive/index.js";
import { sharedEnv } from "../../src/shared/env.js";
import { r2GetVersion, r2Put } from "../vwap/lib/r2.js";

const tables = {
  indicators: stockIndicators,
  rsi: stockRsiPercentile,
  momentum: momentumProjection,
  financials: stockFinancials,
};
type Kind = keyof typeof tables;
type Row = Record<string, unknown>;
type Db = ReturnType<typeof createD1HttpDb>;
export type Plan = {
  databaseId: string;
  bucket: string;
  rows: { code: string; kind: Kind; before: Row }[];
  objects: { code: string; key: string; before: string; after: string }[];
};

export const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
// Exact audited objects, not a ticker rule in a permanent ingestion path.
const originals = {
  "1909": {
    hash: "c16fa1514e7e4639e8a74f1f422a9dffb114248c74c4f3034ad07f22c2f2f5a4",
    first: "2026-08-14",
    last: "2026-09-14",
    splitDate: "2026-09-14",
    ratio: 1 / 4400000,
  },
  "2180": {
    hash: "7f3cb7ac7126ca07a2011783211215d384e6036c19f30ee0e2b47077288507c8",
    first: "2026-08-17",
    last: "2026-09-15",
    splitDate: "2026-09-16",
    ratio: 1 / 1440960,
  },
} as const;
const badCaps = { "1909": 22200, "2180": 13090, "7426": 1182 } as const;
const badEps = {
  "1909": 846560000,
  "2180": -36968876,
  "7426": -140379024,
} as const;

export function repairObject(
  code: keyof typeof originals,
  before: string,
): string {
  const known = originals[code];
  if (sha(before) !== known.hash)
    throw new Error(`repair original changed: ${code}`);
  const object = JSON.parse(before);
  const tail = object.bars.slice(-22);
  if (
    object.code !== code ||
    tail.length !== 22 ||
    tail[0].date !== known.first ||
    tail[21].date !== known.last ||
    tail.some((b: { v: number }) => b.v !== 0)
  )
    throw new Error(`repair tail mismatch: ${code}`);
  const corruptSplits = object.splits.filter(
    (s: { date: string; ratio: number }) =>
      s.date === known.splitDate && s.ratio === known.ratio,
  );
  if (corruptSplits.length !== 1)
    throw new Error(`repair split mismatch: ${code}`);
  return JSON.stringify({
    ...object,
    bars: object.bars.slice(0, -22),
    splits: object.splits.filter(
      (s: { date: string; ratio: number }) =>
        !(s.date === known.splitDate && s.ratio === known.ratio),
    ),
  });
}

async function readRow(
  db: Db,
  kind: Kind,
  stockId: number,
): Promise<Row | null> {
  const table = tables[kind];
  const rows = await db.select().from(table).where(eq(table.stockId, stockId));
  if (rows.length > 1) throw new Error("repair row is not unique");
  return rows.length === 0 ? null : rows[0];
}

export async function preparePlan(
  db: Db,
  databaseId: string,
  bucket: string,
): Promise<Plan> {
  const plan: Plan = { databaseId, bucket, rows: [], objects: [] };
  for (const code of Object.keys(badCaps) as (keyof typeof badCaps)[]) {
    const found = await db
      .select({ id: stocks.id })
      .from(stocks)
      .where(eq(stocks.code, code));
    if (found.length !== 1) throw new Error(`repair stock missing: ${code}`);
    const financial = await readRow(db, "financials", found[0].id);
    if (
      !financial ||
      financial.marketCap !== badCaps[code] ||
      financial.eps !== badEps[code] ||
      financial.dataDate !== "2026-09-25"
    )
      throw new Error(`repair financial evidence changed: ${code}`);
    plan.rows.push({ code, kind: "financials", before: financial });
    if (code === "7426") continue;
    for (const kind of ["indicators", "rsi", "momentum"] as const) {
      // 2180 RSI は破損由来未証明。監査済み対象だけを隔離する。
      if (code === "2180" && kind === "rsi") continue;
      const row = await readRow(db, kind, found[0].id);
      if (!row) throw new Error(`repair derived row missing: ${code}/${kind}`);
      plan.rows.push({ code, kind, before: row });
    }
    const original = await r2GetVersion(`daily/${code}.json`);
    if (!original) throw new Error(`repair R2 original missing: ${code}`);
    plan.objects.push({
      code,
      key: `daily/${code}.json`,
      before: original.body,
      after: repairObject(code, original.body),
    });
  }
  return plan;
}

function expected(row: Plan["rows"][number]): Row | null {
  return row.kind === "financials"
    ? { ...row.before, per: null, eps: null, marketCap: null }
    : null;
}

export async function inspectPlan(db: Db, plan: Plan): Promise<void> {
  const combinations = new Set<string>();
  for (const row of plan.rows) {
    if (
      !(row.code in badCaps) ||
      !(row.kind in tables) ||
      (row.code === "7426" && row.kind !== "financials") ||
      (row.code === "2180" && row.kind === "rsi")
    )
      throw new Error("repair row target invalid");
    const combination = `${row.code}/${row.kind}`;
    if (combinations.has(combination))
      throw new Error("repair row target duplicate");
    combinations.add(combination);
    const owner = await db
      .select({ id: stocks.id })
      .from(stocks)
      .where(eq(stocks.code, row.code));
    if (owner.length !== 1 || owner[0].id !== row.before.stockId)
      throw new Error("repair stock ownership changed");
    if (
      row.kind === "financials" &&
      (row.before.marketCap !== badCaps[row.code as keyof typeof badCaps] ||
        row.before.eps !== badEps[row.code as keyof typeof badEps] ||
        row.before.dataDate !== "2026-09-25")
    )
      throw new Error("repair financial original mismatch");
  }
  if (combinations.size !== 8) throw new Error("repair row targets incomplete");
  for (const row of plan.rows) {
    const current = await readRow(db, row.kind, Number(row.before.stockId));
    if (!same(current, row.before) && !same(current, expected(row)))
      throw new Error(`repair row changed: ${row.code}/${row.kind}`);
  }
  for (const object of plan.objects) {
    const current = await r2GetVersion(object.key);
    if (
      !current ||
      (sha(current.body) !== sha(object.before) &&
        sha(current.body) !== sha(object.after))
    )
      throw new Error(`repair object changed: ${object.code}`);
  }
}

// All columns participate in CAS, including timestamps/NULLs; changes to normal columns stop us.
export function rowCas(table: AnySQLiteTable, before: Row) {
  const columns = getTableColumns(table);
  if (!same(Object.keys(before), Object.keys(columns)))
    throw new Error("repair row schema changed");
  return and(
    ...Object.entries(columns).map(([key, col]) =>
      before[key] === null ? isNull(col) : eq(col, before[key]),
    ),
  );
}

export async function applyRows(db: Db, plan: Plan): Promise<void> {
  for (const row of plan.rows) {
    const current = await readRow(db, row.kind, Number(row.before.stockId));
    if (same(current, expected(row))) continue;
    if (!same(current, row.before) || current === null)
      throw new Error(`repair row CAS changed: ${row.code}/${row.kind}`);
    const table = tables[row.kind];
    const predicate = rowCas(table, current);
    const changed =
      row.kind === "financials"
        ? await db
            .update(stockFinancials)
            .set({ per: null, eps: null, marketCap: null })
            .where(predicate)
            .returning({ id: stockFinancials.stockId })
        : await db
            .delete(table)
            .where(predicate)
            .returning({ id: table.stockId });
    if (changed.length !== 1)
      throw new Error(`repair row CAS refused: ${row.code}/${row.kind}`);
  }
}

export async function verifyPlan(db: Db, plan: Plan): Promise<void> {
  for (const row of plan.rows)
    if (
      !same(
        await readRow(db, row.kind, Number(row.before.stockId)),
        expected(row),
      )
    )
      throw new Error(`repair row verify failed: ${row.code}/${row.kind}`);
  for (const object of plan.objects) {
    const fresh = await r2GetVersion(object.key);
    if (!fresh || sha(fresh.body) !== sha(object.after))
      throw new Error(`repair object verify failed: ${object.code}`);
  }
}

async function privateWrite(file: string, body: string) {
  const temporary = `${file}.new`;
  await fs.writeFile(temporary, body, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}

/** Private sidecar contains fixed comparison labels/API metadata, never response text. */
export function failureMetadata(error: unknown, phase: string) {
  const diagnostic: Record<string, unknown> = { phase, errorClass: "Error" };
  const archiveCauses: Record<string, string> = {
    "moveToTrash: trash状態が未確認のため保全停止": "archive_state_unknown",
    "moveToTrash: 元ページのID・Service・URL・Filesが不一致のため保全停止":
      "archive_origin_mismatch",
    "moveToTrash: 元はtrashですが退避先が見つからないため保全停止":
      "archive_copy_missing",
    "moveToTrash: 退避先の所有元・原本材料・添付が不一致のため保全停止":
      "archive_copy_mismatch",
    "moveToTrash: 元ページのtrash完了を再読確認できず保全停止":
      "archive_origin_not_trashed",
    "moveToTrash: 退避先の物理ファイルSHA不一致のため元原本を保持して保全停止":
      "archive_bytes_mismatch",
  };
  for (let i = 0; i < 4 && error instanceof Error; i++, error = error.cause) {
    if (
      /^(Error|TypeError|SyntaxError|RangeError|NotionConfigError|PreconditionFailed|AccessDenied|NoSuchKey|TimeoutError|AbortError)$/.test(
        error.name,
      )
    )
      diagnostic.errorClass = error.name;
    const comparison = error.message.match(
      new RegExp(
        "^repair (original changed|tail mismatch|split mismatch|row is not unique|stock missing|financial evidence changed|derived row missing|" +
          "row target invalid|row target duplicate|stock ownership changed|financial original mismatch|row targets incomplete|row changed|object changed|" +
          "row schema changed|row CAS changed|row CAS refused|row verify failed|object verify failed|target/plan mismatch|object targets incomplete|" +
          "plan object mismatch|object disappeared|object CAS changed|object fresh read failed|receipt mismatch|archive file missing or duplicate|" +
          "archive bytes mismatch|archive download failed|original upload incomplete|receipt missing origin|receipt trash mismatch)(: (1909|2180|7426)(/(indicators|rsi|momentum|financials))?)?$",
      ),
    );
    if (comparison) diagnostic.rootCause = comparison[0];
    if (Object.hasOwn(archiveCauses, error.message))
      diagnostic.rootCause = archiveCauses[error.message];
    if (
      error.message.startsWith(
        "Notion archive: 同一 Key の重複を選ばず保全停止 database=",
      )
    )
      diagnostic.rootCause = "archive_key_ambiguous";
    if (
      error.message.startsWith(
        "moveToTrash: 物理ファイルURL欠損のため保全停止 name=",
      )
    )
      diagnostic.rootCause = "archive_file_url_missing";
    if (error.message.startsWith("moveToTrash: 物理ファイル取得失敗 name="))
      diagnostic.rootCause = "archive_file_http_failed";
    const api = error as Error & {
      code?: string;
      status?: number;
      $metadata?: { httpStatusCode?: number; requestId?: string };
    };
    const status =
      api.$metadata?.httpStatusCode ??
      api.status ??
      Number(
        error.message.match(
          /^(?:D1 HTTP |Notion API エラー .*?status=|moveToTrash: 物理ファイル取得失敗 .*?status=)(\d{3})\b/,
        )?.[1],
      );
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      diagnostic.status = status;
    const code =
      api.code ??
      error.message.match(/^Notion API エラー .*? code=([a-z_]+)\b/)?.[1];
    if (
      code &&
      /^(ENOENT|EACCES|EEXIST|ENOSPC|ECONNRESET|ETIMEDOUT|PreconditionFailed|AccessDenied|NoSuchKey|validation_error|unauthorized|restricted_resource|object_not_found|conflict_error|rate_limited|internal_server_error|service_unavailable)$/.test(
        code,
      )
    )
      diagnostic.code = code;
    const requestId = api.$metadata?.requestId;
    if (requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId))
      diagnostic.requestId = requestId;
  }
  return diagnostic;
}

let phase = "arguments";
let failureFile: string | undefined;

async function verifyArchive(pageId: string, name: string, hash: string) {
  const files = (await listPageFiles(pageId, "Files")).filter(
    (f) => f.name === name,
  );
  if (files.length !== 1)
    throw new Error("repair archive file missing or duplicate");
  const response = await fetch(files[0].url);
  if (!response.ok)
    throw Object.assign(new Error("repair archive download failed"), {
      status: response.status,
    });
  if (sha(new Uint8Array(await response.arrayBuffer())) !== hash)
    throw new Error("repair archive bytes mismatch");
}

async function main() {
  const args = process.argv.slice(2);
  const planFile = args.find((a) => a.startsWith("--plan="))?.slice(7);
  if (
    !planFile ||
    !path.isAbsolute(planFile) ||
    args.some(
      (a) => !a.startsWith("--plan=") && a !== "--apply" && a !== "--verify",
    ) ||
    (args.includes("--apply") && args.includes("--verify"))
  )
    throw new Error("usage: --plan=<absolute private path> [--apply|--verify]");
  const directory = path.dirname(planFile);
  if (!directory.startsWith("/private/tmp/") && !directory.startsWith("/tmp/"))
    throw new Error("repair plan must use private /tmp directory outside Git");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  failureFile = `${planFile}.failure.json`;
  phase = "configuration";
  const db = createD1HttpDb(tables);
  const databaseId = sharedEnv.D1_DATABASE_ID(),
    bucket = sharedEnv.R2_BUCKET();
  if (!args.includes("--apply") && !args.includes("--verify")) {
    phase = "prepare";
    const plan = await preparePlan(db, databaseId, bucket);
    // Refuse replacing a previously reviewed snapshot.
    await fs.writeFile(planFile, JSON.stringify(plan), {
      flag: "wx",
      mode: 0o600,
    });
    console.info(
      JSON.stringify({
        mode: "read-only",
        planHash: sha(JSON.stringify(plan)),
        rows: plan.rows.length,
        objects: plan.objects.length,
      }),
    );
    return;
  }
  const bytes = await fs.readFile(planFile, "utf8");
  phase = "plan-validation";
  const plan = JSON.parse(bytes) as Plan;
  if (
    plan.databaseId !== databaseId ||
    plan.bucket !== bucket ||
    plan.rows.length !== 8 ||
    plan.objects.length !== 2
  )
    throw new Error("repair target/plan mismatch");
  if (new Set(plan.objects.map((o) => o.code)).size !== 2)
    throw new Error("repair object targets incomplete");
  for (const object of plan.objects)
    if (
      !(object.code in originals) ||
      object.key !== `daily/${object.code}.json` ||
      repairObject(object.code as keyof typeof originals, object.before) !==
        object.after
    )
      throw new Error("repair plan object mismatch");
  if (args.includes("--verify")) {
    phase = "verification";
    await inspectPlan(db, plan);
    await verifyPlan(db, plan);
    console.info(
      JSON.stringify({
        mode: "verified",
        planHash: sha(bytes),
        rows: 8,
        objects: 2,
      }),
    );
    return;
  }
  if (sharedEnv.LOCAL_OUT())
    throw new Error("repair apply requires actual R2 conditional writes");
  phase = "pre-archive-inspection";
  await inspectPlan(db, plan);
  phase = "physical-archive";
  await archiveOriginals(bytes, `${planFile}.receipt.json`);
  // Recheck after Notion's multi-call archive, then CAS each native target.
  phase = "post-archive-inspection";
  await inspectPlan(db, plan);
  for (const object of plan.objects) {
    phase = `r2-conditional-write/${object.code}`;
    const current = await r2GetVersion(object.key);
    if (!current) throw new Error("repair object disappeared");
    if (sha(current.body) === sha(object.after)) continue;
    if (sha(current.body) !== sha(object.before))
      throw new Error("repair object CAS changed");
    await r2Put(object.key, object.after, current.etag);
    const fresh = await r2GetVersion(object.key);
    if (!fresh || sha(fresh.body) !== sha(object.after))
      throw new Error("repair object fresh read failed");
  }
  phase = "d1-row-cas";
  await applyRows(db, plan);
  phase = "final-verification";
  await verifyPlan(db, plan);
  console.info(
    JSON.stringify({
      mode: "applied-verified",
      planHash: sha(bytes),
      rows: 8,
      objects: 2,
    }),
  );
}

export async function archiveOriginals(
  bytes: string,
  receiptFile: string,
): Promise<void> {
  let receipt: {
    planHash: string;
    originPageId?: string;
    trashPageId?: string;
  };
  try {
    receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    receipt = { planHash: sha(bytes) };
  }
  if (receipt.planHash !== sha(bytes))
    throw new Error("repair receipt mismatch");
  const filename = "market-repair-originals-20260928.json";
  // Validate the known physical copy first; moveToTrash still completes/rechecks its origin.
  if (receipt.trashPageId) {
    await verifyArchive(receipt.trashPageId, filename, sha(bytes));
    if (!receipt.originPageId) throw new Error("repair receipt missing origin");
  }
  if (!receipt.originPageId) {
    const recorded = await recordPrimaryData({
      service: "vwap-analysis",
      key: `repair-20260928-${sha(bytes)}`,
      source:
        "audited D1 derived rows/core fields and R2 daily original objects",
      metadata: {
        planHash: sha(bytes),
        rows: 8,
        objects: 2,
        reason:
          "F-01/F-15 corrupt source values; quarantine without inferred replacement",
      },
      files: [
        {
          filename,
          contentType: "application/json",
          bytes: new TextEncoder().encode(bytes),
        },
      ],
    });
    if (recorded.fileTooLarge)
      throw new Error("repair original upload incomplete");
    receipt.originPageId = recorded.pageId;
    await privateWrite(receiptFile, JSON.stringify(receipt));
  }
  if (!receipt.trashPageId)
    await verifyArchive(receipt.originPageId, filename, sha(bytes));
  const moved = await moveToTrash({
    service: "vwap-analysis",
    originPageId: receipt.originPageId,
    reason:
      "F-01/F-15: remove only audited corrupt derived rows/tails and set corrupt core per/eps/market_cap to NULL; normal history and columns retained",
  });
  if (receipt.trashPageId && receipt.trashPageId !== moved.trashPageId)
    throw new Error("repair receipt trash mismatch");
  receipt.trashPageId = moved.trashPageId;
  await privateWrite(receiptFile, JSON.stringify(receipt));
  await verifyArchive(receipt.trashPageId, filename, sha(bytes));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch(async (error: unknown) => {
    if (failureFile) {
      try {
        await privateWrite(
          failureFile,
          JSON.stringify(failureMetadata(error, phase)),
        );
      } catch {
        console.error("market repair private diagnostic could not be saved");
      }
    }
    console.error(
      "market repair stopped; no raw diagnostics printed; inspect private plan/receipt/failure sidecar and re-run read-only verification",
    );
    process.exitCode = 1;
  });
