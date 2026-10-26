import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
  chmodSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { sharedEnv } from "../../../../src/shared/env.js";
import { notionEnv } from "../../../../src/shared/notion-archive/env.js";
import * as notionClient from "../../../../src/shared/notion-archive/client.js";
import { guard } from "./saved-overseas-atomic.js";
import { verifySavedHoldingsMetadata } from "../../../../src/shared/notion-archive/shareholdings.js";
import { verifySavedHoldingsSource } from "../../src/services/edinet/shareholdings.js";
import {
  assertSavedCanonicalSource,
  assertSavedSourcePageMetadata,
  assertSavedClaimsAvailable,
  reserveSavedClaims,
  qualifySavedReadonlyResume,
  installSavedNativeGuard,
  runSavedOrders,
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
    expect(parseSavedOverseasOptions(args)?.ordersDocumentScope).toBeUndefined();
    expect(parseSavedOverseasOptions([...args, "--saved-orders-document-scope=historical"])?.ordersDocumentScope).toBe("historical");
    for (const bad of [
      ["--saved-mode=apply"],
      ["--saved-cohort"],
      [...args, "--force"],
      [...args, "--offset=0"],
      [...args, "--max-http=1"],
      [...args, "--saved-orders-document-scope=latest"],
      [...args, "--resume-readonly-proof=/private/proof.json"],
      [...args, "--resume-readonly-proof=/private/proof.json", "--resume-readonly-proof-sha256="+"a".repeat(64)],
      [...args, "--saved-orders-document-scope="],
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


const readonlyProofDir = join(process.cwd(), "tmp/orders-readonly-resume-proof-v1");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const finiteOptions = (cohortPath: string, outDir: string) => ({
  mode: "apply" as const, cohortPath, cohortSha256: sha256(readFileSync(cohortPath)), outDir,
  afterCode: null, maxTargets: 20, maxSeconds: 900, maxNotionRps: 0.8,
  maxHttp: 300, maxNotion: 200, maxD1: 50, maxResponseBytes: 32 * 1024 ** 2,
  maxRequestBytes: 1024 ** 2, notAfter: new Date(Date.now() + 3600000).toISOString(),
});
function isolatedSavedEnv() {
  // Protocol-only credentials never leave the intercepted native transport.
  vi.spyOn(sharedEnv, "CLOUDFLARE_ACCOUNT_ID").mockReturnValue("0".repeat(32));
  vi.spyOn(sharedEnv, "D1_DATABASE_ID").mockReturnValue(item.archivePageId);
  vi.spyOn(sharedEnv, "CLOUDFLARE_API_TOKEN").mockReturnValue("test-only-not-sent");
  vi.spyOn(notionEnv, "NOTION_TOKEN").mockReturnValue("test-only-not-sent");
  vi.spyOn(notionEnv, "NOTION_YUHO_TEXT_DB_ID").mockReturnValue(item.archivePageId);
  vi.spyOn(notionEnv, "NOTION_MAX_RPS").mockReturnValue(undefined);
}

describe("saved apply read-only admission", () => {
  it("does not burn a permanent claim when fresh PRE fails after the reported-source check", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "saved-late-claim-"))), stateDir = join(dir, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    const cohortPath = join(dir, "cohort.json"), cohort = { version: 1, stateDir, items: [item] };
    writeFileSync(cohortPath, JSON.stringify(cohort));
    const options = finiteOptions(cohortPath, join(dir, "apply"));
    const metadata = JSON.stringify({docID:item.docId,edinetCode:item.edinetCode,secCode:`${item.stockCode}0`,periodEnd:item.periodEnd});
    const sourcePage={id:item.archivePageId,properties:{Metadata:{type:"rich_text",rich_text:[{type:"text",plain_text:metadata,text:{content:metadata}}]},"Fetched At":{date:{start:item.sourceFetchedAt}}}};
    const capsulePath = join(dir, "PRE.gz"), capsule = gzipSync(JSON.stringify({version:1, cohortSha256:options.cohortSha256, qualified:[{item,sourcePage,archivePageId:item.archivePageId,zipSha256:item.zipSha256}]}));
    writeFileSync(capsulePath, capsule);
    const native = globalThis.fetch;
    let requests = 0;
    isolatedSavedEnv();
    vi.spyOn(notionClient, "setNotionMaxRps").mockImplementation(() => {});
    globalThis.fetch = async () => {
      requests++;
      if (requests > 1) throw new Error("declared fresh-schema failure, no external IO");
      return Response.json({success:true,result:[{success:true,results:[],meta:{rows_read:0,rows_written:0,changed_db:false}}]});
    };
    try {
      await expect(runSavedOverseas({...options,capsulePath,capsuleSha256:sha256(capsule)}, process.cwd())).rejects.toThrow();
      expect(requests).toBe(2);
      expect(readdirSync(stateDir).length).toBe(0);
      expect(JSON.parse(readFileSync(join(options.outDir, "STOP.json"), "utf8")).phase).toBe("fresh PRE");
    } finally { globalThis.fetch = native; vi.restoreAllMocks(); rmSync(dir,{recursive:true,force:true}); }
  });

  it("durably captures read429 then uses shared retry, honors singleAttempt, and never retries a mutation or D1 failure", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "saved-read429-"))), cohortPath = join(dir, "cohort.json");
    const cohort = {version:1 as const,stateDir:dir,items:[item]};
    writeFileSync(cohortPath, JSON.stringify(cohort));
    const native = globalThis.fetch;
    isolatedSavedEnv();
    let io: ReturnType<typeof installSavedNativeGuard> | undefined;
    try {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts === 1) return Response.json({object:"error",code:"rate_limited"},{status:429,headers:{"Retry-After":"0"}});
        expect(existsSync(join(dir,"native-1-response.body"))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir,"native-1-response.json"),"utf8")).status).toBe(429);
        return Response.json({object:"page",id:item.archivePageId});
      };
      io = installSavedNativeGuard(finiteOptions(cohortPath,dir),cohort,dir,null,"overseas");
      await notionClient.notionRequest("GET",`/pages/${item.archivePageId}`);
      expect(attempts).toBe(2); expect(io.counts.notion).toBe(2);
      io.restore(); io = undefined;
      for (const [index, mutation] of [false,true].entries()) {
        const out = join(dir,`rejection-${index}`); mkdirSync(out,{mode:0o700}); attempts=0;
        globalThis.fetch=async()=>{attempts++;return Response.json({object:"error",code:"rate_limited"},{status:429,headers:{"Retry-After":"0"}});};
        io=installSavedNativeGuard(finiteOptions(cohortPath,out),cohort,out,null,"overseas");
        await expect(notionClient.notionRequest(mutation?"PATCH":"GET",`/pages/${item.archivePageId}`,undefined,{singleAttempt:true})).rejects.toThrow();
        expect(attempts).toBe(mutation?0:1); // Unarmed mutation fails before transport.
        io.restore(); io=undefined;
      }
      const out=join(dir,"d1-rejection");mkdirSync(out,{mode:0o700});attempts=0;
      globalThis.fetch=async()=>{attempts++;return Response.json({success:false},{status:429});};
      io=installSavedNativeGuard(finiteOptions(cohortPath,out),cohort,out,null,"overseas");
      const q=savedReadQueries(cohort)[0];
      await expect(fetch(`https://api.cloudflare.com/client/v4/accounts/${"0".repeat(32)}/d1/database/${item.archivePageId}/query`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(q)})).rejects.toThrow();
      expect(attempts).toBe(1);
    } finally { io?.restore(); globalThis.fetch=native; vi.restoreAllMocks(); rmSync(dir,{recursive:true,force:true}); }
  });

  it.skipIf(!existsSync(join(readonlyProofDir,"FILES.private.json")))("directly verifies the actual39 read pairs and11 claims, rejects incomplete/unknown/wrong bindings, and burns resume once before HTTP", async () => {
    const dir=realpathSync(mkdtempSync(join(tmpdir(),"saved-actual39-")));
    let failure: string | undefined;
    const native=globalThis.fetch;
    try {
      const bindingBytes=readFileSync(join(readonlyProofDir,"APPLY-STOP-NATIVE-CLAIM-BINDING.private.json"));
      expect(sha256(bindingBytes)).toBe("045e5c73a1e2344246f9d31ff130e29d9356a38d3a480c094d7ebf8541143c5f");
      const proof=JSON.parse(bindingBytes.toString()), index=JSON.parse(readFileSync(join(readonlyProofDir,"FILES.private.json"),"utf8")) as Array<{path:string;sha256:string;bytes:number;localPath:string}>;
      expect(index.length).toBe(175);
      const control=join(dir,"old"), oldOut=join(control,"apply-v1"), stateDir=join(dir,"state");
      for(const path of [control,oldOut,stateDir])mkdirSync(path,{mode:0o700});
      const oldRemote=JSON.parse(readFileSync(index.find(ref=>ref.path.endsWith("/attempt-once.json"))!.localPath,"utf8")).options.outDir as string;
      const pathMap=new Map(index.map(ref=>[ref.path,join(ref.path.includes(".apply-claim.json")?stateDir:ref.path.startsWith(oldRemote+"/")?oldOut:control,basename(ref.path))]));
      for(const ref of index){const bytes=readFileSync(ref.localPath);expect(bytes.length===ref.bytes&&sha256(bytes)===ref.sha256,"private native transfer hash").toBe(true);writeFileSync(pathMap.get(ref.path)!,bytes,{mode:0o600,flag:"wx"});}
      const cohort=JSON.parse(readFileSync(join(readonlyProofDir,"COHORT11.private.json"),"utf8"));cohort.stateDir=stateDir;
      const cohortPath=join(dir,"cohort.json");writeFileSync(cohortPath,JSON.stringify(cohort),{mode:0o600});
      const options=finiteOptions(cohortPath,join(dir,"new-out"));
      const capsule=JSON.parse(gunzipSync(readFileSync(join(readonlyProofDir,"remote-PRE-capsule.json.gz"))).toString());capsule.cohortSha256=options.cohortSha256;
      const capsulePath=join(dir,"PRE.gz"), capsuleBytes=gzipSync(JSON.stringify(capsule));writeFileSync(capsulePath,capsuleBytes,{mode:0o600});
      const preSha=sha256(capsuleBytes), attemptPath=join(oldOut,"attempt-once.json"), attempt=JSON.parse(readFileSync(attemptPath,"utf8"));
      Object.assign(options,{afterCode:attempt.options.afterCode,maxTargets:attempt.options.maxTargets});
      Object.assign(attempt.options,{cohortPath,cohortSha256:options.cohortSha256,capsulePath,capsuleSha256:preSha,outDir:oldOut});writeFileSync(attemptPath,JSON.stringify(attempt));
      for(const ref of proof.claims){const path=pathMap.get(ref.path)!,claim=JSON.parse(readFileSync(path,"utf8"));Object.assign(claim,{outDir:oldOut,cohortSha256:options.cohortSha256,preSha256:preSha});writeFileSync(path,JSON.stringify(claim));}
      const updateRef=(ref:{path:string;sha256:string;bytes:number})=>{ref.path=pathMap.get(ref.path)!;const bytes=readFileSync(ref.path);ref.sha256=sha256(bytes);ref.bytes=bytes.length;};
      for(const ref of [...proof.claims,...proof.records,...proof.native.flatMap((row:{intent:object;requestBody:object;responseMetadata:object;responseBody:object})=>[row.intent,row.requestBody,row.responseMetadata,row.responseBody])])updateRef(ref);
      const proofPath=join(dir,"readonly-proof.json");
      const saveProof=()=>{const bytes=Buffer.from(JSON.stringify(proof));writeFileSync(proofPath,bytes,{mode:0o600});return {...options,capsulePath,capsuleSha256:preSha,resumeReadonlyProofPath:proofPath,resumeReadonlyProofSha256:sha256(bytes)};};
      let admitted=saveProof();
      const d1url=new URL(JSON.parse(readFileSync(proof.native[0].intent.path,"utf8")).url);
      isolatedSavedEnv();
      vi.spyOn(sharedEnv,"CLOUDFLARE_ACCOUNT_ID").mockReturnValue(d1url.pathname.split("/")[4]);
      vi.spyOn(sharedEnv,"D1_DATABASE_ID").mockReturnValue(d1url.pathname.split("/")[7]);
      vi.spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(new Error("declared closed prior PID"),{code:"ESRCH"});});
      expect(qualifySavedReadonlyResume(admitted,cohort).claims.length).toBe(11);
      const rejected=(value:Parameters<typeof qualifySavedReadonlyResume>[0],label:string)=>{let refused=false;try{qualifySavedReadonlyResume(value,cohort);}catch{refused=true;}expect(refused,label).toBe(true);};
      for(const change of [{cohortSha256:"f".repeat(64)},{capsuleSha256:"f".repeat(64)},{afterCode:"1911"},{maxTargets:10},{ordersDocumentScope:"historical" as const}])rejected({...admitted,...change},"wrong prior binding");
      const faultFile=(ref:{path:string;sha256:string;bytes:number},change:(value:Record<string,unknown>)=>void,label:string)=>{
        const original=readFileSync(ref.path);changeFile(JSON.parse(original.toString()));
        function changeFile(value:Record<string,unknown>){change(value);const bytes=Buffer.from(JSON.stringify(value));writeFileSync(ref.path,bytes);ref.sha256=sha256(bytes);ref.bytes=bytes.length;}
        rejected(saveProof(),label);writeFileSync(ref.path,original);ref.sha256=sha256(original);ref.bytes=original.length;admitted=saveProof();
      };
      const responseRef=proof.native[0].responseMetadata,responseOriginal=readFileSync(responseRef.path);
      const changedResponse=JSON.parse(responseOriginal.toString());changedResponse.kind="d1_batch";
      writeFileSync(responseRef.path,JSON.stringify(changedResponse));responseRef.sha256=sha256(readFileSync(responseRef.path));responseRef.bytes=readFileSync(responseRef.path).length;
      faultFile(proof.native[0].intent,v=>{v.kind="d1_batch";},"write intent rejected even with matched request/response kinds and fresh declared hashes");
      writeFileSync(responseRef.path,responseOriginal);responseRef.sha256=sha256(responseOriginal);responseRef.bytes=responseOriginal.length;admitted=saveProof();
      faultFile(proof.records.find((ref:{path:string})=>ref.path.endsWith("APPLY-EXIT.private.json")),v=>{v.exitCode=null;},"unknown terminal rejected");
      const response=proof.native.at(-1).responseMetadata, body=readFileSync(response.path);rmSync(response.path);rejected(admitted,"missing response rejected");writeFileSync(response.path,body,{mode:0o600});
      const partial=join(oldOut,"native-40-response-partial.body");writeFileSync(partial,"",{mode:0o600});rejected(admitted,"partial journal rejected");rmSync(partial);
      const oldHashes=index.map(ref=>sha256(readFileSync(pathMap.get(ref.path)!)));
      vi.spyOn(notionClient,"setNotionMaxRps").mockImplementation(()=>{});
      let attempts=0;globalThis.fetch=async()=>{attempts++;expect(existsSync(join(oldOut,"readonly-resume-once.json"))).toBe(true);throw new Error("declared unknown resumed native read");};
      await expect(runSavedOrders(admitted,process.cwd())).rejects.toThrow();expect(attempts).toBe(1);
      expect(index.every((ref,i)=>sha256(readFileSync(pathMap.get(ref.path)!))===oldHashes[i]),"all old receipts and permanent claims remain immutable").toBe(true);
      rejected({...admitted,outDir:join(dir,"another-out")},"one-use marker rejects a new-out bypass after unknown");
      expect(existsSync(join(options.outDir,"STOP.json"))).toBe(true);
    } catch(error) {
      const bytes=Buffer.from(error instanceof Error?error.stack!:String(error));failure=sha256(bytes);
      writeFileSync(join(readonlyProofDir,"REGRESSION-ERROR.private.txt"),bytes,{mode:0o600});
    } finally {globalThis.fetch=native;vi.restoreAllMocks();rmSync(dir,{recursive:true,force:true});}
    expect(failure,"actual39/11 replay failed; full private cause saved, SHA only").toBeUndefined();
  });
});
