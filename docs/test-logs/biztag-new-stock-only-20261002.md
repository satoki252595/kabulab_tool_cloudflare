# 新規初回事業タグだけAI — 2026-10-02

Refs [#270](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/270)。#268の全面停止は
過去の運用履歴として保持し、利用者の追加方針で `run` だけを限定再開する。
この変更で本番の全件タグ更新・有料probe・新規原本取得は行っていない。

## 適用する範囲

- 停止前は初回以外にも有報/語彙変更・retry・根拠欠けでAIを使った。従来から新規だけ
  だったとは説明しない。今後は必須の `BIZTAG_NEW_LISTING_FROM`、公式上場情報、
  銘柄世代、active状態、初回未完の証明が揃った新規初回事業タグだけを有料対象にする。
  補足行の不存在、CLI `--codes`、過去課金エラーだけでは有料資格にしない。
  公式eventの時刻・SHA・appliedAt tupleとcurrent世代を照合し、古い/未来/重複/欠落proofは
  HOLD。HOLD対象は保存済みの判定済み行も更新せず保持する。初回は行不存在、
  または過去結果なし・明示attempt0が必要で、専用の初回失敗
  marker付き行だけ既存上限内でretryする。
- APIキーは適格scope成立後だけlazy参照する。保存先はNotion「銘柄マスタ（補足）」の
  銘柄コードごとの行。既存の判定済みタグ・AI根拠は有報/語彙が変わってもそのまま再利用する。
  未設定/判定失敗だけ既存prefilterのkeywords/excludes一致を3タグ列・ORテーマへ補完する。
  新たに補完した根拠は`band=keyword` /「キーワード一致」と実原文で示し、AIの確率や
  「はい」へ読み替えない。保存済みAI根拠のlabel/確率を改変しない。
  保存済みの書類/判定書類/語彙版/タグ根拠が欠ける・矛盾する行は再分類せずHOLDで保持し、
  正常なcoverageへ数えない。
- 本文の実資格が無い場合はHOLDで既存結果を保持する。未判定を「該当なし」にしない。
  旧課金切れ25件は新規AI対象外。語彙審査・golden・競合AI/評価は停止を維持し、
  明示SemIfの既存経路以外に自動代替しない。新列・DB migration・依存追加はない。

## 起動・費用・検証

catchupはschedule/all/biztagで `run` を再開し、target=biztagなら親のTDnet/EDINETを
skipする。親取込の失敗や対象外skipでも、取消でなければ既存D1を読むbiztagを許可する。
catchup/backfillの `biztag-notion` job groupで補足行/台帳の同時更新を避ける。
backfillはbiztagだけ停止対象から外し、golden/競合AIはsetupより前にSTOPする。

Actionsの開始日はrepository variableから注入し、鍵はbiztag job/stepだけに渡す。
ローカルの設定は `.env` が正本。開始日未設定/不正値は停止する。新規初回の実tokens・
請求は未測定で、旧全銘柄費用を月額へ外挿しない。現行`--dry-run`の新規初回は
明示HOLDで有料判定0、機械判定への置換もしない。clientの同run再送0と専用markerの
次回retry上限を区別する。旧25件の有料再開のための入金は不要。

初期運用の`BIZTAG_NEW_LISTING_FROM`は`.env`/Actions変数とも2026-10-03に設定済み。
公式上場のeffective listing dateが開始日以後かで判断し、2026-10-02以前の上場を
除外する安全側の日単位境界とする。補足行の追加日・過去の未判定だけでは新規扱いにしない。

最終凍結差分のNix統合検証は43 suites/576件すべてPASS（2026-10-02 15:01:31 JST、3.39秒）。
`pnpm typecheck`、変更TS17 filesのESLint（error/warning 0）、Workerの
`wrangler deploy --dry-run`（Upload 1702.40 KiB / gzip 358.21 KiB）もexit 0。
workflowのYAML解析と`git diff --check`はPASS、資格/計画82 casesと独立最終コードレビューも
PASS。PR/CIはまだ未実行でpending。本作業の有料probe・Notion/D1操作・原本取得・dispatchは0で、
本番の限定AI実受入や既存全件更新が完了したという記録ではない。
私有の実原本fixtureを公開せず、公開資料に企業本文・財務値・認証値・個人残高を含めない。
