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
