# 株式欠測55の新観測診断 PLAN（2026-10-02 JST）

10/1通常runの未保管Chartを事後復元したとは扱わず、同55銘柄の**新観測**だけを取得・保管して分類する。
旧9/29固定runner・固定入力・消費済みreceiptは変更も再実行もしていない。株式D1修復は含まない。

基準コードはmain `380e931e2305d9871e430cfccea3aa033c468e89`（PR256物理原本保管）。
private thinrunnerは `/tmp/kabulab-stock55-diag-20261002.mts`、SHA-256
`e9dff90d80c9689b867644030f95e644db28913085dd69629ef39cd4e9b4d997`。
secret値・一次応答本文はGit/公開artifactへ保存しない。

## 読取済みscope

16:42:13.826 UTC、下記の実D1 anti-join **1 SELECT** が旧失敗batch55と完全一致した。
元batch7,785 bytes / SHA `f7d8d0bd43ae10e9e1a91b2cf995a200b9c06f457b8a8ef51e59a7dba066fbe5` を
私有ローカル保管物へ再照合した。コード昇順改行結合SHAは
`e77a8706f274040bddee776f447284db984809ddfc2afea1433f7914110d141f`。
このPLANで新source GET / Notion mutation / D1 write / R2 writeは0。

```sql
SELECT s.code FROM core_stocks s
WHERE s.is_active=1 AND s.instrument_type='equity'
AND NOT EXISTS (
  SELECT 1 FROM swing_daily_ohlcv d
  WHERE d.stock_id=s.id AND d.date=?
  AND d.close IS NOT NULL AND d.volume IS NOT NULL
)
ORDER BY s.code
```

唯一のparameterは `2026-10-01`。execute時も1 SELECTで再照合し、集合が変わればsource GET0で停止する。
D1 requestはこのSQL/parameter/1 SELECTだけを許し、D1 mutationは拒否する。

対象55:

```text
1380,143A,1787,1788,1992,245A,2993,3439,3477,3583,4124,4242,4365,
5189,5199,5484,5619,5900,5939,5962,5969,5973,5974,5987,6042,6063,
6346,6360,6396,6558,6870,7058,7413,7446,7531,7634,7677,7896,8139,
8225,8303,9012,9171,9313,9353,9355,9362,9428,9476,9539,9635,9691,
9720,9857,9867
```

## 失効した1回限りの実行枠

この計画の新source開始期限は **10/1 16:50 UTC**。共有writerの空きとgrantが成立せず、
期限までにexecuteしなかったため、この枠は失効した。execution receiptは未作成、
新Yahoo GET / Notion mutation / D1 write / R2 writeはすべて0のまま。
16:50/17:00の固定期限は変更せず、このrunnerを後からexecuteしない。

以下は失効した枠の仕様を監査用に残したものであり、実行予定ではない。

- 新しいprivate wx0600/fsync execution receiptを先に作り、同診断の再入実行を拒否する。
  旧receiptを消費/更新しない。新しいrun IDは実実行clockを使う。
- 既存認証proxyを必須にし、共有 `fetchChart(code,"5y",{onRaw})` を各code最大1回。
  callerのChart source GETは最大55、追加retry0、N225 session0、QuoteSummary0。
  proxy内の既存401認証更新は別であり、Yahoo origin全HTTP数を55以下と保証しない。
- source request単位10秒timeout、300ms間隔。16:50 UTC以降は新sourceを開始しない。
  全HTTP requestの17:00 UTC期限も付け、17:13 UTC定時syncへ重ねない。
  期限/単一原文超過/原本不明ならSTOPし、未着手を未着手のまま記録する。
- HTTP/parse/価格guard失敗でも `onRaw` の同HTTP本文を捕捉する。
  全取得を終えてから共有 `archiveYahooRawBatch` のprivate全parts保存→Notion物理保管→
  hosted全bytes照合を行う。unknown POSTは再送しない。CI localの永続回収を保証しない。
- 物理照合後だけ、同じ保存bytesを `parseChartResponse` / `checkFreshClose` で分類する。
  `fresh_close`、`stale_last_date`、`target_bar_all_null`、`fresh_close_missing`、
  `future_last_date`、`empty_timestamps`、`timestamp_missing`、`http_failure`、
  `parse_failure`、`body_unavailable`、`not_started` を区別する。
  Chart全履歴guardのaccept/errorは別項目にし、raw末尾freshが正常stock producer成功を意味しない。
- counts、各raw byteLength/SHA/status/実取得clock/末尾日足timestamp、raw custodyページ、
  D1write0を含むsummaryをprivate保存しNotionへ1添付保管・全bytes照合する。
  8303の負adj保護は変更しない。D1/R2 writerを呼ばない。

追加量は最大55 final Chart応答＋raw gzip parts＋summary1ページ。
旧54 Chart標本と同程度なら約3.7 MB raw / 約1.3 MB gzipだが、新観測の量は実測で報告する。
raw1 part＋summary1添付の通常経路は約12 Notion API呼出し・hosted readback2 GET。
タイムアウト、追加status poll、429等は別であり、費用・時間の上限とはしない。

## 通常runの保存原文を先に分類する

17:13 UTC定時株式syncの、PR256適用後にNotionへ保存される通常run原文を先に読む。
通常run自体の起動・writer排他はrootが管理する。診断側はsourceの再取得・POST・
D1/R2書込みを行わず、既存Notionページとhosted添付をGETで読むだけとする。
定時runの開始遅延や失敗を、この失効枠を再開する理由にはしない。

対象は上記固定55コードの `stocks-first` Chart原文。ページのrun ID・stage・対象日・
part集合・添付manifestを照合し、gzip全bytesと内部全memberのbyteLength/SHAを確認後、
同じ保存Chart bytesを共有 `parseChartResponse` / `checkFreshClose` で分類する。
原文が存在しないcode/attemptは未保管として明示し、別時刻の原文で補完しない。
HTTP異常・parse異常・Chart全履歴guard・終値鮮度を区別する。

この通常runの原文も、未保管だった旧run36879969126の同一応答とは扱わない。
実取得clockを伴う新しい通常観測としてcounts・SHA・ページID・read時刻を記録する。
診断summaryはprivate localへ残し、安全な集計と参照だけをこのrepoへ追記する。
Notionへのsummary再POSTや公開artifactへの原文uploadは行わない。
