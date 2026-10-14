# 保存済みClef出力1社の本番受入

対象は4054 / S100Z492（2026-06-30期）の補足page `3e6d74ff-84cd-8168-b0de-fc610a27c9b4`。通常のローカルClef本番判定で得た実出力を保存済み物理PREから反映した。モデルreceiptは `Cloudflare/clef-flash@8b2e5fd1/torch-mps` / vocab v5。旧SemIf receiptのモデル名を書き換えていない。

最初の通常CLIは、rootの限定native guardが必要なheading appendを許可していなかったため、モデル処理後の最初の業務送信前に停止した。実native102要求/全HTTP200にはPRE物理保管3mutationだけが含まれ、PATCH/DELETEのintentは0。原ラッチ・STOP・実モデル出力を保持し、CLI再送や再推論を行わなかった。

物理PRE `biztag-pre.json` は450,504 bytes、SHA `ada9086f5f5d77d5b66c43704fa14eb7426e536d2888aa2b53b674b031029f2f`、Notion page `3f9d74ff-84cd-81b8-bb59-f779a5ffae95`。旧全67props・時計・children、保存済み新63props/根拠、最新D1 doc/pointerをfresh読取りで再資格化した。

継続はaccepted main `049e39a44819f1ea72ac5c47ab0b91991c38cd2a` の既存共有writerを最小限の私有adapterで再用した。保存済みpropsとPRE照合hookだけを差し替え、新根拠append/全文読戻し→props単発PATCH/全67読戻し→旧根拠DELETE最後/読戻しの順序は同一。Nix・kernel writer lock・wx/親dir fsync・全source pin・期限・native allowlistを使い、未知ACKは再送しない。影のtransport検証12項目と共有物理POSTのmetadata58分割検証も通過した。

| 段階 | 結果 | 実native要求 / mutation | 秒 |
|---|---|---:|---:|
| 保存出力の反映 | 全67props、新根拠全文、旧最後退役、最新D1一致 | 21 / 3業務 | 40.801 |
| POST物理保管 | fresh全状態一致後、共有archiveで物理upload/fullSHA | 13 / 3archive | 25.537 |
| 独立別process | 全67props・新根拠・旧退役・最新D1・POST全文SHA一致 | 7 / 0 | 13.501 |

すべてexit0、継続のモデル/取得元API/D1 write/PRE再uploadは0。物理POSTは348,912 bytes、SHA `e435160127076fa32f1a50094b36357561805af33cd403ca6eaf19b0a557bf61`、Notion page `3f9d74ff-84cd-8189-bdcb-ec41959e9b09`。private最終freezeは `c9de554995f956c6af6a1ef6764f0109dc0087b35c2224c64c03069f5c96ec32`、exact root releaseは `177c38f6e4920c18abe5edafffabbd0899f5dd50eadc075cb35572fcfa7f46ac`。

この1社の受入を残106社や全39本文へ広げない。元pilotの開始前swap基準値は取得しておらず、swap増加0とは主張しない。ローカルモデル利用でも電力・ハードウェア費用は未計測。残りはfresh planと全文資格済み本文scopeを交差し、機械同期はモデル0、実入力変更だけをClefへ渡す。
