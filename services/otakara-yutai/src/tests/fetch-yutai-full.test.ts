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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../src/shared/notion-archive/index.js";
import {
  collectAllStockCodes,
  collectStockDetails,
  fetchStockDetail,
  main,
  parseStockDetail,
  parseStockListPage,
  type StockDetailResult,
} from "../../data-scripts/fetch-yutai-full.js";
import type { StockYutaiData } from "../../data-scripts/yutai-full-import.js";

vi.mock("../../../../src/shared/db/d1-http-client.js", async (original) => ({
  ...await original<typeof import("../../../../src/shared/db/d1-http-client.js")>(),
  createD1HttpDb: vi.fn(() => { throw new Error("unexpected_D1"); }),
}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn(), moveToTrash: vi.fn(),
}));

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

/** ok を開く。unknown ならテストを落とす。 */
function unwrapOk(r: StockDetailResult): StockYutaiData {
  expect(r.status).toBe("ok");
  if (r.status !== "ok") throw new Error(`unexpected unknown: ${r.reason}`);
  return r.data;
}

describe("parseStockDetail は表ローカル月を優待に付ける", () => {
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
});
