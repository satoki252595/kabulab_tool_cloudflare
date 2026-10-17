import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { guard } from "./saved-overseas-atomic.js";
import { verifySavedHoldingsMetadata } from "../../../../src/shared/notion-archive/shareholdings.js";
import { verifySavedHoldingsSource } from "../../src/services/edinet/shareholdings.js";
import {
  assertSavedCanonicalSource,
  assertSavedSourcePageMetadata,
  assertSavedClaimsAvailable,
  reserveSavedClaims,
  runSavedOverseas,
  initialSavedSourceIds,
  parseSavedOverseasOptions,
  savedCohortSchema,
  savedReadQueries,
  type SavedOverseasItem,
} from "./saved-overseas-backfill.js";

// Membership and lineage of the accepted actual S100YKAZ saved-source migration.
const item: SavedOverseasItem = {
  stockCode: "1379",
  stockId: 1634,
  documentId: 37536,
  docId: "S100YKAZ",
  edinetCode: "E00008",
  periodEnd: "2026-03-31",
  archivePageId: "3e2d74ff-84cd-81d1-b922-f89327c510ad",
  originalManifest: "unknown",
  sourceFetchedAt: "2026-06-25T15:38:00.000+00:00",
  zipSha256: "1485895ad314b652f1cb593c4e250f4af48ca95ec7abc786bbe02add8c9a9887",
};
const args = [
  "--saved-cohort=/private/cohort.json",
  "--cohort-sha256=" + "a".repeat(64),
  "--saved-mode=prepare",
  "--after-code=START",
  "--max-targets=20",
  "--out=/private/new-output",
  "--max-seconds=900",
  "--max-notion-rps=0.4",
  "--max-http=272",
  "--max-notion=210",
  "--max-d1=42",
  "--max-response-bytes=134217728",
  "--max-request-bytes=67108864",
  "--not-after=2026-10-17T20:00:00Z",
];

describe("normal finite saved overseas entry", () => {
  it("keeps the ordinary mode explicit, rejects malformed saved flags and force/offset mixtures before IO", () => {
    expect(parseSavedOverseasOptions(["--limit=1", "--force"])).toBeNull();
    expect(parseSavedOverseasOptions(args)).toMatchObject({
      mode: "prepare",
      maxHttp: 272,
      maxNotionRps: 0.4,
    });
    for (const bad of [
      ["--saved-mode=apply"],
      ["--saved-cohort"],
      [...args, "--force"],
      [...args, "--offset=0"],
      [...args, "--max-http=1"],
      args.filter((arg) => !arg.startsWith("--cohort-sha256=")),
      args.map((arg) =>
        arg === "--saved-mode=prepare" ? "--saved-mode=apply" : arg,
      ),
    ]) {
      expect(() => parseSavedOverseasOptions(bad)).toThrow();
    }
  });
  it("rejects duplicate, unsorted, oversized and unknown cohort data rather than silently filtering it", () => {
    expect(
      savedCohortSchema.parse({
        version: 1,
        stateDir: "/private/cohort-state",
        items: [item],
      }).items[0].originalManifest,
    ).toBe("unknown");
    for (const bad of [
      [],
      [item, item],
      [{ ...item, sourceFetchedAt: null }],
      [{ ...item, extra: "unknown" }],
      Array.from({ length: 201 }, () => item),
    ])
      expect(() =>
        savedCohortSchema.parse({
          version: 1,
          stateDir: "/private/cohort-state",
          items: bad,
        }),
      ).toThrow();
  });
  it("binds every singleton and chunk by the exact SQL plus parameter pair", () => {
    const other = {
        ...item,
        stockCode: "2459",
        stockId: 2004,
        documentId: 32162,
        docId: "S100Y8DA",
      },
      cohort = {
        version: 1 as const,
        stateDir: "/private/cohort-state",
        items: [item, other],
      };
    const reads = savedReadQueries(cohort),
      pairs = new Set(reads.map((value) => JSON.stringify(value)));
    for (const table of [
      "core_stocks",
      "yuho_documents",
      "yuho_order_facts",
      "yuho_overseas_facts",
      "yuho_text_sections",
      "p_yuho_growth",
    ]) {
      for (const ids of [
        [item.stockId],
        [other.stockId],
        [item.stockId, other.stockId],
      ]) {
        expect(
          reads.some(
            (read) =>
              read.sql.startsWith(`SELECT * FROM ${table} `) &&
              JSON.stringify(read.params) === JSON.stringify(ids),
          ),
        ).toBe(true);
      }
    }
    const singleton = reads.find(
      (read) =>
        read.sql.startsWith("SELECT * FROM core_stocks ") &&
        read.params.length === 1,
    )!;
    expect(pairs.has(JSON.stringify({ ...singleton, params: [1] }))).toBe(
      false,
    );
    expect(
      pairs.has(JSON.stringify({ ...singleton, sql: singleton.sql + " " })),
    ).toBe(false);
  });
  it("accepts only the actual typed-first same-ZIP same-clock lineage, and preserves original unknown", () => {
    const data = {
      docID: item.docId,
      edinetCode: item.edinetCode,
      secCode: "13790",
      periodEnd: item.periodEnd,
      edinetDocType: 1,
      sourceLegacyPageId: item.archivePageId,
      _fileManifest: { files: [{ sha256: item.zipSha256 }] },
    };
    const source = (metadata: unknown, clock = item.sourceFetchedAt) => ({
      object: "page" as const,
      id: "3fbd74ff-84cd-814d-8c11-c7427ccab9d4",
      parent: {
        type: "database_id" as const,
        database_id: "3e2d74ff-84cd-81d1-b922-f89327c510ad",
      },
      archived: false,
      in_trash: false,
      last_edited_time: "2026-10-16T15:14:00.000Z",
      properties: {
        Metadata: {
          type: "rich_text",
          rich_text: [
            {
              type: "text",
              plain_text: JSON.stringify(metadata),
              text: { content: JSON.stringify(metadata) },
            },
          ],
        },
        "Fetched At": { date: { start: clock } },
      },
    });
    expect(() =>
      assertSavedCanonicalSource(
        item,
        source(data),
        item.zipSha256,
        item.sourceFetchedAt,
      ),
    ).not.toThrow();
    expect(item.originalManifest).toBe("unknown");
    const cohort = {
        version: 1 as const,
        stateDir: "/private/cohort-state",
        items: [item],
      },
      typed = source(data);
    const scope = initialSavedSourceIds(cohort, [
      {
        item,
        sourcePage: typed,
        archivePageId: typed.id,
        zipSha256: item.zipSha256,
      },
    ]);
    expect(scope.has(typed.id.replaceAll("-", ""))).toBe(true);
    expect(scope.has(item.archivePageId.replaceAll("-", ""))).toBe(true);
    expect(() =>
      initialSavedSourceIds(cohort, [
        {
          item,
          sourcePage: source({ ...data, sourceLegacyPageId: typed.id }),
          archivePageId: typed.id,
          zipSha256: item.zipSha256,
        },
      ]),
    ).toThrow();
    for (const bad of [
      { ...data, sourceLegacyPageId: source(data).id },
      { ...data, docID: "S100OTHER" },
      { ...data, edinetCode: "E99999" },
      { ...data, _fileManifest: undefined },
      { ...data, _fileManifest: { files: [{ sha256: "b".repeat(64) }] } },
    ])
      expect(() =>
        assertSavedCanonicalSource(
          item,
          source(bad),
          item.zipSha256,
          item.sourceFetchedAt,
        ),
      ).toThrow();
    expect(() =>
      assertSavedCanonicalSource(
        item,
        source(data, "2026-06-25T15:39:00Z"),
        item.zipSha256,
        item.sourceFetchedAt,
      ),
    ).toThrow();
    expect(() =>
      assertSavedCanonicalSource(
        item,
        source(data),
        "b".repeat(64),
        item.sourceFetchedAt,
      ),
    ).toThrow();
  });
  it("admits actual S100XUO9 missing issuer/FY metadata through the shared contract and still requires exact official ZIP DEI", () => {
    const fixture = fileURLToPath(
        new URL(
          "../../src/tests/fixtures/saved-source-S100XUO9/",
          import.meta.url,
        ),
      ),
      proof = JSON.parse(
        readFileSync(join(fixture, "provenance.json"), "utf8"),
      ),
      pageBytes = readFileSync(join(fixture, "source-page.json")),
      source = JSON.parse(pageBytes.toString()),
      original = JSON.stringify(source),
      zip = readFileSync(join(fixture, "S100XUO9.zip")),
      sha = (bytes: Uint8Array) =>
        createHash("sha256").update(bytes).digest("hex"),
      savedItem = proof.item as SavedOverseasItem,
      official = {
        docId: savedItem.docId,
        stockCode: savedItem.stockCode,
        edinetCode: savedItem.edinetCode,
        fiscalYearEnd: savedItem.periodEnd,
      },
      metadata = JSON.parse(
        source.properties.Metadata.rich_text
          .map((part: { plain_text: string }) => part.plain_text)
          .join(""),
      );
    expect(sha(pageBytes)).toBe(proof.sourcePageProjectionSha256);
    expect(sha(zip)).toBe(savedItem.zipSha256);
    expect(zip.length).toBe(proof.zipBytes);
    expect(metadata.edinetCode).toBeUndefined();
    expect(metadata.periodEnd).toBeUndefined();
    expect(verifySavedHoldingsMetadata(metadata, official)).toEqual({
      status: "verified",
      missing: ["edinetCode", "periodEnd"],
    });
    expect(() =>
      assertSavedSourcePageMetadata(savedItem, source),
    ).not.toThrow();
    expect(() =>
      assertSavedCanonicalSource(
        savedItem,
        source,
        savedItem.zipSha256,
        savedItem.sourceFetchedAt,
      ),
    ).not.toThrow();
    expect(verifySavedHoldingsSource(zip, official)).toMatchObject({
      status: "verified",
    });
    expect(JSON.stringify(source)).toBe(original);

    // Explicitly corrupted copies of the actual page must not use nested primary as a fallback.
    for (const mutation of [
      { docID: "S100OTHER" },
      { edinetCode: "E99999" },
      { periodEnd: "2024-12-31" },
      { stockCode: "2900" },
      { rawSecCode: "29000" },
      { stockCode: undefined, rawSecCode: undefined },
    ]) {
      const changed = structuredClone(source),
        raw = JSON.stringify({ ...metadata, ...mutation });
      changed.properties.Metadata.rich_text = [
        {
          type: "text",
          plain_text: raw,
          text: { content: raw },
        },
      ];
      expect(() => assertSavedSourcePageMetadata(savedItem, changed)).toThrow();
    }
    // DEI remains mandatory when top-level metadata is absent; changing the expected issuer/FY/code fails.
    for (const mutation of [
      { edinetCode: "E99999" },
      { fiscalYearEnd: "2024-12-31" },
      { stockCode: "2900" },
    ])
      expect(() =>
        verifySavedHoldingsSource(zip, { ...official, ...mutation }),
      ).toThrow();
    const replaced = structuredClone(source);
    replaced.id = "3fbd74ff-84cd-814d-8c11-c7427ccab9d4";
    expect(() => assertSavedSourcePageMetadata(savedItem, replaced)).toThrow();
    expect(() =>
      assertSavedCanonicalSource(
        savedItem,
        source,
        "b".repeat(64),
        savedItem.sourceFetchedAt,
      ),
    ).toThrow();
    expect(() =>
      assertSavedCanonicalSource(
        savedItem,
        source,
        savedItem.zipSha256,
        "2026-10-03T09:31:00Z",
      ),
    ).toThrow();
  });
  it("full-column CAS detects null/value, omitted-column and extra-row races before DML", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE yuho_documents(id INTEGER PRIMARY KEY,stock_id INTEGER,overseas_omission_json TEXT); INSERT INTO yuho_documents VALUES(37536,1634,NULL)",
      );
      const rows = [
          { id: 37536, stock_id: 1634, overseas_omission_json: null },
        ],
        command = guard(
          "yuho_documents",
          Object.keys(rows[0]),
          "stock_id=?",
          [1634],
          rows,
        );
      expect(() =>
        db
          .prepare(command.sql)
          .all(...(command.params as Array<string | number | null>)),
      ).not.toThrow();
      db.exec("UPDATE yuho_documents SET overseas_omission_json='{}'");
      expect(() =>
        db
          .prepare(command.sql)
          .all(...(command.params as Array<string | number | null>)),
      ).toThrow();
      db.exec(
        "UPDATE yuho_documents SET overseas_omission_json=NULL; INSERT INTO yuho_documents VALUES(37537,1634,NULL)",
      );
      expect(() =>
        db
          .prepare(command.sql)
          .all(...(command.params as Array<string | number | null>)),
      ).toThrow();
      expect(() =>
        guard(
          "yuho_documents",
          Object.keys(rows[0]),
          "stock_id=?",
          [1634],
          [{ id: 37536, stock_id: 1634 }],
        ),
      ).toThrow();
    } finally {
      db.close();
    }
  });
  it("rejects the same source with a copied PRE or a new PRE/new out before any HTTP, preserving the old claim", async () => {
    const temp = realpathSync(
        mkdtempSync(join(tmpdir(), "saved-overseas-claim-")),
      ),
      stateDir = join(temp, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const cohort = { version: 1 as const, stateDir, items: [item] },
      sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex"),
      cohortPath = join(temp, "cohort.json");
    writeFileSync(cohortPath, JSON.stringify(cohort));
    const pre = {
        version: 1,
        cohortSha256: sha(readFileSync(cohortPath)),
        qualified: [{ item }],
      },
      original = gzipSync(JSON.stringify(pre)),
      originalPath = join(temp, "PRE.json.gz");
    writeFileSync(originalPath, original);
    reserveSavedClaims(cohort, {
      cohortSha256: pre.cohortSha256,
      preSha256: sha(original),
      outDir: join(temp, "original-unknown-out"),
    });
    const claimPath = join(
        stateDir,
        `${item.docId}-${item.zipSha256}.apply-claim.json`,
      ),
      claimBytes = readFileSync(claimPath),
      native = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts++;
      throw new Error("negative test must not reach HTTP");
    };
    try {
      for (const [index, capsule] of [
        original,
        gzipSync(
          JSON.stringify({ ...pre, freshReadAt: new Date().toISOString() }),
        ),
      ].entries()) {
        const capsulePath = join(temp, `new-PRE-${index}.gz`);
        writeFileSync(capsulePath, capsule);
        await expect(
          runSavedOverseas(
            {
              mode: "apply",
              cohortPath,
              cohortSha256: pre.cohortSha256,
              outDir: join(temp, `new-out-${index}`),
              capsulePath,
              capsuleSha256: sha(capsule),
              afterCode: null,
              maxTargets: 1,
              maxSeconds: 900,
              maxNotionRps: 0.4,
              maxHttp: 300,
              maxNotion: 200,
              maxD1: 50,
              maxResponseBytes: 1024 * 1024,
              maxRequestBytes: 1024 * 1024,
              notAfter: new Date(Date.now() + 3600000).toISOString(),
            },
            process.cwd(),
          ),
        ).rejects.toThrow("existing saved overseas source claim");
      }
      expect(attempts).toBe(0);
      expect(readFileSync(claimPath)).toEqual(claimBytes);
      expect(() =>
        assertSavedClaimsAvailable({
          ...cohort,
          stateDir: join(temp, "missing-state"),
        }),
      ).toThrow();
      chmodSync(stateDir, 0o755);
      expect(() => assertSavedClaimsAvailable(cohort)).toThrow();
    } finally {
      globalThis.fetch = native;
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
