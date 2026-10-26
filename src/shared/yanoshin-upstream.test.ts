import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import spec from "./yanoshin-upstream-freshness.json";
import { formatYanoshinUpstreamLog, judgeYanoshinUpstream } from "./yanoshin-upstream.js";

it("閾値は監視窓 9–19 時・許容 4 時間で固定する", () => {
  expect(spec.watchOpenHourJst).toBe(9);
  expect(spec.watchCloseHourJst).toBe(19);
  expect(spec.maxWatchSilenceSeconds).toBe(14400);
  const raw = readFileSync(new URL("./yanoshin-upstream-freshness.json", import.meta.url), "utf8");
  expect(JSON.parse(raw)).toEqual(spec);
});

it.each(spec.cases)("$id", (row) => {
  const now = new Date(row.now);
  const newest = row.newest === null ? null : new Date(row.newest);
  const got = judgeYanoshinUpstream(newest, now);
  expect(got.judgement).toBe(row.judgement);
  expect(got.elapsedWatchSeconds).toBe(row.elapsedWatchSeconds);
  expect(got.newestPubdate).toBe(row.newest);
  const line = formatYanoshinUpstreamLog(got);
  expect(line).toContain(`judgement=${row.judgement}`);
  expect(line).toContain(`elapsed_watch_seconds=${row.elapsedWatchSeconds ?? "none"}`);
  expect(line).toContain(`newest_pubdate=${row.newest ?? "none"}`);
});
