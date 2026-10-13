/**
 * リポジトリに同梱した運用データ (ゴールデンセット v1・較正値) が読めることの固定テスト。
 * どちらも実在の有報の原文とゴールデンセットの実測から作った値 (docs/005-yuho-quant-business-tags.md §10・§11.4)。
 */
import { loadGoldenSet } from "./golden.js";
import { evaluateAtThresholds } from "./golden.js";
import { loadCalibration } from "./thresholds.js";
import { readFileSync } from "node:fs";
import { SEMIF_MODEL, SEMIF_HF_MODEL, SEMIF_HF_REVISION, SEMIF_SOURCE_REVISION, SEMIF_MLX_VERSION, SEMIF_MLX_LM_REVISION } from "../../../../src/shared/semif/index.js";
import { CLEF_MODEL, CLEF_MANIFEST } from "../../../../src/shared/clef/client.js";
import { createHash } from "node:crypto";

describe("同梱データ", () => {
  it("ゴールデンセット v1 が形・不変条件の検査を通る", () => {
    const g = loadGoldenSet();
    expect(g.version).toBe("v1");
    expect(g.vocabVersion).toBe("v1");
    const pairs = g.items.flatMap((i) => i.expect);
    expect(pairs.length).toBe(858);
    // 依頼文の「当てたい例」の代表 (味の素の ABF・日本製鋼所の防衛) が含まれる
    const mustHit = new Set(
      g.items.flatMap((i) => i.expect.filter((e) => e.mustHit).map((e) => `${i.code}:${e.termId}`))
    );
    expect(mustHit.has("2802:B.SEMI.PACKAGE_MATERIAL")).toBe(true);
    expect(mustHit.has("5631:B.DEF.DEFENSE_EQUIPMENT")).toBe(true);
  });

  it("較正値は版を固定したモデル名と 0 < noMax < yesMin < 1", () => {
    const c = loadCalibration();
    expect(c.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(c.model).not.toBe("jev-latest");
    expect(c.thresholds.noMax).toBeGreaterThan(0);
    expect(c.thresholds.noMax).toBeLessThan(c.thresholds.yesMin);
    expect(c.thresholds.yesMin).toBeLessThan(1);
  });

  it("新規事業タグのSemIf較正は実87社の測定とruntime pinを共有し、Jev較正を流用しない", () => {
    const c = loadCalibration("semif");
    const file = JSON.parse(readFileSync(new URL("./calibration.semif.json", import.meta.url), "utf8"));
    expect(c.model).toBe(SEMIF_MODEL);
    expect(c).not.toEqual(loadCalibration());
    expect(file.runtime).toMatchObject({ hfModel: SEMIF_HF_MODEL, hfRevision: SEMIF_HF_REVISION,
      semifSourceRevision: SEMIF_SOURCE_REVISION, mlxVersion: SEMIF_MLX_VERSION,
      mlxLmRevision: SEMIF_MLX_LM_REVISION, backend: "mlx", quantization: null, maxInputTokens: 16000 });
    expect(file.basis.companies).toBe(loadGoldenSet().items.length);
    expect(file.basis.expectedPairs).toBe(858);
    expect(file.basis.atChosenThresholds.precisionYes).toBeGreaterThanOrEqual(0.9);
    expect(file.basis.atChosenThresholds.mustNotViolations).toBe(0);
    expect(file.basis.textBasis).toMatchObject({ savedNotionWholeMetadataMatch: 85,
      sourceRecoveredCsv: 2, savedNotionWholeDefectHold: 2 });
    expect(file.basis.measurement.externalJudgeApiRequests).toBe(0);
  });

  it("Clef較正の実858確率から精度を再計算し、専用headとruntime pinを照合する", () => {
    const calibration = loadCalibration("clef");
    const file = JSON.parse(readFileSync(new URL("./calibration.clef.json", import.meta.url), "utf8"));
    const bytes = readFileSync(new URL("./golden/evaluation.clef.v1.json", import.meta.url));
    const evaluation = JSON.parse(bytes.toString());
    expect(calibration.model).toBe(CLEF_MODEL);
    expect(file.runtime).toMatchObject({ hfModel: CLEF_MANIFEST.repo, hfRevision: CLEF_MANIFEST.revision,
      nativeSourceSha256: CLEF_MANIFEST.source_sha256, ...CLEF_MANIFEST.runtime,
      backend: "torch-mps", quantization: null, maxInputTokens: 16000, base: "Nix" });
    expect(createHash("sha256").update(readFileSync(new URL("../../local-model/uv.lock", import.meta.url))).digest("hex"))
      .toBe(file.runtime.uvLockSha256);
    expect(createHash("sha256").update(readFileSync(new URL("../../../../src/shared/clef/manifest.json", import.meta.url))).digest("hex"))
      .toBe(file.runtime.modelManifestSha256);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.basis.evaluationSha256);
    expect(evaluation.perItem).toHaveLength(858);
    for (const [path, expectedSha256] of [
      ["./golden/v1.json", evaluation.provenance.goldenSha256],
      ["./vocabulary/v1.json", evaluation.provenance.vocabularySha256],
    ]) {
      expect(createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex"))
        .toBe(expectedSha256);
    }
    const expected = loadGoldenSet().items.flatMap((item) => item.expect.map((pair) => ({
      code: item.code, docId: item.docId, termId: pair.termId, expectedLabel: pair.label,
      mustHit: pair.mustHit === true, mustNot: pair.mustNot === true,
    })));
    expect(evaluation.perItem.map(({ code, docId, termId, expectedLabel, mustHit, mustNot }: typeof expected[number]) =>
      ({ code, docId, termId, expectedLabel, mustHit, mustNot }))).toEqual(expected);
    const actual = evaluateAtThresholds(evaluation.perItem, calibration.thresholds);
    expect(actual).toEqual(evaluation.metrics);
    expect(actual).toMatchObject({ precisionYes: file.basis.atChosenThresholds.precisionYes,
      recallYes: file.basis.atChosenThresholds.recallYes, mustNotViolations: 0, filterMissRate: 0 });
    expect(actual.precisionYes).toBeGreaterThanOrEqual(0.9);
    expect(file.basis.measurement).toMatchObject({ residentProcesses: 1, inferenceRequests: 95,
      nativeForwards: 96, sourceRequests: 0, externalJudgeApiRequests: 0, productionWrites: 0,
      swapIncreaseBytes: 0, localHardwareCostUsd: null });
  });
});
