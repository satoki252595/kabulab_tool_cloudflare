# 指定コードrunの副処理を限定する（2026-10-18）

[Sonnet事前レビュー](sonnet-production-review-20261018.md)の候補3/4を実calleeで確認した。通常CLIの`--codes=`やカンマだけの指定は空配列へparseされ、その後全市場の省略指定へ変わっていた。また非empty指定でも、補足DBと関連付け先マスタを全件取得し、全市場の見直し材料を更新していた。

## 最小変更

- CLIの明示empty/裸`--codes`と、`runBiztag`の空・不正・sparse codesをmetadata HTTP/モデル前に拒否する。省略時は従来の全市場実行。activeでない/未登録のコードが選択されない意味は保持し、別銘柄や金融値で埋めない。
- コードを正準Setとして揃え、D1と補足DBに同じscopeを渡す。pipeline内の既存`chunk`と補足readerの既存OR filter/paginationを再用し、50コードずつ取得する。101コードも50/50/1へ分かれ、新しいCLI上限を設けない。返却された対象外コードは処理前STOP、選択コードの重複行は既存readerが拒否する。
- 指定runでは全市場の見直し材料を更新しない。部分scopeを全市場packetとして保存しないためで、コード省略時の全件集計・台帳更新は従来どおり。語彙資格・期限通知・未閉鎖journal停止は保持する。
- 関連付け先マスタは、指定runで`create_row`/`sync_and_tag`/`retag`/`retry`の実処理へ進む直前に既存索引を一度だけ取得する。`sync_text`/`skip`/`no_text`/`version_bump`はresolverを使わない。未取得resolverはthrowし、空の索引で代替しない。`masterIndexRead:false`は全市場の重複確認済みを意味しない。実取得時の索引・重複処理と、省略runの事前全件取得は維持する。

通常`runBiztag`の本番callerは`data-scripts/biztag.ts`だけ。`ProcessDeps`の同期resolver契約、通常planner/processor/publisher、本文39項目・根拠・単社書込前資格・物理PRE/POST・canonical completionは変更しない。指定runのbilling/HOLD等の集計は選択scopeの補足行から行う。

## 保存実入力の検証

既受入G50の保存PRE・全39本文・実v5語彙を使い、旧normal pipelineと新pipelineを同じ50社で比較した。全50社の通常publisher入力と保持対象guardが全値一致し、最新doc照合へ渡す値も同じ。master helper呼出1→0、全市場見直し材料writer呼出1→0を確認した。その他の語彙期限通知入力は同値だった。

私有結果 `tmp/feature-audit-20261018/biztag-scoped-run-proof-v1/result.json` SHA `ff138b43b348221d20b6b6c2970aea4bd047746014707a55224c44da8adcffe4`。元G50 gzip SHA、旧新pipeline SHA、全publisher入力SHAを保持する。この比較は保存50社の技術検証であり、metadata/台帳/masterの返却を明示した読取専用test投影に置換している。全市場・現在の資格や実native送信の再現とは呼ばず、外部HTTP/モデル/業務書込/canonical変更は0。

Git回帰では実保存101コードの分割、実215Aの既存receipt/通常refresh、対象外応答STOP、明示emptyの実CLI入口、省略全量run・既存HOLD・関連付け重複を検査する。CLI入口テストではwriter排他を置換し、OS操作を行わない。実価格・株数・原時計・未確定状態は補完しない。

Nixでpipeline/process/plan/source/review/CLI/competitors prepare/停止policyの8 suites・248 tests、private実50比較1件、full TypeScript、owned4 TS lintがPASS。新依存・DDL・本番操作は0。

実D1/Notionの通信量・課金・実行時間改善は未測定。現在の50社metadata READ受入、本文補完、新runtime/env/定時切替は別受入。候補8の全履歴SELECT/window化は、最新HOLDと旧親へ戻らない選択の同値が未証明なので変更していない。
