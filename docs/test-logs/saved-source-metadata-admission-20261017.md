# 保存原本queryと本文資格のmetadata契約を揃える（2026-10-17）

受注の通常有限PREは、保存type1 `290A/S100XUO9` の一意query応答を保存した直後に停止した。
原metadataには `docID`・`stockCode`・`rawSecCode` があるが、top-level `edinetCode` / `periodEnd` はない。
元の `primary` は公式EDINETレコードを保持している。しかしquery observerだけがtop-level提出者を必須にし、
通常の `readSavedHoldingsZip` / `verifySavedHoldingsMetadata` と異なる条件で拒否していた。

## 通常の共通経路

`backfill-orders.ts` と `backfill-overseas.ts --saved-cohort` は同じ
`saved-overseas-backfill.ts` を通る。query admissionと既存canonical full-source確認の
metadata・typed lineage部分を `assertSavedSourcePageMetadata` にまとめ、両方で同じ
`verifySavedHoldingsMetadata` を呼ぶ。

- `docID` と銘柄の束縛は必須。存在する提出者・期末・証券コードが違えばSTOP。
- top-level提出者・期末の欠測は既存readerの `metadataMissing` と原metadataに保持する。
  nested `primary` から値を補完しない。query admissionを業務資格の完了にしない。
- 後段の `readSavedHoldingsZip` は引き続き物理ZIPの全SHA/サイズ/manifest、公式namespaceの
  単一PublicDoc DEI、提出者・証券コード・期末、取得時計を検証する。
- 旧archive IDからtyped canonicalへ変わる場合はtype1・旧legacy ID・一意manifestの同ZIP SHAが必要。
- 既存の最新文書・本文・全6表CAS・原子送信・全POST・immutable source claimは変更しない。
  通常ingest/missing-backfillの抽出・serializer・価格・財務値・DDLも変更しない。

## 保存実データと回帰

実fixture `services/yuho-quant/src/tests/fixtures/saved-source-S100XUO9/` は、停止時のunique query応答から
Metadata rich_text・取得時計など必要なpage fieldsだけを投影したもの。署名URLと無関係なpropsは含めない。
新native HTTP応答とは扱わない。provenanceに元応答SHA、投影SHA、ZIP SHAとbyte数を記録する。

- 元応答: 200 / 8,043B / SHA `b3e95b4da2c128ff226948f0926a7c054c7cb9e947ec53f030911e0647ff2b9e`。
- 同ZIP: 1,495,818B / SHA `891746f766b50e6a42a1f7fccb1f4e07b6852dfe666f56e128ba28361998cf09`。
- 公式DEIは `E40216` / `290A0` / `2025-12-31` と一致。通常order parserは `ok_pattern_a` / 1fact。
- 実metadataの欠測を保った正例と、doc/提出者/FY/stock/rawSecCode/銘柄束縛欠落、
  別canonical ID、ZIP SHA・取得時計・公式DEI違反の明示的負例を回帰した。
- 関連2 suites / 12 tests、全体TypeScript、対象lint、`git diff --check` PASS。
  独立peerはquery/canonical/公式DEIの接続をread-only確認した。

```sh
nix develop --offline -c env -u NODE_PATH node node_modules/vitest/vitest.mjs run \
  services/yuho-quant/data-scripts/lib/saved-overseas-backfill.test.ts \
  services/yuho-quant/data-scripts/lib/saved-orders-backfill.test.ts
```

private保存再生（HTTP拒否）では全128 nativeのrequest/response bytesとSHA、200応答、D1 rows_written=0を照合。
13件のsource query中、旧12件は同値、最後の `S100XUO9:type1` だけが旧observerの必須欄違反だった。
同じ既存ZIPを通常DEI/受注parserへ再生し、全入力の再hashで旧証拠の不変を確認した。

| 項目                                 |  元停止runの実消費 |      今回の保存再生 |
| ------------------------------------ | -----------------: | ------------------: |
| native / Notion / D1 SELECT / hosted | 128 / 98 / 18 / 12 |               追加0 |
| D1 rows read / batch                 |         14,264 / 0 |           本番追加0 |
| request / retained response bytes    | 4,628 / 21,903,563 |             新通信0 |
| 時間 / peak RSS                      |     元run 391.834s | 0.374s / 357,536KiB |

結果 `tmp/saved-metadata-stop-v1/result.json` SHA
`666d75beb1fb51859e02fb68e1199b862ca12bdfcf8e93d8a106094f2a56cf56`。
この時間は保存原本の純再生であり、本番の処理時間予測ではない。
今回の修正はquery応答の既存metadataを同じ関数へ渡すだけで、追加GET・ZIP展開・依存・モデルは0。
変更されたcanonicalのmanifest資格は、もともと後段で必要だった同じ条件をquery時にも照合する。

## 本番と再開の境界

旧凍結92c source、原STOP、128 native、partial ZIP、旧20 claimsを変更・削除していない。
この監査はpartial PREを完了capsuleへ昇格させず、残92文書の業務資格・適用完了を主張しない。
再開は修正の受入後、別の明示releaseで通常PREから行う。元128件の実消費と原17:11:23 JST期限を引き継ぎ、
同じpersistent stateと旧claimsを保持する。source/財務書込み、再送、追加上流GETは今回0。
