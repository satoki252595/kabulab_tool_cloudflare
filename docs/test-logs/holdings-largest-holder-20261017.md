# 保有主体の原本順序監査（2026-10-17）

既受入218文書・2,826行を、受入済みの各操作と全POSTのunionから固定し、同じ保存type1を通常parserで再生した。ready planの未実行行、旧unknown1911の31行、206Aの不該当診断は母集団へ混ぜていない。価格採用・既存行訂正・追加原本取得は0。

## 原本で確定した境界

208A / S100Z0JO / FY2026-06-30の提出者は「株式会社構造計画研究所ホールディングス」。同じ完全なShareholdingsTextBlockは、最大保有会社を「株式会社構造計画研究所」と明示し、同社の銘柄を記載すると説明する。この宣言はtable0より前、旧採用4行はtable3にあり、その間に明示提出会社区画への復帰はない。DEI/提出者は検証済みでも、別名義の保有株式を提出会社自身の明細へ採る証拠にはならない。

1518 / S100YBV8の最大保有会社MM Investments(株)の宣言はtable3の前で、旧採用3行は先行するtable2にある。したがって1518は変更しない。最初の2文書7行という候補集計は順序判定前の暫定値で、原本証拠は保持したまま、後段の順序資格で208Aの4行だけへ訂正した。単語一致15社の一括HOLDは行っていない。2498の明示自己ラベル「提出会社の株式の保有状況」と、1407の明示提出会社区画への復帰も維持する。

7322 / S100YD2Kは最大保有会社「株式会社三十三銀行」の別名義である。旧parserは後方の投資目的変更表でunsupportedになっていたが、その表をskipして約70行を提出会社明細として復旧することはしない。今回もunsupportedを維持し、主体未資格の理由を明示する。

## 共有修正と既存値

`parseShareholdingsData`の既存scope判定へ、保存原文の完全な2文型だけを追加した。別の最大保有会社を明示した後はunknownを保持し、区画中の単なる「当社は」で提出会社へ復帰させない。既に資格済みのother区画は従来どおり除外し、明示した当社/提出会社区画だけでscopeを戻す。会社名から新しい法人・証券コードを推定しない。

218文書の全値比較は208Aの4行だけunsupportedとなり、残る217文書・2,822行はsource、context、行順、全株数・単位・金額・旧価格を含む全fieldが一致した。6つの既存split-basis実原本も同じissuer basisのままで、5文書132行の明示株単位を維持した。原表の株単位や期末basisが取れることと、Yahoo/current OHLC・市場日付・権利調整の資格は別である。旧5,362行は価格と株数basisの証拠不足によるunavailableであり、全行の原表単位が欠測という意味ではない。

## 通常経路と未訂正の表示

通常ingestの`publishVerifiedShareholdings`、保存CLI/prepare、source再開、price再開は同じparserを使う。新規の未資格明細は`held`へ進む。完了済みsourceは`recordRecoveryInfo`が自動降格を拒否し、`resumePendingShareholdingsPrices`も原表status/scope/factsの照合後だけ価格source loaderへ進む。今回の変更で価格や株数の補正は有効にならない。

**既存208Aの4行はまだ訂正していない。** Notion行の`原本照合済`がtrueの間は既存formulaが「明細原本照合済」を表示する。今回のparser修正や純監査を、この表示の訂正受入と呼ばない。別の明示1source操作でsourceを「要確認」、4行の`原本照合済=false`と既存`欠測理由`へ主体保留理由だけを反映する案を準備する。全数値・原文・元出典・作成時計を保全し、最新source/原本/全4行PRE、物理PRE/POST、全旧propsと読戻し、単発送信unknown防止を必須とする。非0価格や前回unknownはSTOP。通常ingestの自動完了降格禁止は緩めない。

静的検索範囲`src/`・`services/`では、これらNotion行を独立公開する保有明細API/MCP/SSR readerは見つかっていない。表示の資格は上記Notion checkbox/formulaで確認した範囲に限る。

## 再生証拠

private WT `.runtime/holdings-unit-basis-20261017/source-v1`内に、全入力SHAと全文native/tableを保持する。原本文や署名URLをGitへ追加していない。Gitのfixtureは既存保存ZIPそのものと、旧通常parser全値・公開原本のprovenanceである。

| 証拠 | SHA256 |
| --- | --- |
| `tmp/accepted218-owner-audit-v2/inventory.json`（25受入group・268pins） | `7fb490528aa1b32c3601ea8667dd5a68fddf62ff4d829549105f7f002ac039ca` |
| `tmp/accepted218-owner-audit-v4/baseline-result.json`（旧54097f6d全値） | `ea0f8225a6cb5ce46e8e3beaf1ecb516e0547db68c47f86e7594b6d0447b1b7e` |
| `tmp/named-largest2-native-proof-v1/result-v1.json`（全文/全表、暫定結論は次行で訂正） | `d8dc7d2c44bc7c93b69fd28004ee036d9f299247caebcce2af2528096d2929ca` |
| `tmp/named-largest2-order-qualified-v2/result-v1.json`（1518宣言後/208A宣言前） | `aacf95426b264a0c4c3d6c614b02036fd86eca15bcb471c16aaca2342da7d844` |
| `tmp/accepted218-owner-pair-v3/result-v1.json`（208A4のみHOLD/217全値一致） | `d66fa91cce37babbd08c49265d19d1165b026ff0cbcbe11eb82612caf4766ba2` |

旧218baselineはZIP 201,752,374B、8.350秒、peak RSS728,608KiB。同じ全原本の新比較は4.422秒、peak RSS327,728KiB。別プロセスの保存再生であり、本番通信の性能改善率ではない。source/HTTP/Notion/DB/model/business write/価格・株数調整はすべて0。private監査の途中停止・部分出力は原形で保存し、生産parserの失敗とは区別した。

Nix Node22.22.2/pnpm9.15.9でparser/valuation5suites68件、通常publisher/unknown/replacementと新実原本4suites127件、`tsc --noEmit`、対象eslintを通過。重複suiteを加算した新規テスト件数ではない。peerは機能1fileと実原本のscope順序・復帰を読み取りレビューしblockingなし。rootの独立再生と、既存4行への明示保留操作は別受入である。

rootの独立218再生も同じ1文書4行だけHOLD・217文書2,822行の全値一致でPASS（4.331秒、HTTP0）。`tmp/accepted218-owner-pair-v3/root-review-v1.json` SHA `802ae29756d8bd17cfaa7c05d0ab8046381089e571ccf287ef45bc6fcc46c465`。この再生でも既存4行は訂正していない。

root独立再生（HTTP0・出力は排他的作成）:

```sh
cd .runtime/holdings-unit-basis-20261017/source-v1
nix develop --offline -c env -u NODE_PATH node --max-old-space-size=1024 --import tsx tmp/accepted218-owner-pair-v3/replay.mjs --out=root-review-v1.json
```
