# 通常財務writerのNotion正本一致 — 2026-09-28

## 原因と共通修正

Notion③の `financial_summary_properties` は未取得項目を明示的な空値で更新する。
通常のD1/local writerだけが `COALESCE` で前回値を残しており、後続の疎な原本や
訂正で消えた数値を、現在のsourceの値として保持していた。

両writerをNotionと同じNULL込みの完全置換へ変更した。連結区分を含む主キー、
古い開示日時の巻戻し拒否、ライセンスの厳しい側、再実行の冪等性は維持する。
使わなくなった列マージの分類・引数・分岐も削除した。schema・依存・設定の追加はない。

## 原本を使った回帰

EDINET `S100UTIN`（7384、2024年9月中間期、原公表2024-11-21 10:06 JST）の
公開済み原文抜粋を共有parserへ通す。BPS 5,918.24円、自己資本比率2.81%を保持した後、
その2項目が未取得になった後続レコードを保存し、Notionの全数値プロパティと
実SQLを実行したD1/local行がNULLまで一致することを検証した。

後続レコードの時刻差1秒は更新順を試す構造条件であり、実在の訂正開示を意味しない。
値を新しく作らず、原本値または未取得だけを使う。古い完全原本の再実行で値が
復活しないこと、同じ疎なレコードの再実行で行が変化しないことも確認する。

## 検査

- `nix develop -c uv run --project pipeline pytest pipeline/tests -o addopts='-rs' -q`:
  1,259 passed / 55 skipped。skipは既存の未取得原レスポンスfixtureで、今回の実原本回帰は実行済み。
- `nix develop -c uv run --project pipeline ruff check pipeline`: PASS。
- `nix develop -c pnpm typecheck` / `pnpm lint`: PASS。
- 未変更のTypeScript側をclean worktreeで `nix develop -c pnpm test`:
  2,567 passed / 383既存fixture未取得skip。通常作業フォルダではignoredの旧cutover SQLを
  テストのmigration一覧が読むため旧DROP済み表で77件失敗した。元ファイルは動かさず、
  clean worktreeの番号付きmigration全件で検証した。PRのCIでもclean checkoutを使う。
- `git diff --check`: PASS。
- 独立サブエージェントはPK/開示日時/licenseガード維持と19数値項目のNone一致を、
  DB/APIを使わず生成SQL・パラメータで確認。追加blockerなし。

この検査は通常writerの契約修正の証拠。全34,663原本の正本修復とD1同期の完了は別の
fresh receipt・隔離D1検証で判断し、本項のテスト成功だけで反映済みとはしない。
