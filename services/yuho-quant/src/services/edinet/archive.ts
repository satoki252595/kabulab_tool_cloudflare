/**
 * EDINET 物理 ZIP の Notion 一次データ記録の共通契約 (type 別 key + 実 bytes)。
 *
 * 根因: 旧来の全経路が `key: docID` の1キーで type=1 (XBRL) と type=5 (CSV)
 * を束ねて記録していたため、Type5 のみ記録済みの通は `isArchived(docID)`
 * が真になり、以後の Type1 実体保存が抑止されていた (Type5 の存在を Type1
 * の証明に使っていた)。海外 backfill は Type1 取得・解析後に記録自体が無い。
 *
 * 契約: 1 type = 1 key (`{docID}:type1` / `{docID}:type5`) + 取得した実 ZIP
 * bytes のみ添付。旧来の素 docID 記録は読まない・書かない・消さない。
 * ingest / backfill-missing-docs / backfill-overseas / manual59
 * (repair-zip-archive) の全4経路がこの helper だけを使う。
 */
import {
  recordPrimaryData,
  type RecordResult,
} from "../../../../../src/shared/notion-archive/index.js";

/** EDINET 書類取得種別 (1=XBRL ZIP / 5=CSV ZIP)。 */
export type EdinetArchiveDocType = 1 | 5;

/**
 * type 別 archive key。旧来の素 docID と衝突しない
 * (`S100XXXX:type1`)。Type5 の存在が Type1 の既存判定に混ざらない。
 */
export function edinetArchiveKey(
  docID: string,
  type: EdinetArchiveDocType
): string {
  return `${docID}:type${type}`;
}

/** 添付 ZIP ファイル名 (既存の `{docID}_xbrl.zip` / `{docID}_csv.zip` を踏襲)。 */
export function edinetArchiveFilename(
  docID: string,
  type: EdinetArchiveDocType
): string {
  return type === 1 ? `${docID}_xbrl.zip` : `${docID}_csv.zip`;
}

/**
 * 記録すべき type の純粋決定。各 type の有無だけを見て、Type5 先在でも
 * Type1 未記録なら type1 を返す。XBRL 未取得なら type1 は計画しない
 * (無い物の記録は捏造。ルール1)。
 */
export function planArchiveUploads(args: {
  t1Present: boolean;
  t5Present: boolean;
  xbrlAvailable: boolean;
  force?: boolean;
}): EdinetArchiveDocType[] {
  const { t1Present, t5Present, xbrlAvailable, force = false } = args;
  const out: EdinetArchiveDocType[] = [];
  if (force || !t5Present) out.push(5);
  if (xbrlAvailable && (force || !t1Present)) out.push(1);
  return out;
}

/**
 * backfill 系 tail の終了判定 (repair-zip-archive と同一方式)。
 * error 系が1件でもあれば process.exitCode=1。保管失敗を tally 加算だけで
 * 終わらせて job green にしない (Sol HOLD1)。呼び出し側の tail で使う。
 */
export function archiveTallyFailed(errorCount: number): boolean {
  return errorCount > 0;
}

/**
 * 1 type 分の実 ZIP を type 別 key で記録する (全経路の共通窓口)。
 * metadata へ `edinetDocType` を付与し、どちらの実体かを行に残す。
 */
export async function recordEdinetZip(args: {
  service: string;
  docID: string;
  type: EdinetArchiveDocType;
  zip: Buffer | Uint8Array;
  source: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
  force?: boolean;
}): Promise<RecordResult> {
  const { service, docID, type, zip, source, fetchedAt, metadata, force } =
    args;
  return recordPrimaryData({
    service,
    key: edinetArchiveKey(docID, type),
    source,
    fetchedAt,
    metadata: { ...metadata, edinetDocType: type },
    files: [
      {
        bytes: new Uint8Array(zip),
        filename: edinetArchiveFilename(docID, type),
        contentType: "application/zip",
      },
    ],
    force,
  });
}
