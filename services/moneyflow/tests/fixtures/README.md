# moneyflow フィクスチャ (JPX 実 PDF)

このリポジトリは **PUBLIC**。JPX サイト統計は **personal-only** なので、
`pipeline/tests/fixtures/jpx/README.md` と同じ理由でここへ commit しない
(`.gitignore` の `services/moneyflow/tests/fixtures/*.pdf`)。

## 置くファイル

- `jpx-sector-marketcap-202608.pdf` — 「株式時価総額」月次 PDF
  (https://www.jpx.co.jp/markets/statistics-equities/misc/07.html の
  一覧から `YYYYMM.pdf` を辿って取得。2026年8月分・48,387 bytes で取得確認済み)
- `jpx-short-selling-sector-20260925.pdf` — 空売り集計・業種別集計 (日次)
  (https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html
  の「業種別集計」列から `YYMMDD-g.pdf` を辿って取得。2026-09-25 分・
  100,090 bytes で取得確認済み)

## 取得方法 (未取得の環境向け)

ブラウザ相当の User-Agent で直接 GET すれば無認証で取得できる (ログイン壁・
CAPTCHA 無し。ただし高頻度アクセスは規約上の自粛要請対象なので、取得は
このフィクスチャ更新時に限ること)。

```sh
curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "<一覧ページで見つけた最新の YYYYMM.pdf の URL>" \
  -o services/moneyflow/tests/fixtures/jpx-sector-marketcap-<YYYYMM>.pdf

curl -s -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" \
  "<日次集計ページで見つけた最新の YYMMDD-g.pdf の URL>" \
  -o services/moneyflow/tests/fixtures/jpx-short-selling-sector-<YYYYMMDD>.pdf
```

未取得の環境では `jpx-sector-marketcap.test.ts` / `jpx-short-selling.test.ts` の
フィクスチャテストは `it.skipIf` で **skip** する (fail ではない)。ファイル名の
日付部分が変わった場合はテスト内の定数を合わせて更新すること。
