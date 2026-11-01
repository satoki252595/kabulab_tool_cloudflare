# 株式通常入口の原文受入検証（2026-10-02 JST）

通常入口は **失敗のまま**。N225の対象日原文に実終値が無く、共有fresh-close guardが
個別株の取得・D1/R2書込みより前に停止した。次の55銘柄診断は実行していない。
原文の保管と再読は確認できたが、通常株式同期やsector33→moneyflowの成功ではない。

## 実行と停止範囲

- [通常手動run36902182830](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36902182830)
  はrootがwriter空きを確認後に1回だけ `target=stocks` で起動した。
  head `4ba208af1339589ad2641d675a85eb4740783092`。定時scheduleの成功として扱わない。
- UTC 10/1 17:49:03生成、sync job 17:49:09〜17:49:37、stock step
  17:49:23〜17:49:32（9秒）。全runのupdatedAtは17:49:39。
  job/step conclusionはfailure、sector33/context/moneyflowはskipped。
- N225の共有Chart `1mo` 取得は1回。対象日は2026-10-01。
  原文保管/readback後のsession gateで停止し、`stocks-first` と母集団overlayへ未到達。
  固定55を含む個別株Chart/QuoteSummary取得0、株式D1/R2 write0。
- 失敗batch `price-sync-batch-36902182830.1` の保管ログも確認した。
  追加Yahoo GET、再dispatch、guard緩和を行っていない。

## 同じHTTP原文の保管と全文照合

[raw page3ecd74ff-84cd-810e-94b8-f085d3f19ade](https://www.notion.so/3ecd74ff84cd810e94b8f085d3f19ade)
のkeyは `yahoo-raw-36902182830.1-stocks-session-part-0`。
service stock-sync / run36902182830.1 / stage stocks-session / expectedDate2026-10-01、
part0/parts1・member1・missing0をstrictに確認した。

| 対象 | byteLength | SHA-256 |
|---|---:|---|
| N225同HTTP原文 | 2,909 | `07dcf5c66085bbbd12ffeed3d39935b6abf390826da9a03e6c8cfef42bcc2ca7` |
| hosted gzip全文 | 2,418 | `e71a9973dee2ff45882262bf0ea0fb8646e4f71d2430d145ba3476f0ad9859bb` |
| private診断report | 1,519 | `800e6eb85884793dcba9a251b151bc842f975c5b20d44baad8ce1f0903a24058` |

HTTP200、実取得clockは **17:49:26.005 UTC**。
添付manifest fingerprint・ファイル名/種別・gzip全bytes/SHA・内部memberのbytes/SHA・
raw/compressed byte counts・part集合を再照合した。private local保存後のSHAも一致した。
株価数値を含む本文と診断詳細はprivate localに置き、公開artifactへ出していない。

## 同じ保存bytesの分類

共有 `parseChartResponse` は成功、末尾timestamp `1790812800` は2026-10-01。
その日のbarはopen/high/lowあり、**close=null・adj=null・volume=0**。
全履歴 `guardChartBars` はaccepted、rejected0。
`checkFreshClose` は `missing_fresh_close`、分類は `fresh_close_missing` だった。
日付不一致・HTTP失敗・parse失敗・全OHLC欠落とは区別する。
前日の終値やmeta価格で補完せず、session gateのSTOPを維持する。

## 読取診断の通信・証跡

- 既知run/key prefixのNotion AI search1回で既存page IDを発見した。
- readerはNotion GET/pages1回＋hosted GET1回。read query POST0。
  診断側source GET/Notion mutation/D1/R2 requestはすべて0。
- 再読clock **17:52:21.351 UTC**。
  private reader `/tmp/kabulab-stock-session36902182830-readonly.mts` のSHAは
  `3677e0f816050d0b3cd866a7e9d8432e910a1bec4407238c9c89a91c999620a5`。
  private reportは `/tmp/kabulab-stock-session-36902182830.1/session-classification-36902182830.1.json`。
- Nix `pnpm exec tsx` で再読・全bytes照合・純分類がexit0。
  [55診断PLAN](stock55-new-diagnostic-20261002.md)の通常原文分類は未完のまま。

今回の原本保管追加量は確認できたsession1 partの2,418 bytesだけ。
全銘柄Chart/QuoteSummary、回収、VWAPの原文保管量・通常完了時間は未実測であり、
この9秒を全量syncの実行時間や追加費用の上限へ外挿しない。
