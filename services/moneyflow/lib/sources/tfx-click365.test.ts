/**
 * TFX くりっく３６５ / くりっく株３６５ パーサのテスト。
 *
 * フィクスチャは 2026-09-27 に実際に本番 URL から取得した実ファイル
 * (`fixtures/private/tfx-click365/tfx-click365-fx-2026-09.html` /
 * `fixtures/private/tfx-click365/tfx-clickkabu365-cfd-2026-09.html`)。
 * TFX のページは再配布不可のため commit せず (`.gitignore` 済み)、置いていない環境 (CI) では
 * 実ファイルを読むテストだけを `describe.skipIf(!hasFixtures)` で skip する。
 * 期待値は https://www.tfx.co.jp/historical/fx/transit_fx.html および
 * https://www.tfx.co.jp/historical/cfd/transit_cfd.html を同日に目視確認した値。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "private", "tfx-click365");
const FX_FIXTURE = join(FIXTURES, "tfx-click365-fx-2026-09.html");
const CFD_FIXTURE = join(FIXTURES, "tfx-clickkabu365-cfd-2026-09.html");
const hasFixtures = existsSync(FX_FIXTURE) && existsSync(CFD_FIXTURE);

// 実ファイルは skip されないテストの中でだけ読む (未取得の環境で import 時に throw させない)。
const fixtureCache = new Map<string, string>();
function readFixture(path: string): string {
  const cached = fixtureCache.get(path);
  if (cached !== undefined) return cached;
  const text = readFileSync(path, "utf8");
  fixtureCache.set(path, text);
  return text;
}
const fxHtml = () => readFixture(FX_FIXTURE);
const cfdHtml = () => readFixture(CFD_FIXTURE);

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

describe.skipIf(!hasFixtures)("parseTfxClick365Html: くりっく３６５ (FX)", () => {
  let data: TfxClick365Data;
  beforeAll(() => {
    data = parseTfxClick365Html(fxHtml(), "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
  });

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

describe.skipIf(!hasFixtures)("parseTfxClick365Html: くりっく株３６５ (CFD)", () => {
  let data: TfxClick365Data;
  beforeAll(() => {
    data = parseTfxClick365Html(cfdHtml(), "clickkabu365_cfd", TFX_CLICKKABU365_CFD_URL, "2026-09-27T00:00:00.000Z");
  });

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

describe.skipIf(!hasFixtures)("様式が想定と違えば throw する", () => {
  it("<table> が4つでなければ throw する", () => {
    const broken = fxHtml().replace(/<table class="snd_table01b td_va_mid th_center">/, "<div>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/table.*4つ/);
  });

  it("期間見出しが月次・年次のいずれの形式でもなければ throw する", () => {
    const broken = fxHtml().replace("<th>2026.08</th>", "<th>令和8年8月</th>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/期間見出しの形式/);
  });

  it("数量セルが数字・カンマ以外を含めば throw する", () => {
    const broken = fxHtml().replace("<td>376,532</td>", "<td>N/A</td>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/数量セルの形式/);
  });

  it("1日平均セルが \"(数字)\" / \"(-)\" 以外なら throw する", () => {
    const broken = fxHtml().replace("<td>(17,930)</td>", "<td>約1.8万</td>");
    expect(() =>
      parseTfxClick365Html(broken, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/1日平均セルの形式/);
  });

  it("単位の注記が「枚」でなければ throw する (unit を黙って決め打ちしない)", () => {
    // 実ページは4表それぞれの下に「単位：枚」がある。1つでも変われば桁・意味を取り違える。
    expect(fxHtml().match(/単位：枚/g)).toHaveLength(4);
    expect(cfdHtml().match(/単位：枚/g)).toHaveLength(4);
    const changed = fxHtml().replace("単位：枚", "単位：千枚");
    expect(() =>
      parseTfxClick365Html(changed, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/単位の注記/);
    const removed = cfdHtml().replace("単位：枚", "");
    expect(() =>
      parseTfxClick365Html(removed, "clickkabu365_cfd", TFX_CLICKKABU365_CFD_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/単位の注記/);
  });

  it("セル内の文字参照は復号し、未対応の名前付き参照は throw する (区分名に生の参照を混ぜない)", () => {
    const withAmp = fxHtml().replace('<th rowspan="2">ユーロ／円</th>', '<th rowspan="2">ユーロ&amp;円</th>');
    const data = parseTfxClick365Html(withAmp, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
    const names = new Set(data.monthlyVolume.map((c) => c.instrument));
    expect(names.has("ユーロ&円")).toBe(true);
    expect([...names].some((n) => n.includes("&amp;"))).toBe(false);

    const withUnknown = fxHtml().replace('<th rowspan="2">ユーロ／円</th>', '<th rowspan="2">ユーロ&reg;円</th>');
    expect(() =>
      parseTfxClick365Html(withUnknown, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/未対応の文字参照/);
  });

  it("出来高と1日平均の空欄の組み合わせが実ファイルに無い形なら throw する (黙って欠測・破棄にしない)", () => {
    // 実ファイルでは「出来高あり ⇔ 1日平均は (数字) か (-)」「出来高空欄 ⇔ 1日平均は空欄か (-)」のみ。
    // 出来高があるのに1日平均が空欄 → 以前は dailyAvg=undefined (欠測) に黙って落としていた。
    const avgBlank = fxHtml().replace("<td>(17,930)</td>", "<td></td>");
    expect(avgBlank).not.toBe(fxHtml());
    expect(() =>
      parseTfxClick365Html(avgBlank, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/1日平均が空欄/);
    // 出来高が空欄なのに1日平均に数値 → 以前は公表された1日平均を黙って捨てていた。
    // (最初に現れる "(-)" の連続は 中国オフショア人民元／円 の 2024/2023 年次で、出来高は空欄)
    const avgWithoutTotal = fxHtml().replace("<td>(-)</td>\n\t\t\t<td>(-)</td>", "<td>(5)</td>\n\t\t\t<td>(-)</td>");
    expect(avgWithoutTotal).not.toBe(fxHtml());
    expect(() =>
      parseTfxClick365Html(avgWithoutTotal, "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z")
    ).toThrow(/出来高が空欄なのに1日平均/);
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
});

describe.skipIf(!hasFixtures)("fetchAndParseTfxClick365 (実ファイル応答)", () => {
  it("正常応答なら取得+パースまで通る", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(fxHtml(), { status: 200 })) as typeof fetch;
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

describe.skipIf(!hasFixtures)("期間の判定・「まだ公表されていない」の判定 (実ファイル)", () => {
  let data: TfxClick365Data;
  beforeAll(() => {
    data = parseTfxClick365Html(fxHtml(), "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
  });

  it("取得済みの期間はpublished、存在しない期間は未publishedと判定する", () => {
    expect(isTfxPeriodPublished("2026-08", data.monthlyVolume)).toBe(true);
    expect(isTfxPeriodPublished("2026-09", data.monthlyVolume)).toBe(false);
  });

  it("最新の公表済み期間を返す", () => {
    expect(latestTfxPublishedPeriod(data.monthlyVolume)).toBe("2026-08");
    expect(latestTfxPublishedPeriod(data.annualVolume)).toBe("2025");
  });

  it("tfxAvailablePeriods は重複なし昇順で返す", () => {
    const periods = tfxAvailablePeriods(data.monthlyVolume);
    expect(periods).toEqual([...periods].sort());
    expect(new Set(periods).size).toBe(periods.length);
    expect(periods).toContain("2026-08");
  });

});

describe("期間の判定・「まだ公表されていない」の判定", () => {
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

  it("月・年の区切りは日本時間で判定する (UTC の暦だと日本時間の月初 0〜9 時に前々月を返してしまう)", () => {
    // 2026-09-30T15:30Z = 日本時間 2026-10-01 00:30 → 前月は 2026-09。
    expect(expectedMonthlyPeriod(new Date("2026-09-30T15:30:00Z"))).toBe("2026-09");
    // 2026-12-31T15:30Z = 日本時間 2027-01-01 00:30 → 前月は 2026-12、前年は 2026。
    expect(expectedMonthlyPeriod(new Date("2026-12-31T15:30:00Z"))).toBe("2026-12");
    expect(expectedAnnualPeriod(new Date("2026-12-31T15:30:00Z"))).toBe("2026");
    // 日本時間の月末 23:59 (= UTC 14:59) はまだ当月扱い。
    expect(expectedMonthlyPeriod(new Date("2026-09-30T14:59:00Z"))).toBe("2026-08");
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

  it("CFD (くりっく株３６５) の説明文で「取引所FX」と書かない", () => {
    const cfd = TFX_CLICK365_METRICS.filter((m) => m.key.startsWith("tfx-clickkabu365-cfd-"));
    expect(cfd).toHaveLength(3);
    for (const m of cfd) {
      expect(`${m.description}${m.definition}${m.limitations}`).not.toContain("取引所FX");
    }
  });

  it("出来高・建玉の定義に、原資料で確かめられない数え方を書かない", () => {
    for (const m of TFX_CLICK365_METRICS) {
      const text = `${m.description}${m.definition}${m.limitations}`;
      // 1件の約定を買い・売りで2回数えるかのような表現 (原資料に数え方の説明は無い)。
      expect(text).not.toContain("両方を1回ずつ数える");
      // 出来高は新規の建てだけでなく決済(反対売買)も含むため「買建て・売建ての双方向合計」は不正確。
      expect(text).not.toContain("買建て・売建ての双方向合計");
      // 建玉が買建玉+売建玉の合計かどうかは原資料に書かれていない。
      expect(text).not.toContain("買建て・売建ての合計");
      // 「丸めて0未満」は誤記 (正しくは1日平均が1枚未満で0に丸められる)。
      expect(text).not.toContain("丸めて0未満");
    }
  });

  it("建玉はストック、出来高は買いと売りを差し引いたネットの流れではないと明記する", () => {
    for (const m of TFX_CLICK365_METRICS) {
      if (m.measures === "positions") {
        expect(m.description).toContain("ストック");
        expect(m.description).toContain("買いと売りのどちらに傾いているか");
      } else {
        expect(m.measures).toBe("gross_turnover");
      }
      if (m.key.endsWith("-turnover")) {
        expect(m.definition).toContain("ネットの資金流入出(net_flow)を表す指標ではない");
      }
      // 1枚の大きさは商品ごとに違うので、枚数の合算・比較は金額比較にならない。
      expect(m.limitations).toContain("1枚あたりの取引単位");
    }
  });

  it("利用条件はヒストリカルデータベースの注意書きとサイト免責事項の両方を出典つきで示す", () => {
    for (const m of TFX_CLICK365_METRICS) {
      expect(m.usageTerms).toContain("https://www.tfx.co.jp/historical/");
      expect(m.usageTerms).toContain("https://www.tfx.co.jp/disclaimer/");
      expect(m.usageTerms).toContain("personal-only");
    }
  });
});

describe.skipIf(!hasFixtures)("1日平均の定義の裏付け (実ファイルの値から逆算した営業日数)", () => {
  let fx: TfxClick365Data;
  let cfd: TfxClick365Data;
  beforeAll(() => {
    fx = parseTfxClick365Html(fxHtml(), "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
    cfd = parseTfxClick365Html(cfdHtml(), "clickkabu365_cfd", TFX_CLICKKABU365_CFD_URL, "2026-09-27T00:00:00.000Z");
  });
  const impliedDays = (cells: TfxClick365Data["monthlyVolume"], instrument: string, period: string) => {
    const c = find(cells, instrument, period);
    if (c.total === undefined || typeof c.dailyAvg !== "number") throw new Error("前提の値がない");
    return Math.round(c.total / c.dailyAvg);
  };

  it("割る営業日数は銘柄ごとに異なる (2026-04: FX 22日 / 金ETF 21日 / DAX 20日)", () => {
    expect(impliedDays(fx.monthlyVolume, "米ドル／円", "2026-04")).toBe(22);
    expect(impliedDays(cfd.monthlyVolume, "金ETF リセット付証拠金取引／26", "2026-04")).toBe(21);
    expect(impliedDays(cfd.monthlyVolume, "DAX(R) リセット付証拠金取引／26", "2026-04")).toBe(20);
  });

  it("期間の途中で上場した通貨ペアは上場後の日数で割られている (2025年: 米ドル／円 260日 / 中国オフショア人民元／円 243日)", () => {
    expect(impliedDays(fx.annualVolume, "米ドル／円", "2025")).toBe(260);
    expect(impliedDays(fx.annualVolume, "中国オフショア人民元／円", "2025")).toBe(243);
  });

  it("「(-)」は1日平均が1枚未満で0に丸められるもの (英ポンド／日本円（ラージ） 2026-03: 9枚 ÷ 22日)", () => {
    const c = find(fx.monthlyVolume, "英ポンド／日本円（ラージ）", "2026-03");
    expect(c.total).toBe(9);
    expect(c.dailyAvg).toBeNull();
    // 同月の営業日数は22日 (米ドル／円から逆算)。9 ÷ 22 ≒ 0.41 枚/日で、整数に丸めると0。
    expect(impliedDays(fx.monthlyVolume, "米ドル／円", "2026-03")).toBe(22);
  });
});

describe.skipIf(!hasFixtures)("toMoneyflowObservations (縦長の観測ログレコード)", () => {
  let data: TfxClick365Data;
  let observations: ReturnType<typeof toMoneyflowObservations>;
  beforeAll(() => {
    data = parseTfxClick365Html(fxHtml(), "click365_fx", TFX_CLICK365_FX_URL, "2026-09-27T00:00:00.000Z");
    observations = toMoneyflowObservations(data);
  });

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

  it("1回の取得で作る行数 (FX 971行 / CFD 264行。欠測・「(-)」の組み合わせを除いた数)", () => {
    // FX: 33通貨ペア × (月次7期×3指標 + 年次3期×3指標) = 990 から、
    //   月次1日平均の「(-)」1件と、年次の欠測 (出来高6件+1日平均6件+建玉6件) を除いた数。
    expect(observations).toHaveLength(971);
    const cfd = parseTfxClick365Html(cfdHtml(), "clickkabu365_cfd", TFX_CLICKKABU365_CFD_URL, "2026-09-27T00:00:00.000Z");
    // CFD: 11銘柄 × 7期 × 3指標 = 231 + 年次は 2025 のみ 11銘柄 × 3指標 = 33。
    expect(toMoneyflowObservations(cfd)).toHaveLength(264);
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
