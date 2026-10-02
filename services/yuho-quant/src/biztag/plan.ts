/**
 * 差分方式のワークキュー計画 (I/O なし・純粋関数)。
 * 設計: docs/005-yuho-quant-business-tags.md §5.1・§5.2。
 *
 * D1 の最新有報 (`loadLatestDocs`) と Notion「銘柄マスタ（補足）」の既存行を
 * 突き合わせ、銘柄ごとに 1 つの `WorkItem` を作る。「取り込み直後にキューへ積む」
 * はこの差分そのもので実現する (別途キュー表は持たない)。
 *
 * 判定済みタグは銘柄コードで再利用し、有報・語彙の更新では付け直さない。
 * 未設定・判定失敗だけを処理し、上場資格や保存済み結果が不確定なら HOLD。
 */
import type { LatestDoc, NewStockEligibility } from "./source.js";
import type { SupplementRow } from "../../../../src/shared/notion-archive/index.js";
import { assertBiztagDate } from "../env.js";

/** 新規初回の外部判定の最大再試行回数。既存の機械判定には適用しない。 */
export const MAX_RETRY_ATTEMPTS = 5;
export const INITIAL_SEMIF_INPUT_PREFIX = "SemIf新規銘柄の初回判定";

export type WorkItemKind =
  | "create_row"
  | "no_text"
  | "sync_and_tag"
  | "retag"
  | "version_bump"
  | "retry"
  | "skip";

export interface WorkItem {
  kind: WorkItemKind;
  stockCode: string;
  companyName: string;
  sector33: string | null;
  doc: LatestDoc["doc"];
  /** 既存の補足行 (無ければ null) */
  row: SupplementRow | null;
  /** 人間可読の判定理由 (ログ・テスト用) */
  reason: string;
  /**
   * `kind === "skip"` のうち、再試行上限 (`MAX_RETRY_ATTEMPTS`) に到達したため
   * 触らずに残っている銘柄かどうか (docs §11.6 の 3 番目の通知条件)。他の
   * skip 理由 (保存済みの判定を再利用 / 再試行期日未到来 等) と区別するための
   * 専用フラグ (`reason` の文字列パースに頼らない)。
   */
  retryExhausted?: boolean;
  /** 公式上場の資格と未完の初回判定が揃った項目だけ true。省略時は機械判定。 */
  initialSemif?: boolean;
  /** 入力資格/本文/保存済み結果が未確定。skip でも完了扱いにしないための明示。 */
  qualificationHeld?: boolean;
}


type Doc = NonNullable<LatestDoc["doc"]>;

/** 最新有報の本文が実際に読める状態か (D1 のポインタと抽出状態から判定)。 */
function hasUsableText(doc: LatestDoc["doc"]): doc is Doc & { notionDocPageId: string } {
  return doc !== null && doc.notionDocPageId !== null && doc.notionDocPageId.length > 0 && doc.textParseStatus === "ok";
}

function hasPreviousJudgment(row: SupplementRow | null): boolean {
  return row !== null && (
    row.tagStatus === "判定済" || row.tagDoc !== null || row.judgedAt !== null ||
    row.upstream.length > 0 || row.downstream.length > 0 || row.distribution.length > 0 ||
    row.themes.length > 0 || (row.uncertain !== null && row.uncertain.length > 0) ||
    (row.evidenceText !== null && row.evidenceText.length > 0)
  );
}

function canInitialSemif(row: SupplementRow | null): boolean {
  if (row === null) return true;
  if (hasPreviousJudgment(row) || row.judgeInput === undefined) return false;
  if (row.attempts === 0 && row.error === null && row.tagStatus !== "判定不能" && row.tagStatus !== "読込失敗") return true;
  return (row.tagStatus === "判定不能" || row.tagStatus === "読込失敗") &&
    typeof row.attempts === "number" && Number.isInteger(row.attempts) && row.attempts > 0 &&
    row.judgeInput !== null && row.judgeInput.startsWith(INITIAL_SEMIF_INPUT_PREFIX);
}

function planOne(
  latest: LatestDoc,
  row: SupplementRow | null,
  today: string,
  eligibility?: NewStockEligibility
): WorkItem {
  const base = {
    stockCode: latest.stockCode,
    companyName: latest.companyName,
    sector33: latest.sector33,
    doc: latest.doc,
    row,
  };

  if (eligibility?.heldCodes.has(latest.stockCode) === true) {
    return { ...base, kind: "skip", qualificationHeld: true, reason: "母集団の上場資格が HOLD。保存済み結果を保持し、新規・既存とも機械判定に置き換えない" };
  }

  if (row === null) {
    if (!hasUsableText(latest.doc)) {
      return { ...base, kind: "create_row", qualificationHeld: true, reason: "補足行を本文なしで作成。初回判定は最新有報の本文取得まで HOLD" };
    }
    const initialSemif = eligibility?.eligibleCodes.has(latest.stockCode) === true;
    return { ...base, kind: "sync_and_tag", initialSemif, reason: initialSemif
      ? "確認済み新規上場の未完の初回判定。最新有報の本文を使用"
      : "補足行なしの既存銘柄を最新有報から機械判定 (新規上場の資格なし)" };
  }

  if (!hasUsableText(latest.doc)) {
    return { ...base, kind: "skip", qualificationHeld: true, reason: "最新有報の本文が無いため HOLD。保存済み本文・タグ・判定状態は保持" };
  }

  const doc = latest.doc;
  if (row.tagStatus === "判定済") {
    // 保存形式は「docId 会計期末」。最新有報ではなく、保存済みの書類同士を照合する。
    const savedTagDocId = row.tagDoc === null ? null : row.tagDoc.split(" ", 1)[0];
    const hasTagOrUncertain = row.upstream.length > 0 || row.downstream.length > 0 ||
      row.distribution.length > 0 || (row.uncertain !== null && row.uncertain.length > 0);
    if (row.docId === null || row.docId.trim().length === 0 || savedTagDocId !== row.docId ||
        row.vocabVersion === null || row.vocabVersion.trim().length === 0 ||
        (hasTagOrUncertain && (row.evidenceText === null || row.evidenceText.trim().length === 0))) {
      return { ...base, kind: "skip", qualificationHeld: true, reason: "判定済みの保存根拠が欠落・不整合のため HOLD。タグと根拠を保持し上書きしない" };
    }
    return { ...base, kind: "skip", reason: "銘柄コードの保存済み判定を再利用。有報・単語帳の更新では付け直さない" };
  }
  if (hasPreviousJudgment(row)) {
    return { ...base, kind: "skip", qualificationHeld: true, reason: "既存タグ・根拠・判定記録があるが状態が未完のため HOLD。保存済み結果を上書きしない" };
  }
  if (eligibility?.eligibleCodes.has(latest.stockCode) === true && !canInitialSemif(row)) {
    const knownPreviousFailure = (row.tagStatus === "判定不能" || row.tagStatus === "読込失敗") &&
      row.error !== null && row.error.trim().length > 0 && row.judgeInput !== undefined &&
      (row.judgeInput === null || !row.judgeInput.startsWith(INITIAL_SEMIF_INPUT_PREFIX));
    if (!knownPreviousFailure) {
      return { ...base, kind: "skip", qualificationHeld: true, reason: "新規上場の初回判定履歴が不明なため HOLD。機械判定の完了に置き換えない" };
    }
  }
  if (eligibility?.eligibleCodes.has(latest.stockCode) === true && canInitialSemif(row)) {
    if (row.attempts !== null && row.attempts > 0) {
      if (row.attempts >= MAX_RETRY_ATTEMPTS) {
        return { ...base, kind: "skip", retryExhausted: true, reason: "SemIf新規銘柄の初回判定が再試行上限に到達" };
      }
      if (row.nextRetryAt === null) {
        return { ...base, kind: "skip", reason: "SemIf新規銘柄の初回判定の再試行期日が未到来" };
      }
      assertBiztagDate(row.nextRetryAt, "SemIf 初回 nextRetryAt");
      if (row.nextRetryAt > today) return { ...base, kind: "skip", reason: "SemIf新規銘柄の初回判定の再試行期日が未到来" };
      return { ...base, kind: "retry", initialSemif: true, reason: "確認済み新規上場の初回判定を再試行 (専用の判定入力記録あり)" };
    }
    return { ...base, kind: "sync_and_tag", initialSemif: true, reason: "確認済み新規上場の未完の初回判定。最新有報の本文を使用" };
  }
  if (row.docId !== doc.docId) {
    return {
      ...base,
      kind: "sync_and_tag",
      reason: `書類IDが最新と異なる (行=${row.docId ?? "無し"} 最新=${doc.docId})`,
    };
  }

  if (row.tagStatus === "判定不能" || row.tagStatus === "読込失敗") {
    return { ...base, kind: "retry", reason: "既存の判定失敗を機械判定で処理。過去の外部判定の再試行期日・回数には依存しない" };
  }

  // 未判定等 (docId は最新と一致しているが判定が完了していない状態。過去の
  // 部分失敗からの回復用に「同期し直す」扱いにする)。
  return {
    ...base,
    kind: "sync_and_tag",
    reason: `同じ書類だが未判定 (tagStatus=${row.tagStatus ?? "無し"})`,
  };
}

/**
 * D1 の最新有報 (`latest`) と Notion の既存行 (`rows`) を突き合わせ、
 * 銘柄ごとに 1 つの作業項目を作る (`latest` の並び順)。
 * 新規資格を渡さない呼出では、不足補完も機械判定のみ。行の無い銘柄を新規と推測しない。
 */
export function planWork(
  latest: LatestDoc[],
  rows: SupplementRow[],
  today: string,
  eligibility?: NewStockEligibility
): WorkItem[] {
  const rowByCode = new Map(rows.map((r) => [r.stockCode, r] as const));
  if (rowByCode.size !== rows.length) throw new Error("planWork: 同じ銘柄コードの補足行が重複しています。判定停止");
  return latest.map((l) =>
    planOne(l, rowByCode.get(l.stockCode) ?? null, today, eligibility)
  );
}
