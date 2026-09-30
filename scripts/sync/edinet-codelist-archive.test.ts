import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveAndVerify,
  parseArchiveArgs,
  type ArchiveDeps,
  type ArchiveInput,
} from "./edinet-codelist-archive.js";

const ZIP = new Uint8Array([0x50, 0x4b, 1, 2, 3]);
const META = new Uint8Array([0x7b, 0x7d]);
const PAGE_ID = "page-1";

function input(): ArchiveInput {
  return {
    key: "edinet-codelist-2026-06-10-abc",
    source: "https://example.invalid/codelist/Edinetcode.zip",
    service: "universe",
    zipName: "Edinetcode.zip",
    zipBytes: ZIP,
    manifestName: "m.json",
    manifestBytes: META,
    metadata: { asOf: "2026-06-10" },
  };
}

interface HostedFile {
  name: string;
  kind: "file" | "external";
  url: string;
}

/** 実 shared verifier の transport だけを stub する (page GET + hosted DL)。 */
function stubTransport(files: HostedFile[], bodies: Map<string, Uint8Array>): void {
  vi.stubGlobal(
    "fetch",
    async (url: unknown) => {
      const u = String(url);
      if (u === `https://api.notion.com/v1/pages/${PAGE_ID}`) {
        return Response.json({
          properties: {
            Files: {
              type: "files",
              files: files.map((f) =>
                f.kind === "file"
                  ? { name: f.name, type: "file", file: { url: f.url } }
                  : { name: f.name, type: "external", external: { url: f.url } }
              ),
            },
          },
        });
      }
      const b = bodies.get(u);
      if (!b) return new Response("not found", { status: 404 });
      return new Response(b as unknown as BodyInit, { status: 200 });
    }
  );
}

const GOOD_FILES: HostedFile[] = [
  { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" },
  { name: "m.json", kind: "file", url: "https://hosted.invalid/m" },
];
const GOOD_BODIES = new Map([
  ["https://hosted.invalid/z", ZIP],
  ["https://hosted.invalid/m", META],
]);

function deps(over: Partial<ArchiveDeps> = {}, calls: { record: number } = { record: 0 }): ArchiveDeps {
  return {
    record: (async () => {
      calls.record++;
      return { pageId: PAGE_ID, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    }) as ArchiveDeps["record"],
    findDb: async () => "db-1",
    queryUnique: async () => ({ id: PAGE_ID }),
    ...over,
  };
}

describe("edinet-codelist-archive", () => {
  beforeEach(() => {
    vi.stubEnv("NOTION_TOKEN", "test-dummy-offline");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("recorded + 実 shared 照合一致で ok (record は 1 回だけ)", async () => {
    stubTransport(GOOD_FILES, GOOD_BODIES);
    const calls = { record: 0 };
    const res = await archiveAndVerify(input(), deps({}, calls));
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.pageId).toBe(PAGE_ID);
    expect(res.outcome).toBe("recorded");
    expect(calls.record).toBe(1);
  });

  it("skipped_existing + 同 bytes の readback 一致で ok (再 POST なし)", async () => {
    stubTransport(GOOD_FILES, GOOD_BODIES);
    const calls = { record: 0 };
    const res = await archiveAndVerify(
      input(),
      deps(
        {
          record: (async () => {
            calls.record++;
            return { pageId: PAGE_ID, outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" };
          }) as ArchiveDeps["record"],
        },
        calls
      )
    );
    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(calls.record).toBe(1);
  });

  it("record 失敗・fileTooLarge は fail (writer へ進めない)", async () => {
    stubTransport(GOOD_FILES, GOOD_BODIES);
    const a = await archiveAndVerify(
      input(),
      deps({ record: (() => Promise.reject(new Error("boom"))) as ArchiveDeps["record"] })
    );
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/record 失敗/);
    const b = await archiveAndVerify(
      input(),
      deps({
        record: (async () => ({
          pageId: PAGE_ID,
          outcome: "recorded",
          fileTooLarge: true,
          manifestMatch: "written",
        })) as ArchiveDeps["record"],
      })
    );
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/fileTooLarge/);
  });

  it("unique 行なし・page 不一致・重複は fail", async () => {
    stubTransport(GOOD_FILES, GOOD_BODIES);
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

  it("同名 ZIP 重複＋manifest 欠落は verified false (件数一致のすり抜けなし)", async () => {
    stubTransport(
      [
        { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" },
        { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z2" },
      ],
      new Map([
        ["https://hosted.invalid/z", ZIP],
        ["https://hosted.invalid/z2", ZIP],
      ])
    );
    const res = await archiveAndVerify(input(), deps());
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
  });

  it("欠落・種別・長さ・SHA の不一致は fail", async () => {
    stubTransport(
      [{ name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" }],
      new Map([["https://hosted.invalid/z", ZIP]])
    );
    const one = await archiveAndVerify(input(), deps());
    expect(one.ok).toBe(false);

    stubTransport(
      [
        { name: "Edinetcode.zip", kind: "file", url: "https://hosted.invalid/z" },
        { name: "m.json", kind: "external", url: "https://hosted.invalid/m" },
      ],
      GOOD_BODIES
    );
    const ext = await archiveAndVerify(input(), deps());
    expect(ext.ok).toBe(false);

    stubTransport(GOOD_FILES, new Map([["https://hosted.invalid/z", ZIP.slice(0, 2)], ["https://hosted.invalid/m", META]]));
    const short = await archiveAndVerify(input(), deps());
    expect(short.ok).toBe(false);
    expect(short.reason).toMatch(/バイト長/);

    stubTransport(
      GOOD_FILES,
      new Map([["https://hosted.invalid/z", new Uint8Array([0x50, 0x4b, 9, 9, 9])], ["https://hosted.invalid/m", META]])
    );
    const sha = await archiveAndVerify(input(), deps());
    expect(sha.ok).toBe(false);
    expect(sha.reason).toMatch(/SHA256/);

    stubTransport(GOOD_FILES, new Map());
    const dl = await archiveAndVerify(input(), deps());
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
