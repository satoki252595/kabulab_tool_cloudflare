# 既済機能の最終照合 — 2026-10-18

[元監査](feature-gap-audit-20261014.md)のうち、[20機能台帳](functional-recovery-20261018.md)の1–4、9、12、16を限定して照合した。通常処理の過去の受入と、最新runの観測を分ける。今回の追加通信はD1 SELECT **1要求・8 rows_read・0 rows_written・0.8365ms**と既存Actionsログの取得だけ。原典GET、Notion通信、producer再実行、モデル、業務書込は0。Nix `--offline` / Node 22.22.2を使用した。

| 機能 | 最終照合と受入の範囲 |
|---|---|
| 1 銘柄マスタ・上場状態 | 既受入の公式233イベント・同値再入を維持。今回D1でoverlay適用基準**10/16**、適用時計10/16 09:01:27.742Z、held NULL、7183/7490/9691が全inactiveと確認。月次`master_sync`の10/4 jobrowを日次overlayの停止と解釈しない。通常`runDailySync`はN225取得より先にoverlayを適用する。 |
| 2–3 株価・派生指標 | 最新opsは10/16の**3,646/3,687**を価格・指標・モメンタムとも不足として検知。保存済み通常run38877553046の物理38gzip/7,375members・41 Chart/41 Quote/N225の全SHA照合では、parser拒否0、41社の当日OHLC/調整値/出来高は全NULL。`missing_fresh_close`として分類済みで、通常producerの再実行は不要。売買なし・停止・廃止の公式理由は未確定を保持。8303の過去RSI245本HOLDは別件。 |
| 4 マクロ | [通常context-only run38966362647](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38966362647)は予定10/16、10/16 21:01:26Z終了、Notion14要求・429/retry0。今回D1最新は**10/16・判定C・必須6値あり**、保存時計も同秒。通常経路はJP同日原本読取→US確定値→物理保管gate→D1保存で、株式全量成功とは扱わない。[日米片市場休場の予定なし契約](macro-split-capture-20261014.md)を維持。今回原本全bytesの独立再読は追加していない。 |
| 9 TDnet・IR PDF | 最新opsも原PDF **tdnetId1279652の未保管1件**を検知。翌9日の公式差替PDFは別原本として保管・全照合済みで、9/8原本のpointer NULLは維持する。取得不能を別PDFの同一原本扱いで成功にしない。 |
| 12 信用残・日証金 | [信用残run38903045497](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38903045497)は**基準10/15・公表10/16・4,250行**。margin-onlyなのでVWAP日足/5分足成功へ広げない。[日証金run38872653336](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38872653336)は10/16取得のzandaka4,756行/4,352銘柄、shina884行、D1 latest4,352行・失敗0。3原本の物理全bytes読戻しを通常logで確認。ログに申込基準日は出ていないため、取得日を申込基準日に置換しない。旧20コードの掲載対象外という既受入は10/13公表CSVの観測として保持する。 |
| 16 資金フロー | [独立run38879272134](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38879272134)の保存JSONを純parseし、**only28・outcomes28・failed0**。9月株式448/ETF26/REIT26行は保存済み原本から同値確認。`sector-turnover`は別契約で、保存前に予定日・母集団非空・当日実close/volume coverage全数一致を必須とし不足でthrowする。Actionsも株式の許容内失敗があれば連鎖しない。現在41源欠測があるためsectorの全量成功とは認定せず、0や前日値で補わない。 |

この対象内で新しい修復writerを開始する必要はない。残る値は原典の源欠測として明示する。公式の売買/停止理由まで確定する場合だけ、保存済み10/16 JPX相場表の有無を確認して必要な公式原典取得を別の有限操作とする。最新日証金の申込基準日も、必要なら既存保存CSVから読取り、通常logの取得日から推定しない。本文・優待・保有・最終配備と将来の定時receiptは20機能台帳の別担当範囲であり、本記録から完了へ加算しない。

private証跡: `tmp/feature-audit-20261018/remaining-features-acceptance-v1/result.json` SHA256 `90e9d222da870a041f51afcd3032ec63fa55ae3e66de441443511048d7899ac4`。既保存最新job SELECTは1要求/378 rows_read/0 writtenで、今回の追加読取へ重複加算しない。株価41の物理受入は[10/16追加受入](recovery-acceptance-20261016.md)の10/17 06:18記録とprivate `stock41-current16-physical-diagnostic-v1/result.json`を使用した。原文・認証値・署名URLはGitへ含めない。
