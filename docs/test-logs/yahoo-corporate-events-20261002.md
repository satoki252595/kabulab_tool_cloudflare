# Yahoo配当・分割イベント保存（Issue272）

調査・検証日: 2026-10-02。対象は取得・保存・配信契約。実際の入金額、税、保有株数、投資損益は扱わない。本番反映・全銘柄バックフィルは未実施。

## 保存・API契約

- 通常日足は現在も1回の10年取得。今回1か月の価格差分取得へ変更しない。イベントだけは要求範囲に見えない過去日を削除せず、同日の訂正を`version`・原値SHA・元の取得根拠付きで追加する。同値再入で履歴を増やさない。
- `corporateEvents` schema1は配当原`amount`、原timestamp、JST権利落ち日、通貨と`chart.result[0].meta.currency`出典を保持。支払日を権利落ち日から推定せず`null / not-provided`とする。通貨欠落も`null`。分割は原timestamp、JST効力日、分子・分母・比率を保持する。
- 応答にイベントなしは`verified-none-in-response`（当該応答/要求範囲だけ）。旧保存物や未取得R2は`corporateEvents: null / corporateEventsStatus: not-fetched / dividends: null`。旧ratio-only分割は`legacySplits`として保持し、失われた原timestamp・分子分母・取得時計を補作しない。
- `/api/daily`は既存`bars / splits / proof`を保ち、最新の既知配当versionと全訂正履歴を追加する。各sourceにYahoo要求URL、実本文取得時計、原本文SHA、対応する保存価格snapshotのSHAとbasisを持たせる。
- basisはYahooの`quote`値を受信したまま既存OHLC2桁丸めで正規化したもの。provider側の調整内容はこの応答では未証明で、調整前価格とは主張しない。`adjclose`は金融入力に使わず、ローカルで配当/分割を再調整しない。consumerが分割係数を再適用すれば二重調整になり得る。snapshot SHAのcanonical JSONは`{priceBasis, bars:[{date,o,h,l,c,v}]}`。保存/API両境界で価格と原値SHAを照合する。
- zero-split比較は日足spanより前で今回proofにも無い旧splitだけを除外。span内欠落、最終日後の保存split、proof内のspan外splitはHOLDを維持し、保存窓split/10y要求/source資格のguardは維持する。
- 既存のraw batch gzip→Notion-hosted全bytes readback→R2条件付きPUTの順序を維持。履歴が参照する旧原文は削除しない。取得範囲外の旧イベントは当該応答不在だけで取消し確定とはしない。

## 私有実原本の照合

既存run `36903916350` のstage0だけを読取。Notion page GET **1**・hosted GET **1**、Yahoo追加GET **0**、Notion/D1/R2 mutation **0**。他26partsを取得していない。

- gzip: 1,430,874 bytes、SHA256 `388f21836e8b11c22fb91e2f1abe79a81fe872076356ce1dd77c39fa4955f7d3`。内部30member全件の長さ/SHA照合PASS。
- 回帰に使う1応答: 226,625 bytes、SHA256 `5d6109a75c8a7b8a14330914e198f8ad91303cf9b2e0eaf924da4319dc64305b`、実本文時計`2026-10-01T18:03:15.537Z`、HTTP200、配当14件・分割1件。原文/金融値/添付URLは私有0600で保持しGitへ含めない。
- 実原値・比率・日付意味・通貨出典・価格snapshot対応をoffline照合。イベントなし1mo/訂正の境界回帰はこの取得済み原値を使う純粋試験であり、実1mo再取得や実source訂正を観測したという意味ではない。実原本の末尾null barに伴うproof span不一致は保留のまま。split境界試験の有効日足span/window投影を実5分足資格へ拡張しない。

## 検証

関連22 suites **367 PASS / 26既存条件付きSKIP**（2026-10-02 22:36 JST）、TypeScript・対象ESLint・diff check PASS。実原本の6回帰はCIに私有原文が無ければ明示SKIP。Worker `wrangler deploy --dry-run` PASS（1709.09 KiB / gzip359.90 KiB、15assets）。本番upload無し。PR CIは後続確認。

## 出典と限界

2026-10-02確認: [Yahoo Adjusted close](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html)（公式検索結果、本文GETは429で未取得）はsplit/dividend調整済み`adjusted close`を説明する。本変更はこの系列をOHLCへ代入しない。[Yahoo配当履歴の公式header](https://finance.yahoo.com/quote/LLY/history/?filter=div)（検索cacheのみ、相場API追加取得0）は配当をex-dateごとに表示することを示すが、Chart quote APIのprovider調整内容を直接証明しない。[Yahoo chart events](https://help.yahoo.com/kb/sln5686.html)は配当/分割イベントの表示を説明する。権利落ち日と支払日の区別は[SEC Investor.gov](https://www.investor.gov/introduction-investing/investing-basics/glossary/ex-dividend-dates-when-are-you-entitled-stock-and)を参照（米国の制度説明を日本の権利日決定へ流用しない）。Yahoo chart原値の意味は取得済み応答との照合と既存取得契約に依存し、現金受領・税・調整前価格を保証しない。
