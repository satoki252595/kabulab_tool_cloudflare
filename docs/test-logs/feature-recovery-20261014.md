# 機能別監査後の復旧と受入

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。監査と全20機能の完了条件は [feature-gap-audit-20261014.md](feature-gap-audit-20261014.md)。作業開始2026-10-14 JST。全件の本番受入が済むまではこのIssueを閉じない。

## 最初の修正

- 母集団overlayをN225鮮度ガードより前へ移動。開始窓・期限・HOLD時の停止は維持。
- JPX/NYSE公式2026/2027休場表をTypeScript/Pythonで共有。未整備の年は推定せず停止し、休場は理由付き予定なしとして扱う。
- 価格依存sector-turnoverだけを株価成功に連鎖。他28取得元は既存`only=independent`でCFから平日18:15 JSTに起動し、23:45に完了を別receiptで確認する。
- 18時writerの期限に合わせ、価格・指標・モメンタムのactive全件coverageとマクロ基準日を既存opsで検査。1銘柄だけ日付が進む誤成功を検知する。
- 連結注記5系統の明示elementId/ラベルを追加し、連結優先を保持。保存済み実有報S100Z2Z6は35→37節になり、連結セグメント・関連当事者が追加、有価証券関係・後発事象は連結版へ是正される。
- Notionカタログは`--refresh-catalog`指定時だけ更新。同値なら無書込。新本文の全読戻し後に旧blockをarchiveし、子DB等混在・結果不明・読戻し不一致は旧本文を残して停止。

## 費用と性能の確認

新規サービス、依存ライブラリ、有料AI、モデルダウンロードは追加しない。通常取込のsource数はsector1＋独立28で29のまま。株価失敗日に独立28も止まっていた状態から、予定どおり稼働する分は回復に伴う負荷として計測する。

10/14 00:50 JST前後に認証済みCloudflare請求画面を読み取り、現行Workers Paid/R2 Paidと、10/4〜10/13観測の従量合計$0・予測$0・全表示項目が包含枠内であることを確認。アカウント全体の表示値はWorkers171.19k requests/CPU2.89M ms、D1 read1.08B/write1.13M、R2 Class A40.64k/Class B190.74k、build51分。R2 storage1.22GB-month、D1 storage0.24GB-monthは累積課金量であり現在容量ではない。請求画面は当プロジェクト単独の使用量ではなく、固定契約費も従量$0に含めない。

coverage SQLの本番SELECT1回は`rows_read=14,757`、`rows_written=0`、SQL20.73ms。30日実行で442,710行/月、D1 Paid包含25,000,000,000行/月の約0.00177%。OHLCV全走査やR2全列挙は行わない。包含超過後の従量単価でもこの増分は月$0.000443相当。

独立資金フローの起動監視は平日2 Cron・既存R2にreceiptを2回PUT/1回GET・GitHub dispatch/Jobs読取を追加する。22平日ならR2は44 PUT/22 GET規模で、100万Class A/1,000万Class B包含枠に比べて小さい。ジョブ本体は既存標準ubuntu-latestのpublic repoで実行する。

連結注記抽出は39項目内の候補照合だけで、通常取得の外部通信増0。営業日判定の実行時通信増0。カタログは明示更新だけなので日次通信増0。原本再処理は保存済み原本から対象を絞り、全38,210通の再GETや13.8GBの歴史原本二重化を行わない。

料金根拠（2026-10-14確認）: [Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。将来の全量保管bytesや通常ジョブの所要時間を未測定のまま$0・性能影響なしとはしない。

## 本番作業の事実

- 00:43 JST前後の母集団overlay: events233、delist3、transfer1、listed0、held0。対象コード7183/7490/9691の読戻しと同日再入の不要書込0は続けて確認する。
- 失敗VWAP run38283511757の3034予定body SHAは`e900aeca117b8d6c9ab304be4958abf63f57533a21c12b6e0bd45115bff61f27`。現R2は旧10/2までの別SHAであり、予定bodyが現保存物と一致する証拠はない。unknown PUTを再送していない。
- 00:44 JSTの新run [38424649307](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38424649307) はN225の10/13終値NULLで、個別銘柄取得前にHOLD。原典NULLを古い終値で補っていない。日足全量完了として数えない。
- 5分足60dの7203単独run [38424981255](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38424981255) は成功。R2全body・原本と全母集団の受入は別に行う。
- IR通常catchupを既存の40日窓・古い未保管優先・12分予算で実行中。取得済み/保管結果不明の自動再送はしない。

## 公式原本の保管

JPX/NYSE営業日HTML、JPX株式・ETF・REITの2026-09実XLSX、トヨタ優待公式HTMLを共有`recordPrimaryData`で実体保存し、全bytes長とSHA256をNotion添付から読戻し照合した。営業日pinは`src/shared/market-calendar.json`、私有receiptは`tmp/feature-audit-20261013/official/`。実XLSXは既存parserで受入でき、パーサ本体の変更は不要だった。

## 受入を残している範囲

株価・マクロ・VWAPの最新全量、39項目の既存文書再投影、識別保留15件/本文なし22社の分類、受注/海外表の未対応パターン、財務専用原典タグ、優待公開条件、Mac runtime、競合未判定理由、資金フロー最新期間、歴史原本索引、保有明細の単位/価格来歴、認証付きAPI/MCP、監視更新、Notionカタログの本番読戻しを継続する。

原典非開示・未提出・非適用・資格未確認は欠測理由として残す。列をNULLで追加しただけ、入口HTTP200だけ、単独銘柄成功だけでは全項目完了にしない。
