# 株式・マクロCF Schedulerの本番設定受入（2026-10-02）

PR195はmain `4440e782238f4f0946935fedf94c9c1d5855adad`へmerge済み。
そのmainのCF Git自動build/deployを確認し、追加manual deployは行っていない。
初回の設定と配信を受け入れた後、下記の最終mainも自動配信を確認した。
真正株式Cronのdispatchとproducer開始は確認できたが、日経平均の対象日終値が
欠落したためproducerは停止した。株価全量の成功と期限readcheckは未達・未観測。

## 本番コード・traffic・登録済みCron

- mainのWorkers Buildsは2026-10-02T14:11:50ZにSUCCESS。
  build `9ecf46fe-4e77-4440-9af2-6b52ffe41ef5`の画面でmainと対象commitを照合した。
  同buildの完成ログは5841 bytes / SHA256
  `12f7524c9a509ba6703a4c338c220d85c38a82332414c1ce6f59818574a11c53`。
- 完成ログのCurrent Version IDは
  `9b2a9629-562f-4b64-90a7-1f95f269426f`。
  2026-10-02T14:15:09.933ZのWrangler read-only deployment listで、最新deployment
  `013a7662-d396-47e7-838c-f8dffe7b71b7`のtraffic100%が同versionを指すことを確認。
  deployment作成clockは2026-10-02T14:11:44.598748Z。
- 完成ログの2026-10-02T14:11:46.283Z行には下記4式が全て登録されている。
  Dashboard production設定でも月曜〜金曜の4次起動時刻が一致した。
  旧checkout/PR branchからのdeploy、設定済みbuildへの再deployは0。

| 処理 | 登録済みCron（UTC） | 初回予定UTC | 初回予定JST |
| --- | --- | --- | --- |
| 株式dispatch | `13 17 * * MON-FRI` | 2026-10-02 17:13 | 2026-10-03 02:13 |
| マクロdispatch | `0 21 * * MON-FRI` | 2026-10-02 21:00 | 2026-10-03 06:00 |
| 株式期限readcheck | `5 21 * * MON-FRI` | 2026-10-02 21:05 | 2026-10-03 06:05 |
| マクロ期限readcheck | `5 22 * * MON-FRI` | 2026-10-02 22:05 | 2026-10-03 07:05 |

## 資格の継続と安全な配信確認

- 2026-10-02T14:15:10.065Zの独立したWrangler OAuth read-only secret listで
  `GITHUB_ACTIONS_TOKEN`の継続存在を確認した。
  2026-10-02T14:18:24.192Zのversion詳細でも同bindingは`secret_text`。
  全secret値の読取・表示は0。既存の広いGitHub OAuthをWorkerへ渡していない。
- 専用fine-grained PATはrepository1件、Actions read/write + Metadata readのみ、
  期限2026-12-31。ローカル.envへの複製は行わず、本番Worker Secretsを正のソースとする。
  作成時の一時token原値・session clipboardは消去済み。
- ソース確認済みの静的portalルート `/`へGET1だけ実行した。
  2026-10-02T14:18:23.513Z〜14:18:23.722Z、HTTP200、`text/html; charset=UTF-8`、
  17971 bytes、title `kabulab | 日本株投資ツール統合ポータル`。
  HTML SHA256は`dfe60cf72c55fa2c9d2e666340d32b6c57951beb4a07b2244e7a70e7a7a3bb17`。
  このルートは外部一次データ取得やDB/storage更新を行わない。
- Nix Node22.22.2 /pnpm9.15.9と既存Wrangler4.101.0を使用。
  metadata/health確認の私有receipt・build logはservice専用のignored tmpへ0600保存。
  公開記録にはsecret原値・一次原本URL・Notion原本IDを含めない。
- traffic/version・buildログの4式・両secret照合・healthをまとめた私有受入receiptは
  1191 bytes / SHA256 `06032879867e535f5272194347a62ebac2e3815c81b99cabc62fea66f393d891`。
  設定受入PASSと真正Cron受入pendingを別項目で保持し、0600/wx/fsyncで確定保存した。

## 最終mainの配信受入（17:25 UTC時点）

- PR276・PR277・PR278を含むmain
  `f115f0658b04afe5d45649cae0c682d1aa7b4d78`のGit連携build
  `cf839ca1-5561-4348-afc2-b0fd0d09a989`でmainと完全commitを照合した。
  deploy完了clockは2026-10-02T17:08:09.780Z。
  完成ログ5842 bytes / SHA256
  `effe996b3adc54ddd71d37223dc31bced86a4cce7ac0d8a3b4e34f1ada88c234`。
- 2026-10-02T17:20:53.212Zのdeployment読取で
  `5e3bed87-47f0-4118-ab24-1b6c1608402b`（作成17:08:07.498456Z）が
  version `17f427ee-12b8-42d0-a599-03786b2b173c`へtraffic100%を配信。
  secret listと同active versionのbindingで`GITHUB_ACTIONS_TOKEN`継続存在を
  照合した。secret値の取得・表示とmanual deployは0。
- 完成ログの4式は上表と一致する。本番設定でも4登録を確認し、次回UTCは
  2026-10-02 21:00・21:05・22:05、および2026-10-05 17:13。
  確認clockは2026-10-02T17:23:58.233Z。
- 静的portal GET1は2026-10-02T17:24:12.496ZにHTTP200、17971 bytes。
  HTML SHA256は初回と同じ`dfe60cf72c55fa2c9d2e666340d32b6c57951beb4a07b2244e7a70e7a7a3bb17`。
  最終配信の私有receipt1911 bytes / SHA256
  `2867042345812fe49920b29557ab1d30cfeecf3d5ac8bff9dcabce8082201696`。

## 真正株式Cronの実結果

2026-10-02 17:13 UTCのCronは実clockでclaim・dispatchした。
予定時刻を代入した手動実行や追加full manualは行っていない。

- claim: 2026-10-02T17:13:40.656Z。
- dispatch: 2026-10-02T17:13:43.842Z。
- [Actions run 37039278807](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37039278807)
  のeventは`workflow_dispatch`、branchはmain、headは上記f115f065。
  作成・開始clockは2026-10-02T17:13:43Z。
- `stock daily sync`は17:14:00Zに実開始し、17:14:10Zにfailureで終端。
  17:14:27.440Zの読取時点でrunもcompleted/failure。
- 失敗理由は日経平均の対象2026-10-02の日足について、実日付は一致するが
  実終値が欠落していること。`checkFreshClose`が全株式書込みを止めた。
  `src/cron/daily.ts`のsession原本保管・全文readback後、Phase1の母集団overlayや
  個別銘柄取得へ進む前に停止している。HTTP制限の全量解除はこの結果から判断しない。
- 定時receiptの固定R2 GET1と、そのreturned runのGH metadata/jobs GET2だけを
  読み取った。失敗診断は同runの`gh --log-failed`操作1回。
  管理認証・CLI内部のAPI呼数は未測。観測者によるYahoo/EDINET取得・dispatch・
  再実行・Notion/D1/R2データwriteは0。
- 起動観測の私有receipt914 bytes / SHA256
  `1ba864cf4ec4e521a0457a0f0be3bdc67c1b9472f19caf00f740586db5490f37`。
  失敗log2384 bytes / SHA256
  `b522b26d93d0b089ac13459b26369a5b7e88510425112201ff00b20129387c3d`。

## 保存済みの同一応答原本による原因確認

2026-10-02T17:48:15.821Z、上記runのsession原本を固定keyのNotion query1・
page GET1・保存添付GET1で全文読み戻し、13:56の保存済み診断原本と純粋比較した。
新しいYahoo取得、個別銘柄取得、dispatch、データwrite、再試行は0。

- 定時応答の実受信clockは17:14:04.078Z、HTTP200、原JSON2920 bytes / SHA256
  `8dcf9ecf9756c50643ceb5f39f1f90a7588e24fa1f0328d873f823178b3623ad`。
  20日足中、対象2026-10-02の1本はclose・adjusted closeともnull。
  現在の共通parserで棄却0本、鮮度判定は`missing_fresh_close`。
- 先の限定診断は13:56:28.367Z、HTTP200、2938 bytes / SHA256
  `3b88e3277b60d8039db3dae74f0cf65988529911d172a85a52f9deec7d936082`。
  同じ共通parserで20日足、棄却0本、対象日の終値あり・鮮度判定PASS。
- 原JSONのSHAは異なる。定時停止の原因は保存済み上流応答の対象日終値欠落と
  確認できた。HTTP429やparserの値棄却による停止とは異なる。
  先の応答を代用するフォールバックや追加の全量再実行は行っていない。
- 比較の私有receipt1373 bytes / SHA256
  `7ac53dccee9d409540241377922178e684232c0213d91fb7df187afd5a821e5a`。
  gzip2440 bytes / SHA256
  `12d2dfe3a360cb84bfbd3ae352c8c0bdb0683a10fb01fb5bb4967a961681c89f`を
  manifestと全文照合した。公開記録に私有原本URL・Notion IDを含めない。

## 真正定時受入として残る確認

株価の同日原本・全量実保存の成功は未達。マクロ21:00 UTC、株式期限21:05 UTC、
マクロ期限22:05 UTCの真正receipt・結果はまだ未観測。
設定検査・readonly観測ではsource GET・workflow dispatch・Notion/D1/R2データwriteは全て0。
先のN225限定診断のHTTP200/fresh close資格は別記録であり、全銘柄やVWAP全量正常化とは扱わない。
負荷の重複を避けるため、追加のfull manual起動も0を維持する。
