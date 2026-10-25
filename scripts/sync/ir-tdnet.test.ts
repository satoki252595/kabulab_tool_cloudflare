import { describe, expect, it } from "vitest";
import { parseTdnetResumeArgs } from "./ir-tdnet.js";
import actual from "../../services/ir-catalog/src/tests/fixtures/tdnet-1279652-identity.actual.json";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const dates = ["--resume-from=2026-09-08", "--resume-to=2026-09-08"];
const id = `--resume-tdnet-id=${actual.disclosure.tdnetId}`;
const deadline = "--deadline-at=2026-10-25T12:05:00.000Z";

describe("TDnet saved-input resume arguments", () => {
  it("keeps catchup/date resume and limits the observed original to an explicit ID/deadline", () => {
    expect(parseTdnetResumeArgs([], now)).toBeUndefined();
    expect(parseTdnetResumeArgs(dates, now)).toEqual({
      from: new Date("2026-09-07T15:00:00.000Z"), toExclusive: new Date("2026-09-08T15:00:00.000Z"), exact: undefined,
    });
    expect(parseTdnetResumeArgs([...dates, id, deadline], now)?.exact).toEqual({
      tdnetId: actual.disclosure.tdnetId, deadlineMs: now + 5 * 60_000,
    });
  });

  it.each([
    [id, deadline], [...dates, id], [...dates, deadline], [...dates, id, id, deadline],
    [...dates, "--resume-tdnet-id=0", deadline], [...dates, id, "--force"],
    [...dates, id, "--deadline-at=2026-10-25T12:00:00.000Z"],
    [...dates, id, "--deadline-at=2026-10-25T13:00:00.001Z"],
    [...dates, id, "--deadline-at=2026-10-25T12:05:00"],
    [...dates, id, "--deadline-at=invalid"],
    ["--resume-from=2026-09-09", "--resume-to=2026-09-08"],
    ["--resume-from=2026-02-30", "--resume-to=2026-03-01"],
  ])("rejects incomplete/ambiguous/unbounded resume before execution (%j)", (...args) => {
    expect(() => parseTdnetResumeArgs(args, now)).toThrow();
  });
});
