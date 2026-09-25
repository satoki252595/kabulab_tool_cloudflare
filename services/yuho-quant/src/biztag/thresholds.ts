/**
 * jev モデル名・判定しきい値の読み込み。設計: docs/005-yuho-quant-business-tags.md §5.5・§11.4。
 *
 * 較正済みの値はゴールデンセット (`pnpm biztag golden`) で精度を測ってから
 * 運営が `calibration.json` として用意する (このリポジトリのソースへ未較正の
 * マジックナンバーやダミー値を先置きしない — ルール1/2)。ファイルが無い・
 * 形式が不正な場合は明示的に throw する (黙って既定値で起動しない)。
 */
import { readFileSync } from "node:fs";
import type { BtThresholds } from "./judge.js";

export interface Calibration {
  model: string;
  thresholds: BtThresholds;
}

interface CalibrationFileShape {
  model: string;
  yesMin: number;
  noMax: number;
}

function isCalibrationFileShape(v: unknown): v is CalibrationFileShape {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.model === "string" &&
    r.model.length > 0 &&
    typeof r.yesMin === "number" &&
    typeof r.noMax === "number"
  );
}

/**
 * `services/yuho-quant/src/biztag/calibration.json` を読む。
 * このファイルはリポジトリに未同梱 (意図的。運営が較正後に用意する)。
 */
export function loadCalibration(): Calibration {
  const path = new URL("./calibration.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      "services/yuho-quant/src/biztag/calibration.json が見つかりません。" +
        "`pnpm biztag golden` でしきい値を較正し、運営が同ファイル " +
        "({model, yesMin, noMax}) を用意してから実行してください " +
        "(docs/005-yuho-quant-business-tags.md §11.4)。既定値では起動しません。",
      { cause: e }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("calibration.json が JSON として解釈できません。", { cause: e });
  }
  if (!isCalibrationFileShape(json)) {
    throw new Error(
      "calibration.json の形式が不正です ({model: string, yesMin: number, noMax: number} が必要です)。"
    );
  }
  return { model: json.model, thresholds: { yesMin: json.yesMin, noMax: json.noMax } };
}
