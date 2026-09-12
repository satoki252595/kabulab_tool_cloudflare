/**
 * 公開面の市場区分 / 業種の出口 (src/shared/db/public-columns.ts) の単体テスト。
 *
 * ここで固定したいのは**既定 (`PUBLISH_JPX_DERIVED_COLUMNS = false`) の挙動**。
 * とくに「`sector33` が NULL のとき JPX の `sector` へ落ちない」は、書き足すのが
 * 自然に見えてしまう 1 行 (`?? row.sector`) で壊れる。壊れても型は通り、本番の
 * `sector33` が全行 NULL なので**公開面が JPX の値に戻ったことに誰も気づかない**。
 *
 * 出力に実際に出る / 出ないことは
 * services/otakara-yutai/src/tests/stock-detail-license.test.ts が
 * 番兵値を DB に入れて見ている。ここはその手前の純関数の契約。
 */
import { describe, expect, it } from "vitest";
import {
  PUBLISH_JPX_DERIVED_COLUMNS,
  publicStockMetaFromRow,
  publicStockMetaLabel,
  publicStockRelationalColumns,
} from "./public-columns.js";

describe("PUBLISH_JPX_DERIVED_COLUMNS", () => {
  it("既定は false (JPX 由来を公開しない)", () => {
    // true でコミットされていたら、公開面が personal-only を返す状態に戻っている。
    expect(PUBLISH_JPX_DERIVED_COLUMNS).toBe(false);
  });
});

describe("publicStockRelationalColumns", () => {
  it("既定では sector33 だけを指名し、JPX 由来の列を含まない", () => {
    // 関係クエリで市場区分 / JPX 業種を取ってこないこと。列を足すと
    // その値が SSR プロセスに載る (= 行を spread した 1 箇所で漏れる)。
    expect(Object.keys(publicStockRelationalColumns).sort()).toEqual(["sector33"]);
  });
});

describe("publicStockMetaFromRow", () => {
  it("市場区分は常に null (EDINET に等価物が無いので出さない)", () => {
    expect(publicStockMetaFromRow({ market: "プライム（内国株式）" }).market).toBeNull();
  });

  it("業種は sector33 を読む", () => {
    expect(publicStockMetaFromRow({ sector33: "輸送用機器" }).sector).toBe("輸送用機器");
  });

  it("sector33 が NULL のとき JPX の sector へフォールバックしない", () => {
    // ここが `?? row.sector` になると、sector33 の充填が終わるまでずっと
    // JPX の値が公開面に出続ける。本番は全行 NULL なので常にそうなる。
    expect(publicStockMetaFromRow({ sector: "輸送用機器", sector33: null }).sector).toBeNull();
    expect(publicStockMetaFromRow({ sector: "輸送用機器" }).sector).toBeNull();
  });

  it("列が 1 つも無い行でも undefined を返さない", () => {
    // 呼び出し側は `?? ""` を書かずに view へ渡す。undefined が混ざると
    // テンプレートに "undefined" と出る。
    expect(publicStockMetaFromRow({})).toEqual({ market: null, sector: null });
  });
});

describe("publicStockMetaLabel", () => {
  it("null の項目を落として繋ぐ", () => {
    expect(publicStockMetaLabel([null, "電気機器"])).toBe("電気機器");
    expect(publicStockMetaLabel(["プライム", "電気機器"])).toBe("プライム / 電気機器");
  });

  it("全部空なら — (空文字にしない)", () => {
    // 空文字だと要素が潰れ、「壊れた」のか「値が無い」のかが見た目で区別できない。
    expect(publicStockMetaLabel([null, null])).toBe("—");
    expect(publicStockMetaLabel([undefined, "", "   "])).toBe("—");
  });

  it('"null" / "undefined" という文字列を出さない', () => {
    // view は `${h(publicStockMetaLabel(...))}` と書くだけなので、ここが
    // 素の値を通すと HTML に "null" が出る。
    expect(publicStockMetaLabel([null, undefined])).not.toMatch(/null|undefined/);
  });

  it("区切り文字を差し替えられる (面ごとに表記が違う)", () => {
    expect(publicStockMetaLabel(["7203", "電気機器"], " · ")).toBe("7203 · 電気機器");
  });
});
