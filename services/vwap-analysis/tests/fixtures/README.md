# vwap-analysis フィクスチャ (JPX 実 PDF)

このリポジトリは **PUBLIC**。JPX サイト統計は **personal-only** なので、
`pipeline/tests/fixtures/jpx/README.md` と同じ理由でここへ commit しない
(`.gitignore` の `services/vwap-analysis/tests/fixtures/*.pdf`)。

## 置くファイル

- `jpx-margin-weekly-20260918.pdf` — 「銘柄別信用取引週末残高」週次 PDF
  (https://www.jpx.co.jp/markets/statistics-equities/margin/05.html の
  一覧から `syumatsu2026091800.pdf` を辿って取得。2026-09-18 申込み現在・
  873,311 bytes・SHA256 `21c99f4e…c52131d` で取得確認済み。
  #117 で Notion 実体アップロードに失敗した週そのもの)
- `jpx-margin-daily-20260928.pdf` — 「銘柄別信用取引残高」日次 PDF
  (https://www.jpx.co.jp/markets/statistics-equities/margin/01.html の
  一覧から `20260928_mtall.pdf` を辿って取得。2026-09-28 申込み現在・
  1,795,979 bytes・SHA256 `7a0c2e21…12ce314` で取得確認済み。
  週次 PDF の公表廃止に伴う日次様式の初回確認分)

## 取得方法 (未取得の環境向け)

ブラウザ相当の User-Agent で直接 GET すれば無認証で取得できる (ログイン壁・
CAPTCHA 無し。ただし高頻度アクセスは規約上の自粛要請対象なので、取得は
このフィクスチャ更新時に限ること)。

```sh
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "<一覧ページで見つけた対象週の syumatsuYYYYMMDD00.pdf の URL>" \
  -o services/vwap-analysis/tests/fixtures/jpx-margin-weekly-<YYYYMMDD>.pdf
```

未取得の環境では `lib/margin.test.ts` のフィクスチャテストは `describe.skipIf`
で **skip** する (fail ではない)。ファイル名の週が変わった場合はテスト内の
定数 (バイト数・SHA256・week・行数) を合わせて更新すること。

## R2 実 excerpt (basis proof の実証用。commit しない)

- `r2-daily-7203.json` — R2 `daily/7203.json` 保存物の写し
  (由来 `/tmp/audit-b/r2/daily-7203.json`・2026-09-28 取得・224,008 bytes・
  SHA256 `2a727f0665ba53e78da50944e58714271f20d26e6ad7e9b296dcd5a21e0c8efc`。
  code 7203・bars 2529 (2016-06-20..2026-09-25)・splits []・
  updated 2026-09-25T13:41:14.066Z・proof なし legacy 形)。
  用途: 同一 cached 再観測の PUT0/standing bytes 不変 regression、
  strict 保存形状の実適合、legacy (proof 欠落) HOLD。
- `r2-intra-7203.json` — R2 `intra/7203.json` の写し
  (由来 `/tmp/audit-b/r2/intra-7203.json`・2026-09-28 取得・525,727 bytes・
  SHA256 `628dfb7fef7a0b8b0dabc09a35198e43d26b2cfa6d28ea2a6f92c939972ff6d1`。
  code 7203・bars 7871 (sessions 121・2026-03-25..09-25)・
  updated 2026-09-25T14:22:51.453Z)。用途: HOLD/適格の実 window。
- `r2-intra-3600.json` — R2 `intra/3600.json` の写し
  (由来 `/tmp/audit-b/r2/intra-3600.json`・2026-09-28 取得・7,694 bytes・
  SHA256 `c369a2081a116e817b9a44bdf842609168e52a1a70ffbd61b35acc4117814466`。
  code 3600・bars 123 (sessions 61・2026-03-25..09-18))。用途: 第二実 window。
- `yahoo-5y-7203.json` — Yahoo chart 5y 応答実 bytes (7203.T)
  (由来 `/tmp/audit-b/yahoo-5y/7203.json`・2026-09-28 取得・
  SHA256 `0db61a252127532d33ae2c486836fd7e5aad5adf17c223903c9e2c36d3a0f023`。
  1222 ts (2021-09-28..2026-09-28)・splits [2021-09-29 5:1])。
  用途: 実 parse→proof→適格 positive。observedAt は取得 mtime 代理
  (2026-09-28T08:54:58Z。市場証拠ではなく clock 表示用)。
- `yahoo-7944-10y.json` — Yahoo chart 10y 応答実 bytes (7944.T)
  (由来 adj-repair 取得 acq-7944.bin・151,523 bytes・
  SHA256 `0b35e0df364f0b0c34ebc92ff9504104e22bdad02abe97beb7bce86be0431e5d`・
  body 完了 2026-09-30T11:01:08.585Z。2462 ts・splits なし)。
  用途: 実 bytes の adj demotion 証明 (GET0 再利用)。
# Issue272 配当/分割回帰の私有原文（2026-10-02）

`services/vwap-analysis/corporate-events.test.ts` はrepoの `tmp/issue272-fixtures/chart-1333.T.json` と `capture-1333.T.json` がある場合だけ実物回帰を実行する。`tmp/` はGitignored。原本文・配当額・価格は公開Gitへ追加しない。Nix開発環境で関連Vitestを実行する。

原器は既存Notion batch `yahoo-raw-36903916350.1-vwap-daily-0-part-0` のgzipで、SHA256 `388f21836e8b11c22fb91e2f1abe79a81fe872076356ce1dd77c39fa4955f7d3`。内部原文226,625 bytes、SHA256 `5d6109a75c8a7b8a14330914e198f8ad91303cf9b2e0eaf924da4319dc64305b`、実本文時計 `2026-10-01T18:03:15.537Z`、配当14/分割1。Notion-hosted全bytesと内部原文SHA照合済み。clockは保存captureから読み、現在clockやmtimeを代用しない。ネットワーク取得はテスト内で行わない。

Yahoo原文の再配布は許可しない運用。出典・照合境界・取得通信数は [検証記録](../../../../docs/test-logs/yahoo-corporate-events-20261002.md) に残す。イベントなし1mo/訂正は純粋な境界試験で、実1mo再取得/実source訂正の証明とは区別する。
