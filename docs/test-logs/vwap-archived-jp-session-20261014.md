# VWAP 日足の同日保存JP原本を明示選択する入口（2026-10-14）

夜間のYahoo `^N225` 日足には、既に引けた日の実closeがNULLになる保存観測がある。同日の引け後に既存stock-syncが保管した原文を、日足取込の開始前に明示選択できるようにした。既存17:00定時と引数なしCLIは従来の `yahoo-direct` を使う。取得失敗後の自動切替はない。

```bash
pnpm ingest:vwap-daily --session-source=archived-jp-leg --session-date=2026-10-14 --codes=7203
```

この日付は実runのJST暦日と一致する場合だけ有効。workflow_dispatchにも同じ2入力を持つ。保存日付から当日を推測せず、未指定・過去日・未来日・対象外sourceを取込前に拒否する。既に起動・待機中のworkflowは変更しない。

## 保存資格

既存 `loadMacroJpLeg` が同日R2を1回読み、JP manifestとVIのNotion物理全文、N225のSHA・当日確定close・前session closeを検証する。その同じcache bytesに対して、directと共通のN225純session資格を適用する。追加でN225の元Notionページと単一gzipをfreshに読み、active/recorded、冪等key、manifestのファイル名・サイズ・全SHA、run/stage/予定日、単一Chart memberのsymbol・attempt・実受領clock・全bytes・要求URLを照合する。

元原文と18:02の受領clockを変更しない。個別株にも既存の要求窓・原文全行・閉場済みmeta・条件付PUTを適用する。日跨ぎはSTOPし、保存原本のclockを更新したりdirectへ切り替えたりしない。内部の原本参照はrun summaryのmetadata/物理JSONに記録し、公開daily JSONへNotionページ参照を追加しない。

## 実原文と費用

2026-10-14の保存原文は2,832B、SHA256 `82343be04851794a5dfe682e22a8cb7a731159aaf256a8a9e993f02ba1d38772`、実受領 `2026-10-14T09:02:12.223Z`。同日のregular sessionは09:00–15:30 JST、実quoteは15:45:03、最終当日barのcloseは67,744.2890625。この原文全bytesをfixtureに固定し、既存と共通の純資格を通信なしで通した。原本ページは `3f9d74ff-84cd-815b-a772-c5f3536ce88a`。取得URLや署名URLはfixtureへ含めない。

選択時はR2 GET1、Notion native GET2、hosted GET3（JP manifest/VI/N225 gzip）の計6read。新upstream GET・原本再upload・R2 PUTは0。展開は最大16MiB、原gzipは20MiB以下の既存manifestサイズでstreamを制限する。通常の銘柄取得数や保存量を増やさない。本番実行はこの変更のCI/main受入後、別の明示運用判断で行う。

## 検証

Nixで4suiteを実行し88 PASS / 既存3 SKIP。実原文の同日資格、gzip/body/clock/symbol不一致、物理読取失敗、cache欠測、日付不正、日跨ぎを確認した。取込callerでもsource指定を記録し、保存原本失敗後のdirect取得0、日跨ぎ時の株取得/PUT0、内部Notion参照の公開JSON混入0を確認した。全repo TypeScript、owned ESLint、YAML parse、diff checkはPASS。通信・本番write・モデル実行0。

rootは凍結8ファイルの全SHAを照合し、Nixで独立した3suiteの74 PASS / 既存3 SKIPを確認した。さらに19:44 JSTに本番保存体へ新readerを一度だけ実行し、R2 GET1・Notion GET2・hosted GET3の計6readを1.724秒で完了した。原本再取得・upload・業務write・モデル実行は0。元の18:02のclockと原文SHA、および保存gzip SHA `307b693de7fb286477dab0440644526f8124cb24e0eab36077fccc7f2a5031fb` を照合した。この読取受入は全銘柄取込の完了を意味しない。既存待機run `38547185176` は変更していない。
