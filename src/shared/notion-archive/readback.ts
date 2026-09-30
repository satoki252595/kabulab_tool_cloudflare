/**
 * 保管直後の readback 照合 (CLAUDE.md ルール6)。
 *
 * 添付の件数・名前・hosted・全 bytes (長さ+SHA256) が記録時と一致する
 * こと。strict `listPageFiles` (不正要素は throw) を使い、短縮・欠落が
 * あれば件数不一致で HOLD する。SHA は WebCrypto 共有 helper
 * (`../sha256.js`) で Worker/Node 両用。
 *
 * 旧 `scripts/sync/stock-gap-diagnostic.ts` の実体を移動したもの
 * (診断 caller は薄い wrapper + 旧 label で契約維持)。
 */
import { sha256HexBytes } from "../sha256.js";
import { listPageFiles } from "./page-file.js";

export interface ArchivedFileInput {
  filename: string;
  bytes: Uint8Array;
}

export async function verifyArchivedAttachments(
  pageId: string,
  files: readonly ArchivedFileInput[],
  label: string
): Promise<void> {
  const fail = (why: string): never => {
    throw new Error(`${label}の readback 照合に失敗したため HOLD: ${why}`);
  };
  const names = files.map((f) => f.filename);
  if (new Set(names).size !== names.length) fail("添付名の重複 (内部不整合)");
  const hosted = await listPageFiles(pageId, "Files");
  if (hosted.length !== files.length) {
    fail(`添付 ${hosted.length} 件 ≠ 記録 ${files.length} 件`);
  }
  const byName = new Map(hosted.map((h) => [h.name, h]));
  for (const f of files) {
    const got = byName.get(f.filename) ?? fail(`添付「${f.filename}」なし`);
    if (got.kind !== "file") fail(`「${f.filename}」が Notion-hosted 添付ではありません`);
    const res = await fetch(got.url);
    if (!res.ok) fail(`「${f.filename}」の再取得に失敗 status=${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== f.bytes.length) {
      fail(`「${f.filename}」のバイト長 ${bytes.length} ≠ ${f.bytes.length}`);
    }
    const [gotSha, wantSha] = await Promise.all([
      sha256HexBytes(Uint8Array.from(bytes)),
      sha256HexBytes(Uint8Array.from(f.bytes)),
    ]);
    if (gotSha !== wantSha) fail(`「${f.filename}」の SHA256 不一致`);
  }
}
