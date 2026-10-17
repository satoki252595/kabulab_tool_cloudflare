# 優待v1条件の明示有限更新（2026-10-17）

## 正常ツールと範囲

`backfill-public-facts.ts` に `prepare-upgrade-v1` / `apply-upgrade-v1` を追加する。旧 `prepare` / `apply` と `planPublicFactsBackfill` のNULL列への初回取込契約は維持する。既存v1をNULLへ仮装したり、全7,716行を書き換えたりしない。

scope JSONは明示した銘柄コード・sourceGroup・正規化前description全文SHA・行数・全recipientのみ。最大3銘柄・15群・19更新行で、同じ銘柄の全PREは100行まで。重複・欠落・部分recipient・別原文を拒否し、束縛JSONは各64,000Bまで。scopeの全3銘柄をactive/equityの正常readerで読み、101行以上なら切り捨てず停止する。

旧v1をstrict読取りし、同じ共通producerへ実原文・全recipient・旧source時計/公式情報を渡す。旧v1の全fieldsが同値で、全文1点選択構造を資格化できた場合だけversion2とconditionStructureを追加する。元時計のNULLや公式未確認を埋めず、原文・価格・評価額・要約・updated_atを変更しない。

全scoped行の全列・株式主体・件数を一つのatomic batchでCASし、旧public_factsはJSON解釈した同値ではなく元文字列でも照合する。更新列は対象19行のpublic_factsだけ。対象外4行の変化もbatchをrollbackする。全列POSTと物理POSTが一致した後だけ完了とする。物理PRE/POSTは既存recordPrimaryData/verifyArchivedAttachmentsによるgzip実体2ファイルで、新sourceAPI・モデル・依存・DDLは0。

## 一度だけの移行記録

適用前にrealpath(.env)の親配下 `tmp/yutai-public-facts-v1-upgrade` へ開始markerをwx/0600/file fsync＋parent fsyncで保存する。最初のPRE保管より前に置き、途中archiveやD1の結果不明を別出力先・変更後PREで迂回しない。物理POST後に元intent/readback/receiptのSHAへ束縛したcompletionを保存し、開始markerを削除しない。この明示migrationは完了後も再送不可で、未知state/破損・残存ファイルも停止する。自動修復・自動再dispatch・GCは追加しない。

全worktreeが同じcanonical .env実体を共有する既存運用が前提。別実体の.envコピーで同じDBへ別stateから適用する運用は認めない。実行側の.env symlink/realpath一致・永続state・source pinsはroot releaseで別途確認する。Macの凍結runtimeや既存producerは変更していない。

## 保存実入力の検証と負荷

既存accepted D1 readbackの全文SHAは `82317d87aedf4877a1a6b16fb899832fc395223e85523d45123a5207a70f8dfb`、元applied receipt SHAは `c9c7e4b92652ac9fe561974ab9178ce7cd4cc4c09e18986082dae72d158d3a83`。2026-10-13の保存断面であり、現在の本番PREではない。3銘柄の全23行を投影し、15群19行だけ更新・他4行の全値保持を正常planner→SQLiteで再生した。旧v1 JSONや時計を合成して実入力と称していない。原文はprivate保存のまま。

全23行×12列、3主体×4列、23行の欠落と余分な行の計312CAS負例で、変更後のPREを保持したまま全更新をrollback。既知成功後の同SQL再送も拒否する。旧NULL-only planner本文はaccepted47b92b54とbyte一致（SHA `96b8c4910bd9e546a2642aa2526be153695635a7943d739ba286a619aacdd8fe`）。

保存23行では3 SQL、HTTP batch JSON72,305B。各束縛JSONの64,000B上限は総HTTP bodyの64KB上限ではない。PRE配列JSON24,593B/gzip2,054B、POST配列JSON31,199B/gzip2,956Bで、配列の計測にはsource/scope/保管metadataを含まない。本番wire bytesや全保存量と呼ばない。ローカルの正常SQL計測は約0.63msであり、D1やNotionの本番所要を保証しない。

根拠は専用worktreeの `tmp/v1-upgrade-saved15-v1/audit.mts` と保存結果。fetch拒否、HTTP/sourceAPI/model/本番書込0。実23行の回帰はprivate入力が存在する環境で実施し、CIの合成境界試験・投影fixtureと区別する。

```sh
nix develop --offline --command pnpm exec tsx tmp/v1-upgrade-saved15-v1/audit.mts tmp/v1-upgrade-saved15-v1/root-replay.json
# fresh実入力とroot release取得後のみ。元NULL移行のmodeへ渡さない。
pnpm exec tsx --env-file=.env services/otakara-yutai/data-scripts/backfill-public-facts.ts prepare-upgrade-v1 <fresh-source.json> <private-output> <explicit-scope.json>
pnpm exec tsx --env-file=.env services/otakara-yutai/data-scripts/backfill-public-facts.ts apply-upgrade-v1 <fresh-source.json> <private-output> <explicit-scope.json>
```

本番fresh PRE・19行の適用・物理2ファイル・全POST受入は未実施。新Notion枠とroot releaseが揃うまでLIVE0を維持する。保有期間tier/併用等の未解析構造や全20機能の完了とは呼ばない。

検証: Nixで関連5 suites87 PASS（既存private入力欠測3 skip）、実23行の限定更新回帰を実施、全typecheck/対象lint/diff check PASS。最終私有pure proof `tmp/v1-upgrade-saved15-v1/result-v4.json` SHA `df104e597ef415c30982cb071eb36d8cc153dc9d1daa32e647b787a0b2277168`、audit script SHA `058491878fc97afe422150625edcd2b7fb18ea62f6601df31948ca93d60838e3`。全312負例込みのローカル実測0.141秒。初回pure比較のSQLite返却object prototype差STOPと旧script、計測単位訂正前の結果は不変保全し、原文や本番データを修正していない。
