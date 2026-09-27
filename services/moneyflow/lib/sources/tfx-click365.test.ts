/**
 * TFX くりっく３６５ / くりっく株３６５ パーサのテスト。
 *
 * フィクスチャは 2026-09-27 に実際に本番 URL から取得した実ファイル
 * (`fixtures/tfx-click365-fx-2026-09.html` / `fixtures/tfx-clickkabu365-cfd-2026-09.html`)。
 * 期待値は https://www.tfx.co.jp/historical/fx/transit_fx.html および
 * https://www.tfx.co.jp/historical/cfd/transit_cfd.html を同日に目視確認した値。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fetchAndParseTfxClick365,
  fetchTfxClick365Page,
  expectedAnnualPeriod,
  expectedMonthlyPeriod,
  isTfxPeriodPublished,
  latestTfxPublishedPeriod,
  parseTfxClick365Html,
  resolveTfxClick365Url,
  tfxAvailablePeriods,
  TFX_CLICK365_METRICS,
  TFX_CLICKKABU365_CFD_URL,
  TFX_CLICK365_FX_URL,
  toMoneyflowObservations,
  type TfxClick365Data,
} from "./tfx-click365.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const FX_HTML = readFixture("tfx-click365-fx-2026-09.html");
const CFD_HTML = readFixture("tfx-clickkabu365-cfd-2026-09.html");

function find(
  cells: TfxClick365Data["monthlyVolume"] | TfxClick365Data["annualVolume"],
  instrument: string,
  period: string
) {
  const hit = cells.find((c) => c.instrument === instrument && c.period === period);
  if (!hit) throw new Error(`テストフィクスチャに見つからない: ${instrument} ${period}`);
  return hit;
}

function findOi(cells: TfxClick365Data["monthEndOpenInterest"], instrument: string, period: string) {
  const hit = cells.find((c) => c.instrument === instrument && c.period === period);
  if (!hit) throw new Error(`テストフィクスチャに見つからない: ${instrument} ${period}`);
  return hit;
}

describe("resolveTfxClick365Url", () => {
  it("市場種別ごとに固定 URL を返す", () => {
    expect(resolveTfxClick365Url("click365_fx")).toBe(TFX_CLICK365_FX_URL);
    expect(resolveTfxClick365Url("clickkabu365_cfd")).toBe(TFX_CLICKKABU365_CFD_URL);
  });
});

describe("parseTfxClick365Html: くりっく３６５ (FX)", () => {
  const data = parseTfxClick365Html(FX_HTML, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");

  it("原本を目視確認した値と一致する: 月次出来高 2026-08 米ドル／円", () => {
    const cell = find(data.monthlyVolume, "米ドル／円", "2026-08");
    expect(cell.total).toBe(376532);
    expect(cell.dailyAvg).toBe(17930);
  });

  it("原本を目視確認した値と一致する: 年次出来高 2025 米ドル／円", () => {
    const cell = find(data.annualVolume, "米ドル／円", "2025");
    expect(cell.total).toBe(6003872);
    expect(cell.dailyAvg).toBe(23092);
  });

  it("原本を目視確認した値と一致する: 月末建玉 2026-08 米ドル／円", () => {
    const cell = findOi(data.monthEndOpenInterest, "米ドル／円", "2026-08");
    expect(cell.value).toBe(347485);
  });

  it("新規上場前の欠測を 0 で埋めず undefined にする (中国オフショア人民元／円 の 2024 年次)", () => {
    // 原資料は total セルが空欄、1日平均セルは "(-)" だが、total が空欄の期間は
    // dailyAvg も undefined にする (「真の値が不明」ではなく「そもそもデータがない」)。
    const cell = find(data.annualVolume, "中国オフショア人民元／円", "2024");
    expect(cell.total).toBeUndefined();
    expect(cell.dailyAvg).toBeUndefined();
    // 2025 は実在する。
    const cell2025 = find(data.annualVolume, "中国オフショア人民元／円", "2025");
    expect(cell2025.total).toBe(161393);
    expect(cell2025.dailyAvg).toBe(664);
  });

  it("表示上「-」に丸められる1日平均は null にする (0 にしない)", () => {
    // 英ポンド／日本円（ラージ） 2026-03: total=9, avg 表示は "(-)"。
    const cell = find(data.monthlyVolume, "英ポンド／日本円（ラージ）", "2026-03");
    expect(cell.total).toBe(9);
    expect(cell.dailyAvg).toBeNull();
  });

  it("33通貨ペア分の行が取得できる", () => {
    const instruments = new Set(data.monthlyVolume.map((c) => c.instrument));
    expect(instruments.size).toBe(33);
  });
});

describe("parseTfxClick365Html: くりっく株３６５ (CFD)", () => {
  const data = parseTfxClick365Html(CFD_HTML, "clickkabu365_cfd", TFX_CLICKKABU365_CFD_URL, "2026-09-27T00:00:00.000Z");

  it("原本を目視確認した値と一致する: 月次出来高 2026-08 日経225リセット付証拠金取引", () => {
    const cell = find(data.monthlyVolume, "日経 225 リセット付証拠金取引／26", "2026-08");
    expect(cell.total).toBe(728991);
    expect(cell.dailyAvg).toBe(34714);
  });

  it("原本を目視確認した値と一致する: 月末建玉 2026-08 日経225リセット付証拠金取引", () => {
    const cell = findOi(data.monthEndOpenInterest, "日経 225 リセット付証拠金取引／26", "2026-08");
    expect(cell.value).toBe(34495);
  });

  it("年末建玉 2025 日経225リセット付証拠金取引 が原本の値と一致する", () => {
    const cell = findOi(data.yearEndOpenInterest, "日経 225 リセット付証拠金取引／26", "2025");
    expect(cell.value).toBe(17837);
  });

  it("新規上場銘柄の欠測期間 (2024/2023) を 0 で埋めず undefined にする", () => {
    const cell2024 = findOi(data.yearEndOpenInterest, "日経 225 リセット付証拠金取引／26", "2024");
    expect(cell2024.value).toBeUndefined();
  });
});

describe("様式が想定と違えば throw する", () => {
  it("<table> が4つでなければ throw する", () => {
    const broken = FX_HTML.replace(/<table class="snd_table01b td_va_mid th_center">/, "<div>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/table.*4つ/);
  });

  it("期間見出しが月次・年次のいずれの形式でもなければ throw する", () => {
    const broken = FX_HTML.replace("<th>2026.08</th>", "<th>令和8年8月</th>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/期間見出しの形式/);
  });

  it("数量セルが数字・カンマ以外を含めば throw する", () => {
    const broken = FX_HTML.replace("<td>376,532</td>", "<td>N/A</td>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/数量セルの形式/);
  });

  it("1日平均セルが \"(数字)\" / \"(-)\" 以外なら throw する", () => {
    const broken = FX_HTML.replace("<td>(17,930)</td>", "<td>約1.8万</td>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/1日平均セルの形式/);
  });
});

describe("fetchTfxClick365Page / fetchAndParseTfxClick365", () => {
  it("HTTP エラー時は throw する", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch;
    try {
      await expect(fetchTfxClick365Page("click365_fx")).rejects.toThrow(/HTTP 404/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("正常応答なら取得+パースまで通る", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(FX_HTML, { status: 200 })) as typeof fetch;
    try {
      const data = await fetchAndParseTfxClick365("click365_fx");
      expect(data.market).toBe("click365_fx");
      expect(data.sourceUrl).toBe(TFX_CLICK365_FX_URL);
      expect(data.monthlyVolume.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("期間の判定・「まだ公表されていない」の判定", () => {
  const data = parseTfxClick365Html(FX_HTML, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");

  it("取得済みの期間はpublished、存在しない期間は未publishedと判定する", () => {
    expect(isTfxPeriodPublished("2026-08", data.monthlyVolume)).toBe(true);
    expect(isTfxPeriodPublished("2026-09", data.monthlyVolume)).toBe(false);
  });

  it("最新の公表済み期間を返す", () => {
    expect(latestTfxPublishedPeriod(data.monthlyVolume)).toBe("2026-08");
    expect(latestTfxPublishedPeriod(data.annualVolume)).toBe("2025");
  });

  it("公表済み期間が1件もなければ throw する", () => {
    expect(() => latestTfxPublishedPeriod([])).toThrow(/期間が1件も/);
  });

  it("expectedMonthlyPeriod は参照日の前月を返す (公表判定は別途 isTfxPeriodPublished で行う)", () => {
    expect(expectedMonthlyPeriod(new Date(Date.UTC(2026, 8, 27)))).toBe("2026-08");
    expect(expectedMonthlyPeriod(new Date(Date.UTC(2026, 0, 15)))).toBe("2025-12");
  });

  it("expectedAnnualPeriod は参照日の前年を返す", () => {
    expect(expectedAnnualPeriod(new Date(Date.UTC(2026, 8, 27)))).toBe("2025");
  });

  it("tfxAvailablePeriods は重複なし昇順で返す", () => {
    const periods = tfxAvailablePeriods(data.monthlyVolume);
    expect(periods).toEqual([...periods].sort());
    expect(new Set(periods).size).toBe(periods.length);
    expect(periods).toContain("2026-08");
  });
});

describe("指標定義 (TFX_CLICK365_METRICS)", () => {
  it("FX/CFD × 出来高/1日平均/建玉 の6指標がすべて揃っている", () => {
    const keys = TFX_CLICK365_METRICS.map((m) => m.key).sort();
    expect(keys).toEqual(
      [
        "tfx-click365-fx-open-interest",
        "tfx-click365-fx-turnover",
        "tfx-click365-fx-turnover-daily-avg",
        "tfx-clickkabu365-cfd-open-interest",
        "tfx-clickkabu365-cfd-turnover",
        "tfx-clickkabu365-cfd-turnover-daily-avg",
      ].sort()
    );
  });

  it("各指標に measures・出典URL・利用条件・頻度・限界の記載がある", () => {
    for (const m of TFX_CLICK365_METRICS) {
      expect(["net_flow", "gross_turnover", "holdings_stock", "positions", "fund_flow", "estimated", "price_only"]).toContain(
        m.measures
      );
      expect(m.sourceUrl).toMatch(/^https:\/\/www\.tfx\.co\.jp\//);
      expect(m.usageTerms.length).toBeGreaterThan(0);
      expect(m.frequency.length).toBeGreaterThan(0);
      expect(m.limitations.length).toBeGreaterThan(0);
      expect(m.requirements).toContain("R3");
    }
  });
});

describe("toMoneyflowObservations (縦長の観測ログレコード)", () => {
  const data = parseTfxClick365Html(FX_HTML, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
  const observations = toMoneyflowObservations(data);

  it("実測値と一致する観測行を含む", () => {
    const hit = observations.find(
      (o) =>
        o.metricKey === "tfx-click365-fx-turnover" &&
        o.period === "2026-08" &&
        o.category === "米ドル／円"
    );
    expect(hit).toBeDefined();
    expect(hit?.value).toBe(376532);
    expect(hit?.unit).toBe("枚");
    expect(hit?.isApproximate).toBe(false);
    expect(hit?.isEstimated).toBe(false);
  });

  it("欠測 (total undefined) の組み合わせは行を作らない", () => {
    const hit = observations.find(
      (o) => o.metricKey === "tfx-click365-fx-turnover" && o.period === "2024" && o.category === "中国オフショア人民元／円"
    );
    expect(hit).toBeUndefined();
  });

  it("「-」に丸められる1日平均 (null) も行を作らない (0 で埋めない)", () => {
    const hit = observations.find(
      (o) =>
        o.metricKey === "tfx-click365-fx-turnover-daily-avg" &&
        o.period === "2026-03" &&
        o.category === "英ポンド／日本円（ラージ）"
    );
    expect(hit).toBeUndefined();
  });
});
