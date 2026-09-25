/**
 * 単語帳への提案の出典検査。設計: docs/005-yuho-quant-business-tags.md §6.3-2。
 *
 * 提案の変更ごと・語ごとの出典 URL を実際に取得し (HTML → テキスト化 /
 * PDF → unpdf でテキスト化)、`quote` (原文からの短い引用) が本文に実在するか
 * NFKC・空白を正規化した部分一致で確かめる。取得できない・引用が見つからない
 * 場合は正直に issue として報告する (黙って通さない・ルール2)。
 */
import { extractText, getDocumentProxy } from "unpdf";
import { normalizeForMatch } from "./text.js";
import type { Change, Proposal } from "./vocabulary/proposal.js";

export interface SourceCheckIssue {
  code: "fetch_failed" | "quote_not_found" | "disallowed_host";
  url: string;
  quote: string;
  label: string;
  message: string;
}

/**
 * 出典として許可するホスト (末尾一致)。設計 §1.5「単語帳の出典は公的資料に限る」の
 * コード側の強制。政府機関ドメイン (`.go.jp`) に限定する — これにより、
 * 提案者 (合言葉トークン保持者) が任意のドメインへ攻撃者管理のコンテンツを
 * 用意して「出典」として通すことができなくなる (単なる到達可能性・引用一致
 * 検査だけでは防げない)。将来ここに無い公的資料が必要になった場合は、
 * このリストへ明示的に追加すること (黙って全ドメインを許可しない)。
 */
export const ALLOWED_SOURCE_HOST_SUFFIXES: readonly string[] = [".go.jp"];

/** 出典 URL のホストが許可リストに含まれるか。 */
export function isAllowedSourceHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_SOURCE_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)
  );
}

/** 出典取得の応答本文の上限バイト数 (それ以上は読まず失敗として扱う)。 */
export const MAX_SOURCE_RESPONSE_BYTES = 20 * 1024 * 1024;
/** 出典取得のタイムアウト (dataset.ts の外部 fetch と同水準)。 */
const FETCH_TIMEOUT_MS = 15_000;

interface CollectedSource {
  url: string;
  quote: string;
  label: string;
}

function sourcesOfChange(change: Change): CollectedSource[] {
  const out: CollectedSource[] = [];
  switch (change.op) {
    case "add_business":
    case "add_theme":
      for (const src of change.term.sources) {
        out.push({ url: src.url, quote: src.quote, label: `${change.op}:${change.term.id}` });
      }
      for (const ev of change.evidence) {
        out.push({ url: ev.url, quote: ev.quote, label: `${change.op}:${change.term.id}(evidence)` });
      }
      break;
    case "update":
      if (change.patch.sources) {
        for (const src of change.patch.sources) {
          out.push({ url: src.url, quote: src.quote, label: `update:${change.id}` });
        }
      }
      for (const ev of change.evidence) {
        out.push({ url: ev.url, quote: ev.quote, label: `update:${change.id}(evidence)` });
      }
      break;
    case "add_keywords":
    case "deprecate":
      for (const ev of change.evidence) {
        out.push({ url: ev.url, quote: ev.quote, label: `${change.op}:${change.id}(evidence)` });
      }
      break;
  }
  return out;
}

/** 提案の全変更から検査すべき (URL, 引用) の組を集める (`sourcesChecked` は引用を持たないため対象外)。 */
function collectSources(proposal: Proposal): CollectedSource[] {
  return proposal.changes.flatMap(sourcesOfChange);
}

const SCRIPT_STYLE_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const HTML_TAG_RE = /<[^>]*>/g;

/**
 * タグは空文字へ置換する (前後に空白を挿し込まない)。ブロック要素の境界は
 * 大抵ソース HTML 自体の改行・空白がそのまま残るため、それを
 * `normalizeForMatch` の空白畳み込みに委ねる。タグ除去時に空白を足すと
 * `<b>製造</b>` のようなインライン強調タグが引用文の途中を割ってしまい、
 * 実在する引用が「見つからない」偽陰性になる (安全側に倒すなら偽陰性より
 * 偽陽性の方が実害が小さい — 誤って通した提案は他の 3 関門でなお弾ける)。
 */
function htmlToText(html: string): string {
  return html
    .replace(SCRIPT_STYLE_RE, "")
    .replace(HTML_TAG_RE, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** PDF バイト列 → プレーンテキスト (`unpdf`。ページ結合)。 */
async function pdfToText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(bytes);
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

function looksLikePdf(url: string, contentType: string): boolean {
  return contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf");
}

/**
 * URL を取得して正規化済みテキストを返す。取得・変換に失敗したら null
 * (フォールバックしない — 呼び出し側が issue にする)。
 *
 * SSRF 対策: リダイレクトは自動追従しない (`redirect: "manual"`。出典は
 * リダイレクトされない前提 — 追従すると許可ホスト外へ誘導されうる)。
 * タイムアウトを付ける (他の外部 fetch (dataset.ts 等) と同水準)。
 * 応答本文は `Content-Length` で事前に上限を検査してから読む
 * (無制限にメモリへバッファしない)。
 */
async function fetchAndNormalize(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_RESPONSE_BYTES) {
    return null;
  }

  const contentType = res.headers.get("content-type") ?? "";
  let raw: string;
  try {
    if (looksLikePdf(url, contentType)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_SOURCE_RESPONSE_BYTES) return null;
      raw = await pdfToText(bytes);
    } else {
      const text = await res.text();
      if (new TextEncoder().encode(text).length > MAX_SOURCE_RESPONSE_BYTES) return null;
      raw = htmlToText(text);
    }
  } catch {
    return null;
  }
  return normalizeForMatch(raw);
}

/**
 * 提案の出典 URL を検査する。同じ URL は 1 回だけ取得する (提案内で使い回している場合が多い)。
 * 見つかった問題を全て返す (0 件 = 問題なし)。
 */
export async function verifySources(
  proposal: Proposal,
  fetchImpl: typeof fetch = fetch
): Promise<SourceCheckIssue[]> {
  const items = collectSources(proposal);
  const cache = new Map<string, string | null>();
  const issues: SourceCheckIssue[] = [];

  for (const item of items) {
    if (!isAllowedSourceHost(item.url)) {
      // 許可ホスト外は取得すらしない (SSRF・任意ドメインへの出典なりすまし対策)。
      issues.push({
        code: "disallowed_host",
        url: item.url,
        quote: item.quote,
        label: item.label,
        message: `出典 URL のホストが許可リストにありません (公的資料のみ許可): ${item.url} (${item.label})`,
      });
      continue;
    }
    let normalized = cache.get(item.url);
    if (normalized === undefined) {
      normalized = await fetchAndNormalize(item.url, fetchImpl);
      cache.set(item.url, normalized);
    }
    if (normalized === null) {
      issues.push({
        code: "fetch_failed",
        url: item.url,
        quote: item.quote,
        label: item.label,
        message: `出典 URL の取得に失敗しました: ${item.url} (${item.label})`,
      });
      continue;
    }
    const normalizedQuote = normalizeForMatch(item.quote);
    if (!normalized.includes(normalizedQuote)) {
      issues.push({
        code: "quote_not_found",
        url: item.url,
        quote: item.quote,
        label: item.label,
        message: `引用が出典本文に見つかりません: "${item.quote}" (${item.url}, ${item.label})`,
      });
    }
  }
  return issues;
}
