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
import { createHash } from "node:crypto";
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

export function unzip(buf: Buffer, limits?: { maxEntries: number; maxExpandedBytes: number }): ZipEntries {
  const eocd = findEocdOffset(buf);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff) {
    throw new Error("ZIP: ZIP64 形式は未対応です");
  }
  if (limits && (!Number.isSafeInteger(limits.maxEntries) || limits.maxEntries < 1 || !Number.isSafeInteger(limits.maxExpandedBytes) || limits.maxExpandedBytes < 0 || totalEntries > limits.maxEntries)) {
    throw new Error("ZIP: entry/展開予算が不正または超過です");
  }

  const entries: ZipEntries = new Map();
  let p = cdOffset, expanded = 0;
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
    if (limits && expanded + uncompSize > limits.maxExpandedBytes) throw new Error("ZIP: 宣言展開サイズが予算を超えます");
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
      data = limits ? inflateRawSync(raw, { maxOutputLength: Math.max(1, limits.maxExpandedBytes - expanded) }) : inflateRawSync(raw);
    } else {
      throw new Error(`ZIP: 未対応の圧縮法 method=${method} (${name})`);
    }
    expanded += data.length;
    if (data.length !== uncompSize) {
      throw new Error(
        `ZIP: 展開サイズ不一致 ${name} expected=${uncompSize} got=${data.length}`
      );
    }
    entries.set(name, data);
  }
  return entries;
}

/** エントリ名順の (名前, 展開長, 展開後SHA256) 一覧。コンテナのメタ情報は含めない。 */
function zipContentDigests(buf: Buffer): string {
  const entries = unzip(buf);
  // unzip は同名エントリを Map で潰すため、CD 宣言件数も束縛する
  // (同名重複の差分を等価と誤判定しない)。
  const totalEntries = buf.readUInt16LE(findEocdOffset(buf) + 10);
  const lines = [...entries.keys()]
    .sort()
    .map((name) => {
      const data = entries.get(name)!;
      const sha = createHash("sha256").update(data).digest("hex");
      return `${name}\0${data.length}\0${sha}`;
    });
  return [String(totalEntries), ...lines].join("\n");
}

/**
 * 2つの ZIP の「中身」が完全一致するか (全エントリの名前と展開後バイト列)。
 *
 * EDINET の type1 (XBRL) ZIP はダウンロード毎に全エントリの ZIP
 * タイムスタンプが再生成され、同一書類でも生バイト列が変わる (実測:
 * S100ASBR、内容は全エントリ一致・生SHAのみ不一致)。保管済み原本との
 * 再照合を生バイト列で行うと再実行が恒久に失敗するため、等価判定は
 * コンテナでなく中身で行う。ZIP として読めない入力は unzip の throw を
 * そのまま伝える (黙って不一致扱いにしない)。
 */
export function zipContentsEqual(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  return zipContentDigests(a) === zipContentDigests(b);
}
