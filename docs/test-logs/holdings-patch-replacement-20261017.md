# 保有明細の未知PATCHを別IDで隔離する通常処理 — 2026-10-17

結果不明のPATCHは、現在値がPREに一致しても遅延適用を否定できない。通常の `inspect-pending-patch` は引き続き1 GETだけを観測し、再送・旧pending削除・source完了を許可しない。

今回の通常CLI `resolve-pending-patch <input.json> <out.json>` は、保存済みの最後のPATCHが `properties` だけを変更することを確認し、旧IDと異なるIDへ置換する。旧原要求には退役解除や新IDを指定する項目がないため、遅延適用が起きても旧IDだけに閉じる。料金源・モデル・新依存・新tableは追加しない。本番置換はこの変更では実施していない。

## 共通経路と停止境界

`src/shared/notion-archive/shareholdings.ts` が通常journalの資格、明示置換、置換後のpublisherを所有する。CLIは既存 `guardedHoldingsMutation` の送信前fsync journal、singleAttempt、結果不明でのsticky STOPを再用する。canonical `.env` の実パスに基づく旧ID別の永続claimは、別outputからの再実行も拒否する。旧pendingと旧143イベントは編集・削除しない。

処理順は次のとおり。

1. 元pending/journal/意図/body/full PRE/schema、同提出者ZIP、旧40行の物理PREと最新D1の提出者・期末・文書を束縛する。全periodと全旧値を読み、未知sourceは従来の厳密な最大5件・同issuer/FY衝突禁止を通す。
2. 全履歴と原本SHAを共通 `recordPrimaryData` で物理PRE保管し、添付の全bytesを照合する。
3. 旧IDをsingleAttemptで退役し、ACKと全propsの読戻しを確認する。新IDを作成し、旧writable値と通常producerの原本列を全比較する。元作成時計は物理PREへ残し、新IDの実時計を偽装しない。
4. 全periodの他行・旧extraが不変であることを確認して物理POSTを保存する。全proof成立後だけ同sourceのoffset0を保持して再開待ちへ移す。
5. 通常publisherで残13行を処理する。完了前に元40行の旧ID→新ID対応・全旧値と47行の全periodを確認し、物理LEGACY-POSTを保存する。その後だけ45原表の完了と価格queueの再開待ちを記録する。株数・価格の補完は行わない。

source queueは明示置換だけversion2を使う。旧version1 publisher/resumerはversion照合で停止し、置換proofを落として再開しない。新readerはv1への置換proof混入、v2のproof欠落、不正ID/原本key/SHA、未対応versionを拒否する。v1→v2は旧未知状態・offset0・全物理POSTの再検証を伴う明示置換だけで許す。通常v1、price queue version1、別会社のsourceに追加IOはない。

通常呼出しはEDINET ingest、保存原本backfill、`publish-saved` CLI、定期 `resumePendingShareholdings` が同じpublisherへ収束する。未知source qualifierと再開readerもv2を読む。価格phaseの全体unknown guardは別の「保有価格状態」を対象とし、今回の原PATCH/source状態の未知と混同しない。

## 実原本と検証

`services/yuho-quant/src/tests/fixtures/holdings-pending1911/` のS100Y1XP ZIP、旧143journal、32行目の意図/送信body/full PRE/schemaを再用した。新規の `legacy-pre.json` は旧native477の172,804 bytesと完全同一（SHA `a21ff85fc1b86a85024d5c2fab80d710192eff665d7fd6cde59c8b65789da157`）。`period-after31.json` は独立読取で保存した44ページから全business props/ID/時計をそのまま投影し、除いたtransport/UI項目と再serializationを `replacement-provenance.json` に明記した。署名URL・認証headerはcommitしない。

テスト中の新ページID、API応答時計、退役/遅延適用は宣言したtransport protocol変化であり、本番完了の証拠ではない。業務値は実原表と保存propsから生成する。正常経路は31既完＋新ID1を維持し、残10更新＋3新規だけを通常publisherへ渡す。元40行の全旧値、別extra2行、旧journal、価格未受入を確認した。

負例は意図SHA改変、退役解除body、legacy SHA、source facts、旧値のdrift、未対応property、同issuer/FYの別未知source、退役/新規/物理POSTのACK不明、最終物理POST失敗、未対応queue versionとproof欠落を含む。別の実1897 unknownは対象1911の置換を妨げない。全テストでlive HTTPを禁止した。

Nixで関連8 suite 190 tests、全体TypeScriptを確認した。DB環境変数を空にしても実fixtureに束縛したCLI回帰を通す。定期処理の行予算を模した10/10/10/10/5の複数windowでもv2と原40行proofを維持し、最後だけ物理LEGACY-POSTと価格queueへ進む。明示対象は原表100行以下・旧移行100行以下・各物理file20MiB以下に限定する。実施時は最新source/全PREの別有限readとroot releaseが必要で、追加D1照合・物理PRE/POST・読戻し分の費用はその対象専用budgetへ計上する。本番の一般処理で追加照合を一括発生させない。
