/**
 * 判定モデル名・競合判定しきい値・候補生成パラメータの読み込み。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §3・§12.9(judge)。
 *
 * biztag 本体の `thresholds.ts` と同じ方針: 較正済みの値は評価セット
 * (`pnpm biztag competitors-eval`) で精度を測ってから運営が
 * `calibration.json` (jev) / `calibration.semif.json` (semif) として用意する。
 * 未較正のマジックナンバーをコードに埋め込まない (ルール1/2)。ファイルが無い・
 * 形式が不正な場合は明示的に throw する。
 *
 * **judge ごとに較正ファイルを分ける** (2026-09-26 追加): jev のクレジット枯渇時に
 * SemIf (ローカル MLX 推論, Qwen/Qwen3.5-4B) を代替判定モデルとして使う運用が
 * 入ったため、しきい値・バッチサイズは判定モデルごとに別々に較正する。`model`
 * フィールドが judge を一意に識別する (jev は `jev-1.13.0` のような版名、semif
 * は `Qwen3.5-4B@851bf6e/semif-mlx` のようにモデル名+リビジョン+バックエンド)
 * ため、`候補生成の版|model` を版タグにする既存の仕組み (`pipeline.ts`) だけで
 * jev 判定行と semif 判定行が自動的に区別できる。
 */
import { readFileSync } from "node:fs";
import type { BtThresholds } from "../judge.js";
import { type CandidateWeights } from "./candidates.js";

/** 判定に使うモデル (judge)。既定は jev。 */
export type CompetitorJudge = "jev" | "semif";

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
  /** 1往復あたりの最大質問数 (judge ごとに較正ファイルで指定。既定20)。 */
  batchSize: number;
}

interface CalibrationFileShape {
  model: string;
  yesMin: number;
  noMax: number;
  candidateTopK: number;
  candidateWeights: { tag: number; sector: number; text: number };
  candidatePostingCaps: { tag: number; ngram: number };
  candidateVersion: string;
  /** 省略可 (既定20。既存 calibration.json との後方互換のため)。 */
  batchSize?: number;
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
    typeof caps.ngram === "number" &&
    (r.batchSize === undefined || typeof r.batchSize === "number")
  );
}

const DEFAULT_BATCH_SIZE = 20;

function calibrationFileName(judge: CompetitorJudge): string {
  return judge === "semif" ? "./calibration.semif.json" : "./calibration.json";
}

/**
 * `services/yuho-quant/src/biztag/competitors/calibration.json`
 * (judge="semif" のときは `calibration.semif.json`) を読む。
 */
export function loadCompetitorCalibration(judge: CompetitorJudge = "jev"): CompetitorCalibration {
  const fileName = calibrationFileName(judge);
  const path = new URL(fileName, import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      `services/yuho-quant/src/biztag/competitors/${fileName.replace("./", "")} が見つかりません。` +
        `\`pnpm biztag competitors-eval -- --judge=${judge}\` でしきい値を較正し、` +
        "運営が同ファイルを用意してから実行してください。既定値では起動しません。",
      { cause: e }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`competitors/${fileName.replace("./", "")} が JSON として解釈できません。`, { cause: e });
  }
  if (!isCalibrationFileShape(json)) {
    throw new Error(
      `competitors/${fileName.replace("./", "")} の形式が不正です ` +
        "({model, yesMin, noMax, candidateTopK, candidateWeights:{tag,sector,text}, candidateVersion, batchSize?} が必要です)。"
    );
  }
  return {
    model: json.model,
    thresholds: { yesMin: json.yesMin, noMax: json.noMax },
    candidateTopK: json.candidateTopK,
    candidateWeights: json.candidateWeights,
    candidatePostingCaps: json.candidatePostingCaps,
    candidateVersion: json.candidateVersion,
    batchSize: json.batchSize ?? DEFAULT_BATCH_SIZE,
  };
}
