/**
 * `parseStockDetail` / `collectStockDetails` (fetch-yutai-full.ts) の検証。
 * fetch しない (stub の fetcher だけ使う)。
 *
 * 固定したい契約: 権利月は h3 セクション (優待の表) ごとの「優待権利確定月」
 * span から取り、その表の優待にだけ付ける。ページ上部の valuations の union
 * を全部の表に被せない (旧形は 8022 の 3 月限定の表に 9 月行 37956 を誤合成)。
 * 表の月が無い等の未確定は `unknown` で理由つきにし、収集は import の前に
 * 止める (未確定を廃止として削除しない)。
 *
 * HTML は実物の verbatim 抜粋 (pointer は各 const の注記。私蔵 custody の
 * /tmp/c45/upstream/*.html が原本。全角空白は eslint のため \u3000 表記だが
 * 値は原文と同一)。欠落系だけ抜粋への合成変形で作る。
 */
import { describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import musashinoMetadata from "./fixtures/musashino-source-saved3.json";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ScheduledSourceDeadlineError } from "../../../../src/shared/scheduled-admission.js";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import { notionRequest } from "../../../../src/shared/notion-archive/client.js";
import { inputFingerprint } from "../../../../src/shared/notion-archive/archive.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../src/shared/notion-archive/index.js";
import {
  collectAllStockCodes,
  collectStockDetails,
  fetchStockDetail,
  main,
  parseStockDetail,
  parseStockListPage,
  parseSavedMonthScopeArgs,
  type StockDetailResult,
} from "../../data-scripts/fetch-yutai-full.js";
import { benefitRowsOf, type StockYutaiData } from "../../data-scripts/yutai-full-import.js";
import { qualifySavedMonthScopeArchive, readSavedMonthScopePage, readMonthScopeRawBytes, readMonthScopePreimage, type SavedMonthScopePage } from "../../data-scripts/saved-month-scope.js";

vi.mock("../../../../src/shared/db/d1-http-client.js", async (original) => ({
  ...await original<typeof import("../../../../src/shared/db/d1-http-client.js")>(),
  createD1HttpDb: vi.fn(() => { throw new Error("unexpected_D1"); }),
}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn(), moveToTrash: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/client.js", async original => ({
  ...await original<typeof import("../../../../src/shared/notion-archive/client.js")>(), notionRequest: vi.fn(),
}));

describe("保存月限定modeの元原本metadata資格", () => {
  const pageId = "a".repeat(32), dbId = "b".repeat(32), parentId = "c".repeat(32), filename = "yutai-source-local-clock.jsonl.gz";
  const raw: SavedMonthScopePage = { html: "", url: "https://minkabu.jp/stock/4661/yutai", receivedAt: "2026-10-22T03:04:05.123Z", batchFetchedAt: "2026-10-22T03:04:05.123Z", sha256: "a".repeat(64), compressedBytes: 1, rawBytes: 1, pages: 1 };
  const text = (value: string) => [{ type: "text", plain_text: value, text: { content: value } }];
  async function fixtures() {
    const manifest = { version: 1, files: [{ originalFilename: filename, uploadFilename: filename, originalMime: "application/gzip", uploadMime: "application/gzip", byteLength: 1, sha256: raw.sha256, upload: "uploaded" }], inputFingerprint: await inputFingerprint([{ filename, contentType: "application/gzip", byteLength: 1, sha256: raw.sha256 }]) };
    const metadata = { runId: "local-clock", pages: 1, rawBytes: 1, bytes: 1, sha256: raw.sha256, _fileManifest: manifest };
    const page = { object: "page", id: pageId, archived: false, in_trash: false, parent: { type: "database_id", database_id: dbId }, properties: {
      Key: { type: "title", title: text("yutai-source-local-clock") }, Service: { type: "select", select: { name: "otakara-yutai" } },
      Status: { type: "select", select: { name: "recorded" } }, Source: { type: "rich_text", rich_text: text("minkabu search/detail response bytes (gzip lossless)") },
      Metadata: { type: "rich_text", rich_text: text(JSON.stringify(metadata)) }, Files: { type: "files", files: [{ name: filename, type: "file", file: { url: "https://file.notion.so/unit" } }] },
      "Fetched At": { type: "date", date: { start: "2026-10-22T03:04:00.000Z" } },
    } };
    const db = { object: "database", id: dbId, archived: false, in_trash: false, parent: { type: "page_id", page_id: parentId }, title: text("一次データ｜otakara-yutai"), properties: Object.fromEntries(Object.entries(page.properties).map(([name, p]) => [name, { type: p.type }])) };
    return { page, db, metadata };
  }
  it("pageと親DBの2単発GETで資格化し、Notionの分表現と元raw時計を混同しない", async () => {
    const f = await fixtures(); vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", parentId);
    vi.mocked(notionRequest).mockReset().mockResolvedValueOnce(f.page).mockResolvedValueOnce(f.db);
    try {
      await qualifySavedMonthScopeArchive(pageId, filename, raw);
      expect(notionRequest).toHaveBeenNthCalledWith(1, "GET", `/pages/${pageId}`, undefined, { singleAttempt: true });
      expect(notionRequest).toHaveBeenNthCalledWith(2, "GET", `/databases/${dbId}`, undefined, { singleAttempt: true });
      expect(raw.batchFetchedAt).toBe("2026-10-22T03:04:05.123Z");
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["archived", "service", "status", "source", "fingerprint", "runId", "clock", "parent", "schema", "truncated"])("%sの不整合は最大2read/書込0でSTOP", async fault => {
    const f = await fixtures(); vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", parentId);
    if (fault === "archived") f.page.archived = true;
    if (fault === "service") f.page.properties.Service.select.name = "other";
    if (fault === "status") f.page.properties.Status.select.name = "obsoleted";
    if (fault === "source") f.page.properties.Source.rich_text = text("other source");
    if (fault === "fingerprint") f.metadata._fileManifest.inputFingerprint = "0".repeat(64);
    if (fault === "runId") f.metadata.runId = "other-clock";
    if (fault === "clock") f.page.properties["Fetched At"].date.start = "2026-10-22T03:05:00.000Z";
    if (fault === "parent") f.db.parent.page_id = "d".repeat(32);
    if (fault === "schema") f.db.properties.Key.type = "rich_text";
    if (fault === "truncated") Object.assign(f.page, { request_status: { type: "incomplete" } });
    f.page.properties.Metadata.rich_text = text(JSON.stringify(f.metadata));
    vi.mocked(notionRequest).mockReset().mockResolvedValueOnce(f.page).mockResolvedValueOnce(f.db);
    try { await expect(qualifySavedMonthScopeArchive(pageId, filename, raw)).rejects.toThrow(); expect(vi.mocked(notionRequest).mock.calls.length).toBeLessThanOrEqual(2); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe("保存済み月限定入力の通信前資格", () => {
  const record = (code: string, bytes: Buffer, clock: string) => ({ url: `https://minkabu.jp/stock/${code}/yutai`,
    receivedAt: clock, status: 200, contentType: "text/html; charset=utf-8", byteLength: bytes.length, bodyBase64: bytes.toString("base64") });
  const first = "2026-10-22T03:04:05.123Z", last = "2026-10-22T03:05:06.456Z";
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const input = () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "saved-month-"))), path = join(dir, "raw.gz");
    const lines = [record("4661", Buffer.from("<html>権利月</html>"), first), record("9101", Buffer.from([0xff]), last)];
    const bytes = gzipSync(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    writeFileSync(path, bytes, { mode: 0o600 }); return { dir, path, lines, bytes };
  };
  it("全gzip SHA/EOFを検証し、対象HTMLだけdecode・末尾の実batch時計を保持する", async () => {
    const f = input();
    try {
      const value = await readSavedMonthScopePage(f.path, sha(f.bytes), "4661");
      expect(value.html).toBe("<html>権利月</html>"); expect(value.receivedAt).toBe(first);
      expect(value.batchFetchedAt).toBe(last); expect(value.pages).toBe(2);
      expect(readMonthScopeRawBytes(f.path, sha(f.bytes))).toEqual(f.bytes);
      await expect(readSavedMonthScopePage(f.path, "0".repeat(64), "4661")).rejects.toThrow();
      expect(() => readMonthScopeRawBytes(f.path, "0".repeat(64))).toThrow();
      expect(() => readMonthScopePreimage(f.path, sha(f.bytes))).toThrow();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("重複code/不正bytes/欠落/未閉鎖gzip/非private/symlinkはSTOPする", async () => {
    const f = input();
    try {
      for (const lines of [[...f.lines, f.lines[0]], [{ ...f.lines[0], byteLength: 1 }], [f.lines[1]]]) {
        const bytes = gzipSync(lines.map(line => JSON.stringify(line)).join("\n") + "\n"); writeFileSync(f.path, bytes);
        await expect(readSavedMonthScopePage(f.path, sha(bytes), "4661")).rejects.toThrow();
      }
      const truncated = f.bytes.subarray(0, f.bytes.length - 8); writeFileSync(f.path, truncated);
      await expect(readSavedMonthScopePage(f.path, sha(truncated), "4661")).rejects.toThrow();
      writeFileSync(f.path, f.bytes); chmodSync(f.path, 0o644);
      await expect(readSavedMonthScopePage(f.path, sha(f.bytes), "4661")).rejects.toThrow();
      chmodSync(f.path, 0o600); const linked = join(f.dir, "link.gz"); symlinkSync(f.path, linked);
      await expect(readSavedMonthScopePage(linked, sha(f.bytes), "4661")).rejects.toThrow();
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
  it("明示mode/完全SHA/全引数を欠く入口は通信前にSTOPする", async () => {
    const args = ["--repair-month-scope", "--code=4661", "--saved-raw=/private/raw.gz", `--saved-raw-sha256=${"a".repeat(64)}`,
      `--raw-archive-page-id=${"a".repeat(32)}`, "--raw-filename=yutai-source-local-clock.jsonl.gz", "--expected-pre=/private/pre.json",
      `--expected-pre-sha256=${"b".repeat(64)}`, "--state-dir=/private/state"];
    expect(parseSavedMonthScopeArgs(args).code).toBe("4661");
    for (let i = 0; i < args.length; i++) expect(() => parseSavedMonthScopeArgs(args.filter((_, n) => n !== i))).toThrow();
    expect(() => parseSavedMonthScopeArgs([...args, "--unknown"])).toThrow();
    const reads = vi.mocked(createD1HttpDb).mock.calls.length;
    await expect(main(["--code=4661"])).rejects.toThrow();
    expect(createD1HttpDb).toHaveBeenCalledTimes(reads);
  });
});

/** 8022 valuations の union (原本 byte 66863 付近。被せてはならない decoy)。 */
const UNION8022 = `<tr>
    <th>優待権利確定月</th>
    <td id="yutai_valuations_day" class="tar">3月,9月</td>`;

/** 8022 フィッティング表 [3,9] (原本 byte 67466〜。2 列: 必要株数/備考)。 */
const FITTING8022 = `<h3 class="ulno">ミズノパフォーマンスフィッティング（ゴルフ）利用料金 無料</h3>
    <span class="flr fwb fcgl mt5"><i class="mr5 fa-solid fa-caret-right"></i>優待権利確定月：<span class="md_ico_tx theme_normal size_s">3月,9月</span></span>
  </div>
    <div class="md_table_wrapper">
      <table class="md_table vborder">
        <tbody>
          <tr>
            <th class="ly_colsize_2_fix">必要株数</th>

            <th class="ly_colsize_5_fix">備考</th>
          </tr>
          <tr>
            <td>100株以上</td>

            <td rowspan="1">■利用可能施設<br />・MIZUNO TOKYO(東京都千代田区)<br />・高島平ミズノフィッティングセンター(東京都板橋区)<br />・ミズノゴルフ淀屋橋（大阪市中央区）</td>
          </tr>
        </tbody>
      </table>`;

/** 8022 ゴルフスクール表 [3] (原本 byte 68443〜。3,300 円は入会金免除)。 */
const GOLF8022 = `<h3 class="ulno">直営ゴルフスクールの入会金 無料</h3>
    <span class="flr fwb fcgl mt5"><i class="mr5 fa-solid fa-caret-right"></i>優待権利確定月：<span class="md_ico_tx theme_normal size_s">3月</span></span>
  </div>
    <div class="md_table_wrapper">
      <table class="md_table vborder">
        <tbody>
          <tr>
            <th class="ly_colsize_2_fix">必要株数</th>
            <th class="ly_colsize_5_fix">優待内容</th>
            <th class="ly_colsize_5_fix">備考</th>
          </tr>
          <tr>
            <td>100株以上</td>
            <td>3,300円相当<br />※月会費、レッスン受講料は各会場で異なります。</td>
            <td rowspan="1">■利用可能施設<br />・ミズノゴルフスタジオ\u3000ハービス店（大阪）<br />・ミズノゴルフスタジオ\u3000淀屋橋店（大阪）<br />・ミズノゴルフスタジオ\u3000心斎橋店（大阪）<br />・ミズノゴルフスクール\u3000くずは（大阪）<br />・ミズノゴルフスタジオ\u3000天神店（福岡）<br />・ミズノゴルフスタジオ\u3000新栄町店（愛知）<br />・ミズノゴルフスタジオ\u3000大曽根店（愛知）</td>
          </tr>
        </tbody>
      </table>`;

/** 3512 QUO 表 [3] (原本 byte 62281〜。3 tier。備考は rowspan で後継行に継承)。 */
const QUO3512 = `<h3 class="ulno">オリジナルQUOカード</h3>
    <span class="flr fwb fcgl mt5"><i class="mr5 fa-solid fa-caret-right"></i>優待権利確定月：<span class="md_ico_tx theme_normal size_s">3月</span></span>
  </div>
    <div class="md_table_wrapper">
      <table class="md_table vborder">
        <tbody>
          <tr>
            <th class="ly_colsize_2_fix">必要株数</th>
            <th class="ly_colsize_5_fix">優待内容</th>
            <th class="ly_colsize_5_fix">備考</th>
          </tr>
          <tr>
            <td>100株以上</td>
            <td>【1年以上保有株主】<br />300円相当<br />【3年以上保有株主】<br />600円相当</td>
            <td rowspan="3">■継続保有期間について<br />継続保有期間1年以上3年未満：毎年3月31日及び9月30日の株主名簿に同一の株主番号で3回以上7回未満連続して株主名簿に記載または記録された株主さま<br />継続保有期間3年以上：毎年3月31日及び9月30日の株主名簿に同一の株主番号で7回以上連続して株主名簿に記載または記録された株主さま<br />なお、保有株式数の確認は、優待の対象となる3月末時点で行います。<br /><br />■贈呈時期<br />毎年6月下旬</td>
          </tr>
          <tr>
            <td>300株以上</td>
            <td>【1年以上保有株主】<br />1,000円相当<br />【3年以上保有株主】<br />2,000円相当</td>
          </tr>
          <tr>
            <td>1,000株以上</td>
            <td>2,000円相当</td>
          </tr>
        </tbody>
      </table>`;

/** 2337 実応答の h3・権利月・1株表の連続抜粋。
 * source body SHA256 7ce495a76643fcef919e9d7093c043ef5018d8db96c8a43e5f1116a3123ff989
 * receivedAt 2026-10-03T22:10:31.318Z (保存原本からの抜粋、追加取得なし)。 */
const ONE_SHARE2337 = `<h3 class="ulno">「いちご THANKS!マンスリープレゼント」※抽選</h3>
    <span class="flr fwb fcgl mt5"><i class="mr5 fa-solid fa-caret-right"></i>優待権利確定月：<span class="md_ico_tx theme_normal size_s">2月,8月</span></span>
  </div>
    <div class="md_table_wrapper">
      <table class="md_table vborder">
        <tbody>
          <tr>
            <th class="ly_colsize_2_fix">必要株数</th>
            <th class="ly_colsize_5_fix">優待内容</th>
            <th class="ly_colsize_5_fix">備考</th>
          </tr>
          <tr>
            <td>1株以上</td>
            <td>◇2026年6月より12月まで毎月1回、継続して実施。当社事業で扱う農産物等をプレゼント（抽選：50名）<br /><br /></td>
            <td rowspan="1">※「いちご Thanks!応募サイト」（2026年6月1日公開）<br />https://www.ichigo-thanks.jp/<br />《案内時期》<br />中間、期末の株主通信(Business Report)とあわせて案内。<br />応募開始可能日は、対象期末時点から4か月後の月初からとなり、6か月間応募が可能です。</td>
          </tr>
        </tbody>
      </table>`;

/** 5283 実応答のh3・権利月・株数だけの表を連続抜粋。
 * source body SHA256 f2e4911dd575b69284443c2f5563b1bf118b72930dd692f562d6787a59cb622a
 * receivedAt 2026-10-04T00:24:48.222Z (保存原本からの抜粋、追加取得なし)。 */
const SHARE_ONLY5283 = `<h3 class="ulno">なめ茸「志賀の郷」</h3>
    <span class="flr fwb fcgl mt5"><i class="mr5 fa-solid fa-caret-right"></i>優待権利確定月：<span class="md_ico_tx theme_normal size_s">6月</span></span>
  </div>
    <div class="md_table_wrapper">
      <table class="md_table vborder">
        <tbody>
          <tr>
            <th class="ly_colsize_2_fix">必要株数</th>
           \u0020
           \u0020
          </tr>
          <tr>
            <td>200株以上</td>
           \u0020
           \u0020
          </tr>
        </tbody>
      </table>`;

/** ok を開く。unknown ならテストを落とす。 */
function unwrapOk(r: StockDetailResult): StockYutaiData {
  expect(r.status).toBe("ok");
  if (r.status !== "ok") throw new Error(`unexpected unknown: ${r.reason}`);
  return r.data;
}

describe("parseStockDetail は表ローカル月を優待に付ける", () => {
  // 保存原本で観測した全文セル2形。既存の実HTML抜粋へのセル差替えだけで
  // table [3,9] と行自身の独立した適用月の優先境界を検証する。
  const rowMonthHtml = (description: string, months = "3月,9月") => GOLF8022
    .replace('size_s">3月</span>', `size_s">${months}</span>`)
    .replace('3,300円相当<br />※月会費、レッスン受講料は各会場で異なります。', description);

  it.each(["1,000円相当<br />（3月のみ）", "500円相当（3月のみ）"])(
    "行全体の単一額面に明示された権利月だけを投影する: %s", (description) => {
      const data = unwrapOk(parseStockDetail("8022", rowMonthHtml(description)));
      expect(data.benefits[0].description).toBe(description.replace('<br />', '\n'));
      expect(data.benefits[0].localRecordMonths).toEqual([3]);
      expect(benefitRowsOf(data).rows.map(row => row.recordMonth)).toEqual([3]);
    });

  it("正整数枚数と月限定だけの全文セルを絞り、利用・発送月や複数内容を推定しない", () => {
    // 保存4661のセル表記だけを既存HTMLの枠へ入れた合成対照。原本全文はprivate。
    for (const month of [3, 9]) {
      const description = `1枚※${month}月のみ`;
      const data = unwrapOk(parseStockDetail("8022", rowMonthHtml(description)));
      expect(data.benefits[0].description).toBe(description);
      expect(data.benefits[0].localRecordMonths).toEqual([month]);
      expect(benefitRowsOf(data).rows.map(row => row.recordMonth)).toEqual([month]);
    }
    expect(parseStockDetail("8022", rowMonthHtml("1枚※3月のみ", "2月")).status).toBe("unknown");
    for (const description of ["1枚※3月のみ利用", "1枚※3月のみ発送", "1枚※3月のみ<br />2枚※9月のみ", "1枚※3月のみ)"]) {
      expect(unwrapOk(parseStockDetail("8022", rowMonthHtml(description))).benefits[0].localRecordMonths).toEqual([3, 9]);
    }
  });

  it.each([
    "1,000円相当（3月のみ利用）", "1,000円相当（3月のみ開催）",
    "1,000円相当（3月のみ申込）", "1,000円相当（3月のみ発送）",
    "1,000円相当（3月のみ）<br />500円相当（9月のみ）",
    "1,000円相当（3月のみ）または500円相当", "1,000円相当（3月・9月のみ）",
  ])("利用時期・複数額面・複数期間から権利月を推定しない: %s", (description) => {
    const data = unwrapOk(parseStockDetail("8022", rowMonthHtml(description)));
    expect(data.benefits[0].localRecordMonths).toEqual([3, 9]);
  });

  it.each(["2月", "随時", "随時,3月"])("行の月とtable scopeが矛盾すれば止める: %s", (months) => {
    expect(parseStockDetail("8022", rowMonthHtml("1,000円相当（3月のみ）", months)).status).toBe("unknown");
  });

  it("8022: union decoy を無視し、表ごとに [3,9] / [3] を付ける", () => {
    const data = unwrapOk(parseStockDetail("8022", `${UNION8022}\n${FITTING8022}\n${GOLF8022}`));
    expect(data.code).toBe("8022");
    expect(data.benefits.map((b) => [b.heading, b.minShares, b.localRecordMonths])).toEqual([
      ["ミズノパフォーマンスフィッティング（ゴルフ）利用料金 無料", 100, [3, 9]],
      ["直営ゴルフスクールの入会金 無料", 100, [3]],
    ]);
    // ゴルフ表の文言は原文のまま (3,300 円は入会金免除の表記)。
    expect(data.benefits[1].description).toBe("3,300円相当\n※月会費、レッスン受講料は各会場で異なります。");
    expect(data.benefits[1].notes).toContain("■利用可能施設");
  });

  it("2337: 明記された1株以上の原月・本文を採用し、0株と安全整数外は止める", () => {
    const data = unwrapOk(parseStockDetail("2337", ONE_SHARE2337));
    expect(data.benefits).toEqual([{
      minShares: 1,
      localRecordMonths: [2, 8],
      description: "◇2026年6月より12月まで毎月1回、継続して実施。当社事業で扱う農産物等をプレゼント（抽選：50名）",
      notes: "※「いちご Thanks!応募サイト」（2026年6月1日公開）\nhttps://www.ichigo-thanks.jp/\n《案内時期》\n中間、期末の株主通信(Business Report)とあわせて案内。\n応募開始可能日は、対象期末時点から4か月後の月初からとなり、6か月間応募が可能です。",
      heading: "「いちご THANKS!マンスリープレゼント」※抽選",
    }]);
    for (const shares of ["0", "9007199254740992", "0.5", "-1", "1,2", "1,,000"]) {
      expect(parseStockDetail("2337", ONE_SHARE2337.replace("1株以上", `${shares}株以上`))).toEqual({
        status: "unknown", code: "2337", reason: "invalid-min-shares",
      });
    }
  });

  it("3512: 単一表の全 tier に [3] を付け、rowspan 備考を継承する", () => {
    const data = unwrapOk(parseStockDetail("3512", QUO3512));
    expect(data.benefits.map((b) => [b.minShares, b.localRecordMonths])).toEqual([
      [100, [3]],
      [300, [3]],
      [1000, [3]],
    ]);
    expect(data.benefits[0].description).toContain("300円相当");
    // 300 株・1000 株の行に備考セルは無い (rowspan)。直前の備考を継承する。
    expect(data.benefits[1].notes).toContain("■継続保有期間について");
    expect(data.benefits[2].notes).toContain("■贈呈時期");
    expect(data.benefits[2].description).toBe("2,000円相当");
  });

  it("5283: 株数だけの公式表は明記された見出しを優待内容として取り込む", () => {
    expect(unwrapOk(parseStockDetail("5283", SHARE_ONLY5283)).benefits).toEqual([{
      minShares: 200, description: "なめ茸「志賀の郷」", notes: "",
      localRecordMonths: [6], heading: "なめ茸「志賀の郷」",
    }]);
    for (const invalid of [
      SHARE_ONLY5283.replace('なめ茸「志賀の郷」</h3>', '</h3>'),
      SHARE_ONLY5283.replace('<td>200株以上</td>', '<td>200株以上</td><td>内容不明</td>'),
      SHARE_ONLY5283.replace('200株以上', '条件不明'),
      SHARE_ONLY5283.replace('必要株数</th>', '必要株数</th><th>優待内容</th>'),
      SHARE_ONLY5283.replace('<th class="ly_colsize_2_fix">必要株数</th>', '<td>必要株数</td>'),
      SHARE_ONLY5283.replace(/優待権利確定月：<span[^>]*>[^<]+<\/span>/, ''),
    ]) expect(parseStockDetail("5283", invalid).status).toBe("unknown");
  });

  it("明記された随時だけを専用enumへ取り込み、他表の実月・本文は保持する", () => {
    // 表の時期だけを実観測した「随時」へ変えた契約回帰。
    const anytime = GOLF8022.replace('size_s">3月</span>', 'size_s">随時</span>');
    const data = unwrapOk(parseStockDetail("8022", `${FITTING8022}\n${anytime}`));
    expect(data.benefits.map(b => b.localRecordMonths)).toEqual([[3, 9], [0]]);
    expect(data.benefits[1].description).toBe(unwrapOk(parseStockDetail("8022", GOLF8022)).benefits[0].description);
    for (const unknown of ["未定", "随時,3月"]) {
      expect(parseStockDetail("8022", anytime.replace("随時</span>", `${unknown}</span>`)).status).toBe("unknown");
    }
  });

  it("表があるのに月 span が無いセクションは unknown (推測しない)", () => {
    const noSpan = GOLF8022.replace(/優待権利確定月：<span[^>]*>[^<]+<\/span>/, "");
    expect(parseStockDetail("8022", noSpan)).toEqual({
      status: "unknown",
      code: "8022",
      reason: "no-local-month: h3=直営ゴルフスクールの入会金 無料",
    });
  });

  it("表が無いページは unknown (100 株の仮優待を作らない)", () => {
    expect(parseStockDetail("8022", `${UNION8022}\n<h3 class="ulno">優待なし</h3>`)).toEqual({
      status: "unknown",
      code: "8022",
      reason: "no-benefit-tables",
    });
  });

  it("同一 h3 の 2 表は表ごとの直近 span が優先する (表ローカル override)", () => {
    // 合成変形: 1 つの h3 配下に 2 表。各表の直前に別の月 span を置く。
    const tableOnly = FITTING8022.slice(FITTING8022.indexOf('<div class="md_table_wrapper">'));
    const span9 = "優待権利確定月：<span>9月</span>";
    const html = `<h3 class="ulno">合成セクション</h3>\n優待権利確定月：<span>3月</span>\n${tableOnly}\n${span9}\n${tableOnly}`;
    const data = unwrapOk(parseStockDetail("9100", html));
    expect(data.benefits.map((b) => b.localRecordMonths)).toEqual([[3], [9]]);
    expect(data.benefits[0].heading).toBe("合成セクション");
  });

  it("最初の h3 より前の表は直前の span があれば表ローカルで取る", () => {
    const tableOnly = GOLF8022.slice(GOLF8022.indexOf('<div class="md_table_wrapper">'));
    const span = "優待権利確定月：<span>3月</span>";
    const data = unwrapOk(parseStockDetail("8022", `${UNION8022}\n${span}\n${tableOnly}`));
    expect(data.benefits.map((b) => [b.heading, b.localRecordMonths])).toEqual([["", [3]]]);
    expect([data.name, data.market, data.category]).toEqual([null, null, null]);
  });

  it("最初の h3 より前で span が無い優待テーブルは unknown (union 推測しない)", () => {
    const tableOnly = GOLF8022.slice(GOLF8022.indexOf('<div class="md_table_wrapper">'));
    expect(parseStockDetail("8022", `${UNION8022}\n${tableOnly}`)).toEqual({
      status: "unknown",
      code: "8022",
      reason: "no-local-month: pre-h3",
    });
  });

  it("h3 を跨いだ span は後の表に適用しない", () => {
    // span は最初の h3 の表にだけ効く。2 つ目の h3 の表には効かない。
    const tableOnly = GOLF8022.slice(GOLF8022.indexOf('<div class="md_table_wrapper">'));
    const html = `<h3 class="ulno">第一</h3>\n優待権利確定月：<span>3月</span>\n${tableOnly}\n<h3 class="ulno">第二</h3>\n${tableOnly}`;
    expect(parseStockDetail("9100", html)).toEqual({
      status: "unknown",
      code: "9100",
      reason: "no-local-month: h3=第二",
    });
  });
});

describe("collectStockDetails は unknown を import の前に止める", () => {
  const okOf = (code: string): StockDetailResult => ({
    status: "ok",
    data: {
      code,
      name: code,
      market: "東証",
      category: "株主優待",
      benefits: [{ minShares: 100, description: "x", notes: "", localRecordMonths: [3], heading: "h" }],
    },
  });

  it("全件 ok なら配列を返す", async () => {
    const fetchDetail = vi.fn(async (code: string) => okOf(code));
    const allData = await collectStockDetails(["9100", "9101"], fetchDetail);
    expect(allData.map((d) => d.code)).toEqual(["9100", "9101"]);
    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it("実形の月無し表は parse が unknown にし、収集がコード・理由つきで止める (import 0 回)", async () => {
    // 実抜粋から span だけ落とした月無し表 (合成変形は span の削除のみ)。
    const noSpan = GOLF8022.replace(/優待権利確定月：<span[^>]*>[^<]+<\/span>/, "");
    const htmlByCode: Record<string, string> = { "9100": QUO3512, "9101": noSpan };
    const fetchDetail = async (code: string) => parseStockDetail(code, htmlByCode[code]);
    const fakeImport = vi.fn(async (_allData: StockYutaiData[]) => {});
    // main と同じ順序: 収集 → (成功時のみ) import。
    const runFlow = async () => {
      const allData = await collectStockDetails(["9100", "9101"], fetchDetail);
      await fakeImport(allData);
    };
    await expect(runFlow()).rejects.toThrow(/未確定 \(UNKNOWN\) が 1 件/);
    await expect(runFlow()).rejects.toThrow(/9101 \(no-local-month/);
    expect(fakeImport).not.toHaveBeenCalled();
  });

  it("取得失敗の unknown も落とさず止める", async () => {
    const fetchDetail = vi.fn(async (code: string): Promise<StockDetailResult> =>
      code === "9101" ? { status: "unknown", code, reason: "fetch: HTTP 429" } : okOf(code));
    await expect(collectStockDetails(["9100", "9101", "9102"], fetchDetail)).rejects.toThrow(/9101 \(fetch: HTTP 429\)/);
    expect(fetchDetail.mock.calls.map(([code]) => code)).toEqual(["9100", "9101"]);
  });

  it("HTTP429も同じ応答bytesを原本captureへ渡し、再送しない", async () => {
    const bytes = new Uint8Array([0, 255, 10, 13]);
    const fetched = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes, { status: 429 }));
    const capture = vi.fn();
    try {
      expect(await fetchStockDetail("9100", capture)).toMatchObject({ status: "unknown", code: "9100" });
      expect(fetched).toHaveBeenCalledTimes(1);
      expect(capture).toHaveBeenCalledTimes(1);
      const raw = capture.mock.calls[0][0] as { bodyBase64: string; byteLength: number; status: number };
      expect(Buffer.from(raw.bodyBase64, "base64")).toEqual(Buffer.from(bytes));
      expect(raw).toMatchObject({ byteLength: bytes.length, status: 429 });
    } finally { fetched.mockRestore(); }
  });

  it("native source停止は通信UNKNOWNへ変換せず、個別GETとcaptureを始めない", async () => {
    const fetched = vi.spyOn(globalThis, "fetch"), capture = vi.fn();
    const stopped = new ScheduledSourceDeadlineError("source stop");
    try {
      await expect(fetchStockDetail("9100", capture, () => { throw stopped; })).rejects.toBe(stopped);
      expect(fetched).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally { fetched.mockRestore(); }
  });
});

describe("collectAllStockCodes は既知の最終ページだけで完了する", () => {
  // 2026-10-03取得原本の yutai_search / cont_search / pagination 構造。
  // 境界ケースはページ番号・銘柄リンク・総数だけを変形する。
  const pageWith = (page: number, next: number | null, ...codes: string[]) =>
    `<div id= "yutai_search" class="result ly_content_wrapper"><h2>検索結果</h2>全2件
      <div class="md_box md_card cont_search clearfix"><ul class="md_list">` +
    codes.map((c) => `<li class="yutai_rank_style"><a href="/stock/${c}/yutai" class="empty_link_area"></a></li>`).join("\n") +
    `</ul></div><div class="paginate_box ui-paginate-box"><span class="current">${page}</span>` +
    (next === null ? `<span class="disabled next_page">次へ&nbsp;»</span>` :
      `<a class="next_page" rel="next" href="/yutai/search?order=&amp;page=${next}">次へ&nbsp;»</a>`) +
    `</div></div>`;

  it("最終disabled next_pageで止まり、一覧外の推薦リンクと次の404を取得しない", async () => {
    const fetcher = vi.fn(async (page: number) => {
      if (page === 3) throw new Error("HTTP 404");
      return pageWith(page, page === 1 ? 2 : null, page === 1 ? "9101" : "130A") +
        `<a href="/stock/9100/yutai">推薦欄</a>`;
    });
    expect(await collectAllStockCodes(fetcher)).toEqual(["130A", "9101"]);
    expect(fetcher.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  it("default入口もmainと同じ公式の空sort optionを全ページで保持する", async () => {
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      return new Response(pageWith(page, page === 1 ? 2 : null, page === 1 ? "9101" : "130A"));
    });
    try {
      expect(await collectAllStockCodes()).toEqual(["130A", "9101"]);
      expect(fetched.mock.calls.map(([url]) => url)).toEqual([
        "https://minkabu.jp/yutai/search?order=&page=1",
        "https://minkabu.jp/yutai/search?order=&page=2",
      ]);
    } finally { fetched.mockRestore(); }
  });

  it("取得失敗は部分リストを返さず止める (404も空ページ扱いにしない)", async () => {
    const fetchListPage = vi.fn(async (page: number) => {
      if (page === 2) throw new Error("HTTP 404");
      return pageWith(1, 2, "9100");
    });
    await expect(collectAllStockCodes(fetchListPage)).rejects.toThrow(/page=2.*部分リストを完成扱い・キャッシュしません/);
    expect(fetchListPage).toHaveBeenCalledTimes(2);
  });

  it("ページ引数を無視した銘柄集合重複では取得を続けない", async () => {
    const fetchListPage = vi.fn(async (page: number) => pageWith(page, page + 1, "9100"));
    await expect(collectAllStockCodes(fetchListPage)).rejects.toThrow(/重複/);
    expect(fetchListPage).toHaveBeenCalledTimes(2);
  });

  it("総カード数が一致してもページ間の部分重複による一意集合不足を完成扱いにしない", async () => {
    const fetcher = vi.fn(async (page: number) =>
      pageWith(page, page === 1 ? 2 : null, ...(page === 1 ? ["9100", "9101"] : ["9101", "130A"]))
        .replace("全2件", "全4件"));
    await expect(collectAllStockCodes(fetcher)).rejects.toThrow(/全件数と銘柄集合が一致しない/);
    expect(fetcher.mock.calls.map(([page]) => page)).toEqual([1, 2]);
  });

  it("検索トップ・欠落したpager・不一致のcurrent/next/総数はUNKNOWNとして止める", async () => {
    const valid = pageWith(1, 2, "9100");
    const malformed = [
      `<a href="/stock/9100/yutai">推薦リンクだけの検索トップ</a>`,
      valid.replace(/<div class="paginate_box[\s\S]*?<\/div>/, ""),
      valid.replace('class="current">1', 'class="current">2'),
      valid.replace('&amp;page=2', '&amp;page=3'),
      valid.replace(/<a class="next_page"[\s\S]*?<\/a>/, ""),
      valid.replace('order=&amp;page=2', 'page=2'),
      valid.replace('order=&amp;', 'order=yutai_yield_desc&amp;'),
      valid.replace('&amp;page=2', '&amp;page=2&amp;page=2'),
      valid.replace('order=&amp;', 'order=&amp;order=&amp;'),
      valid.replace('&amp;page=2', '&amp;page=2&amp;keyword=other'),
      valid.replace('/yutai/search?order=', 'https://example.org/yutai/search?order='),
    ];
    for (const html of malformed) {
      const fetcher = vi.fn(async () => html);
      await expect(collectAllStockCodes(fetcher)).rejects.toThrow(/STOP/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(() => parseStockListPage(pageWith(1, null, "9100"), 1)).not.toThrow();
    await expect(collectAllStockCodes(async () => pageWith(1, null, "9100"))).rejects.toThrow(/全件数/);
  });

  it.skipIf(!existsSync(join(ROOT, musashinoMetadata.privateFixtureDir, "official-8336.pdf")))("8336公式実体添付と新3本文の照合前には通常取込へ進まない（private制御）", async () => {
    const fixture = join(ROOT, musashinoMetadata.privateFixtureDir);
    const packet = JSON.parse(readFileSync(join(fixture, "SAVED-SOURCE-PACKET.private.json"), "utf8")) as { pages: { url: string; contentType: string; bodyBase64: string }[] };
    const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "musashino-collector-"));
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      if (url === "https://minkabu.jp/yutai/search?order=&page=1") return new Response(pageWith(1, null, "8336").replace("全2件", "全1件"));
      const page = packet.pages.find(page => page.url === url);
      if (page === undefined) throw new Error("unexpected_source_request");
      return new Response(Buffer.from(page.bodyBase64, "base64"), { headers: { "Content-Type": page.contentType } });
    });
    vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "controlled-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
    vi.mocked(verifyArchivedAttachments).mockImplementation(async (_id, _files, label) => { if (label === "8336公式原本と提供元") throw new Error("controlled_archive_stop"); });
    try {
      process.chdir(dir);
      await expect(main()).rejects.toThrow("controlled_archive_stop");
      expect(fetched).toHaveBeenCalledTimes(4); expect(createD1HttpDb).not.toHaveBeenCalled();
      expect(recordPrimaryData).toHaveBeenCalledTimes(2);
      const base = vi.mocked(recordPrimaryData).mock.calls[0][0], adopted = vi.mocked(recordPrimaryData).mock.calls[1][0];
      const raw = gunzipSync(base.files![0].bytes).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(raw.map((page: { url: string }) => page.url)).toEqual(["https://minkabu.jp/yutai/search?order=&page=1", packet.pages[0].url]);
      expect(adopted.files).toHaveLength(3);
      for (const [index, file] of adopted.files!.entries()) expect(Buffer.from(file.bytes)).toEqual(Buffer.from(packet.pages[index].bodyBase64, "base64"));
      expect(adopted.metadata).toMatchObject({ adoption: "full_source_qualified", providerArchive: { key: base.key, sha256: createHash("sha256").update(base.files![0].bytes).digest("hex") }, rows: musashinoMetadata.expectedRows });
      expect(verifyArchivedAttachments).toHaveBeenCalledWith("controlled-page", adopted.files, "8336公式原本と提供元");
    } finally { process.chdir(cwd); fetched.mockRestore(); vi.clearAllMocks(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("次GET失敗より先に原本をprivate保存し、終端stream gzipは全bytesを保管してD1へ進まない", async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), "yutai-source-unit-"));
    const rawDir = join(dir, "services/otakara-yutai/data-scripts/data/raw");
    const first = Buffer.from(pageWith(1, 2, "9100") + "\n\0");
    const failed = Buffer.from([0, 255, 10, 13]);
    let calls = 0;
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      if (++calls === 1) return new Response(first);
      const path = join(rawDir, readdirSync(rawDir).find(name => name.endsWith(".jsonl"))!);
      expect(statSync(rawDir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(path, "utf8").trim());
      expect(Buffer.from(saved.bodyBase64, "base64")).toEqual(first);
      return new Response(failed, { status: 429 });
    });
    vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "unit-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
    vi.mocked(verifyArchivedAttachments).mockResolvedValue();
    try {
      process.chdir(dir);
      await expect(main()).rejects.toThrow(/page=2/);
      expect(fetched).toHaveBeenCalledTimes(2);
      expect(fetched.mock.calls.map(([url]) => url)).toEqual([
        "https://minkabu.jp/yutai/search?order=&page=1",
        "https://minkabu.jp/yutai/search?order=&page=2",
      ]);
      expect(createD1HttpDb).not.toHaveBeenCalled();
      expect(recordPrimaryData).toHaveBeenCalledTimes(1);
      const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
      const file = input.files![0];
      const rawPath = join(rawDir, file.filename.slice(0, -3));
      const plain = gunzipSync(file.bytes);
      expect(plain).toEqual(readFileSync(rawPath));
      expect(readFileSync(join(rawDir, file.filename))).toEqual(Buffer.from(file.bytes));
      expect(statSync(join(rawDir, file.filename)).mode & 0o777).toBe(0o600);
      const records = plain.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records.map(r => r.status)).toEqual([200, 429]);
      expect(records.map(r => Buffer.from(r.bodyBase64, "base64"))).toEqual([first, failed]);
      expect(verifyArchivedAttachments).toHaveBeenCalledWith("unit-page", input.files, "優待取得原本");
    } finally {
      process.chdir(cwd);
      fetched.mockRestore();
      vi.clearAllMocks();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("元jobのsource期限に達したら次一覧GET0、先行実bytesだけgzip/Notionへ閉鎖し取込0", async () => {
    const cwd = process.cwd(), dir = mkdtempSync(join(tmpdir(), "yutai-native-source-"));
    const started = Date.now() - 344 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(started + 344 * 60_000);
    vi.stubEnv("BATCH_JOB_STARTED_AT", new Date(started).toISOString());
    const first = Buffer.from(pageWith(1, 2, "9100"));
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      clock.mockReturnValue(started + 345 * 60_000);
      return new Response(first);
    });
    vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "native-source-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
    vi.mocked(verifyArchivedAttachments).mockResolvedValue();
    const prior = vi.mocked(recordPrimaryData).mock.calls.length, writes = vi.mocked(createD1HttpDb).mock.calls.length;
    try {
      process.chdir(dir);
      await expect(main()).rejects.toBeInstanceOf(ScheduledSourceDeadlineError);
      expect(fetched).toHaveBeenCalledTimes(1);
      expect(createD1HttpDb).toHaveBeenCalledTimes(writes);
      expect(recordPrimaryData).toHaveBeenCalledTimes(prior + 1);
      const archive = vi.mocked(recordPrimaryData).mock.calls.at(-1)![0];
      const saved = JSON.parse(gunzipSync(archive.files![0].bytes).toString("utf8").trim());
      expect(Buffer.from(saved.bodyBase64, "base64")).toEqual(first);
      expect(verifyArchivedAttachments).toHaveBeenCalled();
    } finally {
      process.chdir(cwd); fetched.mockRestore(); clock.mockRestore(); vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
