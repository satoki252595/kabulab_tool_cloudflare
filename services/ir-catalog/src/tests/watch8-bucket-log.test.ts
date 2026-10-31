/**
 * diag(INC-20261026-kabulab_tool_cloudflare-tdnet-empty-success): 撤去予定
 * 8社が outside-universe と invalid-code のどちらに入ったかをログ行へ分ける。
 * 判定・保存はしない。
 */
import { describe, expect, it, vi } from "vitest";
import {
  formatWatch8BucketLogs,
  logWatch8Buckets,
  prepareRows,
} from "../services/ingest.js";
import type { TdnetItemRaw } from "../services/tdnet/types.js";

const TAG = "[INC-20261026-kabulab_tool_cloudflare-tdnet-empty-success]";

function item(id: string, companyCode: string): TdnetItemRaw {
  return {
    id,
    pubdate: "2026-10-31 15:00:00",
    company_code: companyCode,
    company_name: "テスト",
    title: "テスト開示",
    document_url: "https://example.invalid/x.pdf",
    url_xbrl: null,
    markets_string: null,
    update_history: null,
  };
}

describe("formatWatch8BucketLogs", () => {
  it("8社に当たらなければ none を1行だけ返す", () => {
    expect(
      formatWatch8BucketLogs(
        [{ tdnetId: "out-1", ticker: "9999" }],
        [{ tdnetId: "bad-1", companyCode: "ABCDE" }]
      )
    ).toEqual([`${TAG} watch8 none`]);
    expect(formatWatch8BucketLogs([], [])).toEqual([`${TAG} watch8 none`]);
  });

  it("バケットと生コードごとに tdnetId を全件つなぐ", () => {
    const outside = [
      { tdnetId: "o1", ticker: "7950" },
      { tdnetId: "o2", ticker: "2989" },
      { tdnetId: "o3", ticker: "7950" },
      { tdnetId: "skip", ticker: "7203" },
    ];
    const invalid = [
      { tdnetId: "i1", companyCode: "62250" },
      { tdnetId: "i2", companyCode: "NOTA" },
      { tdnetId: "i3", companyCode: "3455" },
      { tdnetId: "i4", companyCode: "29891" },
      { tdnetId: "i5", companyCode: "29890" },
    ];
    const outsideBefore = outside.map((row) => ({ ...row }));
    const invalidBefore = invalid.map((row) => ({ ...row }));

    expect(formatWatch8BucketLogs(outside, invalid)).toEqual([
      `${TAG} watch8 bucket=outside-universe code=7950 tdnetIds=o1,o3`,
      `${TAG} watch8 bucket=outside-universe code=2989 tdnetIds=o2`,
      `${TAG} watch8 bucket=invalid-code code=62250 tdnetIds=i1`,
      `${TAG} watch8 bucket=invalid-code code=3455 tdnetIds=i3`,
      `${TAG} watch8 bucket=invalid-code code=29891 tdnetIds=i4`,
      `${TAG} watch8 bucket=invalid-code code=29890 tdnetIds=i5`,
    ]);
    expect(outside).toEqual(outsideBefore);
    expect(invalid).toEqual(invalidBefore);
  });

  it("525A は ticker 一致と company_code 先頭4文字の両方を別行にする", () => {
    expect(
      formatWatch8BucketLogs(
        [{ tdnetId: "a", ticker: "525A" }],
        [{ tdnetId: "b", companyCode: "525A0" }]
      )
    ).toEqual([
      `${TAG} watch8 bucket=outside-universe code=525A tdnetIds=a`,
      `${TAG} watch8 bucket=invalid-code code=525A0 tdnetIds=b`,
    ]);
  });

  it("大文字の8社リストに一致しない表記は拾わない", () => {
    expect(
      formatWatch8BucketLogs([], [{ tdnetId: "c", companyCode: "525a0" }])
    ).toEqual([`${TAG} watch8 none`]);
  });

  it("prepareRows の振り分け結果を変えず、末尾0の5文字は outside-universe の ticker として出る", () => {
    const prepared = prepareRows(
      [
        item("t-2989", "29890"),
        item("t-bad", "ABCDE"),
        item("t-in", "72030"),
      ],
      new Map([["7203", 1]])
    );
    expect(prepared.rows.map((row) => row.tdnetId)).toEqual(["t-in"]);
    expect(prepared.outsideUniverse).toEqual([{ tdnetId: "t-2989", ticker: "2989" }]);
    expect(prepared.invalidCode).toEqual([{ tdnetId: "t-bad", companyCode: "ABCDE" }]);
    expect(
      formatWatch8BucketLogs(prepared.outsideUniverse, prepared.invalidCode)
    ).toEqual([
      `${TAG} watch8 bucket=outside-universe code=2989 tdnetIds=t-2989`,
    ]);
  });
});

describe("logWatch8Buckets の出力先", () => {
  it("該当が無ければ console.info、あれば console.warn", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      logWatch8Buckets([], []);
      logWatch8Buckets([{ tdnetId: "o1", ticker: "8972" }], []);
      expect(info.mock.calls.map((call) => call[0])).toEqual([`${TAG} watch8 none`]);
      expect(warn.mock.calls.map((call) => call[0])).toEqual([
        `${TAG} watch8 bucket=outside-universe code=8972 tdnetIds=o1`,
      ]);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
