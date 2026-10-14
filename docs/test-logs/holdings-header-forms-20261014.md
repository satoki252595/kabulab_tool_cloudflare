# 保有明細の括弧付き種別・明示当期列

2026-10-14。保存type1の保有明細で、完全な括弧付き種別名と当期・前期の列順が未対応だった。通常取込、source queue、手動backfillで共用する `parseShareholdingsData` を最小修正した。

- `(特定投資株式)` / `(みなし保有株式)` という完全に対になった種別見出しだけを、既存の同じ種別へ対応させる。不完全な括弧や未知の注記では前の種別を継承しない。
- `当事業年度` / `前事業年度` が各1つ明示された2列を選ぶ。前期・当期の逆順と、ラベル全体を囲む対応した括弧を扱う。値を入れ替えたり生成したりせず、当期の元セルを読む。
- 提出会社の主体判定、種別総見出し、連結ラベル、未知の期間注記、単位・数値・行対応の条件は維持する。純粋な `verifySavedHoldingsSource` 本体はbyte同一。

## 実原典回帰

既に保存・全文SHA照合済みの3通から、完全なnative `ShareholdingsTextBlock` をUTF8 byte rangeで無改変抽出した。fixtureは合計15,342 bytesのgzipで、ZIP・member・抜粋のSHAと範囲をprovenanceへ固定した。新規外部取得は0。

| 文書 | 表形式 | 原表で確認した当期値 |
|---|---|---|
| 1438 / S100XCY4 | `(特定投資株式)` | 4明細。先頭株数22,900株、帳簿126,408千円 |
| 2437 / S100YZC3 | 前期→当期 | 1明細。当期帳簿6,300千円、前期6,694千円を採用しない |
| 1969 / S100YDOU | `(当事業年度)` / `(前事業年度)` | 35明細。先頭当期帳簿7,726百万円、前期3,530百万円を採用しない |

構造回帰では未知・不完全な種別括弧、種別総見出し、連結期間、重複/欠測期間、子会社区画のHOLDと、逆順の上下段セル単位も検証した。fixtureの価格は未取得のNULLのまま。

## 固定3,200社の全保存源比較

完了済み64 chunksをplan SHA `fd478566717ffb7062368d22e38f67fc248088cb748fbc1823347318a7763933` に固定。旧parser `869fb5e7…965bd` と新parserを同じZIP・metadata・source identityで再実行し、全SHAとDEIを検証した。

| 指標 | 結果 |
|---|---:|
| 原本資格成立 / 未確認HOLD維持 | 3,177 / 23文書 |
| 旧適格文書・明細 | 1,534文書 / 18,904明細 |
| 旧適格の値・行順・種別の変化 | 0 |
| 新たに適格 | 38文書 / 361明細 |
| 修正後適格 | 1,572文書 / 19,265明細 |

新適格38文書の最初の停止理由は、種別だけ26、期間ラベルだけ11、両方1。各新明細について当期列、元の株数・帳簿セル、明示単位、表SHA・member SHAを直接束縛した。2,715,197,345 bytesを147.69秒で再解析、peak RSS 421,937,152 bytes。Notion/R2/上流通信、モデル、本番書込はすべて0。

私有証跡は `tmp/feature-audit-20261013/holdings-header-replay-v1/`:

- `summary.json`: SHA `87df1435d737c91148ebb6da269011ae55a09fad1253c2fdd0ab5bfd2e0d2b37`
- `new-ready-raw-proofs.json`: SHA `34bc738b5232d8e8654a71dd9aee76f3d906286141aea2958ccc32f4dbda5023`
- `all-outcomes.json`: SHA `f2da4219f23a9c0b82ed019b0ca3ae1950a3dd95bf9e6a10c195a0a94886fb63`

この検証は全3,666社の終了を示さず、価格資格・fresh物理保管・業務反映も別の受入である。実行中のsource readerは隔離された旧accepted runtimeの実SHAを維持する。旧planを新parserの受入証跡に流用せず、保存ZIPから新manifestへ再解析する。

Nixで関連3 suites 78 tests、全repo型検査、owned parser/testのESLint、diff checkが通過した。
