# EDINET 自動取得の継続性 — 2026-10-04

この記録はコードとローカル回帰確認の結果。本番の migration 適用・定期実行・新しい取得物の受入は、まだ実施していない。以前の本文69文書・68銘柄の機械タグ補完・646A逆引き修復の本番証跡は変更しない。未観測を含む22銘柄のHOLDは、未提出や対応完了へ読み替えない。

## 根因と変更

- 通常EDINET有報取込は証券コードNULLの文書を対象外にしていた。正規マスタのEDINETコード逆引きが一意で、通常の年次資格・期間・状態を満たす場合だけ、明示した銘柄コードを使用する。原応答のNULLはそのまま保持し、非NULLの不正値を逆引きで補わない。Python財務取込・Node/Worker本文取込・欠落文書回収を同じ識別契約に合わせる。競合は停止、未解決は保留。
- 毎回60日を最初から走査すると、件数・時間上限に届いた未処理分が窓から押し出される。D1の`yuho_edinet_catchup_progress`一表に日付、保管済み一覧の参照・SHA、完了文書ID、理由付き保留、revision、送信中の予約を保存する。初回だけ直近60日を登録し、その後は保存末日の翌日から追加する。古い未完は削除しない。
- 日付一覧の受信済みHTTP本文は、成功・失敗ともJSON/schema判定前に共有Notionへgzip実体保管し、全bytes/SHAの読戻しを確認する。途中再開は同じ保存原文を使い、完了済み文書・一覧のpublisher再取得を避ける。
- 当日20時JSTの一覧は未封印。翌日に終日一覧を再取得し、既完了IDを保持して後発文書だけを処理する。翌日以降に取得した一覧は封印し、完了後の再取得を止める。
- source GET未完や、保管済みだがHTTP/JSON/資格が不成立の応答はそのrunで停止する。同runの再試行はなく、既知のsource失敗予約だけCASで解除して次の通常実行で再開する。Notion/D1の結果不明は予約を保持し、読取照合前の自動再送を禁止する。
- 文書GETも同じ分類を使う。HTTP失敗・JSONエラー・空本文は本文全bytesを先に読み、別の`failed-http` keyと`.response.bin.gz`実体を共有窓口へ保管・全文読戻ししてからsource型失敗を返す。gzipは空本文も欠落なく保管し、元のbytes/SHAと状態をメタデータに残す。404型の互換を保持し、エラー本文をZIPと偽らない。エラー本文の保管が未確定ならsource再開型にせず停止する。
- CSV取得後のXBRL既知源失敗では、通常取込・manual missing・ZIP保管修復の3経路とも、取得済みCSVを`recordEdinetZip`で全bytes保管・読戻し後に停止する。この段階ではD1変更はない。catchupは既知源失敗だけ文書予約を解除して同snapshotから次定時に再開し、保管未知は予約を保持する。単独の海外/本文manual入口も、この失敗を解析エラーのDB書込に置き換えない。
- NULL提出者・未到着マスタ・解析エラーは保留として保持し、通常の日付queueを永久に塞がない。既知の正規取込対象外とは区別する。上限到達・保留・一覧失敗は成功終了せず、CLI非0/HTTP500で未完を示す。
- 旧文書の冪等skipは、保存済み実parse statusと未観測NULLを返す。`parse_error`や未観測状態を`no_table`へ置換して完了checkpointにしない。この早期returnは旧本文の新しい全文資格証明ではなく、原本の再取得・旧本文の再解析を自動追加しない。
- 本番Python workflowは必須Cloudflare保存設定5項目を取得前に確認する。catchupはD1/Notion共通設定をTDnet/EDINET前に確認し、TDnet業務失敗が後続EDINETまで止める条件を除く。セットアップ・共通認証確認の失敗では後続取得を開始しない。

## 保存境界と費用

新規本文のpointerとcheckpointは、共有本文backupの7プロパティ・TEXT2版・順序付き3フィールドの全文Unicode往復一致を確認してから進める。この共通backupの変更は同じ統合変更に含む。force追加・文字除去・切詰め・別値補完はしない。既存原CSVの元取得時計UNKNOWNは、今回の保存読取時計に置き換えない。

日付一覧の物理保管、全文読戻し、進捗CASはNotion通信とD1読書き・保存容量を増やす。費用0とは扱わない。完了済み文書のpublisher重複取得を抑え、既存の件数60・壁時計300秒上限と共有Notionレート制御を維持する。Yahoo・判定モデル・事業タグの設定と書込経路は変更しない。

## 検証

最初のcheckpoint実装はNixで関連TypeScript 11 suite / 88 tests PASS。実476A公式メタデータfixtureのNULL逆引き、訂正有報の従来選択、実migrationを使うSQLite CAS、61件目の再開、翌日の後発提出、保管前後の失敗分類、未知送信の再送停止、既存parse_error保留を確認した。公開fixtureは公式識別メタデータのみで、財務本文・秘密情報・Notion私有IDを含まない。

追加の文書GET根因修正を含む関連12 suite / 114 tests PASSで、HTTP原bytes保管・404互換・archive未知分類、CSV部分保管後のD1送信0、次回snapshot再開を確認した。空本文のgzip保管も最新client回帰で確認済み。Python関連6 suite / 180 PASS・4 SKIP（実EDINET/TDnet fixture不在による既存skip）、TypeScript型検査・関連ESLint・Python RuffはPASS。生成snapshot差分は進捗一表のみ。`0027_edinet_catchup_progress.sql`はCREATE TABLEとINDEXだけで、既存データのDROP/UPDATEはない。

本番ではコード反映と0027適用を同じ切替に合わせる。TABLE_LICENSEに宣言した表が未適用ならops確認はfail-closedとなる。migration適用・定期実行後の原本保管・全文pointer・進捗再開の実受入をもって本番完了を判断し、このローカル検証だけで全自動取得済みとはしない。
