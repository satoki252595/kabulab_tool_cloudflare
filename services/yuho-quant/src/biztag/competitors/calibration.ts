/**
 * jev モデル名・競合判定しきい値・候補生成パラメータの読み込み。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §3。
 *
 * biztag 本体の `thresholds.ts` と同じ方針: 較正済みの値は評価セット
 * (`pnpm biztag competitors-eval`) で精度を測ってから運営が
 * `calibration.json` として用意する。未較正のマジックナンバーをコードに
 * 埋め込まない (ルール1/2)。ファイルが無い・形式が不正な場合は明示的に throw する。
 */
import { readFileSync } from "node:fs";
import type { BtThresholds } from "../judge.js";
import { type CandidateWeights } from "./candidates.js";

export interface PostingCaps {
  tag: number;
  ngram: number;
}

export interface CompetitorCalibration {
  model: string;
  thresholds: BtThresholds;
  candidateTopK: number;
  candidateWeights: CandidateWeights;
  candidatePostingCaps: PostingCaps;
  /** 候補生成の版 (アルゴリズム変更時にインクリメントし、既存判定を陳腐化させる)。 */
  candidateVersion: string;
}

interface CalibrationFileShape {
  model: string;
  yesMin: number;
  noMax: number;
  candidateTopK: number;
  candidateWeights: { tag: number; sector: number; text: number };
  candidatePostingCaps: { tag: number; ngram: number };
  candidateVersion: string;
}

function isCalibrationFileShape(v: unknown): v is CalibrationFileShape {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  const w = r.candidateWeights as Record<string, unknown> | undefined;
  const caps = r.candidatePostingCaps as Record<string, unknown> | undefined;
  return (
    typeof r.model === "string" &&
    r.model.length > 0 &&
    typeof r.yesMin === "number" &&
    typeof r.noMax === "number" &&
    typeof r.candidateTopK === "number" &&
    typeof r.candidateVersion === "string" &&
    r.candidateVersion.length > 0 &&
    w !== null &&
    typeof w === "object" &&
    typeof w.tag === "number" &&
    typeof w.sector === "number" &&
    typeof w.text === "number" &&
    caps !== null &&
    typeof caps === "object" &&
    typeof caps.tag === "number" &&
    typeof caps.ngram === "number"
  );
}

/** `services/yuho-quant/src/biztag/competitors/calibration.json` を読む。 */
export function loadCompetitorCalibration(): CompetitorCalibration {
  const path = new URL("./calibration.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      "services/yuho-quant/src/biztag/competitors/calibration.json が見つかりません。" +
        "`pnpm biztag competitors-eval` でしきい値を較正し、運営が同ファイルを用意してから実行してください。" +
        "既定値では起動しません。",
      { cause: e }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("competitors/calibration.json が JSON として解釈できません。", { cause: e });
  }
  if (!isCalibrationFileShape(json)) {
    throw new Error(
      "competitors/calibration.json の形式が不正です " +
        "({model, yesMin, noMax, candidateTopK, candidateWeights:{tag,sector,text}, candidateVersion} が必要です)。"
    );
  }
  return {
    model: json.model,
    thresholds: { yesMin: json.yesMin, noMax: json.noMax },
    candidateTopK: json.candidateTopK,
    candidateWeights: json.candidateWeights,
    candidatePostingCaps: json.candidatePostingCaps,
    candidateVersion: json.candidateVersion,
  };
}
