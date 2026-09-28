# 財務の会社範囲・単位・年間配当の原本再検証（2026-09-28）

Issue [#124](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/124) の続き。
Notion③の財務ファクトと⑤の物理原本を対象とし、記事本文をD1へ保存する変更ではない。
初回全34,663件の原本再解析は失敗0で完了したが、独立確認で下記を検出したため、
その結果による全件のNotion/D1反映を停止した。原本値の推計や補間は行わない。

## 共通原因と修正

| 原因 | 初回監査での影響集合 | 原本による確認・修正 |
|---|---:|---|
| 会社範囲のdimensionを破棄 | 317原本・325項目 | 事業/地域等を除外。5918の売上はセグメント3,473百万円でなく会社全体4,422百万円 |
| EDINET CSVのユニットIDを破棄 | 非JPY 18原本・100項目 | JPY/JPY per share/pureだけを項目定義に合わせて採用。6269の同一要素にあるUSD売上をJPYとして扱わない |
| IFRS要素名の誤ったalias | 887原本・887項目 | `EquityToAssetRatioIFRSSummaryOfBusinessResults` は原文でBPS、unit=JPYPerShares。比率は別要素・unit=pureを採用 |
| 配当の最初のcontextを採用 | TDnet 2,768原本 | AnnualMemberだけを年額として採用。nil/不明な年間額を半期や期末額から推定しない |
| 半期/当期/翌期予想の混在 | 半期・通期予想共存1,098原本 | 通期予想に限定。翌期が存在すれば全forecast項目を同じ翌期に揃え、欠損を当期で埋めない |
| iXBRL別ファイルのcontext/unit未解決 | TDnet Document Set共通 | 先に共有resourcesを検証。同IDの異なる定義は停止。実績ResultMemberの期と異なる本表を割り当てない |

上記件数は初回結果の影響集合であり、最終更新件数ではない。
全TDnet 2,931原本を独立確認し、同IDの共有resource不一致0、解決後の未参照context0、
contextのmember制限による会社全体・連結・予想の誤除外0を確認した。

原文のunit/contextを失わず、採用候補が同一範囲・期・要素で複数の異なる値を持つ場合は
欠損と警告にする。比率はpureの確定的な%変換だけを行い、外貨換算・株式分割調整は行わない。
TDnetの本表には見出しと異なる未来の期間を持つ原本もある。3463は原本本表の期末が
2027-01-31であり、2026-07-31の実績へ推定移動せず、当期ResultMemberの
営業利益1,625百万円・経常利益1,232百万円を使う。

## 回帰検証

`pipeline/tests/fixtures/edinet/context-unit/` にcommercial-okのEDINET実原本4件の
抜粋・原公開URL/SHA256を保存した。TDnet原本3件は公開repoの既存ポリシーを維持し、
ローカルのignored ZIPだけで検証する。取得ポインタとSHA照合cache複製スクリプトを保存し、
未取得のCIではこの3件だけをskipする。初回CIで禁止fixtureの追跡を検出し、HEADから除去した。
当初6件の回帰は修正前parserで6件すべて失敗し、修正後は合格。
未知unit、隠れたdimension、複数値、使えない翌期値を当期で埋めないこと、共有unit不一致、
cache欠損/SHA不一致で停止することも検証する。市場数値を生成したfixtureは使用しない。
年間配当・予想年度・共有resourcesの構造回帰は原本の未取得にかかわらずCIで実行する。

- `nix develop -c uv run --project pipeline pytest pipeline/tests -o addopts='-rs' -q`: **1,261 pass / 55 skip**（既存の未取得原本fixture）。TDnet local-only原本を除いたCI同等の関連回帰は **43 pass / 3 skip**。
- `nix develop -c uv run --project pipeline ruff check pipeline`: 合格。
- converterとnormalizer両方を監査fingerprintに含める。今回のparser SHA256は
  `d82afc2d0ff05eb257b0f9c75383bb27ce562be8c5052b873f5067d25471087e`。
- SHA照合済みの全34,663原本cacheをAPI呼出0で再監査中。
  新fingerprintの全件結果を確認するまでは全件反映を行わない。

## 優先修復の再確認

先行修復済み26原本/25財務キーを新鮮なNotion読取で照合し、現在の正本25キーを
新parserで再監査した。追加修正対象は次の5行であり、この時点では再反映前。

| コード | 項目 | 現行正本 | 原本再確認値 |
|---|---|---:|---:|
| 8154 | 年間配当予想 | 70 | 140 |
| 7509 | 年間配当予想 | 80 | 160 |
| 9257 | 年間配当予想 | 13 | 19.49 |
| 7699 | 年間配当予想 | 12.99 | 未取得（AnnualMemberはnil） |
| 3463 | 営業利益/経常利益 | 1,625,650,000 / 1,232,259,000 | 1,625,000,000 / 1,232,000,000 |

7699の通期売上85,302百万円、純利益2,745百万円、経常利益3,388百万円、EPS114.32は保持。
独立の原本確認でも年間配当4件と8154のROE pure→%変換を確認した。
8154の古い有報の年配当165円は期中分割前後の原文単純和であり、翌年度の調整済み比較値110円と
同じ株数基準ではない。原本165円を推定置換しない。9257の19.49も半期/期末値を再合算しない。
年度比較の株数基準・JDR換算の表示は下流の別契約で扱う。

反映はPRのCI→Notion更新/再読receipt→既存行を含む実隔離D1の差分・冪等検証→source D1の順。
旧archive receiptは退避先のリンク証拠にのみ使い、数値は必ず今回のparser原本と
新鮮な正本再読で照合する。古いparserの数値を新しい検証済み値として流用しない。

## 全件反映のAPI削減

各PATCH後の個別GETを既存50コードまとめqueryによる新鮮な再読へ置換した。
PATCH応答を再読証拠として扱わず、batchの全対象数値・旧退避ページ・新キー一意性が
一致してからarchive/receiptを許す。不一致時はどの旧ページも退避せず、receiptを出さない。
途中更新済みの値は次回の新鮮queryで再確認して再開できる。未変更batchは最初の
新鮮queryを使い、再PATCH/個別GETは行わない。
2.5rpsを維持したまま、再読約3万件を数百queryへ減らせる。約7〜8時間のAPI待ちを
約4時間へ短縮する計画であり、実所要・件数は全件完了後に固定する。

## 公開仕様

- [EDINETタクソノミ設定規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140303.pdf) §4-1（通貨・perShare・pureのunit）。
- [Notion API制限](https://developers.notion.com/reference/request-limits)。正本APIは既定2.5rps。
- 今回のcache再監査はNotion APIと原公開APIを再取得しない。圧縮64MiB/展開128MiBの
  原本上限とZIP SHA256照合を維持する。
