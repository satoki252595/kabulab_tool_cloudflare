# 優待v5の通常補完受入（2026-10-18）

一般の保有期間行・券利用条件・掲載名簿条件を機械抽出する共通v5を、既存の有限移行CLIで保存済み対象へ反映した。定期の原文取込も同じcompilerを使う。新しい外部推論・依存・DDLはない。未解析条件、本人適用の未確認、公式照合の未実施を値で補わない。

| 対象 | 件数 |
|---|---:|
| 元の保存断面 | 7,716行・5,748群 |
| 今回の移行 | 1,074行・969群・420銘柄 |
| 通常CLIの有限バッチ | 142完了・未完0 |
| 物理PRE/POSTの通常照合receipt | 284 |

実行はmain `c747c638753de99ac7a69dbafb10f42115821d7e`の凍結runtime・Nix・既存lockを使い、同時実行しない単一writerで逐次処理した。各バッチは前のcompletion/intent SHAを確認してから進み、正常全列CAS・読戻し・物理PRE/POSTを閉じた。44/89バッチ後の既知の一時停止は保持し、結果不明を解除して再送していない。最後のwriterは2026-10-18T03:47:18Zにexit0。

独立agentの保存物照合では、142個の通常plan純再生、元断面との対象identity、全source/scope/manifest SHA、全PRE→期待値→readback、canonical intent/completionが一致した。変更は公開factsのversionと構造のみで、金額・理由・要約・取得日時・公式資格は保持した。対象外の行への保存SQL変更はない。

実applyログはNotion 1,704要求、429・一時再試行・新規取得元API・モデル利用0。各バッチの経過時間の合計は3,836.578秒であり、停止期間を含む全体wall時間ではない。D1のrows_read/rows_written/durationとhosted通信の総数・bytesはログに未記録のため、実請求額や全HTTP量をこの件数から認定しない。準備読取、別作業のschema移行、JPX取得の費用は混ぜない。

最終監査は保存物だけを再生し、追加HTTP・原本再GET・モデル・業務書込0。物理ファイルの一致は通常`verifyArchivedAttachments`成功receiptに基づき、今回の監査で全添付を再ダウンロードしたものではない。全7,716行の新たな本番全量POST読取や、全優待条件・本人資格の解決を主張しない。

private受入: `tmp/feature-audit-20261018/yutai-general-tiers-registry-v2/delegate-saved-acceptance-v1.json`、SHA256 `f683db8c94b18d17a889080eb42b0e6d30f43fe55fc4bdc6bc4b3664ea06e8e9`。元原文・署名URL・秘密値はGitへ含めない。[APIの影響範囲](functional-recovery-20261018.md)は1419/2001の全7行を認証付きJSSと通常DTOで一致確認済み。
