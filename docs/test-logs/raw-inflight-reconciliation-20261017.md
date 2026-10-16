# RAW raw_inflight の単一明示解決

通常applyが raw PUT の結果不明で停止すると、原本が実際に存在しない場合も同じPUTを自動再送しない。この挙動を保持し、既存 `raw-index-backfill.ts` の明示reconcileへ raw_inflight 分岐を追加する。既存index_inflight分岐・workflow排他・continuation禁止を再利用する。新しい予約基盤、依存、取得元API、モデル、DDLはない。

本番の調査対象はrun38940600004／inspect38942280144。固定78,832件、cursor13,554、残65,278件、原本136,796B、SHA `2b5df3c6e7ee99010492a4736915be03ef6ac787130997b72e74197f20c30973`、state全bytes SHA `4dc53ee36af09314387e78efe7b45a191fa1930a155d125d72413f9f63a2384f`。独立inspectはraw/indexとも欠測、active/state不変、旧ACK不明の保持を確認した。この実装の試験はローカル通信差替えのみであり、本番での明示解決・後続apply・全量anti-joinは未受入。

既存フラグの `mode=apply/limit=1`、固定cutoff、対象SHA、旧state全SHA、最大64MiB/600秒だけを許可する。初回active/manifest/stateは同一bytesと主体を資格化し、同SHAのresolution intent/completeがあれば停止する。raw keyもmanifestの正準keyへ一致させ、rawとD1索引の実欠測を確認する。現在の⑤ metadataを一意SHAで新たにqueryし、原metadata、EDINET文書ID、実添付名を既存validatorで照合する。既存hosted downloaderだけで原本全文を読み、元SHA/サイズを検証する。署名URL・原文・秘密は公開logへ出さない。

資格化後は、旧active/stateをbytes＋ETagで再確認し、同scopeのintentをIf-None-Match CAS PUTして全文GET一致を確認する。さらに旧状態・raw/index欠測を再確認して原本を1回だけCAS PUTし、全文GET/SHA、索引欠測、旧状態を確認したあとcompleteをCAS PUT＋全文GETする。D1 INSERTと旧active/state/cursor変更は0。complete後の別の通常applyだけが原本を再検証して索引とcursorを進める。

| native操作の上限 | 回数 |
|---|---:|
| R2 receipt GET／raw GET | 13／3 |
| R2 intent／raw／complete CAS PUT | 各1（計3） |
| D1一意SHA SELECT／INSERT | 3／0 |
| Notion metadata API実native／hosted GET admission | 1／2 |
| 合計admission | 最大25 |

metadata APIは共有clientの実 `notionStats.requests` 差分を用い、`singleAttempt` と `beforeRequest` を既存SHA queryへ透過する。キャッシュを既値の資格に使わず、明示操作では同SHA metadataをfresh queryする。hostedは既存最大2GETの開始callbackで予約し、APIと同じ共有pacingを通る。hosted callbackはfetch直前のadmissionであり、signal等で実fetchに届かない場合も数える。summaryは `api_actual_plus_hosted_admitted` と区別し、logical query数をAPI native数とは呼ばない。CLIはNotion最大.25rpsを固定し、より狭い既存typed envは維持する。

各nativeの送信前に残65秒を要求する。Notionはqueue/pacing待機の後、R2 GETは共通readerの `beforeAttempt`、PUTは私有fsyncの後にも確認し、600秒の絶対上限を延ばさない。原本2hostedの既存wrapper余裕とraw PUT＋全文GETを先に予約する。R2 GET本文・PUT本文と全観測hosted本文（partial再読も含む）を共通64MiBへ計数し、超過・未完・SHA差はSTOPする。異常な受領chunkが上限を超えた場合も実受領bytesを記録し、成功にはしない。Notion/D1 API応答、SDKエラー応答、HTTP headersは未測定であり、64MiBを全wire上限とは呼ばない。

永続停止の保証は次の範囲に限定する。intentの既知保存後にraw/complete PUTが結果不明となれば、永続intentが次の明示runを阻止する。intent PUT自体が結果不明ならraw PUTは0、同runの再送も0で止める。ただしintentが実際には未保存の場合、別runnerが不在だけから先の未知送信を判別することはできない。私有fsync receiptと失敗GHA runを保全し、operatorは失敗reconcileを自動・手動で再dispatchしない。既存index分岐のintent未知も同じ限界を持つ。通常apply/inspectは旧raw_inflightの欠測で止まり、自動raw再送0のままである。

回帰は既存index解決・通常apply/inspectの停止契約を含む。追加ケースは、source SHA・wire count・state SHA・直前状態・raw/index競合・POST SHA、第三hosted admission拒否・受領bytes超過、fsync後65秒不足、intent/raw/completeの各unknownと実適用有無、fresh metadata cache回避を検査する。共有clientと実hosted readerの通信差替えではAPI実1＋partialを含むhosted実2、開始0/4000/8000ms、合計最大25を確認した。API429・追加metadata native・pacing待機後の期限不足はAPI実1だけで止まり、intent/raw/INSERT0となる。これは本番HTTPの計測ではない。

検証: Nix node22.22.2/pnpm9.15.9、関連6 suites237 tests PASS、全体TypeScript、対象ESLint、diff check PASS。依存変更、live HTTP、本番dispatch、source API、モデル、業務書込は0。本番の原本回復と残65,278件の完了は別受入とする。
