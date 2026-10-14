# 保有価格の公式銘柄表更新（2026-10-14）

通常日足の価格snapshotが初回の`codeList`を恒久継承していたため、その後の新規上場・商号変更を公式銘柄表へ反映できなかった。通常の`sector33_sync`が既に取得・共有アーカイブしたFSAコードリストを、全量日足の受入時に再利用する。

- `scripts/sync/edinet-codelist-archive.ts`の既存ZIP＋capture manifestを使用。新しい取得元GET・原本再upload・依存追加は0。
- `一次データ｜universe`の`edinet-codelist-`世代を取得時計降順・上位2件で確認する。Statusで事前に除外しない。最新が不完全、同時計競合、未来時計、別page、全SHA不一致なら停止し、古い候補を採らない。候補不在だけ明示HOLDで旧activeを維持する。
- 最新ZIPとcapture manifestの全bytes/SHA、元の世代key、FSA取得元、実取得時計、CSV実基準日を照合する。旧snapshotの銘柄表もfreshに再照合し、基準日後退・未来を拒否する。同じ原本ならそのfresh結果を共用する。
- 価格snapshotの既存CAS/unknown停止を通り、新しい銘柄表参照を束縛する。partial日足・legacy価格参照欠測では、この追加読取も行わない。価格JSON/digest/公開DTOは変更しない。
- 定時Nodeの価格loaderは、銘柄表だけ既存単一ZIPまたは通常ZIP＋manifestの明示契約を受け入れる。価格gzipの単一添付guardは変更しない。ZIP＋manifest双方の実bytesをrun予算へ計数し、既知の予算不足だけ次回へ回す。transport/SHA未知結果は同runで再送しない。

通信増分は通常全量日足の受入時だけ、最新2件query 1回、fresh page最大2回、hosted ZIP/manifest最大4回（同値原本は共用）＋既存の共有DB探索。ZIPは既存約0.57MB/本、captureは小さいJSONで、通常は新旧合わせ約1.2MB。ハード上限は各ZIP20MiB・capture1MiB。銘柄表用のR2 objectは新設せず、既存snapshot CASの回数は同じ。Nodeの価格runでは256MiBの既存予算内で扱う。

検証は実FSA ZIP fixtureを用い、latest→snapshot束縛、旧active保持、不完全最新からの巻戻し拒否、同時計/未来/後退、別page、ZIP/capture SHA/世代key/取得元、全読取予算、既存単一添付の価格guard、通常日足callerを確認した。関連5suite 70PASS/3既存skip、全repo tsc、owned eslint、diffcheck PASS。本番受入は、CI/main後の次の適格全量日足で行う。初回bootstrapの本番有効化証跡と原本session 2026-10-02は既存[価格registry台帳](./shareholdings-price-registry-20261014.md)を保持し、この変更を本番適用済みとはしない。
