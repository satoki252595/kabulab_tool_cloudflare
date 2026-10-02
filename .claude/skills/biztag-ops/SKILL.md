---
name: biztag-ops
description: kabulab-cfの事業タグをApple Silicon Mac/Nixから運用する。定時・手動run、実行サマリ、排他、rollbackの確認に使う。タグ判定ロジックの変更は通常の実装作業。
---

# biztag-ops — Macの事業タグ運用

2026-10-03に定時writerをMacへ移管した。正本は
[`docs/005-biztag-local-runtime.md`](../../../docs/005-biztag-local-runtime.md)、
判定契約は[`docs/005-yuho-quant-business-tags.md`](../../../docs/005-yuho-quant-business-tags.md)。
リポジトリの`CLAUDE.md`とサービスの`CLAUDE.md`も従う。

- **新規銘柄の適格な初回だけSemIf/MLX**。既存保存タグを再利用し、旧失敗/不足だけ
  keywords/excludes一致で補完する。TypeSafeへ送らず、語彙gate・定期golden・競合判定を再開しない。
- **Linuxのcatchup/backfillからbiztagを起動しない**。旧`gh workflow run ... biztag`は
  取得前STOPする。GitHubのconcurrencyはMacとの排他にならない。
- **承認済みmainの専用runtime worktreeとNixを使う**。環境設定はprivate `.env`と
  型付きgetter。`BIZTAG_LOCAL_ACCEPTED_REVISION`・対象開始日・SemIf専用実較正が
  不足/不一致なら早期失敗する。古いcheckoutから実行しない。
- **全writerは`withBiztagWriter`を通す**。同じprivate `.env`実体のkernel flockを使う。
  lockfile残存だけでrunningと判定しない。fileを削除して排他を迂回しない。
- **手動実行はまず対象を絞ったdry-run**。本番writerと競合していないことを確認し、
  意図した変更と保存後確認を具体化してから実書込する。新規0でモデル起動0を確認する。

すべてruntimeのリポジトリルートから実行する。

```bash
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts preflight
nix develop --command pnpm biztag run --dry-run --limit=5
nix develop --command pnpm biztag run --limit=20
nix develop --command pnpm biztag stats
```

定時経路はLaunchAgentの20:00現地時刻/RunAtLoad→Nix→同じCLI。
installはplist作成までで、bootstrapは実runを起動する。bootstrap前に旧GitHub jobと
共有Notion writerが空いていることを確認する。詳細は上記runtime正本を読む。

サマリの判定済/本文なし/読込失敗/判定不能、失敗・HOLD、Notion429、実model/call数を
確認する。時刻・件数・終了statusと保存後確認を証跡に残し、予定時刻を実行clockに置換しない。
空タグだけで「該当なし」を確定しない。未取得/判定不能を黙って別結果で埋めない。
本文・原本・私有NotionID/URL・秘密値を公開Git/log/artifactへ出さない。
一次データ保管は共有`src/shared/notion-archive/`経由のみ。

単語帳を手で書き換えない。rollbackする場合は対象版と理由を明示し、同じMac/kernel排他を
通す。旧版への変更は台帳履歴を残す。処理中/中断結果不明は実保存を読んで確認し、
無条件の全量再実行や同run再送をしない。
