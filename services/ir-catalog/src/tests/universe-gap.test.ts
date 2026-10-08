/**
 * 日次 catchup が「直近7日の再 upsert」と「保持40日以内の D1 欠測の挿入」を
 * 分ける純関数。銘柄コードは合成。外部通信はしない。
 */
import { describe, expect, it } from "vitest";
import {
  catchupListingRange,
  recentWindowStartMs,
  selectDisclosuresForCatchup,
} from "../services/ingest.js";
import type { TdnetItemRaw } from "../services/tdnet/types.js";

const NOW = Date.parse("2026-10-08T02:30:00+09:00");
const CODE_TO_ID = new Map<string, number>([["7203", 1], ["130A", 2]]);

function item(over: Partial<TdnetItemRaw> & { id: string; pubdate: string; company_code: string }): TdnetItemRaw {
  return {
    id: over.id,
    pubdate: over.pubdate,
    company_code: over.company_code,
    company_name: over.company_name ?? "テスト",
    title: over.title ?? "テスト開示",
    document_url: over.document_url ?? "https://example.invalid/x.pdf",
    url_xbrl: null,
    markets_string: null,
    update_history: null,
  };
}

describe("selectDisclosuresForCatchup", () => {
  it("一覧範囲は公開40日の暦日で、7日窓より前から取る", () => {
    expect(catchupListingRange(NOW, 40)).toBe("20260829-20261008");
    expect(recentWindowStartMs(NOW, 7)).toBe(Date.parse("2026-10-01T00:00:00+09:00"));
  });

  it("7日を超えて40日以内の欠測だけを挿入し、既存と母集団外と40日超は書かない", () => {
    const selected = selectDisclosuresForCatchup({
      nowMs: NOW,
      recentWindowDays: 7,
      retainDays: 40,
      codeToId: CODE_TO_ID,
      existingTdnetIds: new Set(["HAVE"]),
      items: [
        item({ id: "LATE", pubdate: "2026-09-18 08:00:00", company_code: "72030" }),
        item({ id: "HAVE", pubdate: "2026-09-18 09:00:00", company_code: "72030" }),
        item({ id: "RECENT", pubdate: "2026-10-02 15:00:00", company_code: "72030" }),
        item({ id: "RECENT-HAVE", pubdate: "2026-10-03 15:00:00", company_code: "130A0" }),
        item({ id: "OUT", pubdate: "2026-09-18 08:00:00", company_code: "99990" }),
        item({ id: "BAD", pubdate: "2026-09-18 08:00:00", company_code: "ABCDE" }),
        item({ id: "OLD", pubdate: "2026-08-29 02:29:59", company_code: "72030" }),
        item({ id: "EDGE", pubdate: "2026-08-29 02:30:00", company_code: "130A0" }),
      ],
    });
    expect(selected.missingTdnetIds).toEqual(["EDGE", "LATE"]);
    expect(selected.pastRetainInUniverseIds).toEqual(["OLD"]);
    expect(selected.items.map((row) => row.id).sort()).toEqual(
      ["BAD", "EDGE", "LATE", "OUT", "RECENT", "RECENT-HAVE"]
    );
  });

  it("公開40日ちょうどの開示は欠測に入り、1秒古い開示は入らない", () => {
    const on = selectDisclosuresForCatchup({
      nowMs: NOW,
      recentWindowDays: 7,
      retainDays: 40,
      codeToId: CODE_TO_ID,
      existingTdnetIds: new Set(),
      items: [item({ id: "ON", pubdate: "2026-08-29 02:30:00", company_code: "72030" })],
    });
    const before = selectDisclosuresForCatchup({
      nowMs: NOW,
      recentWindowDays: 7,
      retainDays: 40,
      codeToId: CODE_TO_ID,
      existingTdnetIds: new Set(),
      items: [item({ id: "BEFORE", pubdate: "2026-08-29 02:29:59", company_code: "72030" })],
    });
    expect(on.missingTdnetIds).toEqual(["ON"]);
    expect(before.missingTdnetIds).toEqual([]);
    expect(before.pastRetainInUniverseIds).toEqual(["BEFORE"]);
  });
});
