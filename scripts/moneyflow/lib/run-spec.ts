/**
 * `MoneyflowSourceSpec` (services/moneyflow/lib/source-spec.ts) を 1 回分実行する
 * 共通の取込フロー。Phase 1 の jpx-sector-marketcap と同じ方針
 * (「アーカイブ済み ≠ 観測ログ書込済み」) を全取得元に一般化したもの:
 *
 *   - 未保管のキー: 取得元から本体を取り、先に `recordPrimaryData()` で実体保管
 *     (解析が様式変更で失敗しても一次データは残す — ルール6) → 保管添付の
 *     完全一致 (件数・名前・バイト長・SHA256) を検証 → 解析 → 観測ログへ upsert。
 *     file_too_large・添付不一致は観測ログを書かず停止する。
 *   - 新規・更新が 1 行でもある書込バッチは、書込後 `verifyObservedBatch()` で
 *     全行を read-only 再検証する (全行 unchanged の再実行は upsert 照合済み)。
 *   - 保管済みのキー: 取得元へは取りに行かず、Notion の保管ファイルから再解析し、
 *     全 draft を upsert し直す。`upsertObservation` が同値行は書かず
 *     (unchanged)、途中欠落・値・relation の不一致だけ修復する。
 *     最後の 1 行の有無で全バッチを skip しない (最後だけある途中欠落を
 *     見落とすため)。
 */
import {
  ensureObservationsDb,
  isArchived,
  recordPrimaryData,
  upsertObservation,
  verifyObservedBatch,
  type ObservationInput,
  type VerifiedObservationRow,
} from "../../../src/shared/notion-archive/index.js";
import {
  validateDrafts,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../../../services/moneyflow/lib/source-spec.js";
import {
  downloadArchivedFile,
  findArchivedRecordByKey,
  requirePrimaryDataDbId,
  verifyArchivedAttachments,
} from "./archived-files.js";

export interface SpecRunContext {
  dryRun: boolean;
  now: Date;
  /** 指標キー → 「資金フロー｜指標定義」のページ ID (未同期なら throw する実装を渡す)。 */
  indicatorPageId(key: string): string;
}

/** 観測ログ書込の件数内訳。 */
export interface WriteCounts {
  created: number;
  updated: number;
  unchanged: number;
}

function countByIndicator(drafts: readonly ObservationDraft[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of drafts) out[d.indicatorKey] = (out[d.indicatorKey] ?? 0) + 1;
  return out;
}

/** 観測ログ書込の結果 (書込後検証に必要な行入力・ページ ID を含む)。 */
interface WrittenBatch {
  dbId: string;
  counts: WriteCounts;
  rows: VerifiedObservationRow[];
}

async function writeObservations(
  drafts: readonly ObservationDraft[],
  primaryDataPageId: string,
  ctx: SpecRunContext
): Promise<WrittenBatch> {
  const { dbId } = await ensureObservationsDb();
  const counts: WriteCounts = { created: 0, updated: 0, unchanged: 0 };
  const rows: VerifiedObservationRow[] = [];
  // 配列順に 1 行ずつ書く。最後の行の存在を「このバッチの取込完了」の印に使うため、
  // 並列化して順序を崩さない。
  for (const d of drafts) {
    const input: ObservationInput = {
      ...d,
      indicatorPageId: ctx.indicatorPageId(d.indicatorKey),
      primaryDataPageId,
    };
    const r = await upsertObservation(dbId, input);
    counts[r.outcome] += 1;
    rows.push({ input, pageId: r.pageId });
  }
  return { dbId, counts, rows };
}

/**
 * 新規・更新が 1 行でもあれば書込バッチ全体を read-only で再検証する。
 * 全行 unchanged の再実行は upsert 時に各行を全項目照合済みのため呼ばない。
 */
async function verifyWritesIfChanged(specName: string, key: string, written: WrittenBatch): Promise<void> {
  if (written.counts.created + written.counts.updated === 0) return;
  await verifyObservedBatch(written.dbId, `[${specName}] ${key}`, written.rows);
}

function describeCounts(n: number, c: WriteCounts): string {
  return `${n}行 (新規${c.created}/更新${c.updated}/同値${c.unchanged})`;
}

function parseAndValidate(
  spec: MoneyflowSourceSpec,
  key: string,
  files: readonly SpecFile[]
): ObservationDraft[] {
  // 解析側がバイト列を detach しても (unpdf 等 — services/moneyflow/lib/pdf-text.ts)
  // 保管・再利用するバイト列を壊さないよう、コピーを渡す。
  const copies = files.map((f) => ({ filename: f.filename, bytes: f.bytes.slice() }));
  const drafts = spec.toObservations({ key, files: copies });
  validateDrafts(spec.name, drafts, spec.indicators);
  return drafts;
}

/**
 * 取得元 1 件を実行し、取込ログ用の詳細文を返す。失敗は throw (呼び出し側で集計)。
 */
export async function runSpec(spec: MoneyflowSourceSpec, ctx: SpecRunContext): Promise<string> {
  const resolved = await spec.resolve(ctx.now);
  const key = resolved.key;

  if (ctx.dryRun) {
    const batch = await resolved.fetch();
    if (batch.key !== key) {
      throw new Error(`[${spec.name}] resolve のキー ${key} と取得結果のキー ${batch.key} が一致しません`);
    }
    const drafts = parseAndValidate(spec, key, batch.files);
    console.info(
      JSON.stringify(
        {
          source: spec.name,
          dryRun: true,
          key,
          files: batch.files.map((f) => ({ filename: f.filename, bytes: f.bytes.length })),
          rows: drafts.length,
          rowsByIndicator: countByIndicator(drafts),
          sample: drafts.slice(0, 5),
        },
        null,
        2
      )
    );
    return `dry-run key=${key} ${drafts.length}行`;
  }

  if (await isArchived("moneyflow", key)) {
    const primaryDbId = await requirePrimaryDataDbId(spec.name);
    const rec = await findArchivedRecordByKey(primaryDbId, key);
    if (!rec) {
      throw new Error(`[${spec.name}] isArchived("${key}")=true なのに保管済みページが見つかりません (整合性エラー)`);
    }
    if (rec.files.length === 0) {
      throw new Error(
        `[${spec.name}] 保管済みレコード ${key} にファイルがありません (file_too_large 等)。` +
          `保管ファイルから再解析できないため、Notion 上の記録を確認してください。`
      );
    }
    const files: SpecFile[] = [];
    for (const f of rec.files) {
      files.push({ filename: f.name, bytes: await downloadArchivedFile(f, spec.name) });
    }
    const drafts = parseAndValidate(spec, key, files);
    // 最後の 1 行の有無で skip しない。全 draft を upsert し、同値なら
    // 書かず、途中欠落・値・relation の不一致だけ修復する。
    const written = await writeObservations(drafts, rec.pageId, ctx);
    const counts = written.counts;
    if (counts.created === 0 && counts.updated === 0) {
      return `未更新 (${key} は取込済み・${drafts.length}行同値確認・取得元への再取得なし)`;
    }
    await verifyWritesIfChanged(spec.name, key, written);
    return `保管済み ${key} から観測ログを再送 ${describeCounts(drafts.length, counts)}`;
  }

  const batch = await resolved.fetch();
  if (batch.key !== key) {
    throw new Error(`[${spec.name}] resolve のキー ${key} と取得結果のキー ${batch.key} が一致しません`);
  }
  if (batch.files.length === 0) {
    throw new Error(`[${spec.name}] 取得結果にファイルがありません (一次データを実体保管できない)`);
  }
  const archive = await recordPrimaryData({
    service: "moneyflow",
    key,
    source: batch.source,
    metadata: batch.metadata,
    files: batch.files,
  });
  // 上限超過で一部未保管のまま観測ログを書くと「原本なしの観測値」が残るため、
  // 書込前に必ず停止する (保管ページは手動確認用に残る)。
  if (archive.fileTooLarge) {
    throw new Error(`[${spec.name}] 一次データ ${key} の一部が Notion 上限超過で未保管 (file_too_large) のため観測ログを書きません`);
  }
  await verifyArchivedAttachments(archive.pageId, `[${spec.name}]`, key, batch.files);
  const drafts = parseAndValidate(spec, key, batch.files);
  const written = await writeObservations(drafts, archive.pageId, ctx);
  await verifyWritesIfChanged(spec.name, key, written);
  return `${key} を記録 ${describeCounts(drafts.length, written.counts)}`;
}
