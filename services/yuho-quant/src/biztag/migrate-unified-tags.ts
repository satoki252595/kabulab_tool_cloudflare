/**
 * 事業タグ1列化のデータ移行: 旧3列の和集合を統合列「事業タグ」へコピーする。
 *
 * - dry-run (既定) は読み取りのみ。スキーマも作らない (列追加は apply 時の
 *   ensureSupplementDb が行う)。
 * - apply は ensure で統合列 (空の選択肢+説明文) を作ってから行ごとに書く。
 *   選択肢はページ書込時の自動作成で累積する (212種可を 2026-11-03 実証)。
 * - 冪等: 統合列が既に和集合と集合一致する行は書かない。再実行で残りだけ進む。
 * - 旧3列は一切変更しない (移行の正は当面3列、切替は別PR)。
 * - 書込の成否が不明な行 (例外) は failed として数え、最後の全行再検証で
 *   不一致が残れば終了コードを落とす前提で summary に出す。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { NotionConfigError, notionEnv } from "../../../../src/shared/notion-archive/env.js";
import {
  ensureSupplementDb,
  loadSupplementRows,
  updateSupplementRow,
  type SupplementRow,
} from "../../../../src/shared/notion-archive/stock-supplement.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";

export interface UnifiedMigrationItem {
  code: string;
  pageId: string;
  expected: string[];
  current: string[] | undefined;
  action: "write" | "skip-equal";
}

export interface UnifiedMigrationOptions {
  apply: boolean;
  journalPath?: string;
  limit?: number;
  codes?: string[];
}

export interface UnifiedMigrationSummary {
  apply: boolean;
  columnPresentBefore: boolean;
  rowsScanned: number;
  plannedWrites: number;
  skippedEqual: number;
  written: number;
  failed: number;
  verifiedRows: number;
  mismatchedAfter: number;
}

/** 3列の和集合 (upstream→downstream→distribution の順、重複は単語帳上あり得ない)。 */
export function expectedBusinessTags(row: SupplementRow): string[] {
  return [...row.upstream, ...row.downstream, ...row.distribution];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const rest = new Set(b);
  return a.every((v) => rest.has(v));
}

export function planUnifiedTags(rows: readonly SupplementRow[]): UnifiedMigrationItem[] {
  return rows.map((row) => {
    const expected = expectedBusinessTags(row);
    const current = row.businessTags;
    // 期待値の正は3列 (移行元) なので、統合列が未読/空で期待値も空なら
    // 書く意味が無い (空PATCHで全行の更新時刻だけ進めない)。
    const equal = sameSet(expected, current ?? []);
    return {
      code: row.stockCode,
      pageId: row.pageId,
      expected,
      current,
      action: equal ? "skip-equal" : "write",
    };
  });
}

async function resolveSupplementDbReadOnly(): Promise<{
  dbId: string;
  propertyIds: Record<string, string>;
  columnPresent: boolean;
}> {
  const dbId = notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID();
  if (dbId === undefined) {
    throw new NotionConfigError("既存補足DBの明示設定 (NOTION_STOCK_SUPPLEMENT_DB_ID) がありません");
  }
  const schema = await notionRequest<{
    object: string;
    id: string;
    properties: Record<string, { id: string }>;
  }>("GET", `/databases/${dbId}`);
  if (schema.object !== "database") throw new NotionConfigError("補足DBの取得結果が不正です");
  const propertyIds = Object.fromEntries(
    Object.entries(schema.properties).map(([name, p]) => [name, p.id])
  );
  return { dbId, propertyIds, columnPresent: propertyIds["事業タグ"] !== undefined };
}

function journal(journalPath: string | undefined, entry: Record<string, unknown>): void {
  if (journalPath === undefined) return;
  appendFileSync(journalPath, JSON.stringify(entry) + "\n");
}

export async function runUnifiedTagsMigration(
  opts: UnifiedMigrationOptions
): Promise<UnifiedMigrationSummary> {
  if (opts.apply && (opts.journalPath === undefined || opts.journalPath.trim() === "")) {
    throw new Error("migrate-unified-tags の --apply には --journal が必須です (監査証跡)");
  }
  if (opts.journalPath !== undefined) mkdirSync(dirname(opts.journalPath), { recursive: true });

  const before = await resolveSupplementDbReadOnly();
  let dbId = before.dbId;
  let propertyIds = before.propertyIds;

  if (opts.apply) {
    // 旧列の選択肢には触らない spec (機械同期と同じ形) で統合列だけを足す。
    const ensured = await ensureSupplementDb({
      textColumns: TEXT_SECTIONS.map((s) => s.title),
      upstreamOptions: [],
      downstreamOptions: [],
      distributionOptions: [],
      themeOptions: [],
      versionOptions: [],
      sector33Options: [],
    });
    dbId = ensured.dbId;
    propertyIds = ensured.propertyIds;
    if (propertyIds["事業タグ"] === undefined) {
      throw new Error("ensure 後に統合列「事業タグ」がありません");
    }
  }

  const loadOpts = opts.codes !== undefined && opts.codes.length > 0 ? { codes: opts.codes } : {};
  const rows = await loadSupplementRows(dbId, propertyIds, loadOpts);
  const planned = planUnifiedTags(rows);
  const targets = (opts.limit !== undefined
    ? planned.filter((i) => i.action === "write").slice(0, opts.limit)
    : planned.filter((i) => i.action === "write"));
  const summary: UnifiedMigrationSummary = {
    apply: opts.apply,
    columnPresentBefore: before.columnPresent,
    rowsScanned: rows.length,
    plannedWrites: planned.filter((i) => i.action === "write").length,
    skippedEqual: planned.filter((i) => i.action === "skip-equal").length,
    written: 0,
    failed: 0,
    verifiedRows: 0,
    mismatchedAfter: 0,
  };
  journal(opts.journalPath, {
    kind: "plan",
    apply: opts.apply,
    columnPresentBefore: before.columnPresent,
    rowsScanned: summary.rowsScanned,
    plannedWrites: summary.plannedWrites,
    skippedEqual: summary.skippedEqual,
    limit: opts.limit ?? null,
    at: new Date().toISOString(),
  });

  if (!opts.apply) return summary;

  for (const item of targets) {
    try {
      await updateSupplementRow(item.pageId, { businessTags: item.expected });
      summary.written += 1;
      journal(opts.journalPath, { kind: "written", code: item.code, pageId: item.pageId, tags: item.expected.length });
    } catch (cause) {
      summary.failed += 1;
      journal(opts.journalPath, {
        kind: "failed",
        code: item.code,
        pageId: item.pageId,
        error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300),
      });
    }
  }

  // 全行再検証: 統合列 == 3列の和集合 (集合一致) を数える。書込結果不明もここで拾う。
  const after = await loadSupplementRows(dbId, propertyIds, loadOpts);
  summary.verifiedRows = after.length;
  summary.mismatchedAfter = planUnifiedTags(after).filter((i) => i.action === "write").length;
  journal(opts.journalPath, { kind: "verified", ...summary });
  return summary;
}
