# 新規初回事業タグのSemIf切替・実データ評価（2026-10-03）

今後の新規銘柄の初回事業タグをローカルSemIfへ切り替える。公式上場日・現世代・active・初回未完の資格と本文候補が揃った項目だけ、常駐モデルを遅延起動する。開始日 `BIZTAG_NEW_LISTING_FROM=2026-10-03` の資格は維持する。既存の保存済みタグと根拠は銘柄コードで再利用し、未設定・失敗だけをkeywords/excludesで補完する。有報・語彙更新による既存再判定、TypeSafeへの切替、有料API、語彙審査・競合判定の定時再開は行わない。

## 実装境界

- `calibration.semif.json` を新規事業タグ専用に用意し、旧Jevと競合他社の較正値を流用しない。
- `run` はMac/Nix・承認済みclean main・同じ `.env` 実体のkernel排他を通る。Linux catchup/backfillのタグ処理は取得前に停止する（先行PR276）。Mac LaunchAgentの登録・真正実行は本変更のmerge後に別受入する。
- 1runに1residentを使い、正常・例外終了ともcloseする。起動応答のモデル・revision・backend・入力上限・SemIfソース・MLX版・MLX-LMソースpinが違う場合は入力送信前にSTOP。timeout後は同じrunで再起動しない。
- 資格なし、保存済みタグの再利用、機械補完、dry-runの新規初回はモデル起動0。新規初回の失敗だけ専用履歴による既存の上限付き再試行を使い、旧課金エラーをSemIf初回へ分類し直さない。
- ローカル計算費用とトークン数の合計は未計測。互換形式のJevカウンター0を実測費用とは呼ばず、`judge.costMetering=not_metered_local`、費用・トークン数null、外部判定API0を別記する。

## 本文と評価範囲

既存の実ゴールデンセットv1（87社・858ラベル）と既存語彙v1を使った。D1索引1SELECTでexact87を固定し、既存Notion本文を読取った。計Notion237（本文232＋診断5）・既存添付hosted2・D1読取1＝240 native読取。旧レスポンスを再利用し、既取得URLの再GET、Yahoo/EDINETの新規取得、保存結果の書込は0。

85通は保存本文の全節・正規codepoint文字数とメタデータが一致した。残る2通は保存本文のサステナビリティ節にU+200Bの欠落1文字・3文字があり、実CSV添付を回収し全ZIP CRC・全34節を照合した。両方とも判定入力の4節は保存本文と実CSVが完全一致した。評価では実CSV全節を `SOURCE_RECOVERED` と明示して使い、本文の補作・長さの許容・評価対象の削減は0。**保存Notionの全87通一致ではない。欠落2通は未修復HOLD、旧manifest・本文SHA・取得時計の来歴はUNKNOWNを維持する。**

本文map SHA256: `0e6ed4a866773c0a64de66f8e0a78e71e3cf1ec559147c56ea6548043b6c422b`。本文・法人の財務値・Notion私有URL・認証情報・モデル入力は公開Gitへ保存しない。新たなAPI原レスポンスとモデル測定の私有証跡は物理保管の別受入対象。

## 実SemIf推論

Apple Silicon/MLX、既存キャッシュのみ（HF/Transformers offline）。Qwen/Qwen3.5-4B revision `851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`、SemIf `23cf1f39fc9534fe81437200959b6dfc7106e45a`、MLX0.32.2、MLX-LM `a63e24c389382619eb6d9af656e3b46024be217a`、非量子化、入力上限16000、batch20。追加インストール・モデルdownload0。

最初の66社を1resident/73callsで測定し、その後の87通datasetから同じstate/questionsを生成して全input SHA・actual output・全ラベル結果をPURE照合し再利用した。残る21社は別residentで21callsを実行。研究計測は2resident phase合計94calls・全候補881問・183180ms（各phaseの経過時間の和）。全858期待ラベルに欠落なく対応し、外部判定API・本番タグwriteは0。既存質問文・抜粋・フィルタ・語彙は変更しない。

評価全文SHA256: `5e7b174bee4c116b888c5830d27b5b447e3fb02498c853fc76bc80f050bb251b`。

## 閾値と測定限界

| yesMin | 「はい」精度 | 再現率 | mustHit再現率 | はい件数 |
| --- | ---: | ---: | ---: | ---: |
| 0.50 | 0.8159 | 0.7956 | 0.9524 | 353 |
| 0.80 | 0.8939 | 0.6519 | 0.8095 | 264 |
| **0.85** | **0.9157** | **0.6298** | **0.7619** | **249** |
| 0.90 | 0.9355 | 0.5608 | 0.7619 | 217 |
| 0.95 | 0.9675 | 0.4116 | 0.6190 | 154 |

採用値はyesMin0.85/noMax0.20。0.80〜0.83は精度0.9未満、0.84〜0.85は同じ249件だったため、0.85で精度と再現率を折衷する。noMax0.20では「いいえ」正解347/381（0.9108）、正例の断定的除外34。0.25では同376/417（0.9017）・除外41となるため、追加7件を要確認として残す。

この閾値で858ラベルは、はい249・要確認227・いいえ381・候補なし1。TP228/FP21/TN475/FN134、mustHit16/21、mustNot誤検出0、filterMiss0。FNは要確認も含む二値の「はい」取りこぼしであり、134件を断定的な「いいえ」とは扱わない。旧Jevの測定（精度0.962/再現率0.760/mustHit0.905）と同等ではない。現在停止中の語彙変更ゲートの同版非劣化条件を、新モデル採用と混同しない。

SemIfの値は提示したyes/noオプション間の条件付きsoftmaxで、較正済み信頼度ではない。上記はこの実ゴールデンセットでの測定であり、新規銘柄すべてに同じ精度を保証しない。要確認を自動的な「はい」や別モデルで埋めない。

公式根拠（2026-10-03読取）: [SemIf公式repo](https://github.com/TheoLeeCJ/SemIf-OpenJev)、[固定ソースのMLX運用・モデルpin](https://github.com/TheoLeeCJ/SemIf-OpenJev/blob/23cf1f39fc9534fe81437200959b6dfc7106e45a/docs/MLX.md)。旧URL `TheoLeeCJ/SemIf` は同repoへredirectする。

## 検証状況

専用較正の回帰を含む関連7suites150/150 PASS、typecheck/変更TS17files ESLint（0error/0warning）/Python compile PASS。Wrangler4.101.0 `deploy --dry-run` PASS、1734.42KiB/gzip365.72KiB/15assets、upload0。独立コードレビューはlazy起動・保存結果保持・provider pin・timeout/close・Mac共通writer境界でblocking0。rootと独立レビューで全858ラベルの集計・専用較正・本文85＋2の区分を照合した。PR/CIとmerge後の真正Mac運用受入は後続。
