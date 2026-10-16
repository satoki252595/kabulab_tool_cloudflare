# Notion本文列のU+200B表現（2026-10-17）

9273のS100Z2Z6（2026-06-30期末）を通常`processStock`の本文同期で送ったところ、「サステナビリティに関する考え方及び取組」の3106 UTF-16単位がNotionのACKと読戻しでは3105になった。差はoffset1457のU+200B（ZERO WIDTH SPACE）1文字だけで、可視文字は同一だった。通常publisherが読戻しの不一致を検出し、旧根拠の退役・再送と後続処理を停止した。

共通`buildSupplementProperties`の`input.texts`に限定してU+200Bを除き、Notion本文表示の送信表現へ揃える。汎用rich_text splitterや他の入力を変更しない。入力map、保存原文、一次データの物理バイト、39本文同期receiptと事業タグ判定入力のSHAを保持する。Notion本文列の送信処理は通常cron/CLIのcreate/update/atomic publisherで同じbuilderを使う。読戻しの比較・PREラッチ・未知結果で停止する条件は緩めない。

実原本とnative応答から採ったfixtureは`src/shared/notion-archive/fixtures/9273-s100z2z6-notion-zero-width.json`。原文は保存済みNotion有報テキストの通常パーサー出力と実PATCH要求を全文照合した。

| 根拠 | SHA256 |
| --- | --- |
| 原文本文（3106） | `bdba023bff4b9fcd72b0fcc09d2a8998bdbcf549e1294119e706414b8fda2498` |
| Notion読戻し本文（3105） | `f35bb3a1b26db404c2a65c56922133072b4cd78499b0cd337464ab1441ae2145` |
| 実PATCH要求384 | `a8863d00d1eb4667f30e62b2db143132deda9251347fbd5554f61256481d00de` |
| 実読戻し応答385 | `29ad51dd68aa9ab73d1e19822852f20d1e602cd4f9856270d87202716fdb304c` |

回帰では実native本文への一致、原文mapと判定入力SHAの保持、U+200C/U+200D/U+FEFFと本文以外の値の保持を確認する。同じ通常publisherを通し、可視1文字の追加は`NotionUnknownResultError`で停止し、旧根拠を削除しないことも検証する。新たな原本GET・モデル・依存・DDLは増えない。

Nix（Node22.22.2/pnpm9.15.9）で全体typecheck・変更3ファイルのESLint・関連4 suites/106 testsが通過した。追加処理は既存本文変換ループ内の文字列走査だけで、外部通信・モデル回数は増やさない。全体の処理時間短縮や本番での完了は、このローカル検証から推定しない。

元のbatch10 STOPは保存したままである。この変更のテスト通過やマージだけで9273を受け入れず、固定2社の最新文書・全props・旧根拠と子ブロックを別の有限read-only処理で照合する。再PATCHや旧STOPの成功への書換えは行わない。
