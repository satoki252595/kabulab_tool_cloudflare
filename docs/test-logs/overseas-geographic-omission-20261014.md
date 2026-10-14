# 地域別外部顧客売上の明示省略理由 — 2026-10-14

## 通常取込の変更

`parseOverseasData` は、地域別外部顧客売上の原文が「本邦の外部顧客への売上高が連結損益計算書の売上高の90%を超えるため記載を省略」と明示した場合に限り、既存の抽出結果へ任意の `omission` を付ける。理由の適用範囲は `regional_external_customer_sales_note` であり、有報全体の海外売上未開示を意味しない。

資格は同じ本文・実 native duration・issuer・期末・dimension の照合と、可視原文の完全な省略文で確定する。`CurrentYearDuration` の dimension なしの期間と、原文の「連結損益計算書の売上高」を両方必要とし、DEI の連結値だけで表の主体を補わない。原本文 member SHA、地域 TextBlock 原 bytes SHA、原文 quote、native context の entity/start/end を証拠に残す。

コメント、CDATA、`ix:hidden`、未閉鎖、外側または内側 `ix:nonNumeric` の `continuedAt` は省略理由の証拠にしない。同じ entity/start/end の地域売上 TextBlock に実表と省略文が共存する場合だけ明示 HOLD とする。期末だけ同じ短期期間の表や、別の収益分解・セグメント開示の実数との共存は矛盾としない。後者の既存 facts/proof は保持する。金額、海外ゼロ、`total − Japan`、海外比率は省略理由から作らない。既存 status/DB/UI schema は増やさない。

呼出経路は次のとおりで、private 回復 runner 限定の仕様ではない。

- `scripts/sync/yuho-edinet.ts` / Worker admin → `runYuhoEdinetCatchup` → `ingestDocument` → 共通 parser。
- 通常 `data-scripts/backfill.ts` → 同じ `ingestDocument`。
- `backfill-missing-docs.ts` → `processMissingDoc` → 同じ parser。
- `backfill-overseas.ts` → 同じ parser。

3つの実原本 writer は、取得済み ZIP を既存 `recordEdinetZip` で保全する際の metadata へ `overseasOmission` を渡す。新しい取得・アップロード呼出は追加しない。同じ原本 key が既存なら共有の `skip_existing` 契約に従い、旧 metadata は更新されない。この PR が既存原本の省略理由を本番へ遡及保存済みであるとは扱わない。

## 実原典と負例

5原本 fixture は 1414/1435/155A/1852 の連結省略と、153A の実在する単体期間を含む。153A は期欠測ではなく別主体の注記であり、連結の省略理由へ昇格しない。追加4原本 372A/5204/6059/6960 は、同期間の収益分解等に実数がある一方、地域注記では省略を明記する。この4社の既存数値と proof は同値に保つ。

fixture は原本全文ではなく、実 TextBlock と実 native context の限定抜粋。ZIP/member/excerpt/fixture member SHA、原文位置、元保管行、元 manifest/取得時計の既知・不明を各 `.provenance.json` に記録する。数値や期を生成した fixture は使わない。期/主体/metric/閾値/continuation/非可視構造の負例は、実 fixture を意図的に変えた負例として区別する。

独立一次レビューを次の private receipt に束縛する（共通 prefix は `tmp/feature-audit-20261013/disclosures-recovery-finish/`）。

| Receipt | SHA-256 | 確認範囲 |
|---|---|---|
| `geographic-omission-primary-five-v1/independent-primary-review-market-three-v1.json` | `4209d4f9af96243294a86f1d9147a922de490d6d882278ceb64c1ce783c94625` | 1414/1435 の当期連結、153A の単体期間・主体 |
| `geographic-omission-all2583-replay-v1/independent-primary-review-market-omission2-v1.json` | `3f88c006a149b474f5b6c1add8cb4be8a8b3aac64888c805456614e9734e99ed` | 372A/5204 の実売上と地域注記省略の共存 |

372A は日本49,321,939・アジア3,623,361・計52,945,301千円、5204 は国内55,173・海外4,336・計59,510百万円の別開示が存在する。省略文はその実数を否定しない。数値を消したり、別表へ省略理由を拡大したりしない。

## 保存原本の再解析

固定した保存 type1 原本 2,583件を、原 item/ZIP 全 SHA と既存 metadata/DEI 資格 receipt で再確認した。元2,600件のうち17件は source HOLD を維持し、後から別に取得した source overlay をこの旧集合へ混ぜない。外部 source GET / Notion / model / 業務 write は全て0。

`geographic-omission-all2583-replay-v2/classification.json` SHA `297e15c226606e83c8e5d0b5493c8350a08902ff8ad42c43450bfa322ecf3e14` は、2,181,634,925 source bytes、672理由、既存 status/facts 差分0、既 supported 差分0、直接矛盾0。parse 608.259秒、wall 616.062秒、item 境界最大 RSS 1,496,743,936 bytes。この616秒は新版だけの再解析とローカル IO であり、旧新版の合計ではない。

672理由を、先の本番 authoritative snapshot の status で分けると `geo_present_unstructured` 82 / `no_overseas_table` 583 / `ok_geo_rows` 7。この時点の現行 parser では未構造化510 / 表なし158 / supported4。**672件の海外未対応が解消したという意味ではない。** 地域注記の理由だけを記録し、別開示の実表は別に対応する。

旧271診断からの70理由は全て672内に含まれる。そのうち66件は診断上の表不在196内、4件は別の blocked table を持つ。2158/2286/3416 の blocked table は前期。3196 は当期 MDA の店舗数および消去を含む販売実表が残るため、会社全体の売上未開示・対応完了とは扱わない。

期間 guard を entity/start/end 一致へ厳密化した後、理由672社は旧新版の全 extraction/capture を実原本から再解析して一致を確認した。`geographic-omission-final672-v1/classification.json` SHA `9702899a0316033cf017f78324160d7e374da457b2d7c668d600df576c121c77`。source 507,597,063 bytes、旧 parse153.368秒 / 新 parse153.133秒 / wall308.380秒。**308秒はこの2 parse の合計**。残1,911件は全2,583再解析と exact inverse-byte / zero-conflict-branch 証明を祖先として再用し、最終 bytes で全2,583を再実行したとは記録しない。

## 最終性能・容量確認

同じ672保存原本を同じ順序で、受入 b5 parser と最終 parser の別 Nix process で比較する。共通の構造 scan で全 regional TB の内側 continuation を確認する。parse 時間は source SHA/IO/共通 scan を除く。両 process は同じマシン上で併存し得るので、RSS 差を parser 単体の純増メモリと解釈しない。

最初の最終版測定は、返却された省略 proof を保持した状態で600/672後に V8 の約4GiB heap 上限で OOM（exit134）。業務・通信0で、旧 attempt は `geographic-omission-continuation-final-v1/final-oom-observed-receipt.json` に保全する。これは bulk offline 測定の失敗であり、本番 OOM を観測したものではない。元 stderr の private file は保存されていなかったため、その receipt は tool で確認できた終端値だけを記録する。

短い quote/context から元全文の backing storage が残ることを防ぐため、返却する plain evidence だけ JSON roundtrip で値を複製する。heap 上限は変更しない。最終測定は50件ごとに immutable checkpoint を保存し、完全 stdout/stderr も private に保存する。引用文/native period/member SHA/raw TB SHA の値は全672で祖先と比較する。

最終 paired 測定は全672件完了。数値・facts/proof・原文理由の祖先比較は全て一致し、内側 continuation は全 regional TB で0件。返却 proof を672件保持したまま、heap 上限変更なしで完了した。

| 同集合672 / 507,597,063 source bytes | 受入 b5 | 最終版 |
|---|---:|---:|
| Parser 秒 | 109.651 | 111.087 |
| 共通構造 scan 秒 | 6.760 | 6.845 |
| Wall 秒 | 117.183 | 118.817 |
| Process max RSS (KiB) | 1,093,840 | 1,081,712 |
| Item 境界最大 heapUsed (bytes) | 828,809,336 | 828,876,776 |
| 省略理由数 | 0 | 672 |

Parser 時間差は +1.31%。これは理由を持つ672社の実測であり、全社平均への外挿ではない。新しい `overseasOmission` field の JSON は最大704 bytes / 計469,494 bytes。既存の原本保全呼出への metadata 追加なので新原本の呼出数増分0・source/raw file bytes 増分0だが、これを全 Notion request wrapper / metadata本文分割 / PRE・POST / readback の総費用とは扱わない。

- `geographic-omission-detached-final-v1/baseline-benchmark.json`: SHA `72e62afdd4a21cf384c385f7a49fbf099cfcb48600a5be7ca9d3920587aeb5e4`。
- `geographic-omission-detached-final-v1/final-benchmark.json`: SHA `14216131fb8a8981272009fcf4c51ece14ca0b25118b30751eac69aab6adaa77`。
- `geographic-omission-detached-final-v1/final-transition-proof.json`: 内側 guard と JSON detach の各 inverse-byte 一致、実再解析672と未再実行1,911の限定再用を固定。旧 OOM/旧 replay を上書きしない。

## 歴史的省略理由の反映境界

歴史70件を含む既存原本への理由付与は、原 ZIP の再アップロード・旧 metadata の後付けでは行わない。最終 qualified reason を50件以下で固定し、原 source item/ZIP/member/TextBlock/quote/context の SHA・保管行・祖先 receipt・parser pin を含む派生説明ファイルを、別 key の物理バッチとして共有 `recordPrimaryData` へ保存する計画とする。元 source custody、旧 status/facts、期/日付/旧 clock は変更しない。現時点で当該バッチの業務 release・本番保存は0であり、別 root review/release と物理 readback が必要。

## 検証

- 実原典14 tests PASS（内側だけ `continuedAt` を付けた負例を含む）。
- 関連20 suite: 320 PASS / 14 SKIP。SKIP は既存の限定外 fixture。
- `nix develop --command pnpm exec tsc --noEmit` PASS。
- 所有 TypeScript 5 files の ESLint PASS。
- 最終 source byte freeze / exact inverse-byte / `git diff --check` PASS。

rootは凍結11ファイル・8証跡・verificationの全SHAを独立照合し、共通parserと3 writerの全差分を確認した。Nixの独立3 suite / 25 testsもPASS。歴史原本への理由反映とsafe20の業務更新は、このPRの検証に含めない。
