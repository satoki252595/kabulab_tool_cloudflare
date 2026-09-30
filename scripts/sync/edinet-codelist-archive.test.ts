import { describe, expect, it } from "vitest";
import {
  archiveAndVerify,
  parseArchiveArgs,
  type ArchiveDeps,
  type ArchiveInput,
} from "./edinet-codelist-archive.js";

const ZIP = new Uint8Array([0x50, 0x4b, 1, 2, 3]);
const META = new Uint8Array([0x7b, 0x7d]);

function input(): ArchiveInput {
  return {
    key: "edinet-codelist-2026-06-10",
    source: "https://example.invalid/codelist/Edinetcode.zip",
    service: "universe",
    zipName: "Edinetcode.zip",
    zipBytes: ZIP,
    manifestName: "m.json",
    manifestBytes: META,
    metadata: { asOf: "2026-06-10" },
  };
}

function deps(over: Partial<ArchiveDeps> = {}, calls: { record: number } = { record: 0 }): ArchiveDeps {
  return {
    record: (async () => {
      calls.record++;
      return { pageId: "page-1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    }) as ArchiveDeps["record"],
    findDb: async () => "db-1",
    queryUnique: async () => ({ id: "page-1" }),
    listFiles: async () => [
      { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" },
      { name: "m.json", kind: "file", url: "https://hosted.invalid/m" },
    ],
    download: async (url) => (url.endsWith("/z") ? ZIP : META),
    ...over,
  };
}

describe("edinet-codelist-archive", () => {
  it("recorded + 全 bytes 照合一致で ok (record は 1 回だけ)", async () => {
    const calls = { record: 0 };
    const res = await archiveAndVerify(input(), deps({}, calls));
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.pageId).toBe("page-1");
    expect(res.outcome).toBe("recorded");
    expect(res.files).toHaveLength(2);
    expect(calls.record).toBe(1);
  });

  it("skipped_existing + 同 bytes の readback 一致で ok (再 POST なし)", async () => {
    const calls = { record: 0 };
    const res = await archiveAndVerify(
      input(),
      deps(
        {
          record: (async () => {
            calls.record++;
            return { pageId: "page-1", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" };
          }) as ArchiveDeps["record"],
        },
        calls
      )
    );
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(calls.record).toBe(1);
  });

  it("record 失敗は fail (writer へ進めない)", async () => {
    const res = await archiveAndVerify(
      input(),
      deps({ record: (() => Promise.reject(new Error("boom"))) as ArchiveDeps["record"] })
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/record 失敗/);
  });

  it("fileTooLarge は fail", async () => {
    const res = await archiveAndVerify(
      input(),
      deps({
        record: (async () => ({
          pageId: "page-1",
          outcome: "recorded",
          fileTooLarge: true,
          manifestMatch: "written",
        })) as ArchiveDeps["record"],
      })
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/fileTooLarge/);
  });

  it("unique 行なし・page 不一致・重複は fail", async () => {
    const a = await archiveAndVerify(input(), deps({ queryUnique: async () => null }));
    expect(a.ok).toBe(false);
    const b = await archiveAndVerify(input(), deps({ queryUnique: async () => ({ id: "page-9" }) }));
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/不一致/);
    const c = await archiveAndVerify(
      input(),
      deps({ queryUnique: () => Promise.reject(new Error("not unique")) })
    );
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/unique/);
  });

  it("件数・種別・長さ・SHA の不一致は fail", async () => {
    const one = await archiveAndVerify(
      input(),
      deps({ listFiles: async () => [{ name: "Edinetcode.zip", kind: "file", url: "u" }] })
    );
    expect(one.ok).toBe(false);
    const ext = await archiveAndVerify(
      input(),
      deps({
        listFiles: async () => [
          { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" },
          { name: "m.json", kind: "external", url: "https://hosted.invalid/m" },
        ],
      })
    );
    expect(ext.ok).toBe(false);
    const short = await archiveAndVerify(
      input(),
      deps({ download: async (url) => (url.endsWith("/z") ? ZIP.slice(0, 2) : META) })
    );
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/バイト長/);
    const sha = await archiveAndVerify(
      input(),
      deps({
        download: async (url) =>
          url.endsWith("/z") ? new Uint8Array([0x50, 0x4b, 9, 9, 9]) : META,
      })
    );
    expect(sha.ok).toBe(false);
    expect(sha.reason).toMatch(/SHA256/);
    const dl = await archiveAndVerify(
      input(),
      deps({ download: () => Promise.reject(new Error("status=500")) })
    );
    expect(dl.ok).toBe(false);
  });

  it("引数パース: 必須不足は throw、service 既定は universe", () => {
    expect(() => parseArchiveArgs(["--key=k"])).toThrow(/必須/);
    const args = parseArchiveArgs([
      "--key=k",
      "--source=s",
      "--zip=z",
      "--manifest=m",
      "--as-of=2026-06-10",
      "--completed-at=t",
    ]);
    expect(args.service).toBe("universe");
    expect(args.key).toBe("k");
  });
});
