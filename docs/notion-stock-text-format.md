# 有報Notion本文の可逆保存形式

正準処理は `src/shared/notion-archive/stock-text.ts` の `buildTextBodyBlocks` / `readStockTextRow`。外部へ返す `StockTextSection[]`、D1索引、Notionの7プロパティは変えない。

既存のplain-v1は、先頭の `抽出テキスト全文 (N項目)` を明示的に認識し、従来の見出しと本文を無変換で読む。既存行の通常スキップは維持する。新規書込みの先頭には `[json-escaped-v2]` を付け、見出しをJSONの `[itemName, sectionKey]`、本文をJSON stringとして保存する。

JSON標準の引用・制御文字エスケープに加え、UnicodeのCf文字とUTF16 surrogateの各unitをliteral `\uXXXX` にする。日本語BMPはそのまま保持する。これにより既知のU+200B削除条件を送信本文から排除し、補助文字のsurrogateを2000unitの分割途中で壊さない。chunkをすべて連結してから一度だけdecodeするため、エスケープ途中の分割も原文へ復元できる。

v2は未知のmarker・不正JSON・見出し/本文の型違い・fragment欠落/不一致・非正準な再encode・セクション件数矛盾・重複キーで停止する。decode失敗時に旧形式へ切り替えたり、文字を削除・挿入して一致扱いにはしない。文字数プロパティは復元前のJSON量ではなく、抽出した原本文のcodepoint数を保持する。force時の入力検証とブロック/プロパティの純粋組立は旧ページのarchiveより前に済ませ、不正入力で旧本文を不可視にしない。

取得済み2通の68節・296,260codepoint・U+200B4文字を使った純粋検証では、全3fieldと既知U+200B削除条件への投影後の全文が一致した。block数は154/111で、各通の本文書込み2回・読取り2ページを維持する。原文・私有ID・取得鍵は公開しない。

この純粋検証だけではNotionサーバーでv2形式が受け入れられた証明にならない。[後続の本番実行](test-logs/yuho-text2-lossless-actual-20261003.md)では新PRE全112memberを物理保管・独立照合後、2通の全68節を原本文と実往復照合し、全D1 PREに対するpointer2件のみの条件付き更新とPOST物理保管・全文読戻しが成立した。rootと第二者の独立全raw照合もPASS。[既存HOLD記録](test-logs/yuho-text2-roundtrip-hold-20261003.md)は履歴として保持し、元publisher取得時計・旧manifest/SHAのUNKNOWNを保存形式の変更で補完しない。
