# moneyflow 取得元フィクスチャ (実ファイル)

このリポジトリは **PUBLIC**。取得元の利用条件に応じて置き場所を分ける
(規約は `services/moneyflow/lib/adapters/README.md`「フィクスチャ」節)。

- `private/<key>/` — **commit しない** (`.gitignore` 済み)。personal-only・利用条件要確認・
  再配布不可の取得元。未取得の環境 (CI) では該当テストが `describe.skipIf` で skip する。
  下表の手順で取得して置けば手元でテストが走る
- `public/<key>/` — commit 済み。再配布が明示的に許される取得元のみ (出典表示は下表)

<!-- 取得元ごとの一覧は Phase 2〜5 統合時に追記する -->
