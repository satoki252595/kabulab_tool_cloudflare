# 公式取得元への移行と保存運用の実行計画 (2026-09-28)

Native 実装・テスト・実データ担当の記録。基準 `origin/main 31d206b` (PR156 squash
merge 済み)、branch `fix/official-source-storage-20260928`。本番書込は writer 枠待ち
のため、本記録の検証はコード・隔離 (mock/合成)・読取専用 (公開 HTTP GET・Notion
GET/query・D1 SELECT・R2 GET) のみ。書込 0。

表記: Notion ページ/DB の ID・署名 URL・秘密値は記さない (役割・件数・時刻のみ)。
公開原本 (IMF API 応答・JPX PDF/HTML) の SHA は full で記す。R2 派生 JSON は sha16
まで。一次証拠の全文は `/tmp/*` (0600) に保持し、Git には含めない。

## 1. CODE1: IMF pip 公式口への移行 (実装・テスト・実証済み)

### 旧ミラーの状態 (移行理由)

- 旧実装は DBnomics (CEPREMAP 運営の非営利ミラー) 経由で IMF CPIS を取得。
  ミラーの更新は 2025-04-08 で停止し、複数系列の最新観測が 2024-S1 止まり
  (IMF 本体の公表から約1年遅延)。
- IMF は CPIS を pip (Portfolio Investment Positions by Counterpart Economy) に
  改名し、旧 CPIS 頁は 404。公式 SDMX 3.0 API (`api.imf.org`) は匿名・登録不要で
  到達できることを 2026-09-28 に実機確認した (開発者 portal の signin は SDMX
  data API に不要だった)。

### 公式契約 (一次証拠で確定した範囲のみ)

- dataflow `IMF.STA:PIP` v5.0.0 / DSD `IMF.STA:DSD_PIP` v5.0.0。
  一次メタデータ頁 (`data.imf.org` の `IMF.STA:PIP` 頁、HTTP 200) の表題は
  "Portfolio Investment Positions by Counterpart Economy (formerly CPIS)"。
- データキー順 (応答の keyPosition 0〜6 で実測):
  `COUNTRY.ACCOUNTING_ENTRY.INDICATOR.SECTOR.COUNTERPART_SECTOR.COUNTERPART_COUNTRY.FREQUENCY`
  (+ 観測次元 `TIME_PERIOD`)。
- 固定次元: `COUNTRY=JPN` / `ACCOUNTING_ENTRY=A|L`
  (A=Assets・L=Liabilities) / `SECTOR=S1` (Total economy) /
  `COUNTERPART_SECTOR=S1` / `FREQUENCY=S` (Half-yearly, semester)。
- 指標対応 (意味同一を実測で証明した範囲のみ。指標キー 6 件は旧ミラー時代と同一に維持):
  - `jp_holds_abroad` (資産・報告値): `A` + `P_TOTINV_P_USD` / `P_F51_P_USD` /
    `P_F3_P_USD`。応答属性 `DERIVATION_TYPE=O` (Reported official data)。
  - `world_holds_jp` (負債・Derived): `L` + `P_TOTINV_P_SCC_USD` /
    `P_F51_P_SCC_USD` / `P_F3_P_SCC_USD`。応答属性 `DERIVATION_TYPE=SCC`・
    `DV_TYPE=SCC` (IMF Staff calculations, derived from counterpart data)。
- 結合禁止の実証: `JPN.L.P_TOTINV_P_USD` (報告負債) は存在し、Derived と大きく
  異なる値を持つ (2025-S1 世界計で +28.6%、米国相手国別で +22%)。資産・報告負債・
  Derived 負債の無根拠の同一視は誤りであり、実装の対応表に `L` + 非SCC 指標は
  存在しない (要求も解釈もできない。実バイト列での拒否を検証済み)。
- pip の全 60 指標 (`CL_PIP_INDICATOR` v4.0.0) は "Positions" (残高) でフロー指標は
  無い。`flowType: holdings_stock` を維持する。
- 単位: `UNIT=USD` (US dollar)。`OBS_VALUE` は米ドルそのままの値で係数を掛けない。
  根拠: (a) ミラー値とのセント単位の一致 (下記)、(b) 小数点以下3桁の値、
  (c) `SCALE=6` を 10^6 の乗数と解釈すると世界 GDP の40倍超になり不可能。
  `SCALE` は表示用メタデータとして `6` のみ受理し、それ以外の値・未知の単位が
  来たら throw する。
- 相手国コードは公式 3 文字 (`CL_PIP_COUNTRY` v2.0.0。`G001`=World ほか 16 件の
  名称を確認)。要求側は旧来の 2 文字コード (`W00`・`US`・…) のまま受け、対応表で
  変換する (表に無いコードは throw)。台湾 (`TWN`) の Derived 系列は応答に存在
  しない (台湾は IMF 非加盟で報告しないため。要求しても応答に含まれないことを
  実測)。欠落として明示し、行は作らない。
- 系列ごとの最新期は揃わない (2026-09-28 実測: 資産側は全17相手国が 2025-S1、
  Derived 側は AU・SG が 2024-S2 止まり、TWN は不在)。日本・世界計の最新期到達を
  全部の最新期とみなさない。最新期は要求系列の実観測から求め、応答に明示された
  `TIME_PERIOD` だけで期間を絞る。
- `startPeriod`/`endPeriod` クエリは公式 API に無視される
  (`2024-S1` のみに絞る指定で全 38 期 `1997-S2`〜`2025-S1` が返ることを実測)。
  実装は期間クエリを送らない。`lastNObservations` は有効だが、遅延系列の取漏れを
  避けるため全履歴を取得して呼び出し側が応答明示の期間で絞る。
- 応答ごとに `structures[].links` の Dataflow/DSD の URN (`IMF.STA:PIP(5.0.0)` /
  `IMF.STA:DSD_PIP(5.0.0)`) を検証する。版が変わったら止める (黙った追従なし)。
- 専用の単一応答のみ受理する (`dataSets`/`structures` は 1 件ちょうど。
  複数は混在スコープとして拒み、先頭選択しない)。
- 観測値の検証: 空・空白の文字列は `Number("") === 0` になるため 0 として読まず
  throw する。`null` は非開示として読み飛ばす (0 埋めなし)。
- 系列・観測・次元グループの位置指定の属性値を許可カタログに照合する。
  整数添字は範囲内のみ受理。文字列リテラルは観測した唯一の例外
  (観測値なし行の STATUS 位置の `"C"`: `[null, null, 0, "C"]` の形。
  19 captures 中 26 件・すべて値なし。意味は未定義のため意味付けしない) のみ
  受理する。他の属性・他の文字列・値を持つ行の旗・値一覧がある属性への直書き・
  系列/次元グループ位置の直書きは止める。
  (BIS の `OBS_STATUS` 検証と同型の最小 guard。Sol storage review の指摘対応。)
- `TIME_PERIOD` 値の重複は下流の `validateDrafts` が冪等キー重複として拒む
  (共通 gate。パーサ側での重複排除・上書きはしない)。
- `COUNTERPART_COUNTRY` の複数値 (`USA+GBR+…`) を 1 リクエストで受け付ける
  (17 件束ねて HTTP 200 を実測)。向き×資産クラスの 6 バッチ (計約166KB) で
  99 系列を取る。

### 意味同一と改訂差分の実証 (2024-S1 新旧突合)

| 系列 | 旧ミラー 2024-S1 | 公式 2024-S1 | 差 |
|---|---|---|---|
| 資産・合計・世界計 | 4337640482073.52 | 4330263358778.068 | −0.17% |
| 資産・合計・米国 | 2072394613197.0 | 2067753466689.767 | −0.22% |
| 資産・株式・米国 | 927585184508.034 | 946127519641.4787 | +2.0% (内訳改訂) |
| 資産・債券・米国 | 1144809428688.97 | 1121625947048.288 | −2.0% (内訳改訂) |
| Derived・合計・世界計 | 2806446928109.16 | 2939239361973.019 | +4.73% (改訂) |
| Derived・合計・米国 | 1225933000000.0 | 1225933000000 | 完全一致 (セント単位) |
| Derived・株式・米国 | 1027565000000.0 | 1027565000000 | 完全一致 (セント単位) |
| Derived・債券・米国 | 198368000000.0 | 198368000000 | 完全一致 (セント単位) |

(全文は `/tmp/imf-official-20260928/` の private 0600 captures。各 capture の full
SHA は本記録 §6。資産・合計・米国は合計が安定し株式/債券の内訳だけ ±2% 改訂 =
内訳の再分類であり系列の意味変更ではない。)

### 変更ファイル (CODE1)

- `services/moneyflow/lib/sources/imf-cpis.ts`: 公式 SDMX-JSON 専用パーサへ書換え。
  旧ミラー (DBnomics) の URL・系列コード・パーサは残さない (旧ミラー応答は
  `data` オブジェクト無しとして拒む)。指標キー 6 件・半期ヘルパ・縦持ち変換は維持。
- `services/moneyflow/lib/adapters/imf-cpis.ts`: 6 バッチ (向き×資産クラス) 構成へ。
  保管ファイル名は `imf-cpis-imf-NN.json`。旧ミラー名の混入は throw (混在停止)。
  冪等キーは `imf-cpis-<最新H>-sha-<応答バイト列sha256先頭12桁>`
  (公式応答に版表示が無いため内容ハッシュを版とする。`toObservations` は再計算で照合)。
- バッチは 6 件ちょうどが契約 (欠落バッチの受理なし。各ファイルの中身は
  ファイル番号に対応する要求と突き合わせる)。
- 回帰: `sources/imf-cpis.test.ts` (41 件)・`adapters/imf-cpis.test.ts` (23 件) を
  公式形へ書換え。合成の公式応答 (実応答と同じ骨格・値は作り物) で対応付けと
  検証を確かめる。旧ミラー実ファイル依存のテストは削除
  (新パーサでは読めないことが正しい挙動であり、拒否自体をテストする)。
- `docs/moneyflow.md` の IMF 行・注記を公式口へ更新。

### 検証 (CODE1)

- 上記 64 件の focused テストが全緑 (CI でも走る。skip なし)。
- 実バイト列検証 (`/tmp/*.mts` は throwaway probes。本文書の主張の証拠は captures):
  - 17 系列フルバッチ → 646 レコード (17×38 期)。世界計 2025-S1 の実測値を再現。
  - Derived 最新バッチ → 16 レコード + TWN 欠落の明示 + AU/SG の 2024-S2 止まりを保持。
  - Derived 世界計フル (42 期) → 試行分 4 期を除外し 38 レコード。
  - 報告負債 (L 非SCC) の実バイト列 → 対内期待では拒否 (INDICATOR 不一致)。
  - `start/end` 無視の実バイト列 (38 期) → 応答明示の期間で正しく復号。
  - アダプタ E2E (実 6 ファイル・計166078 bytes) → 384 行
    (資産 68×3 + 対内 60×3。窓 2023-H2〜2025-H1。対内 AU/SG の 2025-H1 未公表は行なし)。
  - 本番 ingest 経路の `--dry-run --only=imf-cpis` (live 公式 API・書込 0) →
    同一キー `imf-cpis-2025-H1-sha-97260a8f93a3`・384 行で成功
    (live 応答が captures とバイト同一 = 決定性も実証)。
- `tsc --noEmit` clean。`eslint src services --max-warnings=0` exit 0。

## 2. CODE2: 週次信用残の利用側データ品質契約 (実装・テスト・実証済み)

### 消費者全経路の調査結果

- 唯一の writer: `scripts/vwap/ingest-margin.ts` → R2 `margin/{week}.json` +
  `margin/weeks.json` (+ Notion 一次保管が先)。Python 側に R2 `margin/` の writer
  は無い (`margin_key` に関数外からの呼出なし。JSF は別源泉の日次 personal-only)。
- 唯一の行読取: `services/vwap-analysis/app.ts` の `GET /api/margin`
  (`weeks.json` → 各週ファイル → `.find(r => r.code === code)` の先頭一致)。
  `all-daily.ts` は job 名の列挙のみ (行を読まない)。
- swing に信用残の消費は無い (grep で CSS の `margin:` のみであることを確認)。
- フロント (`public/vwap-analysis/app.js`) は `/api/margin?n=104` を取得し
  `buy`/`sell` を週次系列として重畳・最新週を meta 表示する。

### 欠陥 (旧 R2 隔離表示の主張は実経路で未証明だった点)

- 崩壊 11 週 (2026-06-12〜09-04) の R2 JSON は 6 コード
  (2593/5076/7550/9201/9202/9434) に同一 4 桁コードの複数行を持つ
  (dupExcess=7)。JSON に ISIN が無いため普通株・種類株を区別できない。
- 旧 API は `.find()` で先頭行を黙って採用し、6 コード×11 週の値を正常として
  返していた (実 PDF の並びでは普通株が先だが、JSON だけでは証明不能)。
- `CODE_RE` は 4 文字のみのため、9/11 以降の 5 桁種類株行は API から到達不能
  (common の 4 桁行のみ返す。用途=普通株の重畳には正しい。既知の制限として残す)。

### 最小契約 (正常な他コード/週を保護。捏造・補完・一律消去なし)

- 新設 `services/vwap-analysis/lib/margin-select.ts` (依存なし。Worker から
  `unpdf` を含む `margin.ts` を引かずに済むよう分離):
  - `selectMarginRows(rows, code)`: `ok` (1 行) / `missing` (0 行) /
    `ambiguous` (2 行以上 + 件数) を明示する純関数。
  - `assertDistinctMarginCodes(rows)`: 同一コードの複数行を列挙して throw。
- `validateMarginData` に重複検査を追加 (崩壊取込の将来の書込を fail-fast で防止。
  正常取込の出力は不変 = もう一方のリポとのバイト同一要件を維持)。
- `GET /api/margin`: 崩壊 (週, コード) は値無しで `weeks[]` から除外し、
  `ambiguousWeeks[]` に週を列挙して返す (後方互換の追加フィールド)。
  正常な週・銘柄は従来どおり返す。
- フロント: `ambiguousWeeks` を受け、除外がある銘柄の meta に
  「信用残高 (一部週を除外) N週を非表示 (銘柄統合の不整合)」と表示する
  (既存の `tip("信用残高")` を再利用。新規の専門用語なし)。
- 回帰: `margin-select.test.ts` (新・6 件)・`margin.test.ts` (+1 件)・
  `app.test.ts` (新・Hono `app.request` + 差替 BUCKET・5 件)。
- 実バイト列検証 (R2 読取の 9/04 崩壊・9/11 正常):
  - 9/04: 6 コードが `ambiguous` (件数 2/2/2/2/2/3)。7203・130A は `ok`。
  - 9/11: 2593・25935・94345・7203 が `ok` ( distinct 値)。
  - writer guard: 9/04 行に throw (6 コード列挙)。9/11 行は通過。
  - API: 2593 → 9/11 値のみ + `ambiguousWeeks: ["2026-09-04"]`。
    7203 → 両週の値 + 除外なし。

## 3. 水平展開の調査 (同型のみ。結果: 追加の修正なし)

- 他 spec に DBnomics/ミラー利用は無い (`imf-cpis` が唯一だった)。
- `startPeriod`/`endPeriod` の使用は他 spec に無い。`lastNObservations` の使用は
  BIS のみで、系列ごとの最新 2 観測・消滅国の過去行・呼出側の期間絞り・世界計より
  新しい期の throw (adapter の newer-period guard) と、CODE1 と同型の不備は無い。
- IMF 改名の機械的な横展開はしない (指示どおり)。
- 結論: 同型不備の追加発見なし。水平方向のコード変更なし。

## 4. 本番適用 plan (writer 枠で root が直列実行。未 apply)

共通 gate: 対象 writer の実行中 0・queued 0。各 plan は適用→再読→2 回目 0 件までを
1 枠で直列。新コードの適用は承認済みの範囲のみ (未承認コードの apply 禁止)。
初期 normal DAG: P3→B(benefits)→A(overseas)→market(saved inputs)→catchup(edinet)→
P2→daily-intra→P1 (root 調整可)。

### P3. ①マスタ重複の適用 (最優先・本記録の早期提示分)

fresh 読取専用 (書込 0。全文は `/tmp/p3-fresh-20260928/targeted.json` 0600)。
APPLY のみ writer 枠待ち (read-only plan 自体に grant 不要)。

- 対象 4 ページ (役割のみ。ID は記さない): 3681 keep/retire・7129 keep/retire。
  全て active (`archived=false`・trash でもない)。
  - 3681 keep: created 2026-06-28T02:34Z・edited 2026-09-15T16:20Z (月次 sync)。
    子 0・incoming 0 (開示0・財務0)・forward 原本 1。
  - 3681 retire: created 2026-06-28T02:34Z (keep と同分。page-id 決定は既存
    テストの規則どおり)・edited 2026-09-01T23:40Z。子 0・incoming 開示12・財務8・
    forward 原本 1。
  - 7129 keep: created 2026-06-28T02:44Z・edited 2026-09-10T17:31Z。
    子 1 (子DB「株価テクニカル履歴」。非空・既存・P3 では触らない)・
    incoming 開示11・財務8 (全 19 行が keep のみを指すことを個別再読で確認済み。
    既に収束しており移行対象なし)・forward 原本 1。
  - 7129 retire: created 2026-06-28T06:44Z (keep より後)・edited 同刻 (無変更)。
    子 0・incoming 0・forward 原本 1。
- canonical: 既存の最古収束どおり keep 側 (3681 は同分タイの page-id 決定、
  7129 は keep が古い)。D1 `jss_notion_pages` (fresh SELECT): 3681・7129 とも
  1 行ずつ・別 page_id・同一バッチ時刻 2026-09-15 16:21:08。後方8桁の照合で
  両行とも keep 側を指すことを確認 → D1 step は verify-only (0 writes 見込み)。
- 移行対象 (rows が退役側を指すことを個別再読で確認した分のみ):
  - 3681: 開示12 + 財務8 = 20 ops (全て still-link-retire を確認)。
  - 3681 raw 行: 退役の forward 原本が指す 1 行は 2026-09-01T23:05Z に書換え済みで
    関連 25 件中に 3681 を含まない (keep の forward 原本 1 件とは別行) →
    移行 no-op (証拠付き)。捏造・補完しない。
  - 7129: 開示・財務は移行 0 (keep 側に収束済み)。raw 行 1 件
    (関連 5 件 = 他 4 + 退役。edited 2026-06-28 のまま) → 1 op
    (退役→keep の置換。他 4 件は保持)。
  - 7129 の開示 11 件は lane C 時点の「10 件」から +1 (新規開示の到着または
    集計基準差。snapshot が created 時刻で確定する。数合わせの推測をしない)。
- 補足: 3681 は行なし。7129 は 1 行・`銘柄マスタ` relation が EMPTY
  (lane C どおり) → 1 op (keep を設定)。
- 退役 2 ページ: 子 0・移行後 incoming 0 の純 empty → 既存契約どおり直接 archive
  (PATCH archived:true。`moveToTrash` 不可・Service 推測 stamp 禁止・ごみ DB 新設なし)。
  内容の証拠は snapshot (full JSON) + receipt。
- 限定 mutation counts (apply 1 枠の見込み): incoming 更新 21 (3681×20 +
  7129-raw×1) + 補足 1 + 3681 lifecycle 1 (下記) + D1 0 + 退役 archive 2。
  snapshot 記録 1 (一次データ保管) は本記録の snapshot-only 枠で完了済み
  (receipt あり)。変更しない全 normal 列: keep 2 ページの非 relation props
  (既知の例外: 3681 keep の `状態` 1 件のみ apply で更新)・
  対象外 incoming 行・他コードの補足行・D1 他行 (before/after 比較で不変を証明)。
- 3681 lifecycle (fresh): keep は `上場状態=false`・`状態=(none)`。
  `上場状態` は false のまま (listedStaysFalse 成立)。
  `状態` は `上場廃止` への更新が NEED (1 op。apply 枠)。
  退役は `上場状態=true`・`状態=上場廃止` (参考。退役自体は archive 対象)。
- D1 正本照合 (full ID の正規化比較。suffix ではない): 3681・7129 とも
  `equalsKeep=true`・`equalsRetire=false` → D1 step は verify-only (0 writes)。
- count 照合 (snapshot vs targeted。delta 0): incoming 22 行
  (3681 開示12・財務8・raw1 + 7129 raw1) + 補足 1 行。うち移行対象は 21 行
  (3681×20 + 7129-raw×1)。3681 raw 行は full relation 読取 (3818 件。
  page_size 25 の打切り回避) で退役を含まないことを確定 → no-op (証拠付き)。
  7129 keep 側 19 行は keep のみを指すことを個別再読で確認 (移行 0)。
- snapshot (writer 枠・完了): `archiveSnapshot` (承認済み既存関数) で
  `master-dedup-102` / `master-dedup-3681-7129/snapshot/v1` に記録。
  snapshot JSON (4 masters 全文 + 22 incoming 全文・全 relation・子 inventory +
  補足全文 + D1 + 証拠) + `Edinetcode.zip` + `jpx-delisted.html` の 3 ファイル。
  記録後に GET 再読 (Status=recorded・Files 3 件) + 3 ファイル実ダウンロードの
  full SHA 照合まで完了 (receipt あり。全文・ID は private)。
  snapshot sha256 の先頭 16 桁: `a3a6a27af40292e5` (全文は private receipt)。
  取込 shape は `takeSnapshot` と同一。差分は文書化済みの 2 点のみ:
  (a) 剥離済み 3681 raw 行を証拠として含め throw しない
  (migration planner は retire-link filter で自然に 0 op)、
  (b) `incomingSchema` は targeted-only 注記 (full 列挙は apply 枠で再実行。
  不一致時は apply guard が停止する)。
  添付 inventory: 4 masters + 22 incoming + 補足 1 の子に file/image 系 0 件 →
  添付の別途保管・照合は不要 (vacuous)。
- fully-captured proof (本 snapshot の物理範囲。全文は private):
  master 4 ページ全文 + 子 (3681 keep 0・3681 retire 0・7129 keep 子DB 1・
  7129 retire 0) + incoming 22 行全文・全 relation 配列 (has_more は full 読取。
  最大 3818 件)・子 inventory + 補足 1 行全文 + D1 2 行 + 証拠 2 ファイル
  (EDINET zip・JPX html)。非対象 (keep 側 19 行・他コード補足・D1 他行) の
  不変は apply 枠の before/after 比較で証明する (本記録は before 側の確定のみ)。
  private: `/tmp/p3snap/snap/` (snapshot JSON + 証拠 + receipt。0600)。
  正常 jobs (master_sync・biztag) の成功は未証明 (予定の成功を推測で書かない)。
- CAS preimage (current-before 正準 hash): targeted 読取の
  `sha256 = 2b435ecb2f3324074541ea6f4da959d48dd7650274a75443324c90c331d38eb8`
  (master 4 ページ全文 + 子 inventory + incoming 集合 + 補足 + D1 の正準 JSON)。
  full snapshot (below) の hash が正本になり、apply 直前に再読して一致を要求する。
- 途中 failure の停止・resume 境界: 既存 helper (`master-dedup-3681-7129.ts`)
  の guard (TARGETS・EDINET・JPX・D1 の不一致は plan のみ保存) →
  snapshot → `recordPrimaryData` → 検証 → 移行 (op 毎に actualBefore 照合) →
  補足 → lifecycle → D1 → archive。receipt 存在時は完了 op を再検証のみ
  (書換えなし) で再開。incoming-schema 再列挙が snapshot と不一致なら停止。
- 正常成功 criteria: `master_sync.yml` (no inputs) の通常 run 成功 →
  `catchup.yml target=biztag` の通常 run 成功 + fresh 保存の重複 0。
  #102 の旧 failed close は実 normal 成功の後に行う。
- 待条件 (concrete): APPLY は (a) writer 解放 (解放時は対象 writer の
  実行中 0・queued 0 を root が fresh 確認すること。本記録の読取は grant 不要で
  完了済み) + (b) 共通 snapshot/all-apply 根因コードの main 反映 (未実装。
  全 apply 入口の完全 proof/CAS gate を含む) + (c) #160 moneyflow 依存の修正
  適用 (未適用。独立 cron gap + producer 実成功/source-date coverage 担保) が
  全て揃うまで HOLD。承認済み main (156 反映) 上の master-only 適用であり、
  IMF 未承認コードの apply は含まない。
- full plan (incoming-schema 全列挙つき) は `master-dedup-3681-7129.ts` の plan
  モードで試行したが、workspace の DB schema 列挙が 60 分を超えても終わらず
  (1.4 秒 pace × 大量 DB。CPU は待機のみで進行は正常と見られるが完了見込みが
  立たないため) 打ち切った。書込 0・成果物なし。本 targeted 読取 (4 ページ全文 +
  子 inventory + incoming 全行の個別再読 + 補足 + D1) が read-only plan の証拠
  として成立している。未知 incoming-DB の完全列挙 (single_property 方向) は
  apply 枠で full plan を再実行して得ること (apply 時の guard が snapshot との
  一致を要求するため、どのみち apply 直前の fresh が要る)。
- full incoming-schema 列挙 (完了。打切り後の checkpointed 再実行):
  `enumerateMasterIncoming` と同一の検出ロジック (search + per-DB schema +
  master-bound relation 検出) を短命 batch に分割して全 DB を走査。
  `dbCount=8378 hits=6 unknown=0`。`guardIncomingSchema` (承認済み) =
  known-only OK。6 hits は既知のみ: ③財務サマリ/銘柄マスタ (dual)・
  ④開示書類/銘柄マスタ (dual)・⑤原本ファイル/関連銘柄 (dual)・
  ⑧需給/銘柄マスタ (dual)・⑨株主優待/銘柄マスタ (dual)・
  銘柄マスタ（補足）/銘柄マスタ (single)。未知 single_property incoming は
  存在しない (上記「打切り・apply 枠で再実行」の未知-有無の問いは closed。
  apply 直前の fresh 再列挙は guard の一致要求として依然要る)。
  完了 2026-09-28 19:35 UTC。書込 0 (read-only)。private:
  `/tmp/p3-full-20260928/` (dblist・hits・evidence・batch logs。0600)。

### P2. 週次信用残の再保管・修復

before (fresh 読取専用・書込 0):

- R2 `margin/weeks.json`: 13 週 (2026-06-12〜09-18。7/3・7/10 欠落のまま)。
- 6/12〜9/4 の 11 週: 各 dupExcess=7・5 桁 0 (崩壊のまま)。
  8/28 は 4229 行・9/4 は 4226 行。etag/sha16 を全週取得済み
  (R2 条件付き書込の CAS 用。全文は private inventory)。
- 9/11・9/18: dup 0・5 桁 7 (正常。無変更で保護)。
- Notion `一次データ｜vwap-analysis` の `jpx-margin-*`: 0 行 (9/18 再保管は未実施)。
- 原本 PDF の SHA 再検証 (laneC 確保分): 9/18・8/28・9/4 の 3 本とも task 記載の
  full SHA と一致 (再掲は §6)。
- 現行 main コードでの再 parse: 8/28 は 4229/4229 distinct・9/4 は 4226/4226
  distinct・5 桁 7 (`25935/50765/75505/92015/92025/94345/94346`)・原本バイト不変・
  `validateMarginData` (重複検査つき) 通過。`weeksMissing` は 7/3・7/10 のみを報告。

apply (writer 枠・既存 normal 経路のみ):

1. `--week=20260918` で 9/18 PDF を再保管 (bytes は full SHA と照合) →
   物理添付の再 GET 読取で sha 照合。R2 9/18 は正常のため書換えなし。
2. `--week=20260828`・`--week=20260904` で R2 JSON を再生成・上書き
   (旧 JSON の etag/sha16 を CAS 条件と証跡に記録。`r2Put` の `IfMatch` を使用) +
   PDF 保管。全コード別の保存比較 (旧 4 桁崩壊 7 行 → 新 5 桁 distinct 行への
   置換と、他コードの不変) を記録。
3. R2 `weeks.json` の不変 (13 週のまま) と 9/11 の無変更を確認。
4. 7/3・7/10 と 6/12–8/21 の 9 週は欠落・既知不良のまま残す (原本なし)。
   `missingWeeks` が 7/3・7/10 だけを示すことを出力で確認。
   崩壊 9 週の API 表示は CODE2 の `ambiguousWeeks` で除外明示される (R2 書換えなし)。
5. `vwap-ingest target=margin` の normal 最新版成功 + 原本 physical/actual-saved proof。
   新様式/日次は deferred (旧 weekly の範囲のみ)。

### P1. moneyflow 初回保存 + IMF 公式切替え

before (fresh 読取専用・書込 0):

- moneyflow 4 DB (primary/defs/obs/runlog): 全て 0 行のまま
  (page_size 1 probe + has_more=false)。schema 列数はコード定義と一致
  (primary 10・defs 9・obs 13・runlog 7)。
  注意: defs/obs/runlog の `last_edited_time` が 2026-09-28T12:56:00Z に更新
  されている (primary は 9/27 のまま)。適用前に schema の再照合を行うこと
  (不足列の PATCH 移行は既存動作。列の削除・型変更が無いことを確認する)。
- IMF 新コードの live `--dry-run --only=imf-cpis` (書込 0):
  `imf-cpis-2025-H1-sha-97260a8f93a3`・384 行で成功。live 応答は captures と
  バイト同一。
- 監査の 25 spec dry-run OK は既存証跡を参照 (本記録では重複実行しない)。

apply (writer 枠・IMF 公式コードの merge/deploy 後):

1. 25 spec を既存 normal 保存経路へ (`dry_run=false`。`only=""` 全件)。
   全 keys/periods/units/schema/relations/physical-source-SHA/保存 obs を比較する。
   既存 5121 行の count 固定 expect はしない (旧 counts は前提にしない)。
2. 再実行: unchanged な source/obs の writes 0。正当な NEW runlog write は別 count
   (全 Notion 0 と虚偽主張しない)。
3. IMF 公式切替えの改訂差分 (2024-S1 の例: 資産・合計・世界計 −0.17% /
   Derived・合計・世界計 +4.73% / 内訳 ±2%) は、snapshot/CAS の限定修復として扱う。
   旧ミラー 2024H1 出典の黙った付替えはしない (source 表示は公式へ更新済み。
   指標キーは意味同一の範囲で維持)。
4. `recordPrimaryData` → observations 全 draft upsert → prior captures 再読 →
   before/after full-Normal の同一限定 actual-diff の順で記録する。
   `catalog` logging/`source_key` バグは #156 の fix を使う。

## 5. writer 所有と root への決定事項

- 本 stage の書込: 1 件のみ (P3 snapshot の `recordPrimaryData`。
  snapshot-only grant の範囲内。lease は結果報告とともに返却済み)。
  P3 migration・P2・P1・IMF prod の書込は未実施 (grant 待ち)。
- P3 migration の minimal grant 待ち (pre-migration set は §4 P3 に完備:
  full-ID 照合・count delta0・receipt/fullSHA/CAS・lifecycle NEED 1 op)。
  P3 の master 正常成功で B (benefits) の source-apply 依存を解除できる。
- P1 は IMF 公式コードの merge/deploy 後に実行 (未承認コードの apply 禁止)。
- moneyflow schedule 未発火の扱いは C 記録 §6 の提案どおり
  (P1 の手動 dispatch + 翌発火の監視)。
- 日次信用残 job の初回設計に backfill 要求を含めること (C 記録 §6 の提案どおり)。

## 6. 証拠インベントリ

(集計のみ。全文・ID・URL・body・secrets は `/tmp/*` 0600 のみ)

- `/tmp/imf-official-20260928/f{1..6}-*-full.json`: 公式 6 バッチの full history
  (計166078 bytes)。SHA は §1 の E2E 記録と dry-run 証跡に記載。
- `/tmp/imf-official-20260928/q*.json` (13 件): counterpart/indicator 候補・
  報告負債の存在・start/end 無視の各 probe。b1–b6: 系列別最新期バッチ。
- `/tmp/imf-official-20260928/pip-datapage.html`: 一次メタデータ頁 (HTTP 200)。
- `/tmp/laneC-imf-pipflow.json` (2877031 bytes): 公式 structure
  (dataflow+DSD+53 codelists+concept schemes)。
- `/tmp/laneC-01-syumatsu*.pdf`: 8/28・9/4・9/18 原本 (SHA は task 記載と一致)。
- `/tmp/p2-fresh-20260928/r2-margin-inventory.json`: R2 全 13 週の
  rows/distinct/dupExcess/five/etag/sha16。
- `/tmp/p1p2-fresh-20260928.json`: moneyflow 4DB (0行・schema列数・時刻) +
  vwap `jpx-margin-*` (0行)。
- `/tmp/p3-fresh-20260928/targeted.json`: P3 targeted fresh 読取全文 (0600)。
- `/tmp/p3snap/snap/`: snapshot JSON + `Edinetcode.zip` + `jpx-delisted.html` +
  receipt JSON (0600)。snapshot sha256 先頭 16 桁 `a3a6a27af40292e5`。
  Notion 記録の再読・実ダウンロード full SHA 照合まで完了 (receipt あり)。
- `/tmp/imf-official-20260928/dryrun-imf-cpis.json`: live dry-run 出力全文。

### full SHA (公開原本のみ本文記載)

- margin 9/18 PDF (873311 B):
  `21c99f4e06641cae0270bd8151c41d45559e28a08f165a829726b9601c52131d`
- margin 8/28 PDF (856411 B):
  `660596c6e48730d490c7ea99a638b082a3ab71dba94f3647b4a15fa3a8b11c99`
- margin 9/4 PDF (867440 B):
  `c263121c131e6a79a01353d1e7ae94e8b22a45368104f1fdd76690eee43b0bfd`
- IMF structure (laneC-imf-pipflow.json, 2877031 B):
  `48cca344729fee9b2f6f67b3666076f13899da6cdce78c0ffe5d7712feffdcd9`
- IMF f1–f6 full batches:
  - f1 `201d1f37a149a23f5dd70606a1ba79dbb2f72b6818dc9339ef1befe7e809994c`
  - f2 `8f136d7f1d696436d03ee375c00a39344c37c1239440d0571b5adc4a21e4aa19`
  - f3 `2990b9bc47e5ece69fdf6c7d3176ea7a0bdfc6904a8b208d54df386ec23a95d3`
  - f4 `9aa6090c39fc94a65597555361581a754695dbad0cf5ab99d650e43999871278`
  - f5 `4a99b3fdcfa989263e98e1fa644df0b62401a670747e24384bcf5409fd9c53e0`
  - f6 `8ea93b11ba6073a12e3fa12d609626bccf58d7ae2331e670d8965d272de604c6`
- IMF PIP datapage (300411 B):
  `9a6f8a33014f6f35bb33966e65f4c81c41c8a3fa828e61ba1400b5bd9076f2c2`
- IMF q/b probes (意味同一・最新期・無視クエリの実証):
  - q01 `d8f3864d2335c4023423120943d1e59690c3778b8127ece96d99cebdb086b8c8`
  - q02 `7c63e5beb43d6ff83d61f1d1ac973659d1e0e8379d47a96d4868b724f4a140f2`
  - q03 `cd3d09b636994f7c25cffc652b5cc39384000ff0acb901fa60122b430d340bc9`
  - q04 `f1d97d3408d9e113851e8afbccdf89882e0e716e3e9eeff51aee8f89c5dc8447`
  - q05 `c3a3c58ee08e82ba17f5e83aefdf5da4f3f573025eb45f938b2a0854a489c77c`
  - q06 `2e6db40d291b2581f326bc149db91775bb8fa156e612e5a49db45437881af5db`
  - q07 `f19dd5218f054758fb392d791b2284f976eb9c583e786ec6985f7da983e3d021`
  - q08 `94f2990c091a3e340da8f30cad4b80efd488bd6bca65053af6748483fe63fdf3`
  - q09 `34f634e1732176a87ac2ec2e01e63f4e10ab2dee8c45c5c0033fcc9397eedab6`
  - q10 `b076d0a91a33223f66c4576e85f68a8d5461628676c052fbef44c060ee5fdd45`
  - q11 `3415370de464bb4460da3bf862bdc42a983adf87a586500841e0da953ec7fed4`
  - q12 `3961abcb61672166346dbb351adf11c3be77c44ee3475b19ca58232d4a9eb099`
  - q13 `5e8dbb4b08841e4710f67268a1ee6d8474fe20a8807be6d71f66591aa6b523ad`
  - b1 `f4f5437026b21a9477f8818d63f0ab1dbd67ee749a60aee82d526891c32dd829`
  - b2 `3f71f5214c741c9b51334332b213a2f80a17ade30a7701b95801db495676c667`
  - b3 `ddf0f5137c9a32bb800d43b533481803e00773473d5f98c8f94429fc7ef0b0e3`
  - b4 `8e067809afb88360109bd63fc86f4d95823f6c45adee911a2fe53697efb52009`
  - b5 `aee0c5e67a6481cbcb7e72cbc0c8a7b4df835a240494b7ebdd3066f0ed51578b`
  - b6 `f072c6e24b4b7d630aaffb61ab8ff56982a55d39567331d1d69530a94665b1e7`
- IMF live dry-run 出力 (`dryrun-imf-cpis.json`):
  `7d7b3ea7151da32a5b0164cbe60cba349d296d6db738ceafe0e9e4472a8dba27`
