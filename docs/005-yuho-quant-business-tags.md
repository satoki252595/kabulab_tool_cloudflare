# 005 yuho-quant — 銘柄マスタ（補足）と事業タグ（設計書）

有報（EDINET 有価証券報告書）の開示テキスト 39 項目を **1 銘柄 1 行**の Notion
データベース「銘柄マスタ（補足）」に構造化して置き、「事業の内容」（＋セグメント情報・MD&A・研究開発活動の該当箇所）
から**単語帳（語彙）に沿った事業タグ**を jev（TypeSafe System One）で判定して
同じ行のマルチセレクトに持たせる。

- 読み手: 人（Notion で閲覧・監査）と姉妹プロジェクト kabulabAgents（会員の
  「注目テーマ」に合う銘柄探し）。kabulabAgents 向けの契約は
  [005-yuho-quant-business-tags-contract.md](./005-yuho-quant-business-tags-contract.md)。
- 置き場所: Notion「株式情報」ページ（Python パイプラインの ① 銘柄マスタ 等と同じ親）。
- **D1 には何も書かない**（コスト判断。2026-09-25 運営決定）。D1 は既存表を読むだけ。

## 1. 守ること（原則）

1. **AI に事業内容を作文させない。** 保存・表示するのは次の 3 つだけ。
   - 単語帳の語（ID・名前）
   - 判定の確率と帯（はい／確認不能／いいえ）
   - 根拠として有報から**コードで抜き出した原文の文**（書類 ID・会計期末つき）
2. **黙って埋めない（ルール2）。** データが無い・失敗したときは状態を
   「本文なし／読込失敗／判定不能／未判定」と明示する。未判定を「該当なし」と
   扱わない。件数は実行サマリと GitHub Issue で運営が見られる。
3. 秘密は `.env`（ローカル）と GitHub Secrets（Actions）だけ。リポジトリは PUBLIC。
4. 出所は EDINET の有報原文（PDL1.0・出典表示）。既存 yuho の扱いに合わせる。
5. 単語帳の出典は公的資料に限る（GICS・株探/みんかぶのテーマ・指数構成銘柄は使わない）。

## 2. 全体像

```
EDINET ──(既存) Worker /yuho-quant/admin/catchup──> D1 yuho_documents(索引)
                                                   └> Notion「一次データ保管」の単一DB「有報テキスト」(本文)
                     │ 平日 catchup.yml の次のステップ (J1: 新 workflow を足さない)
                     ▼
     pnpm biztag run  (GitHub Actions / Node)
       1) 単語帳の見直し関門 (未審査の提案があれば) ・期限切れ通知の検査
       2) 作業一覧: D1 の銘柄ごと最新有報 と 補足 DB の行 を突き合わせる
       3) 1 銘柄ずつ: 本文同期 (有報テキスト行→補足行の 39 列)
                     → 絞り込み (コード) → jev 判定 → 行を更新 + 根拠を本文へ
       4) 見直し材料 (review packet) を台帳 DB に更新
                     │
                     ▼
Notion「株式情報」
  ├─ 銘柄マスタ（補足）    … 1 銘柄 1 行。39 本文列 + 事業タグ + 状態
  └─ 事業タグ単語帳（台帳） … 単語帳の版・提案・見直し材料・通知の記録

Cursor Automation（年 1 回・8 月）
  GET  /yuho-quant/vocabulary/review-packet ─┐ (合言葉 = VOCAB_REVIEW_TOKEN)
  POST /yuho-quant/vocabulary/proposals ─────┘→ 台帳 DB に「提案（未審査）」
```

「取り込み直後にキューへ積む」は、**D1 の最新有報 ID と補足行の有報書類 ID の差分**で
実現する（キュー表を持たない）。差分方式は取りこぼし・二重実行に強く、D1 書込も
要らない。新しい有報の本文は Worker 取込で Notion「有報テキスト」に入るので、
タグ付けはそこから 1〜2 リクエストで読む（Worker の取込時間予算を増やさないため、
判定は Worker 内で行わない）。

## 3. Notion の構成

### 3.1 銘柄マスタ（補足）

親: 「株式情報」ページ（`NOTION_STOCK_INFO_PAGE_ID`）。探索は Search の完全一致 +
親ページ一致 + 最古優先（P6 重複事件の教訓。`archive.ts` と同じ）。作成後は
`NOTION_STOCK_SUPPLEMENT_DB_ID` に ID を記録すると Search を使わない。
スキーマは「足りない列だけ足す」（`dataset.ts` の `ensureChildDb` と同じ流儀）。
マルチセレクトの選択肢は**書き込み前にスキーマ更新で作っておく**（既存の選択肢は消さない）。

| 列 | 型 | 意味 |
|---|---|---|
| 銘柄名 | title | `core_stocks.name` |
| 銘柄コード | rich_text | 4 桁。**冪等キー** |
| 銘柄マスタ | relation（片方向） | ① 銘柄マスタ（`NOTION_DB_STOCK_MASTER`）の同じ銘柄コードの行 |
| 33業種 | select | `core_stocks.sector33`（EDINET 提出者業種・commercial-ok） |
| 有報書類ID | rich_text | 本文列の出所の書類（EDINET docID） |
| 書類種別 | select | 有報（120）／訂正有報（130） |
| 会計期末 | date | 書類の会計期末 |
| 提出日 | date | 書類の提出日 |
| 本文の状態 | select | 取得済／本文なし／読込失敗 |
| 事業タグ（素材・部品・装置） | multi_select | 単語帳 business 層・`notionColumn=upstream` の「はい」 |
| 事業タグ（製品・サービス） | multi_select | 同 `notionColumn=downstream` の「はい」 |
| 投資テーマ | multi_select | theme 層。上の 2 列の語から**決定的に導く**（判定しない） |
| 要確認タグ | rich_text | 「確認不能」の語（名前と確率） |
| 事業タグの状態 | select | 判定済／本文なし／読込失敗／判定不能／未判定 |
| 事業タグの根拠書類 | rich_text | `S100XXXX 2025年3月期` |
| 単語帳の版 | select | `v1` など |
| 事業タグ判定日 | date | 判定した日（JST） |
| 候補語数 | number | 絞り込みで残った語の数（0 = 語なし） |
| 判定入力 | rich_text | 渡した本文の範囲と文字数（例「事業の内容 全文 808字／補足 MD&A2・研究開発1段落 1,122字」「事業の内容 抜粋 冒頭3,000字+該当4箇所（原文14,512字）／補足 該当なし」） |
| 判定エラー | rich_text | 直近の失敗理由（成功で空） |
| 再試行回数 | number | 連続失敗回数（成功で 0） |
| 次回再試行日 | date | 失敗後に再試行してよい日 |
| （39 本文列） | rich_text | `TEXT_SECTIONS` の項目名そのまま（例「事業の内容」「事業等のリスク」…）。原文全文。 |

- 本文列は `TEXT_SECTIONS`（`services/yuho-quant/src/services/edinet/text-sections.ts`）が正本。
  列名 = `title`。その書類に無い項目は空（＝非開示。捏造しない）。
- 実測（2026-09-25・全 37,945 通）: 1 項目の最大 30,000 字・1 通合計の最大 211,899 字。
  1 列は rich_text 2,000 字 × 最大 15 要素で収まる。1 要求 500KB を超える分は
  列単位で複数の PATCH に分ける（行の上限 2.5MB の内側）。
- 本文の分割はサロゲートペアを割らない（コードポイント境界で 2,000 以下）。
- **不変条件**: `事業タグの状態 = 判定済` ⇔ `事業タグの根拠書類` の docID = `有報書類ID`
  かつ `単語帳の版` = 判定に使った版。書類が変わったらタグは一旦消して判定し直す
  （古い書類のタグを新しい書類のもののように見せない）。

#### ページ本文（根拠）

行のページ本文には、トグル見出し 1 つ（`事業タグの根拠（単語帳 v1・有報 S100XXXX 2025年3月期）`）
の下に、語ごとに引用ブロックを 1 つ置く:

```
▼ 事業タグの根拠（単語帳 v1・有報 S100W6XE 2025年3月期）
  ┃ 半導体パッケージ・基板材料（はい 0.93）
  ┃ 「…ABF（味の素ビルドアップフィルム）は…」
  ┃ — 有報 S100W6XE 2025年3月期「事業の内容」
  ┃ 要確認: 〇〇（確認不能 0.55） …
```

判定し直すときはトグルを 1 つ削除して作り直す（2 リクエスト）。

### 3.2 事業タグ単語帳（台帳）

同じ「株式情報」ページの下。1 行 = 1 記録。本文に JSON を code block（2,000 字ずつ）で
置き、プロパティ「ハッシュ」に SHA-256 を持つ。**読むときにハッシュを照合し、
一致しなければ throw**（Notion 上で手で書き換えた値を黙って読み戻さない）。

| 列 | 型 | 意味 |
|---|---|---|
| 名前 | title | `v2` / `提案 2027-08-02 …` / `見直し材料` / `通知 2027 期限切れ` |
| 種別 | select | 版／提案／見直し材料／通知 |
| 状態 | select | 版: 有効・置換済 ／ 提案: 未審査・採用・不採用・変更なし ／ 通知: 送信済 |
| 版 | rich_text | 版名（例 v2）。提案は基にした版 |
| ハッシュ | rich_text | 本文 JSON の SHA-256（hex） |
| 記録日 | date | |
| 理由 | rich_text | 関門の判定理由（コードが作る文。提案者の作文は入れない） |
| 差分 | rich_text | 追加・変更・廃止の語 ID 一覧 |
| 巻き戻し元 | rich_text | 巻き戻しで作った版なら、内容の出所の版 |

- 単語帳 **v1 はコード**（`services/yuho-quant/src/biztag/vocabulary/v1.ts`）で版管理し、
  初回実行時に台帳へ「版 v1（有効）」として投入する（投入は 1 回だけ・ログに出す）。
- **v2 以降は台帳が正本。** 有効な版はちょうど 1 つ。0 個・2 個以上・ハッシュ不一致は throw。
- 巻き戻しは「前の版と同じ内容の新しい版」を作る（履歴を消さない）。

## 4. 単語帳（語彙）

型は `services/yuho-quant/src/biztag/vocabulary/schema.ts`（zod）。

- 2 層: **business（事業・製品。判定対象）** と **theme（投資テーマ。business 語の集合）**。
- business の語は `notionColumn` で 2 列に分かれる（upstream＝素材・部品・装置、
  downstream＝製品・サービス）。各列・テーマ列とも **100 語以内**（Notion の
  選択肢の上限を安全側で守る）。
- 1 語のレコード:

| フィールド | 規則 |
|---|---|
| `id` | `B.<FAMILY>.<UPPER_SNAKE>` / `T.<UPPER_SNAKE>`。**変えない・使い回さない**（廃止しても欠番） |
| `layer` | `business` / `theme` |
| `family` | business のみ。`SEMI` `ELEC` `ENERGY` `MAT` `MED` `MACH` `MOBI` `DEF` `ICT` `FOOD` `FIN` `RE` `LOGI` `CONT` |
| `notionColumn` | business のみ。`upstream` / `downstream` |
| `labelJa` | Notion の選択肢名。カンマ（`,` `、`）禁止・40 字以内・大文字小文字を無視して一意 |
| `definitionJa` / `definitionEn` | 判定の指示文に使う（En を jev へ渡す） |
| `keywords[]` | 有報に実際に出る表記（同義語・略語）。絞り込みに使う |
| `excludeKeywords[]` | その文に含まれていたら、その文の当たりを数えない |
| `members[]` | theme のみ。実在する business の `id` |
| `sources[]` | 1 つ以上。題名・URL・日付・該当項目・短い原文引用 |
| `addedIn` / `deprecated` | 追加した版 / 廃止済みか |

- 出典（公的資料）: 日本標準産業分類（総務省 R5）、経済安全保障推進法の特定重要物資
  （内閣府）、日本成長戦略（2026-07 閣議決定）、METI 半導体・デジタル産業戦略、
  GX 分野別投資戦略（METI 2025-12）。
- 検査（テストと年次見直しの関門で**同じ関数** `validateVocabulary` を使う）:
  ID 重複なし・形式、ラベル規則、全語に出典 URL、列ごと 100 語以内、テーマの構成語が実在し
  廃止済みでない、keywords が空でない。
- ハッシュ: 正規化 JSON（キー順固定）の SHA-256。Worker と Node の両方で WebCrypto を使う。

## 5. タグ付け

### 5.1 対象の書類（D1 を読むだけ）

母集団は `activeEquityCondition()`（上場中の内国普通株）。銘柄ごとの**最新の有報**を
`doc_type_code IN ('120','130')` の中で `period_end DESC, submitted_at DESC` の先頭として選ぶ
（実測: 訂正有報 130 も平均 30 項目・99.96% が「事業の内容」を持つ全文書類）。
最新書類の本文が無い（`notion_doc_page_id` が NULL・抽出失敗）ときは、
古い書類に**戻らず**「本文なし」とする。

### 5.2 状態の遷移（1 銘柄）

| 条件 | 処理 | 結果の状態 |
|---|---|---|
| 行が無い | 行を作る（銘柄名・コード・33業種・relation） | 以下へ |
| 最新有報なし／本文なし | 本文列は空 | 本文の状態=本文なし・事業タグの状態=本文なし |
| 有報書類ID ≠ 最新 | 有報テキスト行を読む → 39 列を書く → 判定 | 取得済 → 判定済/判定不能 |
| 読込に失敗 | 再試行回数+1・次回再試行日 | 読込失敗 |
| 同じ書類・判定済・同じ版 | 何もしない | — |
| 同じ書類・判定済・版が違う | 影響判定（下）→ 判定し直す／版の列だけ更新 | 判定済 |
| 判定不能・読込失敗で次回再試行日 ≤ 今日・回数 < 5 | やり直す | — |
| 回数 ≥ 5 | 触らない（サマリと Issue に件数を出す） | そのまま |

- 再試行の間隔: 失敗 n 回目の後 `2^(n-1)` 日（1, 2, 4, 8 日）。
- 版の違いの**影響判定**: 新しい版で絞り込みをやり直し（本文は補足行から読む）、候補語か
  今のタグ・要確認のどれかが「変わった語」に当たれば判定し直す。当たらなければ
  `単語帳の版` とテーマ列（テーマ定義の変更を反映）だけ更新する。

### 5.3 絞り込み（コードのみ）

1. 正規化: NFKC、長音・ハイフン類（`ｰ ー ― ‐ − –` 等）を `ー`/`-` に揃える、空白の畳み込み、
   ASCII の小文字化。照合は正規化後の文字列同士（keywords も同じ正規化をかける）。
2. 文に分ける: `。` `！` `？` と改行・箇条記号（`・` 先頭、`(1)` 等）で区切る。
   原文の位置（開始・終了オフセット）を保持し、**引用は常に原文から切り出す**。
3. 各語の keywords が文に「語として」現れたら当たり（`text.ts` の `matchesKeyword`）。
   - キーワードの先頭・末尾が英数字なら、その外側は英数字でないこと（「ec」が英単語の途中に当たらない）。
   - 片仮名だけの 4 字以下のキーワードは、前後が片仮名でないこと（「ソース」が「リソース」に、
     「リース」が「リリース」に当たらない）。漢字は複合語に切れ目が無いため境界を見ない。
   - 単語帳 v1 はこの規則で実データ 338 社に対して調整した（2026-09-25）。
4. その文が excludeKeywords のどれかを含むなら、その文の当たりは数えない。当たった文が
   1 つ以上ある語が**候補**。当たらなかった語は「語なし」（候補にならない＝判定していない。未判定とは別）。
5. 対象の節: 「事業の内容」（主）と、補足として「セグメント情報等、財務諸表」「経営者による財政状態、
   経営成績及びキャッシュ・フローの状況の分析」（MD&A）「研究開発活動」（`prefilter.ts` の
   `PREFILTER_SECTIONS`）。補足の節を足した理由（2026-09-25 実測・338 社）:
   - 「セグメント情報等」がある有報は約 13%（29/338）しかない。
   - 味の素の ABF は「事業の内容」（808 字）に無く、「研究開発活動」にだけ「先端半導体パッケージに
     おけるビルドアップ層用材料として幅広く採用」とある。
   - 候補語が 1 つも無い会社が「事業の内容＋セグメント」だけだと 55 社、補足を足すと 5 社。
   - 1 社あたりの候補語は平均 6.3・90 パーセンタイル 13（jev 1〜2 往復）。
   補足の節には「需要の追い風」「借入先の銀行」「研究段階」のような言及も多いので、当たっただけでは
   タグにせず、jev が「その会社自身が今営んでいるか」で絞る（§5.5）。

### 5.4 抜粋（jev に渡す状態）

- 見出し: 銘柄コード・会社名・書類 ID・会計期末・書類種別。
- 「事業の内容」が 12,000 字以内なら全文。超えたら冒頭 3,000 字 + 当たった文の前後
  ±400 字の窓（重なりは結合）を `（中略）` でつなぐ。
- 補足の節は当たった段落だけ。合計 8,000 字まで（`SUPPORT_MAX`）。まず候補語ごとに 1 段落ずつ
  （節の優先順: セグメント → MD&A → 研究開発）入れ、残りの予算で文書順に足す。どの候補語にも
  最低 1 つは文脈が付くようにするため。1 段落だけで予算を超えるときは「…」を付けて切る。
- 切り詰めたこと・原文の文字数・使った段落数・省いた段落数を「判定入力」列に書く
  （例「事業の内容 全文 808字／補足 MD&A2・研究開発1段落 1,122字」）。

### 5.5 jev 判定

- 質問の型 `business_term_significance`（noul）を語ごとに `bt.<termId>` で作る（2026-09-25 実機で
  ドットを含む質問 ID が通ること、`jev-latest` が `jev-1.13.0` に解決されることを確認）。
- 指示（英語。`definitionEn` を埋める。`judge.ts` の `buildQuestion` が正本）:
  "Answer only from the excerpt of this company's annual securities report. Does this company itself
  (including its consolidated subsidiaries) currently conduct the business defined below, as a business
  segment, product line, or explicitly stated business? Definition: {definitionEn} Answer false if the
  excerpt mentions it only as its customers' industry or a demand driver, a supplier, partner or lender,
  research and development without current sales, a future plan, or an incidental mention. When the
  definition is about making a product, trading or distributing products made by other companies does not count."
  最後の一文は、ゴールデンセットの予備測定で総合商社が製造の語（建設機械・工作機械など）で
  「はい」になる誤判定が多かったため足した。この一文・2 語の追加・原子力と核酸医薬の定義の明確化を
  合わせて、yesMin=0.50 での精度が 0.923 → 0.962 になった（それぞれの寄与は分けて測っていない）。
- しきい値: 共通の `yesMin` / `noMax` を 1 組持ち、全 `bt.*` に割り当てる。値はゴールデンセットで
  精度を測ってから `calibration.json`（`{model, yesMin, noMax, …測定値}`）に置く（§11.4）。
  指示文や定義を変えたら測り直す。**v1 の較正（2026-09-25）: `jev-1.13.0`・yesMin=0.50・noMax=0.25**
  （87 社・858 組で「はい」の精度 0.962・再現率 0.760・当てたい例の再現率 0.905・「はい」286 /
  要確認 74 / いいえ 497）。
- 1 往復で候補を最大 20 問まとめる。モデルは版を固定（`calibration.json` の `model`。別名 `jev-latest` は使わない）。
- 429/529/5xx・通信失敗は指数バックオフで有界リトライ。最後まで失敗したら**判定不能**（既定の答えを入れない）。
- 費用: 入力 $0.042/100 万トークン・出力無料。実行ごとにトークン数と費用の見積もりをサマリに出す。

### 5.6 結果

| jev の帯 | 保存 |
|---|---|
| はい（`p ≥ yesMin`） | 事業タグ列に語の名前。根拠（当たった文 ≤3・節・書類 ID・期末・確率）を本文に |
| 確認不能（`noMax < p < yesMin`） | 要確認タグ列に「名前（0.55）」、本文に根拠 |
| いいえ（`p ≤ noMax`） | 何もしない |

投資テーマ列 = 「はい」の business 語を 1 つ以上含む theme の名前（決定的）。

## 6. 年 1 回の見直し（Cursor Automation + 関門）

### 6.1 Automation「kabulab-cf 単語帳の年次見直し」

- cursor.com/automations・No Repository・モデル Grok 4.7。
- 頻度: 年 1 回。8 月第 1 月曜 06:00 JST。「第 1 月曜」は cron で正確に書けないので、Automation は
  **7〜8 月の毎週月曜 06:00 JST（cron `0 21 * 7,8 0`、UTC の日曜 21:00）**に起動し、review-packet の
  `reviewWindow.open`（Worker が JST で計算。8 月第 1 月曜〜その 7 日後だけ true。`review-window.ts`）が
  false なら何もせず終える。7 月も入れるのは、8 月 1 日が月曜の年は起動が UTC の 7 月 31 日になるため。
- 秘密（Cursor の My Secrets）: `KABULAB_CF_ORIGIN`（Environment Variable）、`KABULAB_CF_VOCAB_TOKEN`（Runtime Secret）。
  My Secrets はアカウント全体で共有される。kabulabAgents の Automation が既に `KABULAB_APP_ORIGIN`
  （kabulabAgents の URL）を使っているため、名前に `CF` を入れて衝突を避けている（2026-09-25 設定済み）。
- 指示文: [`scripts/biztag-automation/vocabulary-review.md`](../scripts/biztag-automation/vocabulary-review.md)。
  1. `GET {ORIGIN}/yuho-quant/vocabulary/review-packet` を読む（今の単語帳・語ごとのタグ数・
     「語なし」の多い業種・確認不能の多い語・見直しに使う公的資料の URL）。
  2. 公的資料の新しい版を読み、追加・名前の変更・廃止・同義語の追加を、**語ごとに出典の
     URL と原文の引用つきで**まとめる。
  3. `POST {ORIGIN}/yuho-quant/vocabulary/proposals`（合言葉つき）。変更が無い年は
     `noChange: true` と理由・読んだ資料を送る。

### 6.2 Worker（受け付けだけ）

- 認証: `Authorization: Bearer <token>` の SHA-256 を `VOCAB_REVIEW_TOKEN_SHA256`
  （wrangler.toml の vars。ハッシュなので公開リポジトリに置いてよい）と定数時間比較。
  未設定なら常に 401（fail-closed）。
- `GET …/review-packet`: 台帳の「見直し材料」行を返す（ハッシュ照合つき）。
- `POST …/proposals`: zod で形を検査 → 台帳に「提案（未審査）」で保存 → 202。
  形の不正は 400（理由つき）。重い検査はしない（Worker の時間とサブリクエストを使わない）。

### 6.3 関門（`pnpm biztag gate`。平日 catchup の biztag ステップ冒頭で実行）

AI の自己評価には頼らない。全部コード＋jev:

1. **形**: 基にした版 = 今の有効な版。変更を当てた単語帳が `validateVocabulary` を通る。
2. **出典**: 変更ごと・語ごとの URL が取得でき（HTML/PDF を本文化）、引用が本文に実在する
   （NFKC・空白を正規化して部分一致）。
3. **jev でゴールデンセットを再評価**: 「はい」の精度 ≥ 0.9、今の版から下がらない、
   当てたい例の取りこぼしが増えない。提案に `exampleCompanies` があればその会社で「はい」。
4. **変更量**: 変わる語は有効な語の 2 割まで、1 系統の廃止は全体の 1 割まで。

- 全部通れば**自動で新しい版にする**（運営決定 2026-09-25: 自動反映・巻き戻し可）。
  台帳に「版 vN（有効）」、前の版は「置換済」、提案は「採用」＋理由・差分。
  変わった語の銘柄は次の `run` が影響判定で拾う。
- 止まったら提案を「不採用」＋理由にし、GitHub Issue で運営に知らせる。
- 期限（8 月第 1 月曜から 7 日）までに提案も「変更なし」も無ければ Issue で知らせる
  （台帳に通知を 1 行残し、毎日は鳴らさない）。
- 巻き戻し: `pnpm biztag rollback -- --to=v1 --reason=...`（backfill.yml からも実行可）。
- 既知の制約（2026-09-25 最終レビューで確認・意図的に未対応）: 語の `definitionEn` は区切り記号なしで
  jev の質問文に入る。提案が指示めいた定義を入れると、その語の判定が歪み得る。影響はその語のタグに限られ、
  変更量の上限・出典検査・合言葉で入口を絞っている。質問文の書式を変えると較正のやり直しが要るため、
  変えるときは §11.4 の手順で測り直してから `calibration.json` を更新する。新しい語はゴールデンセットに
  ラベルが無く関門で精度を測れないので、採用後の初回実行の「要注意」ビューと語ごとのタグ数で確認する。

## 7. 自動化（既存の仕組みに相乗り・J1）

| どこ | 何を |
|---|---|
| `catchup.yml`（平日 11:00 UTC） | EDINET 取込の**次**に `pnpm biztag run --budget-min=20`（関門・期限・差分処理・見直し材料） |
| `backfill.yml`（手動） | `job: biztag` = 全件（`--budget-min=340`）、`biztag-golden` = 精度測定、`biztag-rollback` |
| 失敗通知 | 既存の `notify-failure`（Issue 1 本）。関門で止まった・期限切れ・上限超えの失敗が残った、も同じ Issue へ |

- 1 回の予算を超えた分は次の実行が差分で拾う（再開可能・冪等）。
- 新 workflow・Workers Cron・Workers Paid 機能は使わない。

## 8. env / 秘密

| 変数 | どこで | 用途 |
|---|---|---|
| `TYPESAFE_API_KEY` | .env / GH Secrets | jev |
| `NOTION_TOKEN` | 既存 | Notion |
| `NOTION_STOCK_INFO_PAGE_ID` | .env / GH Secrets / wrangler vars | 「株式情報」ページ |
| `NOTION_DB_STOCK_MASTER` | .env / GH Secrets（既存） | ① 銘柄マスタ（relation 先） |
| `NOTION_STOCK_SUPPLEMENT_DB_ID` | 任意 | 補足 DB を固定（Search を使わない） |
| `NOTION_BIZTAG_LEDGER_DB_ID` | 任意（Worker は vars で固定） | 台帳 DB を固定 |
| `VOCAB_REVIEW_TOKEN_SHA256` | wrangler vars | Automation の合言葉のハッシュ |
| `CLOUDFLARE_*` / `D1_DATABASE_ID` | 既存 | D1 を読む（D1 HTTP） |

## 9. 計測

実行サマリ（`$GITHUB_STEP_SUMMARY` と標準出力の JSON）: 状態ごとの件数、判定済の割合、
1 社あたりのタグ数・候補語数、jev の呼び出し回数・入力トークン・費用見積もり、
Notion のリクエスト数と 429 回数、処理時間。精度（ゴールデンセット）: 「はい」の精度、
当てたい例の再現率、絞り込みの取りこぼし率。

## 10. 検証

- 単体テスト: 正規化・文分割・絞り込み、抜粋（切り詰めの表示）、単語帳の検査、
  Notion に送る内容（100 語以内・カンマなし・列の形）、状態遷移、関門。
- ゴールデンセット（`services/yuho-quant/src/biztag/golden/v1.json`）: 実際の有報の文だけで作る。
  各項目に書類 ID と根拠の原文を持ち、確かめられないものは入れない。
- 本番の前に、ゴールデンセットの会社だけで Notion への書き込みまで通して確かめる。

## 11. 運用手順（runbook）

CLI は全て `pnpm biztag <subcommand>`（リポジトリルートから。実体は
`services/yuho-quant/data-scripts/biztag.ts`）。標準出力に JSON サマリ、CI 実行時は
`$GITHUB_STEP_SUMMARY` に markdown も出る。

### 11.1 初期セットアップ（最初の1回だけ）

1. **`.env` に最低限の値を用意する**（`.env.example` 参照）: 既存の `NOTION_TOKEN` /
   `NOTION_STOCK_INFO_PAGE_ID`（既に「株式情報」ページ用に存在するはず）/
   `NOTION_DB_STOCK_MASTER`（① 銘柄マスタ）に加えて、`TYPESAFE_API_KEY`（jev / TypeSafe
   System One）を追加する。`NOTION_STOCK_SUPPLEMENT_DB_ID` / `NOTION_BIZTAG_LEDGER_DB_ID`
   はこの時点では**空のままでよい**（初回実行時に Search で見つけるか新規作成する。
   `ensureSupplementDb` / `ensureLedgerDb` が「足りない列だけ足す」流儀で冪等に作る)。
2. **ローカルでドライランする**: `pnpm biztag run --dry-run --limit=5` で数銘柄だけ動かし、
   「銘柄マスタ（補足）」DB と「事業タグ単語帳（台帳）」DB が「株式情報」ページ配下に
   作られること、単語帳 `v1`（コード管理・`services/yuho-quant/src/biztag/vocabulary/v1.json`）
   が台帳へ「版 v1（有効）」として1回だけ投入されることを確認する。
3. **DB ID を固定する**: 作成された2つの DB の ID を Notion の URL から控え、
   `.env` の `NOTION_STOCK_SUPPLEMENT_DB_ID` / `NOTION_BIZTAG_LEDGER_DB_ID` に書く
   （以後は Search を使わなくなり、P6 のような重複作成事故を避けられる）。
4. **GitHub Secrets に登録する**: `TYPESAFE_API_KEY` / `NOTION_STOCK_INFO_PAGE_ID` /
   `NOTION_DB_STOCK_MASTER` / `NOTION_STOCK_SUPPLEMENT_DB_ID` / `NOTION_BIZTAG_LEDGER_DB_ID`
   をリポジトリの GitHub Secrets に追加する（`catchup.yml` / `backfill.yml` が読む）。
5. **Worker の合言葉を発行する**（見直し提案の受付 `/yuho-quant/vocabulary/*` 用）:
   ```bash
   TOKEN=$(openssl rand -hex 32)
   echo -n "$TOKEN" | shasum -a 256   # ハッシュだけを wrangler.toml へ
   ```
   実際のトークン（`$TOKEN`）は Cursor Automation の secrets 欄（`KABULAB_CF_VOCAB_TOKEN`）に、
   ハッシュ（`shasum` の出力）は `wrangler.toml` の `[vars]` の `VOCAB_REVIEW_TOKEN_SHA256`
   に設定する（ハッシュは公開リポジトリに置いてよい。未設定なら Worker は常に 401）。
   `NOTION_STOCK_INFO_PAGE_ID` と `NOTION_BIZTAG_LEDGER_DB_ID` も同じ `[vars]` に足す
   （Worker はバインディング/vars からのみ読み、GitHub Secrets とは別に設定が要る）。
6. **Cursor Automation を作る**: cursor.com/automations で「No repository」の Automation
   （名前例: 「kabulab-cf 単語帳の年次見直し」）を作り、
   [`scripts/biztag-automation/vocabulary-review.md`](../scripts/biztag-automation/vocabulary-review.md)
   の instructions 部分をそのまま貼り付け、モデル **Grok 4.7** を指定し、スケジュールを
   **cron `0 21 * 7,8 0`（UTC。7〜8 月の毎週月曜 06:00 JST）**にする（実際に見直すのは
   `reviewWindow.open` が true の 8 月第 1 月曜からの 7 日間だけ。§6.1）。secrets 欄に
   `KABULAB_CF_ORIGIN`（Worker の本番 URL）と `KABULAB_CF_VOCAB_TOKEN`（手順5の `$TOKEN`）を
   登録する。

### 11.2 日次運用

- 平日 `catchup.yml` が EDINET 取込の直後に `pnpm biztag run --budget-min=20` を実行する
  （§7）。何もしなくてよい。1回の予算で終わらなかった銘柄は、翌日の実行が
  「D1 の最新有報 ID と補足行の書類 ID の差分」で自動的に拾う（再開可能・冪等）。
- 実行のたびに §6.3 の**関門**（未審査の提案があれば審査）と**期限検査**
  （8月第1月曜+7日までに提案/変更なしが無ければ通知）も冒頭で走る。
- 状況を見たいときは Actions の実行ログ（`$GITHUB_STEP_SUMMARY`）か、Notion
  「銘柄マスタ（補足）」DB を直接見る（§4 の状態列の意味は
  [契約書](./005-yuho-quant-business-tags-contract.md) §4 も参照）。

### 11.3 バックフィル（手動）

`backfill.yml` を `workflow_dispatch` で手動起動する（`gh workflow run backfill.yml
-f job=biztag ...` または GitHub UI）。

| `job` | 実行内容 | 使う場面 |
|---|---|---|
| `biztag` | `pnpm biztag run --budget-min=340`（`limit` 指定可） | 日次予算で追いつかない大量の取りこぼしを一気に回収したいとき |
| `biztag-golden` | `pnpm biztag golden` | しきい値・モデルの精度測定（§11.4） |
| `biztag-rollback` | `pnpm biztag rollback --to=<to> --reason=<reason>`（`to`/`reason` 必須） | 単語帳を過去の版へ戻したいとき（§11.5） |

### 11.4 ゴールデンセット・しきい値の較正

1. `services/yuho-quant/src/biztag/golden/v1.json` に、実在する有報の文だけを使った
   期待値（`code` / `docId` / `periodEnd` / `companyName` / `expect[]`）を用意する
   （§10。裏付けられない項目は入れない）。
2. `pnpm biztag golden`（または `--yes-min=` / `--no-max=` / `--out=<path>` で候補の
   しきい値を試す）を実行し、`precisionYes` / `recallMustHit` / `filterMissRate` を見る。
3. 良いしきい値と使うモデル名が決まったら、`services/yuho-quant/src/biztag/calibration.json`
   をコミットする（`loadCalibration()` がこのファイルを読む。無いと `pnpm biztag run` は
   明示的なエラーで止まる。既定値やダミー値では起動しない — ルール2の帰結）。
4. モデル・しきい値を変えたら、影響を受ける銘柄は次回 `run` が「同じ書類・判定済・
   版が違う」の扱いで拾う……わけではない点に注意（§5.2 の遷移表は**単語帳の版**の変更を
   対象にしたもの。しきい値/モデルだけを変えたい場合は `pnpm biztag run` に**強制再判定**
   のオプションが要る。現状は無いため、しきい値変更を伴う較正はゴールデンセットでの
   検証をもって足りるとし、既存本番タグの一括再判定が必要な場合は運営判断で
   `--codes=` を使って対象銘柄を絞って個別に流す）。

### 11.5 巻き戻し（rollback）

単語帳の見直しが誤りだった、精度が悪化した等で前の版に戻したいときは

```bash
pnpm biztag rollback --to=v1 --reason="v3 で追加した語の精度が低いため v1 に戻す"
```

（`backfill.yml` の `biztag-rollback` job からも同じことができる）。**内容を上書きせず、
「指定した版と同じ内容の新しい版」を作る**ので、台帳の履歴は消えない（前の巻き戻しも
含めて全部残る）。実行後、影響を受ける銘柄のタグは次回 `run` の影響判定で再判定される。

### 11.6 Issue 通知の意味

`catchup.yml` / `backfill.yml` の失敗は共通の `notify-failure`（GitHub Issue 1本。
同名 open があれば新規を作らずコメントを足す）で通知される。biztag に関する通知は
2系統ある:

- **`[ジョブ失敗] catchup` / `[ジョブ失敗] catchup (biztag)` / `[ジョブ失敗] backfill
  (biztag*)`**: ジョブ自体が異常終了（例外・タイムアウト等）。ログを見て原因を直す
  （コードのバグ、Notion/jev 側の想定外の応答形状 等）。`catchup.yml` は
  TDnet/EDINET を行う `catchup` job と biztag を行う `biztag` job に分かれており
  （Notion「銘柄マスタ（補足）」「事業タグ単語帳（台帳）」への書込を
  `backfill.yml` の biztag 系 job と同じ `biztag-notion` concurrency グループで
  直列化するため）、失敗した job に応じてどちらかの表題で Issue が立つ。
- **biztag の通知ステップ（`steps.biztag.outputs.notify == 'true'` のときだけ Issue が
  立つ。ジョブ自体は成功のまま）**: 「運営が判断すべきこと」の通知。主な内容:
  - **関門で提案が不採用になった**（§6.3）: 出典が確認できない・ゴールデンセットの
    精度が基準を割った・変更量が上限を超えた 等。台帳の該当提案行の「理由」列に
    詳細がある。単語帳は**自動では変わっていない**（安全側）。
  - **見直しの期限切れ**（8月第1月曜+7日までに提案も「変更なし」も無い）:
    Cursor Automation が動いていない/失敗している可能性がある。手動で
    [`scripts/biztag-automation/vocabulary-review.md`](../scripts/biztag-automation/vocabulary-review.md)
    の手順を実行するか、Automation の実行ログを確認する。
  - **再試行上限（5回）に達したまま残っている銘柄がある**: 継続的に本文取得/判定に
    失敗している銘柄。Notion の該当行の「判定エラー」列を見て原因を切り分ける
    （EDINET 側の本文抽出失敗、jev 側の恒常的エラー 等）。
