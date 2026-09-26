/**
 * 差分方式のワークキュー計画 (I/O なし・純粋関数)。
 * 設計: docs/005-yuho-quant-business-tags.md §5.1・§5.2。
 *
 * D1 の最新有報 (`loadLatestDocs`) と Notion「銘柄マスタ（補足）」の既存行を
 * 突き合わせ、銘柄ごとに 1 つの `WorkItem` を作る。「取り込み直後にキューへ積む」
 * はこの差分そのもので実現する (別途キュー表は持たない)。
 *
 * 版の違いの影響判定 (§5.2 表脚注) が本文を prefilter し直すため、版が違う
 * 判定済の行については `loadSupplementRows(..., { textColumns: 絞り込み対象節の列 })`
 * で本文列を読んだ行を渡すこと (読んでいない行を黙って「影響なし」にしない —
 * sectionsFromRow が throw する)。
 */
import { PREFILTER_SECTIONS, PREFILTER_SECTION_TITLE, prefilter, type PrefilterSectionKey } from "./prefilter.js";
import type { VocabDiff } from "./vocabulary/diff.js";
import type { Vocabulary } from "./vocabulary/schema.js";
import type { LatestDoc } from "./source.js";
import type { SupplementRow } from "../../../../src/shared/notion-archive/index.js";

/** 最大再試行回数 (§5.2)。到達したら触らない (サマリ・Issue で件数だけ可視化する)。 */
export const MAX_RETRY_ATTEMPTS = 5;

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
   * skip 理由 (同じ書類・判定済・同じ版 / 再試行期日未到来 等) と区別するための
   * 専用フラグ (`reason` の文字列パースに頼らない)。
   */
  retryExhausted?: boolean;
}


type Doc = NonNullable<LatestDoc["doc"]>;

/** 最新有報の本文が実際に読める状態か (D1 のポインタと抽出状態から判定)。 */
function hasUsableText(doc: LatestDoc["doc"]): doc is Doc & { notionDocPageId: string } {
  return doc !== null && doc.notionDocPageId !== null && doc.textParseStatus === "ok";
}

function sectionsFromRow(row: SupplementRow): Partial<Record<PrefilterSectionKey, string>> {
  const sections: Partial<Record<PrefilterSectionKey, string>> = {};
  for (const key of PREFILTER_SECTIONS) {
    const title = PREFILTER_SECTION_TITLE[key];
    if (!(title in row.texts)) {
      throw new Error(
        `planWork: ${row.stockCode} の本文列「${title}」が読み込まれていない (版の影響判定に必要。loadSupplementRows の textColumns を確認)`
      );
    }
    const text = row.texts[title];
    if (text !== undefined && text.length > 0) sections[key] = text;
  }
  return sections;
}

/** "名前（0.55）／名前2（0.42）" → ["名前","名前2"] (row.ts の書式の逆変換)。 */
function parseUncertainLabels(uncertain: string | null): string[] {
  if (!uncertain) return [];
  return uncertain
    .split(" / ")
    .map((s) => s.replace(/（[0-9.]+）$/, "").trim())
    .filter((s) => s.length > 0);
}

function buildActiveLabelIndex(vocab: Vocabulary): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of vocab.business) if (!t.deprecated) map.set(t.labelJa.toLowerCase(), t.id);
  for (const t of vocab.themes) if (!t.deprecated) map.set(t.labelJa.toLowerCase(), t.id);
  return map;
}

/**
 * 版の違いの影響判定 (§5.2 表脚注)。今の (新しい) 単語帳で絞り込みをやり直し、
 * 候補語か既存タグ・要確認のいずれかが「変わった語」(`diff.changedTermIds`) に
 * 当たれば true (判定し直す)。当たらなければ false (版とテーマ列だけ更新)。
 *
 * ラベル→id の対応づけは**今の単語帳**を使う: 旧ラベルが今の単語帳に存在しない
 * 語は「名前が変わった/廃止された」= 必ず変更語集合に含まれるはずの語なので、
 * そのまま「影響あり」として扱ってよい (旧単語帳を別途読みに行く必要が無い)。
 */
function isImpacted(vocab: Vocabulary, row: SupplementRow, diff: VocabDiff): boolean {
  const changed = new Set(diff.changedTermIds);
  const sections = sectionsFromRow(row);
  const result = prefilter(vocab, sections);
  if (result.candidates.some((c) => changed.has(c.term.id))) return true;

  const labelToId = buildActiveLabelIndex(vocab);
  const labels = [
    ...row.upstream,
    ...row.downstream,
    ...row.distribution,
    ...parseUncertainLabels(row.uncertain),
  ];
  for (const label of labels) {
    const id = labelToId.get(label.toLowerCase());
    if (id === undefined || changed.has(id)) return true;
  }
  return false;
}

function planOne(
  latest: LatestDoc,
  row: SupplementRow | null,
  vocab: Vocabulary,
  vocabDiffFromRowVersion: (rowVersion: string) => VocabDiff,
  today: string
): WorkItem {
  const base = {
    stockCode: latest.stockCode,
    companyName: latest.companyName,
    sector33: latest.sector33,
    doc: latest.doc,
    row,
  };

  if (row === null) {
    return hasUsableText(latest.doc)
      ? { ...base, kind: "sync_and_tag", reason: "補足行が無く、最新有報の本文が読める (新規作成しつつ同期)" }
      : { ...base, kind: "create_row", reason: "補足行が無く、最新有報の本文も読めない" };
  }

  if (!hasUsableText(latest.doc)) {
    const currentDocId = latest.doc?.docId ?? null;
    const alreadyNoText =
      row.docId === currentDocId && row.textStatus === "本文なし" && row.tagStatus === "本文なし";
    return alreadyNoText
      ? { ...base, kind: "skip", reason: "最新有報の本文が無く、既に本文なし状態" }
      : { ...base, kind: "no_text", reason: "最新有報が無い、または本文が読めない" };
  }

  const doc = latest.doc as Doc;
  if (row.docId !== doc.docId) {
    return {
      ...base,
      kind: "sync_and_tag",
      reason: `書類IDが最新と異なる (行=${row.docId ?? "無し"} 最新=${doc.docId})`,
    };
  }

  // ここから row.docId === doc.docId (同じ書類)。
  if (row.tagStatus === "判定済") {
    if (row.vocabVersion === vocab.version) {
      // PR #108 で「事業タグの根拠文」列を追加した際、版が上がっただけで
      // 影響なし (version_bump) だった行は根拠文を書き戻さずに素通りしたため、
      // タグ/要確認はあるのに根拠文が空のまま残っている行がある。「タグ (3列
      // いずれか) か要確認タグが 1 つでもあるのに根拠文が空」は判定のやり直し
      // 漏れ (黙って空のまま skip しない — ルール2)。タグも要確認も無い行は
      // 該当なしが正しい判定結果であり、根拠文が空でも正常なので skip のまま。
      const hasTagOrUncertain =
        row.upstream.length > 0 ||
        row.downstream.length > 0 ||
        row.distribution.length > 0 ||
        (row.uncertain !== null && row.uncertain.length > 0);
      const evidenceMissing = row.evidenceText === null || row.evidenceText.length === 0;
      if (hasTagOrUncertain && evidenceMissing) {
        return { ...base, kind: "retag", reason: "根拠文が未記録" };
      }
      return { ...base, kind: "skip", reason: "同じ書類・判定済・同じ版" };
    }
    if (row.vocabVersion === null) {
      throw new Error(`planWork: 判定済なのに単語帳の版が記録されていません (code=${row.stockCode})`);
    }
    const diff = vocabDiffFromRowVersion(row.vocabVersion);
    const impacted = isImpacted(vocab, row, diff);
    return impacted
      ? { ...base, kind: "retag", reason: `単語帳の版が変わり影響あり (${row.vocabVersion} → ${vocab.version})` }
      : {
          ...base,
          kind: "version_bump",
          reason: `単語帳の版が変わったが影響なし (${row.vocabVersion} → ${vocab.version})`,
        };
  }

  if (row.tagStatus === "判定不能" || row.tagStatus === "読込失敗") {
    const attempts = row.attempts ?? 0;
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      return { ...base, kind: "skip", retryExhausted: true, reason: `再試行上限 (${MAX_RETRY_ATTEMPTS}回) に到達` };
    }
    const dueForRetry = row.nextRetryAt !== null && row.nextRetryAt <= today;
    return dueForRetry
      ? { ...base, kind: "retry", reason: `再試行期日 (${row.nextRetryAt}) が到来 (${attempts}回目失敗)` }
      : { ...base, kind: "skip", reason: `再試行期日 (${row.nextRetryAt ?? "未設定"}) が未到来` };
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
 */
export function planWork(
  latest: LatestDoc[],
  rows: SupplementRow[],
  vocab: Vocabulary,
  vocabDiffFromRowVersion: (rowVersion: string) => VocabDiff,
  today: string
): WorkItem[] {
  const rowByCode = new Map(rows.map((r) => [r.stockCode, r] as const));
  return latest.map((l) =>
    planOne(l, rowByCode.get(l.stockCode) ?? null, vocab, vocabDiffFromRowVersion, today)
  );
}
