# ローカルworktree統合・整理（2026-10-13）

追跡: Issue #344。ユーザーの「全てマージして、不要なディレクトリをきれいにする」依頼に従う。

## 統合判断

- PR #336はmain取り込み後に型チェック・lint・関連126テスト・監査レポート検証とGitHub CI / Workers Buildsが成功し、2026-10-13にsquashマージした（`d7631be40c0dc1f6e21f5b0c3d42d1e647d2ed1e`）。
- projects直下の`kabulab-cf-*` 36 worktreeに未コミット・未追跡変更はなく、稼働中処理の作業ディレクトリやLaunchAgent・Codex automationの参照もなかった。
- マージ済みPRのhead・main祖先・main履歴への変更照合で31件を確認した。残り5件は実際に統合し、競合を一つずつ確認した。すべて既存mainへの反映または後続修正であり、新しい実装差分はない。
- 統合ブランチは36個すべてのHEADを祖先として含む。PR #336反映後のmainとアプリ・設定・テストの内容が一致することを`git diff origin/main`で確認した。

確認した5件の競合判断:

| worktree | 維持した現行mainの変更 |
|---|---|
| automation-sources | 署名URLを例外traceから除外。保存済みPDFからの本文再開、PDF来歴とNotion銘柄ページキャッシュを保持。 |
| automation-yutai-moneyflow | 資金フローのNotion設定・結果不明停止は反映済み。VWAPの寄付前・無約定・日付跨ぎbenchmark更新を保持。停止境界の説明も既に存在。 |
| automation-yutai-product | 3D製品語の照合は反映済み。契約`.15`と後続の数量・期間・株主番号照合を保持。 |
| edinet-auto | 継続取得は反映済み。D1の100 bind上限、既存本文不一致HOLD、TDnet失敗時停止、適用済み0028 snapshotを保持。 |
| yutai-local | 厳密な円額判定は反映済み。共有条件検証、原本保管前の結果不明ラッチ、採用済みcursor継続、active普通株対象を保持。 |

## 削除対象と履歴

すべて`/Users/satoki252595/projects/`直下。以下のHEADを統合した後、不要なworktree登録とディレクトリを削除する。

| ディレクトリ | 元HEAD | 最初の確認根拠 |
|---|---|---|
| `kabulab-cf-auto-20261004` | `37901b74841b` | #300 |
| `kabulab-cf-automation-market-20261004` | `f0c16664731d` | main履歴 `4e878cf0` と変更照合 |
| `kabulab-cf-automation-source-integration-20261004` | `974c731a587a` | #312 |
| `kabulab-cf-automation-sources-20261004` | `cb53b02071a5` | 上表の競合を確認して統合 |
| `kabulab-cf-automation-yutai-20261004` | `799368d8ceaa` | main履歴 `298add92` と変更照合 |
| `kabulab-cf-automation-yutai-moneyflow-20261004` | `a42b75c57d5b` | 上表の競合を確認して統合 |
| `kabulab-cf-automation-yutai-oneoff-20261004` | `257c4e98777b` | mainと変更照合 |
| `kabulab-cf-automation-yutai-product-20261004` | `04af70913a49` | 上表の競合を確認して統合 |
| `kabulab-cf-context-acceptance-20261004` | `8de6525dfcbf` | main祖先 |
| `kabulab-cf-edinet-auto-20261004` | `7d7b52b1b039` | 上表の競合を確認して統合 |
| `kabulab-cf-edinet-empty-20261005` | `8e96e2e5a78c` | #317 |
| `kabulab-cf-ir-archived-text-resume-20261005` | `4e07fe6caf30` | #324 |
| `kabulab-cf-ir-original-335-20261011` | `beef2aac47d3` | #340 |
| `kabulab-cf-license-origin-20261005` | `e621a3851b23` | #314 |
| `kabulab-cf-macro-required-20261004` | `ade05fda8b40` | #296 |
| `kabulab-cf-market-repair` | `7348190131b4` | #154 |
| `kabulab-cf-market-resume-20261005` | `9760074bc717` | mainと変更照合 |
| `kabulab-cf-remaining-20261003` | `0cd52ade66fa` | main祖先 |
| `kabulab-cf-slo-weekend-overlap-20261005` | `dab57f6e56a9` | #328 |
| `kabulab-cf-stock-auto-20261004` | `53b47cfb749b` | main履歴 `bcce32a6` と変更照合 |
| `kabulab-cf-summary-unit-20261004` | `9270c80b4e9e` | #298 |
| `kabulab-cf-tdnet-backlog-20261005` | `4f004559d60a` | #329 |
| `kabulab-cf-tfx-custody-20261005` | `f30e4400c35a` | #311 |
| `kabulab-cf-vwap-no-trade-20261005` | `bfa47593e5a3` | #323 |
| `kabulab-cf-yutai-active-summary-20261005` | `7ee22e8ba004` | #321 |
| `kabulab-cf-yutai-atomic-20261004` | `ef23c4ce106c` | main履歴 `9d0c75fd` と変更照合 |
| `kabulab-cf-yutai-foot-quantity-20261005` | `29ec46f4c14f` | #325 |
| `kabulab-cf-yutai-local-20261004` | `2f2fe17ebbd6` | 上表の競合を確認して統合 |
| `kabulab-cf-yutai-month-normalization-20261005` | `86c52c1ac6e4` | main履歴 `dae66864` と変更照合 |
| `kabulab-cf-yutai-numeric-selection-20261005` | `0c97778b87b7` | #315 |
| `kabulab-cf-yutai-quantity-units-20261005` | `0240751682ef` | #320 |
| `kabulab-cf-yutai-row-record-month-20261005` | `edb52b942628` | #319 |
| `kabulab-cf-yutai-scoped-conditions-20261005` | `83a94699262e` | #316 |
| `kabulab-cf-yutai-shareholder-number-term-20261005` | `2bf7229821ac` | #322 |
| `kabulab-cf-yutai-shareholder-term-variants-20261005` | `2b0ae62b10d7` | #326 |
| `kabulab-cf-yutai-summary-backlog-20261005` | `37f16caba6f9` | main履歴 `bbefcb41` と変更照合 |

## ローカル保全

- `.env`・取得原本・検証ログ等はGit対象外の`tmp/worktree-cleanup-20261013/<旧ディレクトリ名>/`へ移す。通常ファイルは移動前後のSHA-256を照合する。元々リンク先が存在しない`.env`はリンク文字列を保持し、実体があるとは扱わない。
- 各HEADは`refs/archive/worktree-cleanup-20261013/<旧ディレクトリ名>`へ保存する。統合ブランチもリモートに残し、削除元のコミット履歴を参照できるようにする。
- 再生成可能な`node_modules`・Python仮想環境・キャッシュは削除する。他のworktreeから削除先への依存リンクがないことを確認した。
- 秘密値・取得原文・ローカル保全manifestはGitへ追加しない。削除と保全の実績はIssue #344で記録する。
