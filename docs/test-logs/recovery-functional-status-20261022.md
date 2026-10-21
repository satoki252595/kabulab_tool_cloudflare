# 本番稼働と取込停止の修正 — 2026-10-22

10/22 00:20〜00:36 JSTの読み取り監査。対象はmain `1863a2cf`で動いた直近runと、限定したD1/R2の現在値。修正・起動と、業務データ全件の回復完了を区別する。ユーザー指定により修正後の長時間ジョブ監視は行わない。

## 本番の実績

| 対象 | 確認結果・停止範囲 | 根拠 |
|---|---|---|
| Cloudflare | main #557の配置成功、version `664f6c1f-6b0d-4be6-afc5-75ce24a1d153`、既存10 trigger、home HTTP200。10/21の4系列dispatchは到達 | build `d2250a8a-4eea-4281-85a1-e8503e88383c`、CF scheduled集約 |
| 株式10/21 | 18:01〜19:11、7879の上流429で中断。原本は保管したが一括flush前に停止し、確認時のD1の10/21日足は0行 | [39573749101](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39573749101) |
| 株式10/20 | 成功3,642・失敗44、当日更新3,643・RSI履歴HOLD1。全件成功ではない | [39397883860](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39397883860) |
| VWAP10/21 | 日足796件保存後、3513の条件付R2 PUTが500・適用不明となり停止。5件のsession HOLDもあり、5分足は未起動 | [39566189030](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39566189030) |
| 信用残・需給 | 信用残は10/20基準・10/21公表4,249行。需給は4,352行・失敗0 | [信用残39606730923](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39606730923)、[需給39571074999](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39571074999) |
| 資金フロー・マクロ | 独立28ソースは成功。価格依存の業種資金フローは株式失敗でskip。10/21朝のマクロは入力日10/20で成功、次の10/22 06時は未到来 | [資金フロー39575583366](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39575583366)、[マクロ39496827419](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39496827419) |
| Node開示 | 10/21はTDnetのPDF本文D1 INSERTで502、有報stepはskip。10/20の有報は8/28保存一覧の正当な同docID別観測を重複とみなし停止 | [10/21 catchup39581349032](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39581349032)、[10/20 catchup39404826255](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39404826255) |
| Python開示 | TDnet最新122件・失敗0。EDINETは10/20提出分59件・失敗0。GitHub scheduleの遅配があるため、予定時刻と実起動を分ける | [TDnet39620409698](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39620409698)、[EDINET39453415678](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/39453415678) |
| 月次・Mac | 10/10の月次は一覧1,707社後、1301の取得UNKNOWNで優待取込前に停止。10/22の1301限定READはHTTP200・通常parser成功、原本のNotion実体保管/全bytes照合済み。全量回復とは別。Mac自動2本は停止維持、11/11案内は未到来 | [月次38034596106](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38034596106)、private `yutai1301-once/result.json` |

株式は元からGitHub Actionsで実行し、Yahooへの通信は既存のWorker取得プロキシを通す。実行場所だけを切り替えて制限解消とは断定しない。429/503の停止期限・排他・原本保管・市場日資格を維持する。

## 通常ハーネスの修正

- 株式：取得制限と原本保管障害を区別する。429/503では新GETを止め、物理照合済みの正常snapshotだけを既存の複数表writerで保存し、元例外を返す。全量成功時の集計・剪定・業種資金フローへ進めない。
- 価格R2：原PUTはCAS付き1回。応答不明時に限り、同processが送信した全bytes・全metadata・JSON形式を30秒内の完全GET1回で確認できれば、ACK不明の証拠をsummaryへ残す。旧値・不在・読取失敗は元unknownを保持し、未確定中は次PUTを止める。過去3513のunknownを解除する処理ではない。
- Node開示：共通起動資格・保存設定が成功していれば、TDnet失敗でも独立したEDINETを実行する。取消・共通資格失敗は取得前停止し、TDnet失敗を成功へ変えない。
- EDINET：一覧の主キーである原本＋seqNumberへ観測資格を束縛する。同docIDの別状態を保持し、全行のseq不正・重複を拒否する。修正前後の金融資格やHOLDは解除しない。
- TDnet本文：直近40日・対象銘柄の未完了行を、同じNotionページの保管済みPDFから回復する。既存本文一致は再送せず、不一致は本文と分類4列を更新前に停止する。ページ不一致・非終端の保管状態で上流PDFを取り直さない。
- Python TDnet：9〜19時予定の翌朝09時前の遅配は前日を対象にする。明示`--date`は優先し、UTC/JST境界を検証する。翌09時以降の長い遅延を推測で補わない。

通常成功時のYahooリクエスト数は増やさない。R2の追加GETは価格PUTのunknown時だけ1回。新しいLLM・依存ライブラリ・監視cronは追加しない。修正版はCI確認後にmainへ反映し、株価は既存Actions入口で起動する。起動URLと結果未確認の範囲はIssue #348へ記録する。

ローカルのプロジェクトNixで全Nodeテスト6,672件成功・既存skip444件、型チェック・lint成功。TDnetのPython関連14件とruffも成功。原本・保存・期限・同時unknown・本文不一致の停止条件を検証し、業務全量の成功とは分ける。

## データ上の残り

[10/20監査](recovery-functional-status-20261020.md)の本文6,251セル未分類、財務NULL・歴史relation1,649行、固定保有価格1,758行の未資格は、後続の全件解消を受け入れた記録がない。これらは旧観測時点の数値で、今回全市場COUNTを追加していない。3776の固定文書は10/22の3SELECT/4readでも未解決を確認した。

全権利イベント適用、スイング需給/決算の2条件、TOPIX売買代金比率、内部API/MCPの成功認証試験も残る。空タグの既判定・原本不足・金融資格HOLDを生成や別値で埋めない。機能単位の[全件表](../batch-data-inventory.md)を参照。

私有証跡は`tmp/feature-audit-20261022/`の`market-status`、`remaining-status`、`yutai1301-once`、`vwap-unknown-price-readback-v1`および開示監査。公開資料へ原本・秘密値・個人のCalendar URLを置かない。
