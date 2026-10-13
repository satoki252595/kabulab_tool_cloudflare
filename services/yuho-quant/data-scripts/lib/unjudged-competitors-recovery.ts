import { createHash } from "node:crypto";
import type { CompanyProfile, CandidateScore } from "../../src/biztag/competitors/candidates.js";
import { competitorDecisionVersion, type CompetitorCalibration } from "../../src/biztag/competitors/calibration.js";
import type { CompetitorMeta, WriteCompetitorRelationInput } from "../../../../src/shared/notion-archive/stock-competitors.js";

export interface PageProperty {
  id: string; type: string; has_more?: boolean;
  rich_text?: Array<{ plain_text: string }>;
  title?: Array<{ plain_text: string }>;
  relation?: Array<{ id: string }>;
  date?: { start: string; end: string | null } | null;
}
export interface RecoveryPage {
  id: string; archived: boolean; in_trash: boolean;
  parent: { type: string; database_id?: string };
  properties: Record<string, PageProperty>;
}
export interface RecoverySnapshot {
  version: 1; capturedAt: string; revision: string; dbId: string;
  propertyIds: Record<string, string>; sourceHashes: Record<string, string>;
  calibration: CompetitorCalibration; targetCodes: string[];
  corpus: CompanyProfile[]; candidates: Record<string, CandidateScore[]>;
  pre: RecoveryPage[]; baseline: CompetitorMeta[]; inputFingerprints: Record<string, string>;
  excludedCorpus: Array<{ code: string; reason: string }>;
  decisionReview?: { version: "cal-thr050-eval122-20261014"; holdCodes: ["130A", "145A"]; evalInputSha256: string; evalOutputGzipSha256: string; reason: string };
}
export interface RecoveryOutput {
  stockCode: string; pageId: string; inputSha256: string;
  startedAt: string; finishedAt: string; elapsedMs: number;
  expected: WriteCompetitorRelationInput;
  probabilities: Record<string, number>; candidateCodes: string[];
  bands: { yes: number; no: number; uncertain: number };
  modelCalls: number; peakTreeRssKiB: number;
}

export const RECOVERY_DECISION_REVIEW: NonNullable<RecoverySnapshot["decisionReview"]> = {
  version: "cal-thr050-eval122-20261014", holdCodes: ["130A", "145A"],
  evalInputSha256: "e7735381070a95bd4fed11402eac720ea482fcfb5aba6b7f28afa37905e80243",
  evalOutputGzipSha256: "69dafd69fcb644a00c9af9abe8c4e91a1624e4fdc4f7d9cc8898c00ea5c7f130",
  reason: "130A/4591はmRNA標的創薬とアプタマー創薬、145A/4386・3962・155Aは現場SaaSと広範な受託/公共DX。保存事業原文だけでは同一顧客の代替購入を確定できず2社を未判定のまま保持する。",
};

export const COMPETITOR_WRITE_COLUMNS = ["競合他社", "競合判定日", "競合判定の版", "競合判定書類ID"] as const;
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((k) =>
    `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  if (value === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("保全値に未定義/非有限数");
  return JSON.stringify(value);
}
export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export function propertyText(page: RecoveryPage, name: string): string {
  const p = page.properties[name];
  if (p === undefined || p.type !== "rich_text" || !Array.isArray(p.rich_text) || p.has_more === true ||
      p.rich_text.some((v) => typeof v.plain_text !== "string")) throw new Error(`完全な文字列propertyがない: ${name}`);
  return p.rich_text.map((v) => v.plain_text).join("");
}
export function assertRecoveryPage(page: RecoveryPage, dbId: string): void {
  if (page.archived !== false || page.in_trash !== false || typeof page.id !== "string" ||
      page.parent.type !== "database_id" || page.parent.database_id?.replaceAll("-", "") !== dbId.replaceAll("-", "") ||
      typeof page.properties !== "object" || page.properties === null) throw new Error("補足行の所属/状態が不正");
}
export function assertUnjudged(page: RecoveryPage): void {
  if (propertyText(page, "競合判定書類ID") !== "" || propertyText(page, "競合判定の版") !== "" ||
      page.properties["競合判定日"]?.date !== null || page.properties["競合他社"]?.type !== "relation" ||
      page.properties["競合他社"].has_more === true || page.properties["競合他社"].relation?.length !== 0)
    throw new Error("既存競合値あり。未判定とみなして上書きしない");
}
export function assertFreshPre(pre: RecoveryPage, fresh: RecoveryPage, dbId: string): void {
  assertRecoveryPage(pre, dbId); assertRecoveryPage(fresh, dbId); assertUnjudged(fresh);
  if (pre.id !== fresh.id || canonicalJson(pre.properties) !== canonicalJson(fresh.properties)) throw new Error("PREから補足行が変化。旧値を保持して停止");
}
export function assertRecoveryReadback(pre: RecoveryPage, fresh: RecoveryPage, expected: WriteCompetitorRelationInput, dbId: string): void {
  assertRecoveryPage(fresh, dbId);
  const relation = fresh.properties["競合他社"], date = fresh.properties["競合判定日"];
  if (pre.id !== fresh.id || relation?.type !== "relation" || relation.has_more === true || !Array.isArray(relation.relation) ||
      canonicalJson(relation.relation.map((v) => v.id).sort()) !== canonicalJson([...expected.competitorPageIds].sort()) ||
      date?.type !== "date" || date.date?.start !== expected.judgedAt || date.date.end !== null ||
      propertyText(fresh, "競合判定の版") !== expected.version || propertyText(fresh, "競合判定書類ID") !== expected.judgedDocId)
    throw new Error("競合の全文読戻しが期待値と不一致");
  const exclude = new Set<string>(COMPETITOR_WRITE_COLUMNS);
  const untouched = (p: RecoveryPage) => Object.fromEntries(Object.entries(p.properties).filter(([k]) => !exclude.has(k)));
  if (canonicalJson(untouched(pre)) !== canonicalJson(untouched(fresh))) throw new Error("競合以外のpropertyが変化");
}
export function assertRecoverySnapshot(snapshot: RecoverySnapshot): void {
  if (snapshot.version !== 1 || snapshot.targetCodes.length !== 83 || new Set(snapshot.targetCodes).size !== 83 ||
      snapshot.pre.length !== 83 || snapshot.calibration.candidateTopK !== 50 || snapshot.calibration.batchSize !== 50 ||
      snapshot.calibration.model !== "Qwen3.5-4B@851bf6e/semif-mlx" || snapshot.calibration.candidateVersion !== "cand-v1")
    throw new Error("83社/較正版の固定契約が不一致");
  if (snapshot.calibration.decisionVersion === undefined) {
    if (snapshot.calibration.thresholds.yesMin !== 0.25 || snapshot.calibration.thresholds.noMax !== 0.09 || snapshot.decisionReview !== undefined) throw new Error("旧較正版の閾値/レビューが不一致");
  } else if (snapshot.calibration.decisionVersion !== "cal-thr050-eval122-20261014" || snapshot.calibration.thresholds.yesMin !== 0.5 ||
      snapshot.calibration.thresholds.noMax !== 0.09 || snapshot.decisionReview?.version !== snapshot.calibration.decisionVersion ||
      canonicalJson(snapshot.decisionReview.holdCodes) !== canonicalJson(["130A", "145A"]) ||
      snapshot.decisionReview.evalInputSha256 !== "e7735381070a95bd4fed11402eac720ea482fcfb5aba6b7f28afa37905e80243" ||
      snapshot.decisionReview.evalOutputGzipSha256 !== "69dafd69fcb644a00c9af9abe8c4e91a1624e4fdc4f7d9cc8898c00ea5c7f130" || snapshot.decisionReview.reason.trim() === "")
    throw new Error("新較正版の閾値/全122較正根拠/2社HOLDが不一致");
  const byCode = new Map(snapshot.corpus.map((p) => [p.stockCode, p]));
  if (byCode.size !== snapshot.corpus.length || new Set(snapshot.corpus.map((p) => p.pageId)).size !== snapshot.corpus.length ||
      new Set(snapshot.baseline.map((p) => p.stockCode)).size !== snapshot.baseline.length ||
      snapshot.corpus.some((p) => !/^[a-f0-9]{64}$/.test(snapshot.inputFingerprints[p.stockCode]))) throw new Error("候補corpus/指紋が不完全または重複");
  for (const code of snapshot.targetCodes) {
    const company = byCode.get(code), pre = snapshot.pre.filter((p) => propertyText(p, "銘柄コード") === code);
    if (company === undefined || company.docId === null || company.businessText.trim().length === 0 || pre.length !== 1 ||
        pre[0].id !== company.pageId || propertyText(pre[0], "有報書類ID") !== company.docId) throw new Error(`対象入力が不完全 ${code}`);
    assertRecoveryPage(pre[0], snapshot.dbId); assertUnjudged(pre[0]);
    const candidates = snapshot.candidates[code];
    if (!Array.isArray(candidates) || candidates.length > 50 || new Set(candidates.map((c) => c.stockCode)).size !== candidates.length ||
        candidates.some((c) => c.stockCode === code || !byCode.has(c.stockCode) || byCode.get(c.stockCode)!.pageId !== c.pageId))
      throw new Error(`候補が固定corpusと不一致 ${code}`);
  }
}
export function assertRecoveryOutput(snapshot: RecoverySnapshot, output: RecoveryOutput, inputSha256: string): void {
  const company = snapshot.corpus.find((p) => p.stockCode === output.stockCode);
  const candidates = snapshot.candidates[output.stockCode];
  if (company === undefined || !snapshot.targetCodes.includes(output.stockCode) || output.inputSha256 !== inputSha256 ||
      output.pageId !== company.pageId || output.expected.judgedDocId !== company.docId ||
      output.expected.version !== competitorDecisionVersion(snapshot.calibration) ||
      canonicalJson(output.candidateCodes) !== canonicalJson(candidates.map((c) => c.stockCode)) ||
      output.modelCalls !== (candidates.length === 0 ? 0 : 1) ||
      canonicalJson(Object.keys(output.probabilities).sort()) !== canonicalJson(candidates.map((c) => `cp.${c.stockCode}`).sort()))
    throw new Error("モデル出力の入力版/会社/質問数が不一致");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(output.expected.judgedAt) || !Number.isFinite(output.elapsedMs) || output.elapsedMs < 0 ||
      !Number.isFinite(output.peakTreeRssKiB) || output.peakTreeRssKiB <= 0 ||
      !Number.isFinite(Date.parse(output.startedAt)) || !Number.isFinite(Date.parse(output.finishedAt)) || Date.parse(output.finishedAt) < Date.parse(output.startedAt))
    throw new Error("実行日時/資源測定が不正");
  const bands = { yes: 0, no: 0, uncertain: 0 };
  const yes = candidates.filter((c) => {
    const probability = output.probabilities[`cp.${c.stockCode}`];
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("不正確率。補完しない");
    if (probability >= snapshot.calibration.thresholds.yesMin) bands.yes++;
    else if (probability <= snapshot.calibration.thresholds.noMax) bands.no++;
    else bands.uncertain++;
    return probability >= snapshot.calibration.thresholds.yesMin;
  }).map((c) => c.pageId);
  if (canonicalJson(bands) !== canonicalJson(output.bands)) throw new Error("実確率と判定帯の集計が不一致");
  if (canonicalJson([...yes].sort()) !== canonicalJson([...output.expected.competitorPageIds].sort())) throw new Error("実確率と保存relationが不一致");
}

export function assertNonTargets(before: Record<string, string>, after: Record<string, string>, targets: Set<string>): void {
  for (const [code, fingerprint] of Object.entries(before)) if (!targets.has(code) && after[code] !== fingerprint) throw new Error(`対象外の判定版/入力が変化 ${code}`);
}
export function assertOneWaySchema(properties: Record<string, { id: string; relation?: { database_id: string; type: string } }>, dbId: string): void {
  const relation = properties["競合他社"]?.relation;
  if (relation?.type !== "single_property" || relation.database_id.replaceAll("-", "") !== dbId.replaceAll("-", ""))
    throw new Error("競合relationは同一DBの片方向である必要がある");
}

/** 旧原確率・元doc・実行時刻は保持し、較正変更だけを明示的に再バンド化する。 */
export function rebandRecoveryOutput(snapshot: RecoverySnapshot, original: RecoveryOutput, inputSha256: string): RecoveryOutput {
  const candidates = snapshot.candidates[original.stockCode];
  if (candidates === undefined) throw new Error("対象外の再バンド化は禁止");
  const bands = { yes: 0, no: 0, uncertain: 0 };
  const competitorPageIds = candidates.filter((c) => {
    const p = original.probabilities[`cp.${c.stockCode}`];
    if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error("原確率が不正");
    if (p >= snapshot.calibration.thresholds.yesMin) bands.yes++;
    else if (p <= snapshot.calibration.thresholds.noMax) bands.no++;
    else bands.uncertain++;
    return p >= snapshot.calibration.thresholds.yesMin;
  }).map((c) => c.pageId);
  const output = { ...original, inputSha256, bands, expected: { ...original.expected, competitorPageIds, version: competitorDecisionVersion(snapshot.calibration) } };
  assertRecoveryOutput(snapshot, output, inputSha256);
  return output;
}
export function selectedRecoveryCodes(snapshot: RecoverySnapshot): string[] {
  assertRecoverySnapshot(snapshot);
  const held = new Set<string>(snapshot.decisionReview === undefined ? [] : snapshot.decisionReview.holdCodes);
  return snapshot.targetCodes.filter((code) => !held.has(code));
}
