/**
 * 依存ライブラリを足さない最小 ZIP リーダ。
 *
 * EDINET の書類取得 API (documents/{docID}) は常に ZIP を返す。Node には
 * ZIP コンテナを解く標準 API が無く、本 mono-repo は新規依存を増やさない方針
 * (docs/new-project-template.md §0) のため、End Of Central Directory →
 * Central Directory → Local File Header を辿って各エントリを取り出す。
 * 圧縮は stored(0) / deflate(8) のみ対応 (EDINET はこの 2 種)。想定外の
 * 形式 (ZIP64・暗号化・未知の圧縮法) は CLAUDE.md ルール2 に従い throw する
 * — 黙って空や部分結果を返さない。
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** ZIP 内の 1 ファイル名 → 展開済みバイト列 */
export type ZipEntries = Map<string, Buffer>;

function findEocdOffset(buf: Buffer): number {
  // EOCD は末尾。コメント長最大 0xFFFF + 22 バイト固定部の範囲を後方走査。
  const minPos = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("ZIP: End Of Central Directory が見つかりません (壊れた ZIP)");
}

export function unzip(buf: Buffer): ZipEntries {
  const eocd = findEocdOffset(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    throw new Error("ZIP: ZIP64 形式は未対応です");
  }

  const entries: ZipEntries = new Map();
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) {
      throw new Error(`ZIP: Central Directory ヘッダ破損 (entry ${n})`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lfhOffset = buf.readUInt32LE(p + 42);
    if (lfhOffset === 0xffffffff || compSize === 0xffffffff) {
      throw new Error("ZIP: ZIP64 形式は未対応です");
    }
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // ディレクトリエントリ

    if (buf.readUInt32LE(lfhOffset) !== LFH_SIG) {
      throw new Error(`ZIP: Local File Header 破損 (${name})`);
    }
    const lfhNameLen = buf.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`ZIP: 未対応の圧縮法 method=${method} (${name})`);
    }
    if (data.length !== uncompSize) {
      throw new Error(
        `ZIP: 展開サイズ不一致 ${name} expected=${uncompSize} got=${data.length}`
      );
    }
    entries.set(name, data);
  }
  return entries;
}
