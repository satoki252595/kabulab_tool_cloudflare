/**
 * EDINET 物理 ZIP の Notion 一次データ記録の共通契約 (type 別 key + 実 bytes)。
 *
 * 根因: 旧来の全経路が `key: docID` の1キーで type=1 (XBRL) と type=5 (CSV)
 * を束ねて記録していたため、Type5 のみ記録済みの通は `isArchived(docID)`
 * が真になり、以後の Type1 実体保存が抑止されていた (Type5 の存在を Type1
 * の証明に使っていた)。海外 backfill は Type1 取得・解析後に記録自体が無い。
 *
 * 契約: 1 type = 1 key (`{docID}:type1` / `{docID}:type5`) + 取得した実 ZIP
 * bytes のみ添付。通常経路は旧来の素 docID 記録を読まない・書かない・消さない。
 * D1旧省略根拠の対証だけはreadSavedEdinetZipReferenceで明示page/SHAを読む。
 * ingest / backfill-missing-docs / backfill-overseas / manual59
 * (repair-zip-archive) の全4経路がこの helper だけを使う。
 */
import {
  findBackupRowsByKeys,
  recordPrimaryData,
  verifyArchivedAttachments,
  type RecordResult,
} from "../../../../../src/shared/notion-archive/index.js";
import { findUniqueBackupChildByTitle, queryUniqueRow, readFileManifest, inputFingerprint } from "../../../../../src/shared/notion-archive/archive.js";
import { notionEnv } from "../../../../../src/shared/notion-archive/env.js";
import { listPageFiles } from "../../../../../src/shared/notion-archive/page-file.js";
import { downloadArchivedFile } from "../../../../../src/shared/notion-archive/archived-download.js";
import { sha256HexBytes } from "../../../../../src/shared/sha256.js";
import { notionRequest } from "../../../../../src/shared/notion-archive/client.js";
import type { edinetArchiveMetadata } from "./archive-metadata.js";

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

/** 1 回の OR 照会に入れる最大通数 (2 key/通で 40 key。照会上限 41 内)。 */
const CUSTODY_CHUNK_DOCS = 20;

export function custodyOf(
  rows: Map<string, { fileCount: number; metadata: Record<string, unknown> }>,
  docID: string
): DocCustody {
  const t1 = rows.get(edinetArchiveKey(docID, 1));
  const t5 = rows.get(edinetArchiveKey(docID, 5));
  // T1 行不在 + T5 実体あり + 同通 T5 行の xbrlUnavailable=true (producer が
  // 公式未提供を文書化) → not-applicable。producer は T1 行自体を書かない
  // ため、T1 行の有無だけでは未提供を判定できない。
  const t1c: TypeCustody =
    t1 === undefined
      ? t5 !== undefined &&
        t5.fileCount > 0 &&
        t5.metadata["xbrlUnavailable"] === true
        ? "not-applicable"
        : "missing"
      : t1.fileCount > 0
        ? "complete"
        : t1.metadata["xbrlUnavailable"] === true
          ? "not-applicable"
          : "metadata-only";
  const t5c: TypeCustody =
    t5 === undefined ? "missing" : t5.fileCount > 0 ? "complete" : "metadata-only";
  return { t1: t1c, t5: t5c };
}

/**
 * 複数通の type 保管完成を OR 一括で取得する (run/日ごとの再利用用)。
 * 1 通あたり 2 key を束ね、20 通ずつに chunk する。見つからない通は
 * t1/t5 とも missing で埋める (呼び出し側で存在チェック不要)。
 * 同一 key の重複行は正本不明のため保全停止する (後勝ちで黙殺しない)。
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
    const rows = new Map<string, { fileCount: number; metadata: Record<string, unknown> }>();
    for (const r of await findBackupRowsByKeys(service, keys)) {
      if (rows.has(r.key)) {
        throw new Error(
          `archive custody: 同一 key の重複行のため STOP (監査・整理が必要) key=${r.key}`
        );
      }
      rows.set(r.key, r);
    }
    for (const docID of chunk) {
      out.set(docID, custodyOf(rows, docID));
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

export class SavedEdinetZipQualificationError extends Error {}
/** Only a zero-row exact typed-key query in the existing canonical DB is missing. */
export class SavedEdinetZipMissingError extends SavedEdinetZipQualificationError {}

/** 情報修正の再確認用。既存type別原本だけを読み、作成・上書き・別原典取得はしない。 */
export async function readSavedEdinetZip(docID: string, type: EdinetArchiveDocType) {
  const dbId = await findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    title: "一次データ｜yuho-quant", kind: "database" });
  if (dbId === null) throw new SavedEdinetZipQualificationError("EDINET保存原本DBがありません");
  const page = await queryUniqueRow<{ id: string; archived: boolean; in_trash: boolean;
    parent: { type: string; database_id: string }; properties: { Key: { title: Array<{ type: string; plain_text: string; text: { content: string } }> };
      Metadata: { rich_text: Array<{ type: string; plain_text: string; text: { content: string } }> } } }>(
    dbId, { property: "Key", title: { equals: edinetArchiveKey(docID, type) } }, "EDINET保存原本が複数あります");
  if (page === null) throw new SavedEdinetZipMissingError("EDINET保存原本のtype別行がありません");
  if (page.archived !== false || page.in_trash !== false || page.parent.type !== "database_id" ||
      page.parent.database_id.replaceAll("-", "") !== dbId.replaceAll("-", "")) throw new SavedEdinetZipQualificationError("EDINET保存原本の所属/状態が不正です");
  const key = page.properties.Key.title;
  if (!Array.isArray(key) || key.some(p => p.type !== "text" || p.plain_text !== p.text?.content) ||
      key.map(p => p.plain_text).join("") !== edinetArchiveKey(docID, type)) throw new SavedEdinetZipQualificationError("EDINET保存原本Keyが不一致です");
  const parts = page.properties.Metadata.rich_text;
  if (!Array.isArray(parts) || parts.some(p => p.type !== "text" || typeof p.plain_text !== "string" || p.plain_text !== p.text?.content)) throw new SavedEdinetZipQualificationError("EDINET保存原本metadataが不完全です");
  const metadata = JSON.parse(parts.map(p => p.plain_text).join("")) as Record<string, unknown>;
  if (metadata.docID !== docID || metadata.edinetDocType !== type) throw new SavedEdinetZipQualificationError("EDINET保存原本の文書/typeが不一致です");
  const files = await listPageFiles(page.id, "Files");
  if (files.length !== 1 || files[0].kind !== "file" || files[0].name !== edinetArchiveFilename(docID, type)) throw new SavedEdinetZipQualificationError("EDINET保存原本の物理添付が不一致です");
  const bytes = Buffer.from(await downloadArchivedFile(files[0], "EDINET情報修正の保存原本", { maxBytes: 20 * 1024 ** 2 }));
  const sha256 = await sha256HexBytes(bytes);
  if (metadata.sourceZIPSHA !== undefined && metadata.sourceZIPSHA !== sha256 ||
      metadata.sourceZIPBytes !== undefined && metadata.sourceZIPBytes !== bytes.length) throw new SavedEdinetZipQualificationError("EDINET保存原本SHA/長さが不一致です");
  const manifest = readFileManifest(metadata);
  if (manifest === "malformed") throw new SavedEdinetZipQualificationError("EDINET保存原本manifestが不正です");
  if (manifest !== "absent" && (manifest.files.length !== 1 || manifest.files[0].upload !== "uploaded" ||
      manifest.files[0].originalFilename !== files[0].name || manifest.files[0].byteLength !== bytes.length || manifest.files[0].sha256 !== sha256 ||
      await inputFingerprint(manifest.files.map(f => ({ filename: f.originalFilename, contentType: f.originalMime, byteLength: f.byteLength, sha256: f.sha256 }))) !== manifest.inputFingerprint)) throw new SavedEdinetZipQualificationError("EDINET保存原本manifestが不一致です");
  return { pageId: page.id, bytes, sha256, metadata, originalManifest: manifest === "absent" ? "unknown" as const : "known" as const };
}

/** D1旧省略根拠が明示する1page/物理SHAだけを対証する。通常readerの代替・探索には使わない。 */
export async function readSavedEdinetZipReference(args: {
  docID: string; type: 1; pageId: string; sha256: string; originalManifest: "known" | "unknown";
  nativeMetadata: ReturnType<typeof edinetArchiveMetadata>;
}) {
  const requireReference = (value: unknown) => { if (!value) throw new SavedEdinetZipQualificationError("旧EDINET原本の明示参照が不適格です"); };
  requireReference(/^[a-f0-9]{64}$/.test(args.sha256));
  requireReference(/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(args.pageId));
  const dbId = await findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(), title: "一次データ｜yuho-quant", kind: "database" });
  requireReference(dbId !== null);
  const page = await notionRequest<{ object: string; id: string; archived: boolean; in_trash: boolean; parent: { type: string; database_id: string };
    properties: Record<string, { type: string; title?: Array<{ type: string; plain_text: string; text: { content: string } }>;
      rich_text?: Array<{ type: string; plain_text: string; text: { content: string } }> }> }>("GET", `/pages/${args.pageId}`);
  const nid = (value: string) => value.replaceAll("-", "").toLowerCase();
  requireReference(page.object === "page" && page.archived === false && page.in_trash === false && nid(page.id) === nid(args.pageId) &&
    page.parent.type === "database_id" && nid(page.parent.database_id) === nid(dbId!));
  const text = (parts: Array<{ type: string; plain_text: string; text: { content: string } }> | undefined) => {
    requireReference(Array.isArray(parts) && parts.length > 0 && parts.every(p => p.type === "text" && typeof p.plain_text === "string" && p.plain_text === p.text?.content));
    return parts!.map(p => p.plain_text).join("");
  };
  requireReference(page.properties.Key?.type === "title" && page.properties.Metadata?.type === "rich_text");
  const key = text(page.properties.Key.title), metadata = JSON.parse(text(page.properties.Metadata.rich_text)) as Record<string, unknown>;
  requireReference((key === args.docID || key === edinetArchiveKey(args.docID, 1)) && metadata.docID === args.docID &&
    (metadata.edinetDocType === 1 || key === args.docID && metadata.edinetDocType === undefined) &&
    Object.entries(args.nativeMetadata).every(([k, value]) => metadata[k] === value));
  // legacy page can hold other attachments; qualify only the exact D1-bound type1, never claim custody of the others.
  const files = (await listPageFiles(page.id, "Files")).filter(file => file.name === edinetArchiveFilename(args.docID, 1));
  requireReference(files.length === 1 && files[0].kind === "file");
  const bytes = Buffer.from(await downloadArchivedFile(files[0], "情報修正の旧明示原本", { maxBytes: 20 * 1024 ** 2 }));
  const sha256 = await sha256HexBytes(bytes); requireReference(sha256 === args.sha256 &&
    (metadata.sourceZIPSHA === undefined || metadata.sourceZIPSHA === sha256) &&
    (metadata.sourceZIPBytes === undefined || metadata.sourceZIPBytes === bytes.length));
  const manifest = readFileManifest(metadata); requireReference(manifest !== "malformed");
  const originalManifest = manifest === "absent" ? "unknown" as const : "known" as const;
  requireReference(originalManifest === args.originalManifest);
  if (manifest !== "absent" && manifest !== "malformed") {
    const selected = manifest.files.filter(file => file.originalFilename === files[0].name);
    requireReference(selected.length === 1 && selected[0].upload === "uploaded" && selected[0].byteLength === bytes.length && selected[0].sha256 === sha256 &&
      await inputFingerprint(manifest.files.map(file => ({ filename: file.originalFilename, contentType: file.originalMime, byteLength: file.byteLength, sha256: file.sha256 }))) === manifest.inputFingerprint);
  }
  return { pageId: page.id, bytes, sha256, metadata, originalManifest };
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
 *
 * 記録後は unique physical の full-bytes SHA を readback 確認する
 * (verifyArchivedAttachments reuse)。mismatch・取得失敗は throw。
 * skipped_existing は先に unique 行 + 実体ありを検証する。旧 manifest
 * unknown でも実 bytes 一致は許容し、unknown 表示は保持する
 * (manifest を書換えない)。
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
  if ("docID" in metadata && metadata.docID !== docID) {
    throw new Error("recordEdinetZip: 明示docIDとmetadata.docIDが不一致です。上書きせず停止します");
  }
  const result = await recordPrimaryData({
    service,
    key: edinetArchiveKey(docID, type),
    source,
    fetchedAt,
    metadata: { ...metadata, docID, edinetDocType: type },
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
  if (result.outcome === "skipped_existing") {
    await assertExistingRowPhysical(service, docID, type);
  }
  await verifyArchivedAttachments(
    result.pageId,
    [
      {
        filename: edinetArchiveFilename(docID, type),
        bytes: new Uint8Array(zip),
      },
    ],
    `EDINET一次 ${edinetArchiveKey(docID, type)}`
  );
  return result;
}

/**
 * 直接呼び出し対策の共有 guard。recordPrimaryData の key 存在判定は
 * 行有無しか見ないため、既存行を再照会して実体を検証する。
 * metadata-only 行 (実 Files なし) と同一 key 重複行は保全停止し、
 * 無断で作り直さない (再照会の続き取得・恒久リトライもしない)。
 */
async function assertExistingRowPhysical(
  service: string,
  docID: string,
  type: EdinetArchiveDocType
): Promise<void> {
  const key = edinetArchiveKey(docID, type);
  const rows = (await findBackupRowsByKeys(service, [key])).filter(
    (r) => r.key === key
  );
  if (rows.length > 1) {
    throw new Error(
      `recordEdinetZip: 同一 key の重複行のため STOP (監査・整理が必要) key=${key} rows=${rows.length}`
    );
  }
  const first = rows[0];
  if (!first || first.fileCount === 0) {
    throw new Error(
      `recordEdinetZip: 既存行に実ファイルなしのため STOP (metadata-only 行の成功扱い・無断再作成をしない) key=${key}`
    );
  }
}
