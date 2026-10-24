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

主要境界は、2host同ETag競合、適用済みACK不明のPRE/cursor、後続hostの通信0、純read失敗だけのowner解放、reserve後POSTread失敗の保持、優待raw取込4段階のunknown、旧タグ原文保持・同doc入力変更の再判定、空欄drift検知・未変更source GET0、コード/SQL有限scope、reported-HOLDと空sourceの旧値保護。過去の全社欠測件数を現在値に読み替えるテストではない。

[PR #565](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/565)のGitHub CIと、[初回切替](../mechanical-publishing.md)のcanonical移行・秘密注入・旧runtime拒否・少量本番readback・有効化は、それぞれ別に受け入れる。初期化前のjob skipをデータ取得成功と数えない。
