import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import {
  validateDrafts,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";
import {
  CFTC_COT_JPY_RESPONSE_FILENAME,
  cftcCotJpySpec,
} from "./cftc-cot-jpy.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  here,
  "../sources/fixtures/public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json",
);
const hasFixture = existsSync(FIXTURE);
const ROW_BUDGET = 600;

function fixtureFiles(): SpecFile[] {
  return [
    {
      filename: CFTC_COT_JPY_RESPONSE_FILENAME,
      bytes: new Uint8Array(readFileSync(FIXTURE)),
    },
  ];
}

function find(
  drafts: readonly ObservationDraft[],
  indicatorKey: string,
  category: string,
): ObservationDraft {
  const hit = drafts.find(
    (d) => d.indicatorKey === indicatorKey && d.category === category,
  );
  if (!hit)
    throw new Error(`テスト: ${indicatorKey} / ${category} の行がありません`);
  return hit;
}

// ---------------------------------------------------------------------------
// 合成テストデータ (synthetic test data): Socrata API 応答と同じ形の最小の JSON。
// 値は架空。マッピングロジックの検証専用で、本番経路には出ない。
// ---------------------------------------------------------------------------
function syntheticRow(over: {
  date: string;
  code: "097741" | "240743";
  oi: number;
  ncL: number;
  ncS: number;
  cL: number;
  cS: number;
}): Record<string, string> {
  const isJpy = over.code === "097741";
  return {
    report_date_as_yyyy_mm_dd: `${over.date}T00:00:00.000`,
    yyyy_report_week_ww: "2026 Report Week 0",
    contract_market_name: isJpy
      ? "JAPANESE YEN"
      : "NIKKEI STOCK AVERAGE YEN DENOM",
    cftc_contract_market_code: over.code,
    market_and_exchange_names: `${isJpy ? "JAPANESE YEN" : "NIKKEI STOCK AVERAGE YEN DENOM"} - CHICAGO MERCANTILE EXCHANGE`,
    contract_units: isJpy
      ? "(CONTRACTS OF JPY 12,500,000)"
      : "(NIKKEI INDEX X JPY 500)",
    open_interest_all: String(over.oi),
    noncomm_positions_long_all: String(over.ncL),
    noncomm_positions_short_all: String(over.ncS),
    comm_positions_long_all: String(over.cL),
    comm_positions_short_all: String(over.cS),
    nonrept_positions_long_all: "1",
    nonrept_positions_short_all: "2",
  };
}
function syntheticFiles(rows: Array<Record<string, string>>): SpecFile[] {
  return [
    {
      filename: CFTC_COT_JPY_RESPONSE_FILENAME,
      bytes: new TextEncoder().encode(JSON.stringify(rows)),
    },
  ];
}
const SYNTHETIC_ROWS = [
  syntheticRow({
    date: "2026-01-06",
    code: "240743",
    oi: 100,
    ncL: 10,
    ncS: 30,
    cL: 50,
    cS: 20,
  }),
  syntheticRow({
    date: "2026-01-06",
    code: "097741",
    oi: 1000,
    ncL: 300,
    ncS: 100,
    cL: 200,
    cS: 500,
  }),
  syntheticRow({
    date: "2025-12-30",
    code: "097741",
    oi: 999,
    ncL: 1,
    ncS: 1,
    cL: 1,
    cS: 1,
  }),
  syntheticRow({
    date: "2025-12-30",
    code: "240743",
    oi: 99,
    ncL: 1,
    ncS: 1,
    cL: 1,
    cS: 1,
  }),
];

describe("cftc-cot-jpy adapter: 指標定義", () => {
  it("全指標が enum ガードを通り、キー一意・https 出典・日本語の説明と限界を持つ", () => {
    const keys = cftcCotJpySpec.indicators.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(10);
    for (const i of cftcCotJpySpec.indicators) {
      expect(isMoneyflowFlowType(i.flowType)).toBe(true);
      expect(isMoneyflowFrequency(i.frequency)).toBe(true);
      expect(isMoneyflowLicense(i.license)).toBe(true);
      expect(isMoneyflowRequirement(i.requirement)).toBe(true);
      expect(i.sourceUrl.startsWith("https://")).toBe(true);
      expect(i.description).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(i.limitations).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(i.description).toContain("ストック");
      expect(i.flowType).toBe("建玉");
      expect(i.frequency).toBe("週次");
    }
    expect(cftcCotJpySpec.name).toBe("cftc-cot-jpy");
  });

  it("単位を「枚」に揃えても、1枚の大きさと契約間で合算不可の注意を説明文から落とさない", () => {
    for (const i of cftcCotJpySpec.indicators) {
      expect(i.description).toContain("枚数を足したり");
      if (i.key.startsWith("cftc_cot_jpy_")) {
        expect(i.description).toContain("1枚=1,250万円分の円");
      } else {
        expect(i.key.startsWith("cftc_cot_nikkei225_yen_")).toBe(true);
        expect(i.description).toContain("1枚=日経平均×500円分");
      }
    }
  });

  it("限界に Futures Only (オプション建玉を含まない) とスプレッド除外が書かれている", () => {
    for (const i of cftcCotJpySpec.indicators) {
      expect(i.limitations).toContain("オプション建玉は含まない");
      expect(i.limitations).toContain("スプレッド分を含まない");
    }
  });

  it("ネット指標の説明に符号の向き (プラス=買い越し) が書かれている", () => {
    for (const i of cftcCotJpySpec.indicators.filter((d) =>
      d.key.endsWith("_net"),
    )) {
      expect(i.description).toContain("プラス=買い越し");
    }
  });
});

describe("cftc-cot-jpy adapter: 合成テストデータでのマッピング (CI で常に実行)", () => {
  it("キーの週の 2 契約 × 5 指標だけを、契約定義順・枚単位で出す", () => {
    const drafts = cftcCotJpySpec.toObservations({
      key: "cftc-cot-jpy-2026-W02",
      files: syntheticFiles(SYNTHETIC_ROWS),
    });
    validateDrafts(cftcCotJpySpec.name, drafts, cftcCotJpySpec.indicators);
    expect(drafts).toHaveLength(10);
    expect(drafts.map((d) => d.indicatorKey)).toEqual([
      "cftc_cot_jpy_noncomm_net",
      "cftc_cot_jpy_noncomm_long",
      "cftc_cot_jpy_noncomm_short",
      "cftc_cot_jpy_comm_net",
      "cftc_cot_jpy_open_interest",
      "cftc_cot_nikkei225_yen_noncomm_net",
      "cftc_cot_nikkei225_yen_noncomm_long",
      "cftc_cot_nikkei225_yen_noncomm_short",
      "cftc_cot_nikkei225_yen_comm_net",
      "cftc_cot_nikkei225_yen_open_interest",
    ]);
    for (const d of drafts) {
      expect(d.period).toBe("2026-W02");
      expect(d.periodStart).toBe("2026-01-06");
      expect(d.periodEnd).toBe("2026-01-06");
      expect(d.unit).toBe("枚");
      expect(d.categoryKind).toBe("商品");
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
    expect(find(drafts, "cftc_cot_jpy_noncomm_net", "CME / 円先物").value).toBe(
      200,
    );
    expect(find(drafts, "cftc_cot_jpy_comm_net", "CME / 円先物").value).toBe(
      -300,
    );
    expect(
      find(
        drafts,
        "cftc_cot_nikkei225_yen_noncomm_net",
        "CME / 日経平均先物(円建て)",
      ).value,
    ).toBe(-20);
    expect(
      find(
        drafts,
        "cftc_cot_nikkei225_yen_open_interest",
        "CME / 日経平均先物(円建て)",
      ).value,
    ).toBe(100);
  });

  it("ISO 週が年をまたぐ基準日 (2025-12-30 → 2026-W01) を正しく選ぶ", () => {
    const drafts = cftcCotJpySpec.toObservations({
      key: "cftc-cot-jpy-2026-W01",
      files: syntheticFiles(SYNTHETIC_ROWS),
    });
    expect(drafts).toHaveLength(10);
    expect(
      drafts.every(
        (d) => d.periodEnd === "2025-12-30" && d.period === "2026-W01",
      ),
    ).toBe(true);
    expect(
      find(drafts, "cftc_cot_jpy_open_interest", "CME / 円先物").value,
    ).toBe(999);
  });

  it("キーの週に契約が欠けていれば throw する (黙って片方だけ書かない)", () => {
    const rows = SYNTHETIC_ROWS.filter(
      (r) =>
        !(
          r.cftc_contract_market_code === "240743" &&
          r.report_date_as_yyyy_mm_dd.startsWith("2026-01-06")
        ),
    );
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W02",
        files: syntheticFiles(rows),
      }),
    ).toThrow(/240743.*0 件/);
  });

  it("キーの週の行が無ければ throw する", () => {
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W10",
        files: syntheticFiles(SYNTHETIC_ROWS),
      }),
    ).toThrow(/基準日が 0 種類/);
  });

  it("ファイルが無い・名前が違う・キー形式が違う・未知の契約コードなら throw する", () => {
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W02",
        files: [],
      }),
    ).toThrow(/0 件/);
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W02",
        files: [{ filename: "other.json", bytes: new Uint8Array() }],
      }),
    ).toThrow(/0 件/);
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-01-06",
        files: syntheticFiles(SYNTHETIC_ROWS),
      }),
    ).toThrow(/冪等キーの形式/);
    const unknown = {
      ...SYNTHETIC_ROWS[0],
      cftc_contract_market_code: "240741",
    } as Record<string, string>;
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W02",
        files: syntheticFiles([...SYNTHETIC_ROWS, unknown]),
      }),
    ).toThrow(/追跡対象外/);
    expect(() =>
      cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W02",
        files: [
          {
            filename: CFTC_COT_JPY_RESPONSE_FILENAME,
            bytes: new TextEncoder().encode("{not json"),
          },
        ],
      }),
    ).toThrow(/JSON として読めません/);
  });
});

describe.skipIf(!hasFixture)(
  "cftc-cot-jpy adapter: 実ファイル (2026-09-27 取得の Socrata 応答)",
  () => {
    it("toObservations → validateDrafts を通り、行数が予算内で、独立抽出した実測値と一致する", () => {
      const drafts = cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W39",
        files: fixtureFiles(),
      });
      validateDrafts(cftcCotJpySpec.name, drafts, cftcCotJpySpec.indicators);
      expect(drafts.length).toBe(10);
      expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
      for (const d of drafts) {
        expect(d.period).toBe("2026-W39");
        expect(d.periodStart).toBe("2026-09-22");
        expect(d.periodEnd).toBe("2026-09-22");
        expect(d.unit).toBe("枚");
      }
      // 値は cftc.gov の人間向けレポート (deacmesf.htm, FUTURES ONLY POSITIONS AS OF 09/22/26) と
      // python3 で fixture を直接読んだ値で独立に確認したもの。単位は取得元と同じ「枚 (契約数)」で換算なし。
      const JPY = "CME / 円先物";
      const NK = "CME / 日経平均先物(円建て)";
      expect(find(drafts, "cftc_cot_jpy_open_interest", JPY).value).toBe(
        378_701,
      );
      expect(find(drafts, "cftc_cot_jpy_noncomm_long", JPY).value).toBe(
        192_274,
      );
      expect(find(drafts, "cftc_cot_jpy_noncomm_short", JPY).value).toBe(
        120_292,
      );
      expect(find(drafts, "cftc_cot_jpy_noncomm_net", JPY).value).toBe(71_982); // 192,274 − 120,292
      expect(find(drafts, "cftc_cot_jpy_comm_net", JPY).value).toBe(-76_414); // 143,954 − 220,368
      expect(
        find(drafts, "cftc_cot_nikkei225_yen_open_interest", NK).value,
      ).toBe(21_974);
      expect(find(drafts, "cftc_cot_nikkei225_yen_noncomm_net", NK).value).toBe(
        1_545,
      ); // 4,199 − 2,654
      expect(find(drafts, "cftc_cot_nikkei225_yen_comm_net", NK).value).toBe(
        4_606,
      ); // 11,364 − 6,758
    });

    it("過去週のキー (2026-W32 = 基準日 2026-08-04) でも同じファイルから作れる", () => {
      const drafts = cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W32",
        files: fixtureFiles(),
      });
      expect(drafts.every((d) => d.periodEnd === "2026-08-04")).toBe(true);
      expect(
        find(drafts, "cftc_cot_jpy_open_interest", "CME / 円先物").value,
      ).toBe(419_393);
    });

    it("別の週・マイナスのネット・小さい契約も、独立に読んだ値と一致する (レビューで追加)", () => {
      // 2026-09-15 (W38) の値は cftc.gov 人間向けレポート (evidence raw/cftc_human.htm) の
      // 「09/22/26 の建玉」−「CHANGES FROM 09/15/26」から逆算した値と一致することを確認済み。
      const JPY = "CME / 円先物";
      const NK = "CME / 日経平均先物(円建て)";
      const w38 = cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W38",
        files: fixtureFiles(),
      });
      expect(
        w38.every(
          (d) => d.periodStart === "2026-09-15" && d.periodEnd === "2026-09-15",
        ),
      ).toBe(true);
      expect(find(w38, "cftc_cot_jpy_open_interest", JPY).value).toBe(542_802); // 378,701 + 164,101
      expect(find(w38, "cftc_cot_jpy_noncomm_long", JPY).value).toBe(237_951); // 192,274 + 45,677
      expect(find(w38, "cftc_cot_jpy_noncomm_short", JPY).value).toBe(117_592); // 120,292 − 2,700
      expect(find(w38, "cftc_cot_nikkei225_yen_noncomm_long", NK).value).toBe(
        5_542,
      ); // 4,199 + 1,343
      expect(find(w38, "cftc_cot_nikkei225_yen_noncomm_short", NK).value).toBe(
        2_918,
      ); // 2,654 + 264
      expect(find(w38, "cftc_cot_nikkei225_yen_comm_net", NK).value).toBe(
        4_763,
      ); // 11,643 − 6,880
      // 2026-09-01 (W36): 円先物の非商業筋が売り越し (マイナス) の週
      const w36 = cftcCotJpySpec.toObservations({
        key: "cftc-cot-jpy-2026-W36",
        files: fixtureFiles(),
      });
      expect(find(w36, "cftc_cot_jpy_noncomm_net", JPY).value).toBe(-92_227); // 117,169 − 209,396
      expect(find(w36, "cftc_cot_jpy_comm_net", JPY).value).toBe(97_561); // 225,189 − 127,628
      // 保管済みファイルからの再解析は同じ行を作る (純関数)
      expect(
        cftcCotJpySpec.toObservations({
          key: "cftc-cot-jpy-2026-W36",
          files: fixtureFiles(),
        }),
      ).toEqual(w36);
    });

    describe("resolve()/fetch() (fetch をスタブして fixture を返す)", () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      function stubFetch(): string[] {
        const urls: string[] = [];
        const bytes = readFileSync(FIXTURE);
        vi.stubGlobal("fetch", async (input: string | URL) => {
          urls.push(String(input));
          return new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        });
        return urls;
      }

      it("公表済みの最新回のキーを返し、fetch() は同じキー・固定ファイル名・同じバイト列を返す", async () => {
        const urls = stubFetch();
        // 2026-09-27T03:00Z = 米国東部時間 2026-09-26(土) 23:00 → 基準日 2026-09-22 の回は公表済み
        const resolved = await cftcCotJpySpec.resolve(
          new Date("2026-09-27T03:00:00Z"),
        );
        expect(resolved.key).toBe("cftc-cot-jpy-2026-W39");
        const batch = await resolved.fetch();
        expect(urls).toHaveLength(1); // 取得元へは 1 回だけ
        expect(urls[0]).toContain(
          "publicreporting.cftc.gov/resource/6dca-aqww.json",
        );
        expect(batch.key).toBe(resolved.key);
        expect(batch.files.map((f) => f.filename)).toEqual([
          CFTC_COT_JPY_RESPONSE_FILENAME,
        ]);
        const file = batch.files[0];
        if (!file)
          throw new Error("テスト: fetch() がファイルを返していません");
        expect(file.contentType).toBe("application/json");
        expect(Buffer.from(file.bytes).equals(readFileSync(FIXTURE))).toBe(
          true,
        );
        expect(batch.source).toContain("publicreporting.cftc.gov");
        const drafts = cftcCotJpySpec.toObservations({
          key: batch.key,
          files: batch.files,
        });
        validateDrafts(cftcCotJpySpec.name, drafts, cftcCotJpySpec.indicators);
        expect(drafts).toHaveLength(10);
      });

      it("次の回の公表時刻を過ぎても応答が古いままなら「未公表」として throw する", async () => {
        stubFetch();
        // 2026-10-03T00:00Z = 米国東部時間 2026-10-02(金) 20:00 → 基準日 2026-09-29 の回が出ているはず
        await expect(
          cftcCotJpySpec.resolve(new Date("2026-10-03T00:00:00Z")),
        ).rejects.toThrow(/まだ公表されていません/);
      });
    });
  },
);
