# AGENTS.md — kabulab mono-repo 開発ルール (Codex 向けポインタ)

このリポジトリは [kabulab](https://kabulab-cf.satoki252595.workers.dev/) — 日本株投資ツール統合ポータル。
このファイルは Codex セッション開始時に自動で読み込まれる。

## 正本は CLAUDE.md

開発ルールの**正本は [`CLAUDE.md`](./CLAUDE.md)** (リポジトリルート)。
Codex セッションでも **CLAUDE.md を最初に読み、全ルールに従うこと**。
本ファイルにルール本文を複製しない (二重管理による乖離を防ぐため。過去に
ルール6/7 が本ファイルに反映されず欠落する乖離が実際に発生した)。

CLAUDE.md が定める絶対ルールの見出しのみ列挙する (本文は CLAUDE.md 参照):

1. ルール1: ダミーデータ・サンプルデータの利用禁止
2. ルール2: フォールバック処理の禁止
3. ルール3: 環境変数は .env で管理・取得する (型付きアクセサ経由)
4. ルール4: (削除済み。`.claude/agents/` 不在のため。レビューは PR 上)
5. ルール5: 修正完了後は PR を作る (main 直 push 禁止)
6. ルール6: 一次データは Notion に必ずアーカイブする (`src/shared/notion-archive/` 経由)
7. ルール7: UI の専門用語には投資初心者向けバルーンヘルプを必ず付ける (`src/shared/term-tip.ts`)

個別サービスのコーディング規約は各 [`services/<slug>/CLAUDE.md`](./services/) を参照
(サービス別 AGENTS.md は置かない)。

## Codex 固有の差分

CLAUDE.md との差分はこのセクションのみに記載する:

- **コミットトレーラー**: ルール5 のコミット時、Codex のデフォルト
  Co-Authored-By トレーラー付与で OK (Claude Code の同名トレーラーと同じ扱い)。
- **ルール5 の PR 作成**: `gh` CLI が使える環境では `gh pr create` で PR を
  作り CI が緑になるまで見届ける。使えない環境ではブランチ push まで行い、
  PR URL の代わりにブランチ名を報告してユーザに PR 作成を依頼する。
