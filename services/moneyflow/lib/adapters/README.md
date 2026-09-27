# moneyflow 取得元アダプタ (Phase 2〜5)

`services/moneyflow/lib/sources/<key>.ts` (取得・解析・独自の指標定義) を
Phase 1 の Notion 3 DB (指標定義 / 観測ログ / 取込ログ) と「一次データ｜moneyflow」へ
つなぐ層。1 取得元 = 1 ファイル `adapters/<key>.ts` で、`MoneyflowSourceSpec`
(`../source-spec.ts`) を 1 つ以上 export する。取込 CLI への登録は
`scripts/moneyflow/sources.ts`、実行フローは `scripts/moneyflow/lib/run-spec.ts`。

## 取込の流れ (run-spec.ts)

1. `resolve(now)` で対象バッチの冪等キーを決める (一覧ページ等の軽い取得。
   本体ファイルはここで取らないのが原則)
2. キーが保管済みなら Notion の保管ファイルから `toObservations()` で作り直し、
   最後の行が観測ログにあれば取込済み (取得元へは行かない)。無ければ全行を再送
3. 未保管なら `fetch()` → `recordPrimaryData()` で実体保管 → `toObservations()` → upsert

`toObservations({ key, files })` は **key とファイルのバイト列だけ** から作る純関数
(保管済みファイルからの再解析でも同じ結果になるように)。取得時にしか分からない
情報 (一覧ページの公表日等) が必要なら key に含めるか、ファイル自体から読む。

## 統一規約

| 項目 | 規約 |
|---|---|
| spec 名 (`--only=`) | `<key>` または `<key>-<系列>` (例 `jpx-investor-equity-weekly`)。英小文字とハイフン |
| 冪等キー (一次データ Key) | `<spec名>-<期間>` を基本に、同じ期間が改訂されうる取得元は版 (速報/確報・公表日) も含める |
| 期間ラベル | 日次 `YYYY-MM-DD` / 週次 `YYYY-Www` (期間終了日の ISO 週) / 月次 `YYYY-MM` / 四半期 `YYYY-Qn` (暦年) / 半期 `YYYY-Hn` / 年次 `YYYY` |
| 期間開始・終了 | 取得元が示す実際の集計期間 (`YYYY-MM-DD`)。残高 (ストック) は基準日を開始=終了にする |
| 指標キー | 取得元モジュールの snake_case キーを流用 (全取得元で一意) |
| 金額の単位 | **円に換算** (千円×1,000 / 百万円×1,000,000 / 億円×100,000,000)。米ドル建ては「米ドル」のまま (為替換算しない)。百万米ドル等も米ドルに換算 |
| その他の単位 | 株数→「株」(千株×1,000)、先物/オプション→「枚」、口座数→「口座」、比率・騰落率→「比率」(0.012 = 1.2%)、金利差→「%ポイント」、指数水準→「ポイント」 |
| 区分 | 取得元の日本語表記。2 軸以上は ` / ` 区切りで粗い軸→細かい軸 (例 `プライム / 海外投資家`)。区分種別は最も細かい軸 |
| 区分種別 | 業種 / 投資部門 / 資産クラス / 国地域 / 市場 / 通貨 / 商品 / 全体 |
| 前期比 | 取得元ファイル自体に前期値が無ければ `null` (計算で補わない) |
| 近似フラグ | 指標が「流れ」そのものでなく代理指標・残高ベース・推計のとき `true` |
| 実測推定 | 取得元の公表値 = 実測。他統計からの推計・価格補正 = 推定 |
| 1 バッチの行数 | 目安 600 行以内 (Notion 約 1.3 行/秒)。超える取得元は主要な区分に絞り、絞り方を指標定義の「限界」に書く |
| 指標定義の文 | 投資初心者向けの平易な日本語で、フロー/ストックの取り違え・符号の向き・単位を正確に (CLAUDE.md ルール7 の精神) |
| 利用条件 | personal-only (JPX・Yahoo 等) / attribution-required / public-domain / 要確認 (規約未確認・商用可否不明)。推測で緩い側に丸めない |

## フィクスチャ (実ファイル) の置き場所 — このリポジトリは PUBLIC

- `services/moneyflow/lib/sources/fixtures/private/<key>/` … **commit しない**
  (`.gitignore` 済み)。personal-only・要確認・再配布不可の取得元 (JPX / FFAJ / TFX /
  JVCEA / 資産運用業協会 / JSDA / CoinGecko / Yahoo 等)。テストは
  `describe.skipIf(!existsSync(path))` で、未取得の環境 (CI) では skip する
- `services/moneyflow/lib/sources/fixtures/public/<key>/` … commit してよい
  (パブリックドメイン・CC BY 等で再配布が明示的に許されている取得元のみ)。
  出典表示は `services/moneyflow/lib/sources/fixtures/README.md` に書く
- 取得手順・取得日・サイズ・sha256 は `services/moneyflow/lib/sources/fixtures/README.md`
