/**
 * Notion File Upload API ラッパ。物理ファイルを Notion に実体アップロードする
 * (CLAUDE.md ルール6: ファイル取得時は物理ファイルを必ず Notion に上げる)。
 *
 * Notion のハードリミット:
 *   - single_part: 1 ファイル 20 MiB 以下
 *   - multi_part : 各パート 5〜20 MiB (末尾のみ未満可)、最大 1000 パート
 *   - 合計サイズはワークスペース上限 (本 WS は 5 GiB) まで
 *
 * 上限超過は捏造で埋めず (ルール2)、型付きエラーで呼び出し側に通知し、
 * 呼び出し側が「アップロード不可」を正直なステータスとして記録する。
 */
import { notionRequest, notionSendFilePart } from "./client.js";

/** single_part の上限 (20 MiB) */
const SINGLE_MAX = 20 * 1024 * 1024;
/** multi_part の 1 パートサイズ (10 MiB: 5〜20 MiB の範囲内) */
const PART_SIZE = 10 * 1024 * 1024;

/**
 * Notion File Upload API がファイル名の拡張子で受理する形式の allowlist
 * (https://developers.notion.com/docs/working-with-files-and-media)。
 * ここに無い拡張子 (例 `.jsonl`) は POST /file_uploads が
 * 400 validation_error ("filename has an extension that is not supported")
 * を返すため、本ラッパで Notion が受理できる名前へ正規化する。
 */
const NOTION_SUPPORTED_EXTENSIONS = new Set<string>([
  // audio
  "aac", "adts", "mid", "midi", "mp3", "mpga", "m4a", "m4b", "oga", "ogg",
  "opus", "wav", "wma", "weba", "flac",
  // document / data
  "pdf", "txt", "csv", "json", "doc", "dot", "docx", "dotx", "xls", "xlt",
  "xla", "xlsx", "xltx", "ppt", "pot", "pps", "ppa", "pptx", "potx", "rtf",
  "md", "markdown", "html", "htm", "epub", "xml", "css", "odt", "ods", "odp",
  "ics", "yaml", "yml", "tsv", "zip", "gz", "gzip", "tar", "7z", "bz2", "rar",
  // image
  "gif", "heic", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp", "ico",
  "bmp", "avif", "apng",
  // video
  "amv", "asf", "wmv", "avi", "f4v", "flv", "gifv", "m4v", "mp4", "mkv",
  "webm", "mov", "qt", "mpeg", "ogv", "3gp", "3g2",
]);

/** contentType が UTF-8 テキストとみなせるか (非対応拡張子の .txt 付与判定) */
function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (ct.startsWith("text/")) return true;
  return [
    "application/json",
    "application/x-ndjson",
    "application/ld+json",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/csv",
  ].includes(ct);
}

/**
 * Notion が受理できる (filename, contentType) の組へ正規化する。
 * Notion File Upload API は **拡張子と content_type の両方**を allowlist で
 * 検証するため、両方を同時に Notion 受理形へ揃える。
 *
 * - 対応拡張子ならそのまま (名前・拡張子・content_type を一切変えない)。
 * - 非対応拡張子 (例 `.jsonl` / contentType `application/x-ndjson`) かつ中身が
 *   テキストなら `.txt` + `text/plain` に正規化する (中身は UTF-8 テキストなので
 *   嘘にならず、元の `.jsonl` も名前に残る)。
 * - 非対応かつ非テキスト (バイナリ) は捏造で `.txt` 化せず throw し、呼び出し側に
 *   正直に失敗を返す (ルール1/2: 黙って別形式で埋めない)。
 */
function toNotionUpload(
  filename: string,
  contentType: string
): { filename: string; contentType: string } {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  if (ext && NOTION_SUPPORTED_EXTENSIONS.has(ext)) {
    return { filename, contentType };
  }
  if (isTextualContentType(contentType)) {
    return { filename: `${filename}.txt`, contentType: "text/plain" };
  }
  throw new Error(
    `Notion 非対応の拡張子「.${ext || "(なし)"}」かつ非テキスト (${contentType}) のため` +
      `アップロードできません: ${filename}`
  );
}

/** ワークスペースのファイル上限超過 (アップロード不能) を表す型付きエラー */
export class NotionFileTooLargeError extends Error {
  constructor(
    public readonly filename: string,
    public readonly size: number,
    public readonly workspaceMax: number
  ) {
    super(
      `ファイルが Notion ワークスペース上限を超過: ${filename} ${size} bytes > ${workspaceMax} bytes`
    );
    this.name = "NotionFileTooLargeError";
  }
}

interface CreateFileUploadResponse {
  id: string;
  status: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * file_upload が `uploaded` に確定したことを検証する。
 *
 * send/complete が HTTP 2xx でも、前段エッジ (CDN/WAF) の応答だったり
 * 確定が非同期だったりすると status が `pending` のまま残ることがある。
 * 未確定の id をページに添付すると Notion が 400 (validation_error
 * "has an invalid status of pending") を返し、これは真正 JSON エラー＝
 * 恒久 throw となって**バッチ全体を巻き添え**にする。確定を確認できない
 * id は返さず throw し、呼び出し側で「アップロード失敗」として正直に
 * 1 行単位で扱わせる (捏造・pending 添付をしない — ルール1/2)。
 */
async function assertUploaded(id: string, filename: string): Promise<void> {
  // 確定は概ね即時だが非同期余地を見て数回だけ短くポーリング。
  let last: string | undefined;
  for (let i = 0; i < 4; i++) {
    const fu = await notionRequest<{ status?: string }>(
      "GET",
      `/file_uploads/${id}`
    );
    last = fu.status;
    if (fu.status === "uploaded") return;
    if (fu.status === "failed" || fu.status === "expired") break;
    await sleep(1200);
  }
  throw new Error(
    `file_upload 未確定 (status=${last ?? "?"}≠uploaded) のため添付しない: ${filename} id=${id}`
  );
}

/** インテグレーション所属 WS のファイル上限を取得 (キャッシュ) */
let cachedWorkspaceMax: number | null = null;
async function workspaceMaxBytes(): Promise<number> {
  if (cachedWorkspaceMax !== null) return cachedWorkspaceMax;
  const me = await notionRequest<{
    bot?: { workspace_limits?: { max_file_upload_size_in_bytes?: number } };
  }>("GET", "/users/me");
  const max = me.bot?.workspace_limits?.max_file_upload_size_in_bytes;
  if (typeof max !== "number" || max <= 0) {
    throw new Error(
      "Notion: workspace の max_file_upload_size_in_bytes を取得できませんでした"
    );
  }
  cachedWorkspaceMax = max;
  return max;
}

/**
 * バイト列を Notion にアップロードし、ページの files プロパティへ添付できる
 * file_upload ID を返す。
 *
 * @throws NotionFileTooLargeError WS 上限超過時 (呼び出し側で正直に記録すること)
 */
export async function uploadFile(args: {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}): Promise<string> {
  const { bytes, filename, contentType } = args;
  if (bytes.length === 0) {
    throw new Error(`空ファイルはアップロードできません: ${filename}`);
  }

  // Notion が受理できる (拡張子, content_type) へ正規化 (両方を allowlist 検証
  // するため非対応のままだと 400 になる)。正規化が起きたら運用者が Notion 上で
  // 末尾 `.txt` を見て驚かないよう正直にログする (由来を隠さない)。
  const { filename: uploadName, contentType: uploadType } = toNotionUpload(
    filename,
    contentType
  );
  if (uploadName !== filename || uploadType !== contentType) {
    console.info(
      `[notion-archive] Notion 非対応形式のため正規化: ${filename} (${contentType}) → ${uploadName} (${uploadType})`
    );
  }

  const wsMax = await workspaceMaxBytes();
  if (bytes.length > wsMax) {
    throw new NotionFileTooLargeError(filename, bytes.length, wsMax);
  }

  if (bytes.length <= SINGLE_MAX) {
    const created = await notionRequest<CreateFileUploadResponse>(
      "POST",
      "/file_uploads",
      { mode: "single_part", filename: uploadName, content_type: uploadType }
    );
    await notionSendFilePart(created.id, {
      bytes,
      filename: uploadName,
      contentType: uploadType,
    });
    await assertUploaded(created.id, uploadName);
    return created.id;
  }

  // multi_part
  const numberOfParts = Math.ceil(bytes.length / PART_SIZE);
  const created = await notionRequest<CreateFileUploadResponse>(
    "POST",
    "/file_uploads",
    {
      mode: "multi_part",
      number_of_parts: numberOfParts,
      filename: uploadName,
      content_type: uploadType,
    }
  );
  for (let i = 0; i < numberOfParts; i++) {
    const slice = bytes.subarray(i * PART_SIZE, (i + 1) * PART_SIZE);
    await notionSendFilePart(created.id, {
      bytes: slice,
      filename: uploadName,
      contentType: uploadType,
      partNumber: i + 1,
    });
  }
  await notionRequest("POST", `/file_uploads/${created.id}/complete`, {});
  await assertUploaded(created.id, uploadName);
  return created.id;
}
