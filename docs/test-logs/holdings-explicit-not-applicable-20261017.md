# 株式保有節の明示不該当 — 2026-10-17

保存済みtype1原本の「提出会社の株式保有節が明示不該当」と、原表をまだ構造化できない状態を、通常共通parserで区別する。明示不該当は`explicit_not_applicable`と根拠を返す。株数0・全株式資産の不在・期末時点の数値・価格完了は生成しない。

## 固定した実原本

10銘柄の元plan SHAは`668c272b88866232d8df3fafaa97bb3bae77f0b069307bce458281c31bec5167`。保存済みZIP全10本をNixの通常parserで再実行し、142A/143Aだけを型付き明示不該当に分類した。残8件は従来HOLDのまま。原ZIP・取得時計・既存業務値は変更していない。

| コード/文書 | 実原文の対象 | 判定 |
|---|---|---|
| 142A / S100YHUZ | 当社が純投資・非純投資の株式をいずれも所有しない全文と、両区分の不該当 | 明示不該当 |
| 143A / S100YHBL | `株式の保有状況`節全体が見出しと`該当事項はありません。`だけ | 明示不該当 |
| 141A / S100Z3TN | 子会社の5銘柄と提出会社の非上場1銘柄、一部区分の不該当が混在 | HOLD維持 |

142A/143Aの会計期末は2026-03-31、native `FilingDateInstant`は2026-06-23。提出時のcontextを期末測定日へ読み替えない。142Aは投資株式の両目的、143Aは当該法定節の不該当という範囲を保持する。

CI fixtureは各文書の完全なPublicDoc instance・header・対象HTML（9 member）を収めた選択member用gzip。元物理ZIPではない。各元ZIPのSHA/bytesと各完全memberのSHAは[provenance](../../services/yuho-quant/src/tests/fixtures/holdings-explicit-not-applicable.provenance.json)に分けて保持する。実ZIP10本のpure replay結果SHAは`309e36de9067d6b9f41f3b945adc5c73fd6b04f9c840bf38cd9c0d6b6d1b8caa`（private原本保管下）。

## 通常処理の境界

- 既存の単一・完全なShareholdingsTextBlockだけを使う。空白段落以外の全文を固定2構文と照合し、表・入れ子fact・継続・nil・別主体・一部区分の不該当は資格化しない。
- 同じ展開Mapから既存DEI資格と`readFilingDateInstant`を使う。公式taxonomy/観測済みiXBRLの単一root binding、同提出者・証券コード・期末・実contextの一致が必要。原ZIP/member/原HTML blockのSHA、namespace、native日付、原文をtyped根拠へ残す。
- 通常定時ingest、保存手動CLI、source resumeは同じpublisherへ入る。publisherは`held`と`reasonCode=explicit_not_applicable`を返し、原本行の`要確認`理由と再開情報へ根拠を残す。明細の空配列成功、明細完了marker、新価格queueは作らず、既存価格列も保持する。
- 旧結果未確定・完了source・非0件の旧facts・source cursorを明示不該当へ付け替えない。旧source/owner/ZIPの全束縛と未知項目を保持し、書込前に停止する。価格resumeのparsed/facts一致も緩めない。
- 通常prepareはHOLDのまま同じtyped根拠を保存し、通常applyではskipする。既存の「非0件の適格通だけlegacy custodyを移行する」条件を保持する。元取得時計を付け直さない。

追加HTTP・source GET・モデル・依存・DDLは0。同じZIP展開を再利用し、明細を採用できず固定文面に一致する場合だけ既存context readerを実行する。全量時間の改善や本番負荷は本変更では未受入。

保存同一20本を旧受入parserと変更後parserで1回ずつ純ローカル比較し、非0件10文書36行を含む18結果は全値同一、分類変更は上記2文書だけだった。parser実行のみの単一process実測は旧178.86ms/新198.77ms（20本合計）。この標本以外の性能保証には使わない。比較report SHAは`41380342958289c02d7871d52f97e1553824ab4846389449bcebb696304b037b`。

## 検証と未受入

Nix（Node22.22.2/pnpm9.15.9）で実ZIP10本のpure replay、保存142A/143A/141Aの全member SHA検証、主体・原文可視文字・継続・nil・namespace・context主体/日付/重複・DEIの負例を確認した。共有publisherでは価格列不変・予算未消費・価格queue未生成、旧unknown/nonzero/cursor/completedの書込0、通常prepare/applyでlegacy移行0を確認する。

全typecheck、変更TypeScript6ファイルのlint、関連6suite計170testsがPASS。通信・モデル・業務書込は0。

本番への追加反映は実施していない。既受入の保有原本213行/23文書・価格0/23・未照合旧25行・source HOLD17を変更せず、2件のHOLD解除や全20機能の完了を主張しない。明示不該当を業務上の完了状態へ反映する場合は、既存行との全period照合・物理PRE/POST・旧状態保全を別途受け入れる。
