# 海外売上13文書の本番反映・全項目照合 — 2026-10-02 JST

Refs #132 #146。原文・実数値・認証値・Notionのprivate URLは公開Gitへ保存せず、
集計・SHAだけを記録する。旧[原本15文書・修正前9資格/57明細](overseas-next15-custody-20261002.md)
の履歴を保持し、[統合全文解析の13資格/84明細](overseas-whole-filing-evidence-20261002.md)を別段階として反映した。

## コード・更新前の検証

- [PR266](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/266)のexact head
  `e95d8fc155d34dda8a9f84944ca28e8f46691aca`は406回帰PASS/14既存条件付きskip、
  型・対象lint・Worker dry-run・独立全文レビュー・3CI成功後にmerge。
  main `bbebdb8bd524a829223f7fe1ef90db03767e9d9f`のCI
  [36925586462](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36925586462)も成功。
  21:02UTC頃のCloudflare実画面で同mainのBuild成功、version `75b6e36d`、本番100%を確認した。
- 15原ZIPの全bytes/SHA、全本文のissuer/年度、採用表の実本文位置・単位・地域・引用を
  再計算し、13資格/84明細がrootと独立レビューで一致。S100W1Q5の集計範囲競合と
  S100FHUHの年度矛盾はHOLDのまま、更新対象外にした。
- PREは21:01:07.603〜21:01:13.500UTC。固定13文書の全16列と70明細の全12列を
  正確な2 SELECTだけで取得。原HTTPをschema型へ復号した全集合と保存inputが一致。
  Notion8/hosted1/D1読取2、全11通信がknown HTTP200。197,840 bytesのPRE ZIPは
  実体保管・actual persisted manifest・hosted全文・内部53member全SHAを照合した。
- 最初のapply CLIは必須PRE計画1pinの登録漏れで通信前に停止。env/DB/native/予約/捕捉0、
  apply出力未作成を確認し、旧計画とgrantを保持した。計画へ当該1pinだけを追加し、
  全174pins、旧有効grant相当のSTOP、新しい正の入口・実PRE検証PASSをroot/独立レビューで確認。
  新しい期限付きgrantでだけ実行した。未知の送信の再試行は行っていない。

## 実反映と独立検査

- 実通信は21:20:26.812〜21:20:41.087UTC、単独writer、正常終了0。
  **9 APPLIED / 4 MATCH**。更新対象の9文書は63明細、既に一致した4文書は21明細で
  sender0。更新後の固定13文書は合計84明細が資格保存集合と一致した。
- 9条件付きbatchは各4 SQL、実PREの文書全16列・明細全12列・行IDの全集合を先頭で比較。
  文書は海外解析の2列だけを更新し、他14列を保持。全明細のbusiness値・親ID・実採番IDを
  actual HTTPから独立照合し、更新後84 IDの重複は0。
- 変更した9銘柄だけ表示用集計を更新。実INSERTの32bindを型付き値へ復号し、
  実更新時刻を含む全32列がexpected/actual POSTと一致。MATCH4文書の銘柄は
  集計の読取・再計算0であり、今回の全32列証明には含めない。
- 同じ文書producerへの全13再入はMATCH、追加sender0。全16列・全12列・84実IDが安定。
  集計producer自体の再入は実行していない。
- 実通信はD1 142/Notion8/hosted1/source0、全151予約・捕捉がknown HTTP200。
  全request/response原bytes/SHAが一致、unknown/race/再送0、R2/dispatch0。
  POST ZIP252,985 bytesを共有窓口で実体保管し、actual manifestのMIME/bytes/SHA/
  fingerprint、hosted全文、内部386member全SHAを独立照合。原ZIP・PRE ZIPの再アップロード0。
- 元source段階111通信、PRE11通信、今回apply151通信は別ledgerで保全。
  独立検査の追加通信0。Y53G/AO7Mの旧source clock/legacy manifest UNKNOWNと、
  closed59所属・旧原本台帳所属UNKNOWNを今回の結果で解除しない。旧3611全体の完了は未証明。

| 私有証跡 | SHA-256 |
| --- | --- |
| 固定13資格index | `9d1908c478c08c8f8dfadfb3bb8167fc8eeac8969f8600ebb3ba83dfe4c4f708` |
| 実PRE acquisition | `2abf55ab6cd16257f83d7764f7c467f013f1635bbb43118f1d9f9f89bbe1cac8` |
| PRE ZIP | `4898765f1125c21b7b8b9e01f1020214804fbe43b3eb87efae77b26c65e9c5b2` |
| 修正後174pin計画 | `02c0d694104e904db64bc12d8ad4e2e1a1776f448253d3c6894355cf36972a73` |
| 実apply完了記録 | `76a2255673b0cd48990e8506eaecc5bb11d4469fe8639d5afda6ff42d00174a8` |
| POST ZIP | `61efc4b4e1efc4c24c19af6ca57e010805244ec913f81791f5687a7e1da1926d` |
| 独立source/PRE/POST検査 | `e0004acb65ddeb865053513e28f7eae1d0437a876773f1da138efe042409de25` |

今回applyのD1応答169 statementのmeta全件からread2,554/write328を集計した。
単発実績と月間費用を分け、[費用確認](../cost-audit-2026-10-01.md)へ記録した。
