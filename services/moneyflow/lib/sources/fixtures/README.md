# jpx-derivatives-investor.ts の実フィクスチャ

取得日: 2026-09-27 (ブラウザ相当 User-Agent での実機取得)。

| ファイル | 取得元 | 内容 |
|---|---|---|
| `jpx-deriv-investor-week-20260907_20260911.csv` | `https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv` | 投資部門別取引状況(先物・オプション、週間)。2026-09-07〜09-11 週、全1,760行、80商品×11投資部門×2(数量/代金)。 |
| `jpx-futures-oi-20260918-indexfut.xlsx` | `https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260918_indexfut_oi_by_tp.xlsx` | 指数先物 取引参加者別建玉残高。2026-09-18現在、日経225先物/日経225mini/TOPIX先物の3商品。 |

いずれも取得時のバイト列を無加工で保存している（値不変の検証に使うため）。

## ライセンス上の扱い: personal-only

JPX 利用規約により、商用目的のデータ収集・二次利用・再配信は許諾なしには禁止されている
(`docs/moneyflow.md` 予定の計画が既存の `license_tag=personal-only` と同じ扱いとしている
ものと同一)。このフィクスチャは **私的検証用** であり、公開・再配布・商用利用・商用トラック
への混入を禁止する。

## commit しない（重要）

このリポジトリは **PUBLIC** である。`pipeline/tests/fixtures/jpx/README.md` /
`pipeline/tests/fixtures/convert/README.md` と同じ理由により、personal-only の実データを
commit すると、この README が自ら禁じている「公開・再配布」をリポジトリ自身が行うことになる。

- `.gitignore` がこのディレクトリの `*.csv` / `*.xlsx` を除外している。`git add -f` で
  強制追加しないこと
- 未取得の環境 (このファイルが手元に無い環境。CI 等) では
  `jpx-derivatives-investor.test.ts` の `describe.skipIf(!hasXxxFixture)` が
  **skip** する（fail ではない）
- 再取得手順は `jpx-derivatives-investor.test.ts` 冒頭のコメントを参照
