/**
 * 優待内容の公開表示ガード。
 *
 * `yutai_benefits.description` は外部優待サイト由来の**掲載文そのもの**で、
 * 出典サイトの利用規約が転載・再掲を禁じている。公開面 (HTML / JSON API) に
 * 出してよいのは、そこから事実だけを抜き出した `short_summary` に限る。
 *
 * 型でも lint でも「どの列を公開面に流したか」は検出できない。しかも
 * 識別子名を列挙する形の検査 (`b.description` だけ見る等) は、引数名が変わる
 * だけで無言で効かなくなる。そこで**許可リスト方式**にする:
 * コメントを除いたコードに `description` が出てよいのは、自作のジャンル説明
 * (`yutai_genres.description`) と `<meta name="description">` だけ。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  clipSummary,
  groupBenefits,
  publicSummaries,
  publicSummary,
  type BenefitRow,
} from "../../app.js";

const SERVICE_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** コメント (ブロック / 行) を除いた実コード。文言の説明まで弾かないため。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** `description` が出てよい文脈（自作のジャンル説明とページ meta のみ）。 */
// 長い文脈から先に消す（`description: g.description` を `g.description` より先に）
const ALLOWED = [
  /\bname="description"/g, // <meta name="description">
  /\bg\.description\b/g, // yutai_genres の自作説明 (app.ts)
];
// 以前あった 2 本は外した:
//   - /\bdescription: g\.description\b/ ... 由来は routes/genres.ts
//   - /\bdescription: string \| null;/  ... 由来は views/pages/home.tsx
// どちらも未マウントの並行実装のための減算で、その実装を消した今は
// 「`description:` という**キー名**への代入」を無条件で許す過剰な穴になる
// （例: `select({ description: yutaiBenefits.description })` の左辺を
// 1 個分だけ見逃す）。根拠を失った減算は残さない。

function unexplainedDescriptions(source: string): number {
  let code = stripComments(source);
  for (const pattern of ALLOWED) code = code.replace(pattern, "");
  return (code.match(/description/g) ?? []).length;
}

/**
 * 検査対象 = **本番に到達する公開面**のファイル。
 *
 * 以前はここで `src/routes` / `src/views` を再帰 walk し、「死にコードも再マウント
 * され得るので含める」という建前で未マウントの並行実装まで舐めていた。だがその
 * 並行実装は tsconfig の exclude で tsc からも外れていたため、本番に出ないコードを
 * このテストだけが見ている状態になり、結果として `ILIKE`（D1 は解釈できない）や
 * `shortSummary` の重複キー 5 件を誰も落とせないまま温存していた。並行実装を削除
 * したので、走査は「実際にマウントされている公開面」に定義し直す。
 *
 * walk をやめたのは、対象ディレクトリが消えても walk は静かに 0 件を返し、
 * 件数の下限 (`toBeGreaterThan`) だけが形骸化して気付けないため。**明示リスト +
 * 実在検証**にすれば、パスが変わった時点でこのテストが落ちる。
 * 公開面のファイルを増やしたらここに足すこと。
 */
const PUBLIC_SURFACE = ["app.ts"];

/** 並行実装が再び生えたらここで落とす（走査漏れとして見逃さないため）。 */
const MUST_NOT_EXIST = ["src/routes", "src/views"];

function collectSources(): string[] {
  return PUBLIC_SURFACE.map((rel) => join(SERVICE_DIR, rel));
}

describe("公開面に出典掲載文 (description) を出さない", () => {
  const sources = collectSources();

  it("検査対象を取り逃していない", () => {
    // 件数の下限ではなく「明示リストの全件が実在するファイルであること」を見る。
    expect(sources).toHaveLength(PUBLIC_SURFACE.length);
    for (const path of sources) {
      expect(existsSync(path), `${path} が無い（PUBLIC_SURFACE が古い）`).toBe(true);
      expect(statSync(path).isFile()).toBe(true);
    }
    expect(sources.some((p) => p.endsWith("app.ts"))).toBe(true);
  });

  it.each(MUST_NOT_EXIST)("%s に未マウントの公開面が再び生えていない", (sub) => {
    // ここが生き返ると「本番に出ないが公開面の形をしたコード」が再び溜まる。
    // 再マウントするなら PUBLIC_SURFACE に足して検査対象に入れるのが先。
    expect(
      existsSync(join(SERVICE_DIR, sub)),
      `${sub} を復活させるなら PUBLIC_SURFACE に追加して検査対象に入れること`,
    ).toBe(false);
  });

  it.each(sources.map((p) => [p.slice(SERVICE_DIR.length), p]))(
    "%s が description を公開面に流さない",
    (_label, path) => {
      const left = unexplainedDescriptions(readFileSync(path, "utf-8"));
      expect(left, "許可された文脈以外で description を参照しています").toBe(0);
    },
  );

  it("識別子名を変えただけでは抜けられない", () => {
    // ガードそのものの回帰テスト。以前は ["b","p",...] の列挙だったため
    // 引数名を変えるだけで素通りした。
    expect(unexplainedDescriptions("const t = x.description;")).toBe(1);
    expect(unexplainedDescriptions("const { description } = b;")).toBe(1);
    expect(unexplainedDescriptions('const t = (b as any)["description"];')).toBe(1);
    expect(unexplainedDescriptions("select({ description: yutaiBenefits.description })")).toBe(2);
    // `description:` というキー名への代入だけでは許可されない。
    // かつて ALLOWED にあった /\bdescription: g\.description\b/ と
    // /\bdescription: string \| null;/ はここを素通りさせていた。
    expect(unexplainedDescriptions("{ description: g.description }")).toBe(1);
    expect(unexplainedDescriptions("type G = { description: string | null; };")).toBe(1);
    // 許可された文脈は通る
    expect(unexplainedDescriptions("<p>{h(g.description)}</p>")).toBe(0);
  });
});

describe("publicSummary / publicSummaries / clipSummary", () => {
  it("null と空白のみを空文字にする", () => {
    expect(publicSummary({ shortSummary: null })).toBe("");
    expect(publicSummary({ shortSummary: "   " })).toBe("");
    expect(publicSummary({ shortSummary: " 3,000円相当 " })).toBe("3,000円相当");
  });

  it("重複を畳み、空は列挙しない", () => {
    expect(
      publicSummaries([
        { shortSummary: "500円相当の優待券" },
        { shortSummary: "500円相当の優待券" },
        { shortSummary: null },
        { shortSummary: "" },
        { shortSummary: "カタログギフト 3,000円相当" },
      ]),
    ).toEqual(["500円相当の優待券", "カタログギフト 3,000円相当"]);
  });

  it("上限までは切らず、超えたら … を付ける", () => {
    expect(clipSummary("あ".repeat(80))).toBe("あ".repeat(80));
    expect(clipSummary("あ".repeat(81))).toBe("あ".repeat(80) + "…");
  });
});

describe("groupBenefits", () => {
  const row = (over: Partial<BenefitRow>): BenefitRow => ({
    genre: { name: "食品・飲料", slug: "food" },
    minShares: 100,
    recordMonth: 3,
    summary: "3,000円相当",
    estimatedValue: 3000,
    estimateValueSource: null,
    estimateSourceUrl: null,
    ...over,
  });

  it("同一株数・同一要約は 1 商品にまとめ、月を束ねる", () => {
    const [g] = groupBenefits([row({ recordMonth: 3 }), row({ recordMonth: 9 })]);
    expect(g.tiers).toHaveLength(1);
    expect(g.tiers[0].products).toHaveLength(1);
    expect(g.tiers[0].products[0].summary).toBe("3,000円相当");
    expect(g.tiers[0].products[0].months).toEqual([3, 9]);
    expect(g.allMonths).toEqual([3, 9]);
  });

  it("同一商品に複数の推定額があれば大きい方を残す", () => {
    const [g] = groupBenefits([
      row({ estimatedValue: 3000 }),
      row({ recordMonth: 9, estimatedValue: 5000 }),
    ]);
    expect(g.tiers[0].products[0].estimatedValue).toBe(5000);
  });

  it("株数段階が違えば別 tier にし、株数昇順で返す", () => {
    const [g] = groupBenefits([
      row({ minShares: 1000, summary: "10,000円相当" }),
      row({ minShares: 100 }),
    ]);
    expect(g.tiers.map((t) => t.minShares)).toEqual([100, 1000]);
  });

  it("要約が空の行どうしは同一商品に畳まない", () => {
    const [g] = groupBenefits([
      row({ summary: "", estimatedValue: null }),
      row({ summary: "", estimatedValue: null, recordMonth: 9 }),
    ]);
    expect(g.tiers[0].products).toHaveLength(2);
  });

  it("ジャンル未設定は「その他」に寄せる", () => {
    const [g] = groupBenefits([row({ genre: null })]);
    expect(g.genreName).toBe("その他");
    expect(g.genreSlug).toBeNull();
  });
});
