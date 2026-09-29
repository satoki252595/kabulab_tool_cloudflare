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
  findBackupRowsByKeys,
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

/**
 * type 保管の完成状態。key 存在だけでは完成にしない (容量超過の
 * metadata-only 行が次回成功扱いになる false positive を防ぐ)。
 * - complete: 実 Files 添付あり
 * - metadata-only: 行はあるが実 Files なし (容量超過等)。STOP/明示修復対象
 * - missing: 行なし (記録試行の対象)
 * - not-applicable: XBRL 公式未提供 (既存 metadata の xbrlUnavailable)。t1 のみ
 */
export type TypeCustody = "complete" | "metadata-only" | "missing" | "not-applicable";

/** 通単位の type 保管完成 (t1/t5)。 */
export interface DocCustody {
  t1: TypeCustody;
  t5: TypeCustody;
}

/** 1 回の OR 照会に入れる最大通数 (2 key/通。複合フィルタ上限内に収める)。 */
const CUSTODY_CHUNK_DOCS = 40;

function custodyOf(
  rows: Map<string, { fileCount: number; metadata: Record<string, unknown> }>,
  docID: string,
  type: EdinetArchiveDocType
): TypeCustody {
  const row = rows.get(edinetArchiveKey(docID, type));
  if (!row) return "missing";
  if (row.fileCount > 0) return "complete";
  if (type === 1 && row.metadata["xbrlUnavailable"] === true) return "not-applicable";
  return "metadata-only";
}

/**
 * 複数通の type 保管完成を OR 一括で取得する (run/日ごとの再利用用)。
 * 1 通あたり 2 key を束ね、40 通ずつに chunk する。見つからない通は
 * t1/t5 とも missing で埋める (呼び出し側で存在チェック不要)。
 */
export async function checkDocsCustody(
  service: string,
  docIDs: string[]
): Promise<Map<string, DocCustody>> {
  const out = new Map<string, DocCustody>(
    docIDs.map((docID) => [docID, { t1: "missing", t5: "missing" } as DocCustody])
  );
  for (let i = 0; i < docIDs.length; i += CUSTODY_CHUNK_DOCS) {
    const chunk = docIDs.slice(i, i + CUSTODY_CHUNK_DOCS);
    const keys = chunk.flatMap((docID) => [
      edinetArchiveKey(docID, 1),
      edinetArchiveKey(docID, 5),
    ]);
    const rows = new Map(
      (await findBackupRowsByKeys(service, keys)).map((r) => [r.key, r] as const)
    );
    for (const docID of chunk) {
      out.set(docID, { t1: custodyOf(rows, docID, 1), t5: custodyOf(rows, docID, 5) });
    }
  }
  return out;
}

/** 1 通分の type 保管完成 (checkDocsCustody の単通版)。 */
export async function checkDocCustody(service: string, docID: string): Promise<DocCustody> {
  const m = await checkDocsCustody(service, [docID]);
  const c = m.get(docID);
  if (!c) throw new Error(`checkDocCustody: 判定欠落 docID=${docID}`);
  return c;
}

/**
 * metadata-only 行があれば明示修復 STOP を投げる。容量超過の行を
 * 次回成功扱いで黙殺せず、架空の Type1 を捏造せず、恒久リトライもしない。
 * 呼び出し側は通単位で失敗計上する。
 */
export function assertNoMetadataOnly(custody: DocCustody, docID: string): void {
  const bad = (["t1", "t5"] as const).filter((t) => custody[t] === "metadata-only");
  if (bad.length > 0) {
    throw new Error(
      `archive custody: metadata-only 行のため STOP (明示修復が必要) docID=${docID} types=${bad.join(",")}`
    );
  }
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
 *
 * ファイルが Notion 上限超過で添付できなかった (`fileTooLarge`) 場合は
 * metadata のみ記録成功として返さず throw する。呼び出し側は通単位で
 * 失敗計上し、全 caller (ingest/backfill/repair) で未完了として扱う。
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
  const result = await recordPrimaryData({
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
  if (result.fileTooLarge) {
    throw new Error(
      `recordEdinetZip: 実ファイルが Notion 上限超過で未添付です (metadata のみ記録扱いにしない): ${edinetArchiveKey(docID, type)}`
    );
  }
  return result;
}
