/** モデルを使わない競合入力の固定。旧確率・競合relationは入力にも出力にも持たない。 */
import { createHash } from "node:crypto";
import { canonicalizeForHash } from "../../../../../src/shared/notion-archive/biztag-ledger.js";
import type { SupplementRow } from "../../../../../src/shared/notion-archive/stock-supplement.js";
import { TEXT_SECTIONS } from "../../services/edinet/text-sections.js";
import { planWork, readInputReceipt, readTextSyncReceipt } from "../plan.js";
import type { LatestDoc } from "../source.js";
import { formatPeriodJa } from "../evidence.js";
import { PREFILTER_SECTIONS } from "../prefilter.js";
import { buildCandidates, GENERIC_TAG_LABELS, type CompanyProfile } from "./candidates.js";
import { competitorDecisionVersion, type CompetitorCalibration } from "./calibration.js";
import { buildCompetitorQuestion, buildCompetitorState, questionIdForCandidate } from "./question.js";

export const preparedJson = (value: unknown): string => JSON.stringify(canonicalizeForHash(value));
export const preparedSha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hash = (value: unknown): string => preparedSha(preparedJson(value));
const rowMetadata = ({ texts: _texts, ...row }: SupplementRow) => row;

export function prepareCandidateInputs(rows: SupplementRow[], calibration: CompetitorCalibration, codes: string[]) {
  if (new Set(rows.map(r => r.stockCode)).size !== rows.length || new Set(rows.map(r => r.pageId)).size !== rows.length) {
    throw new Error("競合corpusの銘柄/ページが重複しています");
  }
  // 既存と同じ集合で候補を計算する。資格不足のBを消して別の候補へ置き換えない。
  const corpus: CompanyProfile[] = rows.filter(r => r.tagStatus === "判定済").map(r => ({ stockCode: r.stockCode,
    companyName: r.companyName, pageId: r.pageId, sector33: r.sector33,
    tags: [...r.upstream, ...r.downstream, ...r.distribution], businessText: r.texts["事業の内容"], docId: r.docId }));
  const built = buildCandidates(corpus, { topK: calibration.candidateTopK, weights: calibration.candidateWeights,
    postingCaps: calibration.candidatePostingCaps, genericTagLabels: GENERIC_TAG_LABELS });
  const candidates = Object.fromEntries(codes.map(code => [code, built.get(code) ?? null]));
  const neededCodes = [...new Set([...codes, ...Object.values(candidates).flatMap(cs => cs === null ? [] : cs.map(c => c.stockCode))])].sort();
  return { corpus, candidates, neededCodes };
}

/** 現在タグを使う資格と、歴史的な意味判定入力を検証できたかは分けて返す。 */
export function qualifyPreparedCompany(latest: LatestDoc | undefined, corpusRow: SupplementRow | undefined,
  fullRow: SupplementRow | undefined, today: string) {
  const hold = (reason: string) => ({ status: "hold" as const, reason });
  if (latest === undefined || latest.doc === null) return hold("active/latest-document-missing");
  if (corpusRow === undefined || fullRow === undefined) return hold("supplement-row-missing");
  const doc = latest.doc;
  if (fullRow.stockCode !== latest.stockCode || fullRow.companyName !== latest.companyName ||
      fullRow.sector33 !== latest.sector33 || fullRow.docId !== doc.docId || fullRow.periodEnd !== doc.periodEnd ||
      fullRow.docType !== (doc.docTypeCode === "120" ? "有報" : "訂正有報") ||
      fullRow.submittedAt === null || Date.parse(fullRow.submittedAt) !== Date.parse(doc.submittedAt)) return hold("identity-or-document-generation-mismatch");
  if (preparedJson(rowMetadata(corpusRow)) !== preparedJson(rowMetadata(fullRow)) ||
      corpusRow.texts["事業の内容"] !== fullRow.texts["事業の内容"]) return hold("corpus-input-changed-during-read");
  if (Object.keys(fullRow.texts).sort().join("\n") !== TEXT_SECTIONS.map(s => s.title).sort().join("\n") ||
      Object.values(fullRow.texts).some(v => typeof v !== "string")) return hold("39-text-columns-incomplete");
  try {
    const item = planWork([latest], [fullRow], today)[0];
    if (fullRow.tagStatus !== "判定済" || item.kind !== "skip" || item.qualificationHeld) return hold("tag-or-text-sync-needs-work");
    if (fullRow.tagDoc !== `${doc.docId} ${formatPeriodJa(doc.periodEnd)}` || fullRow.judgeInput === undefined) return hold("tag-document-provenance-missing");
    const sync = readTextSyncReceipt(fullRow.judgeInput), judgment = readInputReceipt(fullRow.judgeInput);
    // Notionの空rich_textはpublisherがクリアしたNULL。未知の欠落列は上で拒否する。
    const textsSha256 = hash(TEXT_SECTIONS.map(({ title }) => [title, fullRow.texts[title] === "" ? null : fullRow.texts[title]]));
    if (sync === null || sync.docId !== doc.docId || sync.textPageId !== doc.notionDocPageId || sync.textsSha256 !== textsSha256) return hold("39-text-sync-receipt-mismatch");
    if (fullRow.texts["事業の内容"].trim() === "") return hold("business-text-missing");
    const currentTagSectionsSha256 = hash(PREFILTER_SECTIONS.map(key => {
      const def = TEXT_SECTIONS.find(s => s.key === key);
      if (def === undefined) throw new Error("判定対象節が定義にありません");
      return [key, fullRow.texts[def.title] === "" ? null : fullRow.texts[def.title]];
    }));
    const businessSha256 = preparedSha(fullRow.texts["事業の内容"]);
    if (judgment !== null && (judgment.sectionsSha256 !== currentTagSectionsSha256 || judgment.businessSha256 !== businessSha256)) {
      return hold("known-tag-judgment-input-changed");
    }
    return { status: "qualified" as const, docId: doc.docId, periodEnd: doc.periodEnd, textPageId: doc.notionDocPageId,
      textsSha256, fullTextValuesSha256: hash(fullRow.texts), businessSha256, currentTagSectionsSha256,
      tagsSha256: hash([fullRow.upstream, fullRow.downstream, fullRow.distribution]), textSyncReceipt: sync,
      historicalTagInput: judgment, historicalTagInputStatus: judgment === null ? "unverified-legacy" as const : "stored-receipt" as const };
  } catch {
    return hold("tag-or-text-receipt-invalid");
  }
}

export function buildPreparedCompetitorManifest(args: { rows: SupplementRow[]; fullRows: SupplementRow[]; latest: LatestDoc[];
  plan: ReturnType<typeof prepareCandidateInputs>; calibration: CompetitorCalibration; codes: string[];
  sourceHashes: Record<string, string>; today: string }) {
  const { rows, fullRows, latest, plan, calibration, codes, sourceHashes, today } = args;
  for (const group of [fullRows.map(r => r.stockCode), latest.map(r => r.stockCode)]) {
    if (new Set(group).size !== group.length) throw new Error("競合準備の行/最新docが重複しています");
  }
  const byCode = new Map(rows.map(r => [r.stockCode, r])), fullByCode = new Map(fullRows.map(r => [r.stockCode, r]));
  const latestByCode = new Map(latest.map(r => [r.stockCode, r])), profiles = new Map(plan.corpus.map(r => [r.stockCode, r]));
  const qualification = Object.fromEntries(plan.neededCodes.map(code => [code,
    qualifyPreparedCompany(latestByCode.get(code), byCode.get(code), fullByCode.get(code), today)]));
  const prepared = codes.map(code => {
    const a = profiles.get(code), candidates = plan.candidates[code];
    const heldCodes = [code, ...(candidates === null ? [] : candidates.map(c => c.stockCode))]
      .filter(c => qualification[c].status === "hold");
    const questions = candidates === null ? null : Object.fromEntries(candidates.map(c => {
      const b = profiles.get(c.stockCode);
      if (b === undefined) throw new Error("固定corpusに候補がありません");
      return [questionIdForCandidate(c.stockCode), buildCompetitorQuestion(b)];
    }));
    const state = a === undefined ? null : buildCompetitorState(a);
    return { stockCode: code, status: a !== undefined && candidates !== null && heldCodes.length === 0 ? "prepared" : "hold",
      heldCodes, state, stateSha256: state === null ? null : preparedSha(state), questions,
      qids: questions === null ? null : Object.keys(questions), questionsSha256: questions === null ? null : hash(questions), candidates };
  });
  return { version: "competitor-prepared-input-v1" as const, purpose: "input-preparation-only" as const,
    calibration, calibrationSha256: hash(calibration), decisionVersion: competitorDecisionVersion(calibration), sourceHashes,
    targetCodes: codes, corpus: plan.corpus, corpusSha256: hash(plan.corpus),
    latest: plan.neededCodes.map(code => latestByCode.get(code) ?? { stockCode: code, status: "latest-unobserved" }),
    fullRows: [...fullRows].sort((a,b) => a.stockCode.localeCompare(b.stockCode)), qualification, prepared,
    holds: prepared.filter(p => p.status === "hold").map(p => ({ stockCode: p.stockCode, heldCodes: p.heldCodes })),
    modelCalls: 0 as const, competitorWrites: 0 as const, schemaWrites: 0 as const,
    limits: ["Preparation is not a competitor decision or proof of the historical tag judgment.",
      "No saved probability is transferred to this input. Recheck current generations before any later judgment/publication.",
      "Candidate caps/recall limits remain the existing calibrated contract; qualification failure preserves the candidate set and holds A."] };
}
