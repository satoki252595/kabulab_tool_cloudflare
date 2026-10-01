# 未資格・外部設定の残件調査 — 2026-10-01

Refs #102 #132 #146 #196。起点 main `7f1442972793051882d4c2d15771348eb6e4c647`。
最新Issueコメント、既存実行記録、共有producer、公式の公表・料金ページを照合した。
本調査は本番データ修復の新しい実績を主張しない。課金補充、Notion/D1/R2への
書込、workflow dispatch、結果不明POSTの再送は行っていない。

## 事業タグの課金切れ

[定時run 36745804474](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36745804474)
のbiztag job `109999206256`は成功終了だが、保存済み課金ブロッカー25件を報告している。
そのrunの成功応答統計は `calls=0 / inputTokens=0 / outputTokens=0 / estimatedCostUsd=0`、
Notion読取133件・rateLimited0・transientRetries0。これは残件を読み取りで検知した
実績であり、25件の判定成功や過去の請求額ゼロを意味しない。

対象コードは141A、151A、157A、196A、197A、2428、246A、2762、3242、3300、3457、
378A、386A、4068、407A、4326、4767、584A、598A、6547、6888、6920、7812、9444、9565。
10/2にshared Notion readerで25行を再読し、D1最新書類とのdocIDは25/25一致した。
すべて判定不能・attempts=2（上限到達0）。次回期日は14件10/2、11件10/3。
現在有効な単語帳v5と保存4本文を通常`prefilter`/`buildJudgeInput`/`buildQuestion`へ渡すと、
候補語は1〜8個で保存候補数と25/25一致し、すべて1batch。再構築state計138,977文字、
JSON request payload計545,216 bytes。jev API呼出は0。

- 直接呼出先は `api.typesafe.ai/v1/systemone`。CloudflareのPaid料金に含まれる
  Workers AIの呼出ではない。
- [公式モデル価格](https://docs.typesafe.ai/models)は入力100万tokenあたりUSD0.042、
  出力無料。現行コードの単価と一致する。推論費の見積もりは
  `成功応答usage.input_tokensの合計 / 1,000,000 × 0.042`。1銘柄でも候補語を20個ずつ
  複数batchに分けて同じstateを送るので、25回という固定回数から費用を断定しない。
- [公式MCA §8.2](https://typesafe.ai/legal/mca)ではCredits残高はアカウントで確認し、
  購入Creditsは原則購入後12か月または契約終了まで。自動補充はopt-in。
  10/2の認証済[console billing](https://console.typesafe.ai/settings/billing)では、
  購入inputの最小値USD5・自動補充OFF・カード未登録を確認した。個人の残高は公開しない。
  最低補充額と今回の推論料金は別で、税を含む決済の最終金額は未確定。補充は未実施。
- 復旧操作は同じAPIキーの所属する[公式console](https://console.typesafe.ai/)で残高・
  支払状態を確認し、必要な補充を確定すること。キーを交換する場合だけ `.env` と
  GitHub `TYPESAFE_API_KEY` Secretを同じ値に更新する。秘密値はログへ出さない。
- 残高復旧後、既存plannerの対象・retry期日・attemptsを読んで限定実行する。
  `--codes=`は期日・5回上限を解除しない。上限到達分の手動解除や再判定は、最新本文・
  既存行の保持条件・既存writerを確認した別の限定修復が必要。`--dry-run`でも有料の
  jev呼出があり、無料の残高確認手段としては使わない。

この25件は10/3以降なら通常の`pnpm biztag run --codes=<上記25コード>`で再開できる。
事前に残高復旧・最新行・docID・単語帳を再確認し、attemptsやretry日を強制変更しない。
正確な入力tokenはAPI応答の`usage`で確定し、文字数やUTF-8 bytesをtokenと同一視しない。
[公式64k/request上限](https://docs.typesafe.ai/models)を65,536tokenとして保守的に算出すると、
25成功呼出の入力料金上限概算はUSD0.0688128。クライアントの最大3回retryまで全attemptが
同じ上限で課金されると仮定した100attemptはUSD0.2752512。これは現行モデル・価格・
各1batchが維持される25件だけの計算で、関門のgolden再評価・別銘柄・税・最低補充額を
含まない。保存本文から組んだ予算準備であり、新しい判定成功や実課金tokenの測定ではない。

今回のコード修正は、`attempts<5`によって課金ブロッカーが課金通知から消える条件を
撤去した。上限到達通知と課金通知の両方を維持し、再試行や書込の対象は変更しない。
既存pipeline回帰は、未来のretryと5回到達の両方を課金残件として検出するよう修正した。

## 新規上場622A・646A

[7銘柄の実修復記録](ipo-sector7-actual-20261001.md)と
[公式5資料の資格記録](ipo-source5-qualification-20260930.md)を再利用する。
追加の7件修復をこの調査で再実行しない。

- 622Aは[公式公告](https://www.tecraft.co.jp/ir/notice/)にE42099、
  [公式株式情報](https://www.tecraft.co.jp/ir/stock/)に622A・東証スタンダードがある。
  9/30の保管済FSA原本では非上場・サービス業で、JPX上場情報と一致しない。
  会社名対応の証明だけでFSA所有の業種をJPX値へ置換できない。
- 646Aは9/30に取得した申請PDFでは直接対応根拠を欠いたが、10/1の公式コードリストを
  1 GETで取得して既存の厳密CSV readerへ渡したところ、E42126・646A0・法人番号
  5320001020638・上場・化学の同一行を確認した。11,396行・13列、571,998 bytes、
  ZIP SHA256 `388821356ec1b2d968e5d6543296757f628f4a96005aca55dc9523b301d026c8`。
  通常parserは646Aを採用する。622Aは同じ原本でも非上場・サービス業・証券コード空欄。
  原ZIPは0600で保持し、ローカル型変換エラー後も再GETせず読み直した。HTTP応答の
  正確な時刻・headerは永続化できず、保存時刻を取得時刻の代用にしない。
  共有Notion物理保管・readbackおよび本番適用はこの時点で未実施。
- 再開点は当日の公式EDINETコードリストを取得・物理保管し、既存の厳密CSV readerと
  発行体資格関数で現在行を読むこと。証券コードが公式に補完済みなら通常経路を使い、
  なお空欄なら公式ticker・EDINETコード・現在法人番号・JPX上場世代の資格を満たす
  証拠を集める。最新の全列preimageに基づくCASと実更新後照合が必要。
  9/30の原本だけで10/1にも欠損継続と断定しない。

## 優待行生成HOLD15

[68銘柄の実修復](../ops-yutai-cas68-20260930.md)は完了済み。残る15行は、
2307の未来移行5、2001の制度/解析差6、8508の一回限り1、3189の消失2、6577の消失1。
金額NULL化11・未変更4という既存結果を保持する。

| 銘柄 | 公式の追加調査先・判断に必要な点 |
| --- | --- |
| 2307 | [9/17制度・基準日変更PDF](https://www.xcat.co.jp/ja/ir/news/auto_20260917537890/pdfFile.pdf)の実原文は、初回2027/3/31、以後3月末、贈呈6月、額面/株数基準変更なし、2026/9/30は旧制度と明示。旧5行33181–33185はデジタルギフトと9月/12月発送が混在している。次回制度を全5行で厳密に対応付け、2026年の既存権利と混同しない限定修復候補。 |
| 2001 | [公式制度説明](https://www.nippn.co.jp/ir/stock/stockholder/index.html)の実HTMLは2027年3月から9月優待を3月へ統合、株数/保有期間別4tierを明示。HOLD6は32973–32975・32977–32979。旧行の月コピー・旧金額を新4tierへそのまま流用せず、100株以上半年からの新しい資格を本文に保持して次回制度へ置換する候補。 |
| 8508 | [公式株主還元](https://www.jt-corp.co.jp/ir/jstock/shareholders_reduce/)は2026年9月2日基準の特別優待を通常6月優待と別に掲載。単発の権利日を毎年9月の恒常優待へ変えない。 |
| 3189 | [公式優待](https://www.anap.co.jp/ir/information/benefit/)は通常優待と抽選優待を別記。消失2行は旧原文・新原文・変更開示を対応付けてから処置を確定する。抽選額を確約の経済額にしない。 |
| 6577 | 10/2の[公式優待](https://www.best1cruise-corp.info/yuutai/)実HTMLは「2026年7月末基準分の配布をもって廃止」と明示した。9/30/10/1のブラウザキャッシュ観測とは分ける。旧デジタルギフト36656を将来の恒常行から除く候補で、2026年7月の既存権利の配布終了を推定しない。旅行割引3行は別条件として保持する。 |

共有readerで保管済CAS68 PRE/POST packetをread-only回収した。PRE ZIP5,664,840 bytes・
SHA`0c9e4440033977dc0c8dfea9fc0a2ee0bb1e03f218bdc6b3cc96c3bd6862171f`、
POST ZIP6,704,121 bytes・SHA`1b817512e3b84cb4fa7b620a03688eac86fd54c9ec400f8f8ef8700692e3fd92`は
既存証拠と一致し、旧HOLD15のID・原因を回収した。最新D1のcore/benefit2 SELECTも保存済み。
公式5資料（2307 PDF・他4 HTML）を各1 GETで0600保存したが、追加原本の共有物理保管・
全15行のqualification完了ではない。確定した処置だけを既存full-import/whole-writerへ渡す。
最新PRE4表・原本を物理保管して全列条件・POST全列・再適用書込0を確認する。

## 海外売上の未資格・未保管

[44文書の実修復](overseas-closed44-actual-2026-09-30.md)は完了済み。
[物理照合記録](overseas-physical-close69-prep-2026-09-30.md)のTier A59件は全文一致済み。
legacy type1先頭S100YWM7は同じ内容でもZIP全体SHAが不一致で停止した。残りtype1の4件は
未試行、legacy type5の5件は期待バイト列不在で除外。inner一致をsame-bytesの証明に変更しない。

[3675文書の比較](overseas-current3675-compare-2026-09-30.md)は原本資格とは別。
9/30の比較時点では全3675の観測を持つが、pin不足73は過去保管UNKNOWNだった。
その後の59件物理閉鎖・44件修復を他3616件の成功へ広げない。

再開は保存済み0600 packet・実応答・固定ZIPを回収し、既存
`overseas-physical-close64.ts`/共有`verifyArchivedAttachments`で残る対象を別runとして
固定する。旧失敗receiptを上書き・再pinしない。新たに不足原本を取得する場合は、
文書ID・取得URL・実取得時刻・bytes/SHAを保存し共有`recordPrimaryData()`で物理保管した後、
原表の期間・単位・連結区分・地域と通常parser出力を個別に照合する。全体の無条件backfillは
実行しない。既存物理保管の再読だけで過去UNKNOWNを消したり、未資格値を0で補ったりしない。

## 信用残1件の結果不明

対象は `2026-09-28|sector_margin_std_buy_amount|医薬品`（固定462行の#110）。
[#132の既存調査](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/132#issuecomment-5896406142)
で安全461行はsame-upsertのunchanged461・追加更新0が完了済み。
active exact-key query、archive検索、Trash UIとページ送り検索118候補でも#110は未発見。
0hitは以前のPOST不成立を証明しないため、再POSTしない。

Enterprise監査ログは[Notionの公式仕様](https://www.notion.com/help/audit-log)で確認できるが、
[#132のプラン観測](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/132#issuecomment-5896652915)
はBusiness trialでアクセス不可。当時の結果を確定するpage-created等のイベントまたは
サーバー側記録が必要。新規の監査ログ契約だけで過去イベントが復元できるとは扱わない。
公式仕様は、Enterpriseへの変更前のイベントは監査ログに含まれないと明示している。
この未知の解消のためにプランを変更しても過去記録は得られない。
この調査で462行完了の主張やNotionプラン変更はしない。

## JPX新様式の公表待ち

2026-10-01に公式告知を再確認した。

| 対象 | 新様式の最初の掲載日・時刻 | ファイル名 |
| --- | --- | --- |
| [株式月間](https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html) | 10/8 15:30（前月最終週の週間と同日） | `stock_1_mYYYYMM.xlsx` |
| [ETF月間](https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html) | 10/13 15:30（毎月第8営業日） | `etf_mYYYYMM.xlsx` |
| [REIT月間](https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html) | 10/13 15:30（毎月第8営業日） | `reit_mYYYYMM.xlsx` |

各一覧の9月実データは未掲載。予告サンプルを本番一次データとして取込まない。
株式週次は9/29実ファイルで検証済み。月次/ETF/REITのunknown-rejectと既存サンプル用回帰を
保持し、公表後に実ファイルを保存・既存adapterでdry-run、全セル/単位/期間/部門/売買符号を
原本と照合してからshared archive→観測upsert→同一入力unchangedを確認する。

## 検証

コード差分はbilling集計の制限撤去と既存回帰の修正のみ。
`nix develop -c pnpm exec vitest run services/yuho-quant/src/biztag/pipeline.test.ts`
は17件pass。`nix develop -c pnpm typecheck`および対象2ファイルのESLintはexit0。
既存のNix管理runtimeとrepo依存を使用し、グローバルinstallは0。
CI結果は本PRで確認する。実データ修復・課金復旧・新様式の実ファイル検証の成功とは区別する。
