# 本文39・優待機械publisherの検証

2026-10-25、製品/互換test commit `a61ec68ec5e7ec8db955ba14e4eb7795274a338e`。main #564を通常mergeした専用worktreeでNixを使用した。原本・秘密値はこの記録に含めない。

| 確認 | 結果 |
|---|---|
| 関連18 suite | 556 PASS、既存2 skip |
| 単体apply退役の隔離child実行 | 3 PASS。空のenv/private新規cwdで入力ファイル読取・業務初期化前に停止 |
| 新schema/退役CLIの全体互換 | 3 suiteの修正後に全Nodeを再検証。原native fixture bytesは変更せず、新nullable列だけtransportへ投影 |
| `nix develop --command pnpm exec vitest run --reporter=json ...` | **6,792 PASS / 0 FAIL / 465 skip** |
| `nix develop --command pnpm exec tsc --noEmit` / `pnpm lint` | PASS。変更scripts/testの個別ESLintもPASS |
| `nix develop --command pnpm exec wrangler deploy --dry-run --outdir ...` | exit0。bundle作成だけで実配備/業務取得は行わない |
| 実モデル・一次上流取得・業務書込・共有初期化 | 全て0。rootの切替/本番受入は別途必要 |

私有ログは専用worktreeの`tmp/mechanical-publishing-validation/`へ保存する。全Node JSON SHA256は `1e125b9ed650d9956e61d47e10d7873dbcc08d42f4cc81ccb5bd921a3331e53d`。Wrangler私有ログSHA256は `80cbdf9e71900283f6dabbf85da3c84d2089da9d45c6297eec0de0ec5d80f092`。

主要境界は、2host同ETag競合、適用済みACK不明のPRE/cursor、後続hostの通信0、純read失敗だけのowner解放、reserve後POSTread失敗の保持、優待raw取込4段階のunknown、旧タグ原文保持・同doc入力変更の再判定、空欄drift検知・初回候補の未変更source GET0（後続の資格追補で変更）、コード/SQL有限scope、reported-HOLDと空sourceの旧値保護。過去の全社欠測件数を現在値に読み替えるテストではない。

[PR #565](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/565)のGitHub CIと、[初回切替](../mechanical-publishing.md)のcanonical移行・秘密注入・旧runtime拒否・少量本番readback・有効化は、それぞれ別に受け入れる。初期化前のjob skipをデータ取得成功と数えない。

## native期限・本文資格の追補

GitHub両jobは既存record-job-clockとnativeJobExecutionWindowを再利用する。CLI元budgetは維持し、hardはCLI開始＋budget＋5分とjob実開始＋25分の早い方、softはhardの5分前。時計なし/開始余裕なしはowner・業務依存生成前に停止し、開始済み原子unitだけhardまで閉鎖する。

本文sourceは変更のない選択対象も共通qualified readerを1回通すよう変更した。初回候補のsource GET0という費用説明は現行の保証ではない。選択1docのD1照会、Notion page所属/7メタ、strict本文を同じ資格helperで検証する。consumerの件数は実本文のcodepointから算出し、producerの独立件数/全文照合は維持した。原本ZIP/全市場メタ読込/モデル追加は0。

Nix関連6suite157件PASS、global tscと対象lint PASS。主な追加回帰はsetup11分時のnative hard短縮/clock欠落/soft到達、開始済みbody後の次unit停止、優待原子batchの閉鎖、7メタ欠落・別issuer、限定1doc SELECT、通常Mac/tagとmechanicalの資格HOLDでpublication/forward 0。初回本番のNotion request数・秒・processedはrootの切替時に別途実測し、コードテストから処理量を推定しない。

main #560を通常mergeした追補候補で、Nix Node全体6867件PASS/0FAIL/既存465SKIP、global tsc/lint、Wrangler deploy --dry-run（実配備なし）を確認。モデル/上流取得/業務APIは0。私有検証ログは`tmp/mechanical-native-validation/`、全Node JSON SHA256 `f0cf90be34aeb26e351ea0560aa961f4416d5683ea742b3b21bf21de19c0f158`。
