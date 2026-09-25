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
  code: "fetch_failed" | "quote_not_found" | "disallowed_host" | "verification_timed_out";
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

/**
 * `verifySources` 全体 (逐次 fetch のループ) に許す時間予算の既定値。
 *
 * `MAX_PROPOSAL_SOURCE_REFS` (schema 側の合計件数上限) だけでは、
 * 「上限いっぱいの正当そうな提案」が実際に fetch されるとどれだけ時間が
 * かかるかまでは縛れない (1件最大 `FETCH_TIMEOUT_MS`=15秒・同じ URL は
 * キャッシュされるが、異なる URL を大量に挙げれば依然として長時間化しうる)。
 * ここで検査ループ自体にも独立した壁時計の予算を持たせ、超えたら残りを
 * 「検査タイムアウト」として正直に報告し打ち切る (黙って続行しない・
 * ルール2)。これにより関門 (`evaluateProposal`) は該当提案を不採用にでき、
 * `pnpm biztag run` 全体 (catchup.yml 60分・backfill.yml 355分のジョブ
 * タイムアウトがある) を道連れにしない。
 */
export const DEFAULT_VERIFY_SOURCES_BUDGET_MS = 5 * 60_000;

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

export interface VerifySourcesOptions {
  /**
   * この時刻 (epoch ms, `Date.now()` 基準) を過ぎたら、以降の未検査分は
   * 実際には fetch せず `verification_timed_out` として報告し打ち切る。
   * 省略時は無期限 (既存呼び出し元・テストの後方互換のため)。
   */
  deadlineAt?: number;
}

/**
 * 提案の出典 URL を検査する。同じ URL は 1 回だけ取得する (提案内で使い回している場合が多い)。
 * 見つかった問題を全て返す (0 件 = 問題なし)。
 */
export async function verifySources(
  proposal: Proposal,
  fetchImpl: typeof fetch = fetch,
  opts: VerifySourcesOptions = {}
): Promise<SourceCheckIssue[]> {
  const items = collectSources(proposal);
  const cache = new Map<string, string | null>();
  const issues: SourceCheckIssue[] = [];

  for (const item of items) {
    if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
      // 残り (この item を含む) は正直に「時間切れで未検査」と報告して打ち切る
      // (黙って続行しない・黙って「問題なし」にもしない — ルール2)。1 件でも
      // 出ればこの提案は不採用になる (evaluateProposal のステップ2)。
      issues.push({
        code: "verification_timed_out",
        url: item.url,
        quote: item.quote,
        label: item.label,
        message: `出典検査の時間予算 (${DEFAULT_VERIFY_SOURCES_BUDGET_MS}ms 相当) を超えたため、これ以降 (${item.label} を含む) の検査を打ち切りました`,
      });
      break;
    }
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

/**
 * `runGate`(`GateChecks.verifySources`)にそのまま渡せる、時間予算つきの
 * `verifySources` を作る。呼び出しのたびに `Date.now() + budgetMs` を締切に
 * するため、審査する提案が複数あっても合計の壁時計予算は 1 回ぶんに固定される
 * (提案ごとにリセットしない — 1 提案が予算を使い切ったら、以降の提案は
 * ほぼ即座に `verification_timed_out` になり不採用として処理が進む。
 * 「1 回の実行全体を止めない」という目的に対してはこれで十分)。
 */
export function makeBudgetedVerifySources(
  budgetMs: number = DEFAULT_VERIFY_SOURCES_BUDGET_MS,
  fetchImpl: typeof fetch = fetch
): (proposal: Proposal) => Promise<SourceCheckIssue[]> {
  const deadlineAt = Date.now() + budgetMs;
  return (proposal: Proposal) => verifySources(proposal, fetchImpl, { deadlineAt });
}
