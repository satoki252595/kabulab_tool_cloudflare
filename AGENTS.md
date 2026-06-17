# AGENTS.md — kabulab mono-repo 開発ルール (Codex 向けポインタ)

このリポジトリは [kabulab](https://kabulab.vercel.app/) — 日本株投資ツール統合ポータル。
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
4. ルール4: コード修正後は専門エージェントによる多角精査が必須
5. ルール5: 修正完了後は git push まで実施する
6. ルール6: 一次データは Notion に必ずアーカイブする (`src/shared/notion-archive/` 経由)
7. ルール7: UI の専門用語には投資初心者向けバルーンヘルプを必ず付ける (`src/shared/term-tip.ts`)

個別サービスのコーディング規約は各 [`services/<slug>/CLAUDE.md`](./services/) を参照
(サービス別 AGENTS.md は置かない)。

## Codex 固有の差分

CLAUDE.md との差分はこのセクションのみに記載する:

- **コミットトレーラー**: ルール5 のコミット時、Codex のデフォルト
  Co-Authored-By トレーラー付与で OK (Claude Code の同名トレーラーと同じ扱い)。
- **ルール4 のエージェント起動**: Codex に Agent ツール相当が無い場合は、
  `.claude/agents/*.md` の 4 観点 (concept-brand / quality-manager /
  cost-manager / designer) のチェックリストを自分で順に適用し、全観点
  PASS 相当になるまで修正してからコミットする。
