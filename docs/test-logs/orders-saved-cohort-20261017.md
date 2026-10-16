# 保存原本による受注の有限補修 — 2026-10-17

通常 `ingestDocument` と `processMissingDoc` の受注保存変換を `toOrderSaveRows` に統一した。受注parser・採用表・金額・NULL・前期行・提出会社単独のfalseは変えていない。新 `backfill-orders.ts` は既存の保存海外売上ツールの原本資格、typed-first、現在最新有報/本文、全6表CAS、通常growth投影、物理PRE/POST、独立inspect、通信予算を再用する。新源取得・モデル・依存・DDLは追加0。

## 有限入口

`nix develop --offline -c env -u NODE_PATH node --import tsx services/yuho-quant/data-scripts/backfill-orders.ts` へ既存saved-modeの全有限引数を渡す。`.env` は `dotenv/config` と既存型付きenv accessorで読む。通常CLI/Actionsと同じNode依存lockを使い、Nixはローカル環境構築だけに用いる。

- cohort は strict `{version:2,kind:"orders",stateDir,items}`。各itemは既存のstock/document/EDINET/FY/ZIP全SHA/元archivePageId/元manifest既知・未知/原取得時計で固定する。海外version1と混用できない。
- `--saved-cohort` / `--cohort-sha256` / `--saved-mode=prepare|apply|inspect` / `--after-code=START|<code>` / `--max-targets` / `--out` / `--max-seconds` / `--not-after` / `--max-notion-rps` / `--max-http` / `--max-notion` / `--max-d1` / `--max-response-bytes` / `--max-request-bytes` を必須にする。apply/inspectは `--capsule` / `--capsule-sha256` も必須。通常のforce/limitによる迂回は拒否する。
- 1window 1–20文書、最大1800秒、HTTP1000/Notion400/D1SELECT400、応答保持256MiB/要求64MiB。各nativeの前に65秒余白、単一試行/60秒/redirect拒否、未知・429・構造不正はsticky STOP。D1 rows_read 500kは応答後の停止上限で、SQL scanを事前に限定する保証ではない。応答保持量と受領済みchunk量も分けて記録する。
- stateDirは専用の同一実体を継続使用する。既存realpath・本人所有・0700を必須とし、新しい空stateの自動生成はしない。同docId+ZIP SHAのclaimをapply HTTP前にwx/fsyncで保存し、成功も結果不明も削除しない。別PRE・別outだけでは再送不可。別stateを作り直す操作はこの保護を壊すため禁止。Actionsのephemeral filesystemが次runへ永続するとは主張しない。

## 更新する値と保持する値

正常parserの4つのok status、非空facts、当期を1行以上含むこと、全FYが報告期末以下、scopeが同じ明示boolean、実DBのFY/segment自然キーの一意性を必須にする。B/C型が原表で明示する前期・当期の両方を保持し、falseをtrueへ読み替えない。不明表/HOLD/重複は削除前に停止する。

更新は対象docの `parse_status` / `honbun_file` とその受注factsだけ。共通通常growth投影は再計算する。全6表の全旧列/行数/集合を同一atomic batchの先頭CASで保護する。海外facts/omission JSON/39本文索引/他文書facts/core株は保持し、任意の旧値raceで全batchをrollbackする。物理保管key/filename/statusはordersへ明示分離し、海外v1の保存形式と既存claim/capsは維持する。

## 保存実データと検証

新fixtureは既に受入済みの通常PREから3106/S100YIYEの全6表断面を抽出し、同じ実原本ZIPをそのまま保存したもの。原本/断面/元capsuleのSHAをprovenanceへ保存した。これで6表CAS、その他列保持、通常growth、同値repeatを確認した。既存1719/S100YHJPの実ZIPでB型の2025/2026両FY・falseを確認し、HOLD・重複・期間不明を負例で停止する。

818対象のうち資格済み813実原本の通常parser/mapper再生（source HOLD5は別保持）と、海外20文書の旧新atomic全SQL/expectedの照合結果は下記の実測欄に記録する。関連8 suites74 tests、全TypeScript/lintはNixでPASS。HTTP/model/本番writeは0。

## 同条件の実測

818対象の資格済み813 ZIP（合計 768309541 B）を再parseし、保存parser結果・旧mapper・新mapperの全値が一致した。positive221/構造化未資格592/source HOLD5を区別した。既に保存された海外20文書の全6表断面を旧accepted2bacのbuilderと新builderへ渡し、全SQL/params/expectedが20/20一致した。新源GET/Notion/D1/モデル/本番書込は0。

純再生 120.987秒、親peak RSS 835504 KiB。20件builderの累計呼出時間は旧 368.374 ms / 新 363.286 ms（旧→新の1回比較、中央値 18.192 / 17.901 ms）。小さなローカル実測であり本番完走・料金の保証には使わない。通常ingest/missingの変更はpure mapperだけなので追加通信0。保存補修は既存有限プロトコルの通信・物理PRE/POSTを伴い、fresh対象の実費は別受入する。

私有結果 `.runtime/orders-fixed-cohort/source-v1/tmp/orders-saved-pure-v1/result.json` SHA `496ebd2bdc7c4e9f82de313e13ca8c9843f14584e60da33523f2feb0c321ae85`。同dir `replay.mts` SHA `dd9db4350fa5168ae7a8442557f2958e81916a02614778829ac8c53a6876dd92` を作業WTのNixから `node --max-old-space-size=3072 --import tsx tmp/orders-saved-pure-v1/replay.mts <同dirの未使用絶対JSON>` で独立再実行できる。入力とproduction source/lockの全SHAをbefore/after固定する。最初の私有auditorは813資格済みitemを全対象818と比較する分母assertで停止したため、元script/STOPを保全して対象818と実813を分けた再生へ修正した。parser/production writerの失敗ではない。

## 未受入

rootの保存20D1応答の再集計 `current-saved-comparison-v2.json`（SHA `1e60453690efe9d6fd13a1fbe127e62218bd1fef9cf7edd52dbe1cee7700ec77`）は818対象、813原本資格済み/5source HOLD、221positive/177補修候補。B型の前期行を過剰除外していた旧184/140/51比較は保全し、真のunsupported＋旧facts48は別HOLDのまま削除0にする。

177候補の現在最新有報・全6表fresh PRE・実適用・独立inspectはまだ未資格/未実行。本変更のコード検証を本番受入と混同しない。定時取込の共通保存変換は共有化したが、保存cohortの対象選択・永続state・writer排他・有限releaseは別の運用契約である。

## 合計行を持たない正資格受注の保存

固定disjoint112の最初20文書はaccepted `7d938e38462b5cf151ff53172faac052a4b7ae8d` の通常prepareで原本・本文・全6表を読取だけで取得した。202 native（Notion152 / D1 SELECT30 / 保存ZIP20）、D1 30,044 rows_read、応答33,597,678 B、608.198秒。PRE capsule SHA `bccaf870b19ba408922b7e0b2c7a07c99c88475ddf96fb5cc3d99e24cf46d4b7`。書込み・新源取得・モデルは0。

続く純atomic検査は1720で `rebuilt.stocks === 1` に停止した。通常のgrowth投影は `segment_kind='total'` の受注だけを成長率へ採用し、合計のない正常B型は0行を返す。全20文書の純診断で9文書（1720/1766/1768/1799/1807/1811/1833/1835/1850）がこの条件に当たり、残11文書は従来どおり1行だった。最初のSTOP・旧source/env/PRE/cohort/永続stateは保全し、applyは未実行。

共有atomic builderのorders分岐だけ投影0または1行を許可する。海外分岐は従来の1行必須を保持する。通常投影のSQL・対象限定DELETE/sweep・expected断面は変更せず、`計`を`合計`へ読み替えたり、セグメントの和・全社合計・成長率を生成しない。実1768/S100YEJUのZIPと全6表断面をfixtureへ保存し、前期・当期6明細（segment/subtotal）、投影0、全他値保持、6表CAS rollback、同値repeatを確認した。既存3106の投影1行も明示確認する。

旧新paired純再生では20/20の新builderが成功し、旧成功11文書の全SQL/params/expectedが一致、旧guard停止9文書は成長率未算出のまま保存可能になった。全6表の変更PRE負例120件をrollbackし、20repeatと既存海外20文書の旧新全SQL/expected一致を確認した。parser・mapper・saved資格moduleは同bytes、別途追加済みの保有read-only inspect関数を含むarchiveファイルは、実使用 `readSavedHoldingsZip` / `verifySavedHoldingsMetadata` の関数本文が同bytesであることを固定する。

純再生12.402秒、peak RSS1,298,128 KiB。共通成功11件のbuilder累計呼出時間は旧216.928 / 新210.979 ms（中央値19.115 / 18.918 ms、1回測定）。追加SQL・GET・モデル・依存・DDLは0で、実本番の所要保証にはしない。関連4 suites61 tests、Nix TypeScript/lint PASS。

私有paired結果 `.runtime/orders-empty-projection/source-v1/tmp/orders-empty-growth-pure-v1/result.json` SHA `b00e8e5764f501cb90f606cafc17fa357d58ff1de58e2d92e206cb1db6f986a8`。同dir `replay.mts` SHA `74d4d657de50d307970d32aba2c3a383d8368e9550d8852fb97a05434a4413c6` は、そのWTのNixから `node --import tsx tmp/orders-empty-growth-pure-v1/replay.mts <同dirの未使用絶対JSON>` で再実行できる（HTTP禁止）。新sourceを旧PREのproducerと主張せず、明示した旧新資格同値を根拠にする。実applyは受入済みの新revisionと旧PREを別々に束縛し、通常の書込み前全6表・最新doc・原本文字列の再照合が同値である場合にだけ別releaseで実施する。永続claim・旧unknown・独立inspectの契約は維持する。
