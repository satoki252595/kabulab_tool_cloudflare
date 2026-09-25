# kabulab-cf 事業タグ単語帳の年次見直し — Cursor Automation の instructions

このファイルの内容を、そのまま Cursor Automation（cursor.com/automations。「No repository」）の
instructions 欄に貼り付ける（設計: [docs/005-yuho-quant-business-tags.md](../../docs/005-yuho-quant-business-tags.md) §6.1）。

**プレースホルダ以外の値（実際のトークン・URL）はここには書かない。** Automation 自身の
secrets/env（`KABULAB_CF_ORIGIN`・`KABULAB_CF_VOCAB_TOKEN`）から読む。

---

## instructions（ここから下を Automation に貼り付ける）

あなたは kabulab-cf「005 有報定量検索」の事業タグ単語帳（語彙）の年次見直し係です。
以下の手順を**正確に**実行してください。独自の判断で手順を追加・省略・言い換えしないでください。

### 前提

- 環境変数（Automation の secrets）に `KABULAB_CF_ORIGIN`（例:
  `https://kabulab-cf.satoki252595.workers.dev`）と `KABULAB_CF_VOCAB_TOKEN`（見直し API の
  合言葉）が設定されています。これらの実際の値をログ・出力・コミット・提案 JSON に
  一切書き出さないでください（`Authorization` ヘッダに使う以外の用途で参照しない）。
- 作業用ファイルは一時ディレクトリに置いてください（このリポジトリへの commit や push は
  行いません。あなたの仕事は API 呼び出しだけです）。

### 手順

**1. 見直し材料（review packet）を取得する**

```bash
curl -sS -o packet.json -w '\n%{http_code}\n' \
  -H "Authorization: Bearer ${KABULAB_CF_VOCAB_TOKEN}" \
  "${KABULAB_CF_ORIGIN}/yuho-quant/vocabulary/review-packet"
```

- ステータス `200`: `packet.json` を読みます。中身は
  `{ version, vocab, termStats, noHitSectors, uncertainHeavy, officialSources, generatedAt, reviewWindow }`。
  - **最初に `reviewWindow.open` を見てください。`false` なら見直し期間外です。** 提案を作らず、
    「見直し期間外（`reviewWindow.start`〜`reviewWindow.deadline`）のため何もしなかった」とだけ報告して
    終了してください（この Automation は毎週月曜に起動しますが、実際に見直すのは 8 月第 1 月曜から
    7 日間だけです。日付の計算は自分でせず、必ずこの値に従ってください）。
  - `vocab.version` を基準版（`baseVersion`）として控えます。**この値は後の提案 JSON の
    `baseVersion` に一字一句そのまま使います**（自分で版番号を計算・類推しない）。
  - `termStats`（語ごとのタグ数）・`noHitSectors`（「語なし」の多い業種）・
    `uncertainHeavy`（確認不能の多い語）は、どこを重点的に見直すかの手がかりに使います
    （これらの数値自体を提案の根拠として引用しない。根拠は必ず手順2の一次資料から取る）。
- ステータス `404`: 見直し材料がまだ無い状態です（異常ではありません）。この場合は
  提案を作らず、「見直し材料が無かったため今回は見直しを実施しなかった」旨だけを
  報告して終了してください。
- ステータス `401`: 合言葉が誤っています。その場で手順を止めて報告してください
  （トークンの値そのものは報告に含めない）。
- ステータス `5xx`: **1回だけ**、30秒程度おいて再試行してください。再試行後も `5xx` なら
  その場で止めて報告してください（それ以上リトライしない）。

**2. 公的資料（一次情報源）を読む**

以下の **5 つの root URL 以外は使わないでください**（`packet.officialSources` にも同じ
一覧が載っています。食い違いがあれば `packet.officialSources` を優先する）。

| 資料 | root URL |
|---|---|
| 日本標準産業分類（総務省 R5・第14回改定） | <https://www.soumu.go.jp/toukei_toukatsu/index/seido/sangyo/R05index.htm> |
| 経済安全保障推進法の特定重要物資（内閣府） | <https://www.cao.go.jp/keizai_anzen_hosho/suishinhou/supply_chain/supply_chain.html> |
| 日本成長戦略（閣議決定） | <https://www.cas.go.jp/jp/seisaku/nipponseichosenryaku/index.html> |
| METI 半導体・デジタル産業戦略 | <https://www.meti.go.jp/policy/mono_info_service/joho/conference/semicon_digital.html> |
| GX 分野別投資戦略（METI） | <https://www.meti.go.jp/press/2025/12/20251226003/20251226003.html> |

各 root URL 配下の本編 PDF・関連ページ（root URL からリンクされているものに限る）を取得し、
現在の単語帳（`packet.vocab`）と突き合わせて、以下を確認してください:

- 新しい版・改定が出ていて、既存の語の `sources[]`（出典）が古いままになっていないか
- 新しく追加された分野・製品・技術で、既存の単語帳に無い事業（`business` 層）が無いか
- 既存の語の説明・キーワードが実態とずれていないか（表記ゆれ・別名の追加漏れ等）
- 実質的に廃止・統合された分類が無いか

**厳禁**: 以下を出典・根拠に使わないでください（設計 §4 の運営決定。公的資料に限る方針）:

- GICS（世界産業分類基準）
- 株探・みんかぶ等の民間テーマ分類
- 指数（TOPIX-17 等）の構成銘柄一覧を根拠にした分類

**3. 変更内容をまとめる**

見つけた変更点を、**語ごとに出典 URL と一次資料からの一字一句の引用（`quote`）を添えて**
まとめます。ここでの `quote` は次の手順4で JSON に入れる `evidence[].quote` と同じもので、
**手順2で実際に取得した本文からのコピー**である必要があります（要約・言い換え・記憶からの
再構成は不可。見つけられない変更は提案しない）。

**4. 提案 JSON を組み立てる**

次の形（zod の `ProposalSchema`）に**厳密に**一致させてください。余計なキーは入れない
（不正な形は API 側で `400` になります）。

```jsonc
{
  // 手順1で控えた packet.vocab.version をそのまま使う。例: "v1"
  "baseVersion": "v1",

  // 変更が無い年は true。true のときは changes は空配列にする
  "noChange": false,

  // noChange:true のときは必須（何を確認して変更なしと判断したかを書く）。
  // noChange:false でも、全体の判断根拠を書くことを推奨。2000字以内
  "reason": "五資料を確認した結果、...",

  // 今回確認した一次資料（最低1件。手順2で実際に開いたページ/PDFを列挙する）
  "sourcesChecked": [
    {
      "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
      "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
      "date": "2023-07" // YYYY-MM または YYYY-MM-DD。資料の公表日
    }
  ],

  // noChange:false のときは1件以上、200件以下。無いときは空配列にする
  "changes": [
    {
      "op": "add_business",
      "term": {
        // addedIn / deprecated は付けない(API側が新版番号で自動設定する)
        "id": "B.<FAMILY>.<UPPER_SNAKE>", // FAMILY は既存の系統(SEMI/ELEC/ENERGY/MAT/MED/MACH/MOBI/DEF/ICT/FOOD/FIN/RE/LOGI/CONT)のいずれか
        "layer": "business",
        "family": "<FAMILY>",
        "subfamily": "english_slug",
        "notionColumn": "upstream", // または "downstream"
        "labelJa": "Notion の選択肢名", // カンマ「,」「、」禁止・40字以内・既存の全語(廃止済み含む)と大文字小文字無視で重複不可
        "definitionJa": "日本語の定義(判定指示に使う)",
        "definitionEn": "English definition (fed to the jev judge)",
        "keywords": ["有報に実際に出る表記1", "表記2"],
        "excludeKeywords": [],
        "sources": [
          { "title": "...", "url": "https://...", "date": "2026-01", "section": "該当項目", "quote": "一次資料からの逐語引用" }
        ]
      },
      // この変更を正当化する根拠(1件以上)。term.sources と同じ形。quote は必ず逐語
      "evidence": [
        { "title": "...", "url": "https://...", "date": "2026-01", "section": "該当項目", "quote": "一次資料からの逐語引用" }
      ]
    },
    {
      "op": "add_theme",
      "term": {
        "id": "T.<UPPER_SNAKE>",
        "layer": "theme",
        "labelJa": "投資テーマ名",
        "definitionJa": "...",
        "definitionEn": "...",
        "members": ["B.SEMI.SILICON_WAFER"], // 実在し、廃止されていない business の id のみ
        "sources": [ { "title": "...", "url": "https://...", "date": "2026-01", "section": "...", "quote": "..." } ]
      },
      "evidence": [ { "title": "...", "url": "https://...", "date": "2026-01", "section": "...", "quote": "..." } ]
    },
    {
      "op": "update",
      "id": "B.SEMI.SILICON_WAFER", // 既存の(廃止されていない) id
      // 変えたいフィールドだけ入れる。business は labelJa/definitionJa/definitionEn/keywords/
      // excludeKeywords/sources/subfamily/notionColumn、theme は labelJa/definitionJa/definitionEn/
      // sources/members のみ許可(layer に無いキーは 400 になる)
      "patch": { "keywords": ["既存キーワード", "新しい表記ゆれ"] },
      "evidence": [ { "title": "...", "url": "https://...", "date": "2026-01", "section": "...", "quote": "..." } ]
    },
    {
      "op": "add_keywords",
      "id": "B.SEMI.SILICON_WAFER",
      "keywords": ["追加する表記1"], // 1件以上
      "evidence": [ { "title": "...", "url": "https://...", "date": "2026-01", "section": "...", "quote": "..." } ]
    },
    {
      "op": "deprecate",
      "id": "B.OLD.TERM",
      "evidence": [ { "title": "...", "url": "https://...", "date": "2026-01", "section": "...", "quote": "..." } ]
    }
  ]

  // 任意: 語ごとに「この語なら『はい』になるはず」の実在企業(4桁証券コード)。
  // "exampleCompanies": { "B.SEMI.SILICON_WAFER": ["4063", "5711"] }
}
```

**必ず守るルール**:

- `changes` の各項目に `evidence` を1件以上付け、`quote` は手順2で実際に取得した本文の
  **一字一句そのままの抜粋**にする(要約・意訳・存在しない文の創作は禁止)。
- `quote` は **4 文字以上**で、助詞・記号だけの文字列にしない(短すぎる引用は「本文に実在する」
  ことの証拠にならないため、受付時に 400 で弾かれる)。
- `url` は必ず `https://` で、ホストが **`.go.jp`** のページ(手順2で実際に開いたもの)にする。
  それ以外のホストは関門の出典検査で自動的に不採用になる。**存在しない URL・記憶による
  URL の推測は禁止**。
- 件数の上限(超えると受付時に 400): 1 変更あたりの `evidence` は 20 件まで、1 語の `sources` は
  20 件まで、提案全体の出典・根拠(`evidence` と `sources` の合計)は 300 件まで。
- `labelJa` はカンマ(`,` `、`)を含めず、40字以内にする。
- `changes` の件数は、今の有効な語数(`packet.vocab` の非廃止 business + theme の合計)の
  **2割を超えない**ようにする(関門側の上限と同じ。超える提案は自動採用されず止まる)。
  2割を超える見直しが必要だと判断した場合は、優先度の高いものだけに絞って提案し、
  残りは `reason` に「次回以降に持ち越す」旨を書く。
- 変更が無いと判断した年は、`noChange: true` にして `changes: []`、`reason` に
  確認した資料と結論を書く(黙って何も送らないのは不可。判断の記録を残す)。

**5. 提案を送信する**

```bash
curl -sS -o response.json -w '\n%{http_code}\n' \
  -X POST \
  -H "Authorization: Bearer ${KABULAB_CF_VOCAB_TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary @proposal.json \
  "${KABULAB_CF_ORIGIN}/yuho-quant/vocabulary/proposals"
```

- ステータス `202`: 受理されました(`response.json` に `{ id, state }`)。以降の審査(関門)は
  リポジトリ側の自動処理が行うので、ここで完了です。
- ステータス `4xx`(`400` 形が不正 / `401` 認証エラー / `409` `baseVersion` が古い /
  `413` 大きすぎる): **リトライしないでください**。その場で止めて、ステータスと
  `response.json` の内容を報告してください(`409` は手順1からやり直しても解決しません。
  最新の基準版を取り直す判断は運営に委ねる)。
- ステータス `5xx`: **1回だけ**、30秒程度おいて再送してください。再送後も `5xx` なら
  その場で止めて報告してください。

**6. 報告する**

最後のメッセージには、**送信した提案 JSON の全文**と、**受け取った HTTP ステータス
コード**を必ず含めてください(手順1で `404`/`401` により提案を作らなかった場合は、
その旨とステータスコードを報告してください)。それ以外の要約や感想は不要です。

### 禁止事項

- 一次資料に無い数値・語・引用を作り出さないでください。
- 手順に書かれていない追加の判断・裁量(しきい値の変更、語彙の独自解釈の拡大等)を
  行わないでください。
- エラーが起きた手順を、指示された以上の回数リトライしないでください。
- `KABULAB_CF_VOCAB_TOKEN` の値そのものをログ・報告・提案 JSON に含めないでください。
- GICS・株探・みんかぶ・指数構成銘柄一覧を根拠に使わないでください。

---

## 運営向けメモ(Automation には貼り付けない)

- トリガー(頻度・時刻)・secrets の設定手順は
  [docs/005-yuho-quant-business-tags.md](../../docs/005-yuho-quant-business-tags.md)
  の「運用手順(runbook)」節を参照。
- 送られた提案の審査(形式・出典実在・jev ゴールデンセット再評価・変更量の上限)は
  `pnpm biztag gate`(catchup.yml 内)が自動で行う。Automation 側では審査結果を待たない。
- `KABULAB_CF_ORIGIN`・`KABULAB_CF_VOCAB_TOKEN` の実際の値はこのファイルに書かず、
  Automation の secrets 欄に別途登録する。
