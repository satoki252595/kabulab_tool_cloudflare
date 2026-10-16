# 株式の報告権利イベントと指標窓の共通診断

2026-10-17。追跡: [#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)。既存の[権利処理監査](corporate-actions-20261016.md)を補う。これは原本・計算窓の診断追加であり、全権利処理や次回本番定時の受入ではない。

通常`sync:daily:core`と`parseSavedStockRawData`は同じ`extractStockCorporateEvents` / `buildStockCorporateDiagnostics`を通る。同じChart応答の実受信clock、全文SHA、5y/1d・split,div要求、応答metadata、実資格化列の窓を束縛する。splitの辞書keyとepoch、分子・分母・比率・splitRatio、配当等のamountを厳格検査し、省略・null・空・観測ありを区別する。時刻の逆順・重複・未来、配列長不一致、比率不一致、未知のイベント形は当該銘柄の計算・保存前にSTOPする。正常な分割やclose/adj差そのものではHOLDしない。

| 診断窓 | 通常計算の入力 | 保存原本でsplitが窓内にある銘柄 |
|---|---|---:|
| ATR130 | 直近130行中の有限high/low/close全行（Wilderの履歴） | 111 |
| volume21 | 直近21行（当日と直前20行） | 54 |
| range20 | 直近20行 | 54 |
| close2 | 直近130行中の末尾2本の有限close | 0 |
| adjustedMomentum90 | 末尾90行の受領adjclose | 97 |

窓の行数・期間・要求本数の充足・欠測数は診断であり、指標の可否判定を置き換えない。短いrangeやNULLを除くモメンタム等の既存契約はそのまま。イベント日は株式バーと同じUTC暦日への投影で、法的な効力日の証明ではない。確認した実原本ではUTC/JST暦日の差は0だった。

通常runはfresh gate前に取得成功attemptの診断を回収し、CLIへ件数を表示、既存必須`price-sync-batch`物理JSONへ保存する。fresh HOLDやrun中断時の回収済み診断も残す。Chart/QuoteSummaryのparse失敗等で共通raw結果まで到達しなかったattemptは診断済みには数えず、既存の応答原本・失敗理由を保持する。診断内は窓ごとの原本内event path参照だけで、原イベント全文やChart本文を二重コピーしない。旧保存原本も同じ関数で再生でき、DBの価格・OHLCV・指標・clock・schemaを変更しない。

## 実原本・性能確認

保存run `38539360030.1`（2026-10-14）の38 gzip、118,224,469Bを純ローカルでSHA/bytes照合。株式37parts/7,372応答=3,686 Chart + 3,686 QuoteSummary、session1応答を検査し、重複・欠測0。入力manifest SHA `3d4b5e30fd36be1af43b58cfd7f5363362f8ebad54f479d7dd27024d913a4f37`、物理読戻しreceipt SHA `6c210ba86f51182e58aa8e084d8be2701313fcab8769ccac09a98e4a8be4e4b7`。取得clockは09:02:12.223Z〜11:05:48.554Z。

旧main `151119ae182a333ee4da601323dad0251586e053`と診断追加後で全3,686 raw結果（診断fieldを除く）が同値、fresh通過3,639銘柄は全financial snapshotが同値。47銘柄のfresh欠測と8303の過去RSI HOLDを保持する。原イベントはsplit905件/800銘柄（ratio<1は18件/17銘柄）、配当23,093件/3,134銘柄。直近130本の111 splitに併合は0件。events自体の省略485、split kind省略2,401、dividend kind省略67を「なし」に読み替えない。

同じ原本の111件ではclose前後比0.940〜1.167、配当同日の60件を除く51件の`(adj/close)後÷前`は0.99999994〜1.00000006。quote closeが既に調整されていることと整合する観測だが、全OHLC・出来高の株数単位の証明にはならない。7203の配当50円によるclose/adj差も保持する。Yahoo公式の[調整済み終値の説明](https://in.help.yahoo.com/kb/finance/adjusted-close-sln28256.html)はsplit・配当反映を説明するが、Chart API全OHLCVの基準や全法的権利の網羅性までは保証していない。

Nix Node22.22.2/pnpm9.15.9。比較監査は18.33秒、peak RSS669,663,232B（新旧双方の解析・全監査原イベント・結果を保持したプロセス全体）。parse累計は旧4.662秒、新5.333秒、差0.671秒/3,686銘柄。単発のローカル比較で本番保証ではない。診断8,094,422B、既存batch合計8,095,168Bで20MiB内。追加取得元GET・モデル・依存・DDL・D1要求・Notion要求は0。既存1ファイルのbytesは約8.1MB増える（同runのraw gzip118.2MBに対して約6.8%）；全量本番の実所要・保存量は次回受入で測る。

公開fixtureは実4374/7203/9252原本からmetadata・不変events・直近130行だけを投影し、原SHA/投影SHA/実clockをprovenanceへ残す。原本・署名付きURL・私有receiptはGitに含めない。

```sh
nix develop --offline -c env -u NODE_PATH pnpm exec vitest run src/shared/yahoo/stock-corporate-events.test.ts src/shared/yahoo/stock-daily-scopes.test.ts src/cron/daily-batch-custody.test.ts
nix develop --offline -c env -u NODE_PATH pnpm exec tsc --noEmit
```

## 未完の境界

OHLC・volume・配当額の株数基準は`unknown`、ローカル係数補正は`none`。capitalGainsは未要求（応答に存在した場合だけ厳格抽出・件数表示）で、未観測を不存在とは扱わない。増資・新株予約権・会社分割・合併・全法的権利の効力日／株数履歴は未提供・未実装。推定係数・111件一括HOLD・close/adj一致判定によるHOLDは追加しない。

残件は一次資料でproviderのOHLC/volume基準を証明し、取得原本の報告イベントと正式な権利台帳／各時点の株数単位を結ぶこと。証明後に必要な成分だけ資格化し、元OHLCVと約定価格を保持する。#343はopenのまま。診断の本番定時実行・物理保管結果と、修正済み日次/月次の全量受入は別途必要である。
