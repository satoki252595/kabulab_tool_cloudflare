# 保有明細の保存価格接続（2026-10-14）

通常Node catchupへ、明細原本の公開と独立した価格補完を接続する。価格の同定・単位・期末日・分割・非開示の共通条件は維持する。価格を照合できなくても保有株数・帳簿価額を非開示へ変更しない。

## 原本参照と通常更新

- 日足の同一条件付PUTへ、Notion物理原本のpage/filename/gzip SHA/bytes、symbol/raw SHA/bytes/実clockをS3 custom metadataで保存する。公開JSON、digest、DTOへ内部参照を追加しない。余分な銘柄別PUT/LISTはない。
- 通常全母集団の成功時だけ、metadata-only snapshotを全文照合してimmutable保存→inflight CAS→active CAS→complete CAS/readbackする。subset、欠測、legacy参照なしは旧active維持。結果不明はinflightを残し、以降の利用も停止する。
- Node loaderは有効化された明示snapshotだけを使う。native pageのactive/parent/Status/単一manifest/filename/bytes/SHAと、単発のbounded hosted全bytesを照合する。原本GETの失敗Promiseも保持し同runで再送しない。
- 同じgzipに旧観測や非activated memberが同梱されても、`priceMembers`のsymbol/raw SHA/bytes/clockに一意一致する候補だけを使う。gzip自体の全bytes/SHAは変更しない。指定なしの既存callerは従来どおり。
- catalogueと必要価格chunkはrun内で共有する。全必要chunkが予算内と確認してから予約し、順次GETする。予算不足を原本不在へ変換しない。
- 欠測理由には「snapshot内。その他保存観測の存在は未判定」を残す。近似名、別期末日、adjclose、別snapshot、推定株数による補完はしない。

## 初回の明示bootstrap

固定snapshot `37202207552.1`、116価格ファイル/3456symbols、173,188,326B。全日足の末尾は**2026-10-02**、実captureは**2026-10-04**。10/13の最新価格受入とは別である。

公式Edinetcode ZIPは573,041B、SHA `f65840ce54b4817583d02669cfbba8cbabf66d2225400a6ec0ee890450b86b0b`。初回fresh受入は価格116＋銘柄表1＝native/hosted各117GET、0.5rps、256MiB、1200秒を上限とする。新規upstream GET、原文再保管、モデル、業務行の更新はいずれも0。

prepareは通信0。既存directory/plan/attemptを上書きしない。applyは承認plan SHA、candidate全SHA、相対import closure/lockの全SHA、origin/mainとの実行byte一致を検査する。全117ファイルfresh照合・全3456 raw member/native chart/10/2末尾資格が終わってから、既存active/intentがないことを再確認し、metadataのみCAS/readbackする。unknownはSTOP、同attemptの再送は禁止。

```sh
nix develop --offline -c pnpm exec tsx scripts/sync/bootstrap-holdings-price.ts \
  --mode=prepare --candidate=<private-final-schema-candidate.json> --out=<new-private-directory>

# CI/main後に新prepareを作り、rootがそのplan SHAをレビューしてから一度だけ実行する。
nix develop --offline -c pnpm exec tsx scripts/sync/bootstrap-holdings-price.ts \
  --mode=apply --out=<reviewed-private-directory> --approved-plan-sha=<reviewed-64hex>
```

現在は**NOT_ACTIVATED**。private candidate SHA `b940dd66af52055e4773ac4b2d639c655461884e51dd8e6de18ccbdbb0c9f41f`、1,370,373B。過去prototype、原本、旧plansは保全した。

## 検証・増分

- 新schema/同PUT/native読取/CAS/unknown/明示memberとbootstrapを含む8suiteは122 pass、既存3 skip。fresh資格失敗・旧状態競合send0、4CAS成功、二度目STOPも検証した。全repo tsc、変更対象eslint、diffcheckはPASS。
- 実固定116/3456を保存bytesだけで全再検証：20.608秒、観測peakRSS390,873,088B。公式銘柄表込み173,761,367B。全raw SHA/実clock/10/2末尾が一致。Notion/R2/upstream GET・remote writeは0であり、fresh本番物理受入ではない。
- 初回native/hosted読取以外に原文の追加保存はない。通常全量activationは最大8小型/manifest GET＋4metadata PUT、manifest約1.4MiB。partial/参照欠測ではactivation write0。価格側100rows/116chunks/256MiBの別予算と結果未確定ラッチは通常queue側で管理する。
