# VWAP 5分足の明示期間回復（2026-10-14）

Issue #348。対象は保存済み422が確定した593A・598A・603A・604A・607Aだけ。通常5d/60d取得を自動切替えせず、明示workflow/CLIから同じproxy・5m parser・一次原本保管・旧R2形状検査・merge・条件付PUTへ流す。本番回復はCI/merge後の別操作であり、この変更の検証ではsource GET/業務writeは0。

## 根因と現在の受入範囲

[run 38437920118](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38437920118)は1,855対象中1,850書込、5件HTTP422、rateLimit/unknown PUTは0。追加1,850件のR2全body SHA・shape・latestSourceBarを502.25秒、612,911,516Bの1,850 GETで照合済み。先行1,830件と重複0、7203単独pilotを含め当初active3,686中3,681が物理照合済みだった。残5件は下記の明示回復と保存原本再利用で物理受入まで完了した。

保存4gzipの全120membersをmanifest/全body SHAへ照合したところ、失敗5件の要求は`range=60d&interval=5m`だが、Yahoo errorの内部startTimeは各社の初取引日7/22・7/16・7/29・7/29・8/4を示し、endTimeとの差は70.76〜89.76日だった。公式上場日と保存日足/既存5mも確認済みで、上場前窓要求やYahoo全面未提供とは分類しない。

## 明示契約

- `target=intra`、`intra_codes`は上記5コードの重複なし非空部分集合。from/toは両方必須、`--range`/`--limit`混在不可。対象外activeコードも拒否する。
- 実clockの60日前以降で最初の公式JP営業日09:00から、直近閉場営業日の引け15:30+1秒exclusiveまで。公表済み市場カレンダーと既存厳格ISO helperを使用し、休日・未来・不明年・短縮窓はSTOPする。
- 2026-10-14寄り前の窓は`2026-08-17T00:00:00Z`〜`2026-10-13T06:30:01Z`。保存実原本には15:30のauction timestampがあるため、06:30:00 exclusiveでは最終バーを落とす。
- 原URLは`interval=5m&period1=...&period2=...`。range/eventsへ読み替えず、原本とsummary各銘柄の原SHA・実clock・全raw timestamp範囲を保存する。全raw行の営業日・市場時間・5分刻み・昇順・窓内を検査し、null/v0除去前に範囲外があればSTOPする。11:30より後/12:30より前の昼休みは、同長のOHLCV全5配列が厳密nullのスロットだけを欠測paddingと認識し、件数をproofに保持する。部分null・実値・volume0・他時間帯は許容しない。currency/issuer/EQUITY/interval/timezone不一致、末尾営業日の遅れ、解析後emptyも回復未成立。from/toの秒境界と、実受領clockの小数秒を混同しない。
- 通常5m同様events=false。日足corporateEventsや日足確定証拠には流用しない。原本物理照合前はPUT0、旧barの未知フィールド/範囲外保持と既存保持期間剪定を維持し、既知ETag条件付きPUTのunknown/rejectedは再送せずSTOPする。

## 実行と検証

CI/merge後、rootが通常workflowから明示回復を実行する。時刻が変われば有効な窓も変わるため、古い入力を自動補正しない。

```sh
gh workflow run vwap-ingest.yml --ref main \
  -f target=intra -f intra_codes=593A,598A,603A,604A,607A \
  -f intra_from=2026-08-17T00:00:00Z \
  -f intra_to_exclusive=2026-10-13T06:30:01Z
```

関連7suite203tests、全repo tsc、所有ファイルeslint/diffcheckはPASS。対象/期間/休日/auction境界、実clock .123/.987秒、422 captureの単発保管、窓不一致/stale/非EQUITY/全v0未成立、原本unknown、PUT unknown、既存barフィールド保持を回帰。保存422原文5件と旧R2本文5件のoffline回帰（全120members SHA、既存3,592bars全フィールド保持）、保存日足5原本のEQUITY同定receiptはprivate保存先に残し、原本文・署名URLはGitへ追加しない。

追加負荷は明示回復時の最大5source GET、既存batch原本1gzipとsummary、最大5R2 GET/5CAS PUT（事後の全文照合は追加5GET）。通常CronのGET/走査増分0。最終完了には実5件の原本物理照合、summary全件成功/unknown0、R2全body SHAと旧履歴保持の照合が必要。

## 初回明示runの保存原本診断

[run 38460357230](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38460357230)は593Aの1sourceだけを取得し、資格guardで書込前STOP。written0、後4未着手、unknown/rejected0。原本132,460B・SHA `ef0912bcebeb78a25709e9ab64ef1d44535c792ae7d313ad074214f36846db3f`、Notion rawpage `3f8d74ff-84cd-81f8-ad65-c774d64603a2` の物理gzip/全body SHA照合済み。

要求/銘柄/JPY/EQUITY/interval/timezone・2,965全timestampの窓/5分刻み/順序/営業日は適格だった。追加した市場時間guardが、11:35–12:25の418slots（全OHLCV厳密null）を誤って拒否した。昼休みの完全nullだけを区別する最小修正後、同じ実SHA/clockから既存parserが2,332barsを抽出し、旧845timestamps全件を保持してmergeできることをoffline確認。593A原本の再取得は不要、残4のみ別の明示取得対象として扱った。


## 本番受入（2026-10-14 05:33 JST）

main `01f72d6c6328f252fff5f51f362f494e013f1083` のCI成功後、593Aは保存済み同SHA/実clockだけを再解析し、rootが旧ETag付き単発CAS→全body SHAを確認した。source GET/Notion mutationは0、2,332bars、旧845timestamps全件保持、unknown0。

残4は[run 38463034602](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38463034602)で各1source GET、written4/errors0/unknown0/rejected0。Notion原本1gzip136,211B（SHA `808783cd41258654b2a6814551c7cf7703fe5b4245987fba3b651a1adee310f7`、page `3f8d74ff-84cd-8139-984a-ea9ae97a4082`）とsummaryの物理全文を照合し、4つのR2全body SHAがwriter記録と一致した。保存raw clock/period1/period2・5配列・全timestampsを同じguardで再検証し、各418の昼休みstrict-null paddingを確認した。

| code | 新source bars | 保存後bars | 保持した旧timestamps |
|---|---:|---:|---:|
| 598A | 1,975 | 1,977 | 562 |
| 603A | 2,362 | 2,364 | 845 |
| 604A | 2,371 | 2,372 | 844 |
| 607A | 2,300 | 2,300 | 496 |

旧全履歴と新sourceからのmerge内容も全件一致。今回の読戻しはR2 4GET、追加Yahoo/業務write/PUTは0。先行1,830＋次1,850＋593A保存再利用1＋残4＋7203pilot1を重複0で合算し、fresh D1 active3,686とのanti-joinはmissing0/obsolete0だった。これは各receipt時刻の全body照合の合算であり、同時刻の3,686object snapshotとは扱わない。

private `tmp/feature-audit-20261013/vwap-explicit4-38463034602/full-acceptance.json`（SHA `787e5f94127ae6426ad90c4c7d17d627646bf9c51cbcf4d64cb86887997b6b96`）と`active3686-acceptance.json`に原本SHA/全R2 SHA/旧履歴保持/集合証明を固定した。最初のread-only受入scriptは明示bucket引数欠測でR2送信前STOPし、旧receiptを保存してtyped getterのv2で照合完了。原本や本番への再送は行っていない。通常日足・定時起動の受入は別機能として残す。


物理SHAと集合充足は時刻鮮度から分ける。各fullreadback receiptのlastTs JST日付は10/13が3,623件、10/9が44件、10/8が12件、10/7が3件、10/6が3件、10/5が1件。63件は13日到達未成立であり、当日3,623件も引けslot全充足までは未判定。古い更新日を最新と読み替えず、無取引・NULL・未提供・parser除外の理由は保存原本の追加再生で区別する。全3,686objectの個別lastTs/元run/全SHA確認clock/保留理由はprivate `active3686-freshness-v1.json` に固定した。新Yahoo GETで欠測を埋めたとは主張しない。
