# 保存価格の新世代で未資格の保有明細を再資格する

2026-10-18。通常の日次処理が新しい保存価格snapshotを有効化しても、旧snapshotで全明細を走査して「要確認」になったsourceは通常価格queueへ戻らなかった。`resumePendingShareholdingsPrices` に限定した再資格入口を追加した。実価格の再公開・旧queueの書換えは本検証では行っていない。

## 通常入口と対象

- `scripts/sync/yuho-edinet.ts` → `createHoldingPriceSourceLoader` → `runYuhoEdinetCatchup` → `resumePendingShareholdingsPrices`。WorkerへR2 SDKやfilesystemを持ち込まない。
- 通常の「再開待ち」を優先し、それが空の場合だけ新世代を確認する。loaderの既存active読取を一度だけ共有し、世代ID確認自体はNotion・Yahoo・原本downloadを行わない。legacy注入loaderにはこの機能を要求せず、従来の初回passを保つ。
- source原本が「明細原本照合済」、価格が「要確認」、全明細走査済み、未資格数が正、旧snapshotと新snapshotが異なるものだけ。208Aのようなsource自体の要確認は対象外。同snapshotのHOLDは再開しない。
- 価格unknownが一件でもあれば従来どおり全価格自動再開を停止する。reported-document HOLDは変更せず対象から外し、D1不明応答は停止する。

## 原本・旧価格の保全

保存ZIPの物理bytes/SHA/主体、全factsと順序、同じ期末の全原本行を照合する。sourceの全propsとnative時計を直前GETで比較し、旧再開情報・全原表行・移行先snapshotを含むPREを通常`recordPrimaryData`と物理読戻しで保存する。

PRE送信前に通常価格markerを「実行中（結果未確定）」へ単発更新する。PREのupload・読戻しが不明ならこのmarkerを残し、別runや別出力先から再送しない。正常に保管した場合だけ、旧snapshot/cursor/未資格数とPRE参照を`previousPricePass`へ残して新passをoffset 0で再開する。外部queueからこのoptionalを読む際も全keys・旧完了counter・PREのpageId/SHA/size/filename・同source/docのkeyを検証する。pending中に通常新snapshotへ進める既存契約があるため、PREの初回targetと現在のsnapshotIdは固定一致させない。さらに古い履歴はPRE内の旧再開情報に保存される。

再資格では既に価格照合済みの行へ新価格を上書きしない。全原本propsを照合し、全props・時計の再読取が同じことを確認して旧価格・旧根拠を保持する。価格loader/qualifierへ渡すのは未資格行だけで、既資格行は新passの`unavailableRows`へ加算しない。新passの進捗は既存publisher/単発送信/全POST照合で記録する。

## 上限・費用

候補queryは最大3ページ×100 metadata行、再開のためのsource読取は成功数によらず最大5試行。各sourceの前に停止時計を確認し、ZIPの既知size（未知なら20MiB）を既存256MiB予算へ先に予約、実byteを控除する。新passの通常writer前に再読する同ZIPも同じ予算へ控除し、不足なら「再開待ち」を保って次runへ残す。通常価格passは従来の100明細・116価格chunk・256MiB・300秒の条件を維持する。旧初回passのsource読取契約は変更しない。5sourceを再開した場合は、残りの旧HOLDを完了と扱わないため保守的に`pending=true`とする。候補の全件処理を保証するcursorや新tableは追加しない。

追加費用は新世代確認の既存active metadata読取、最大3候補query、再開sourceごとの保存ZIP読取・全period照合・PRE物理保管・価格marker 2回である。ZIPは従来の1source 20MiB上限、PREも1source 20MiB上限。通常publisherには新passの既確定行保持を確認するperiod読取が加わる。これらは追加費用であり、旧passの保存費用や将来のD1/Notion実費をゼロとしない。

## 検証

通常loaderのactive cache共有・明示null・unknown伝播、通常価格queueの新世代回復、同世代/source未完了のmutation 0、facts変更でPRE前停止、PRE unknownのsticky marker、既資格行の全props/旧proof保持と新pass未資格数0、ZIP予算不足でhosted/PRE/PATCH 0、外部再資格PREの欠落/key/SHA差でmutation前STOPを回帰で確認した。query時計は試験で明示したtransport投影であり、fresh本番観測の証拠ではない。Nixで関連6スイート187件、全体型検査、owned lintが成功した。

正式な権利効力日・Yahoo価格basisを資格化できない行は従来どおり理由付きHOLD。今回の再資格入口はその値を推測せず、全権利処理や全価格セルの完成を意味しない。新registryの通常producer実受入、schema migration、現在原本/価格のfresh資格と通常価格writerの本番受入は別途必要である。


## SSHでの固定価格対象の一巡

10/18 16:48 JSTまでに通常の価格補完は`pending=false`で停止し、次の窓は開始しなかった。main527固定の追加47窓で2,755行を確認し、先行main526の2窓67行を含む累計は217文書・2,822行。これは確認した明細数であり、新規価格資格成立数ではない。47窓の全ACK/戻り・pending不存在・metadata STOP0・所有プロセス閉鎖を保存物から照合した。

16:49の最後のメタデータ読取は通常共有Notion clientを使う読取専用5query、2.866秒で正常終了した。基準218文書すべてを観測し、基準外の旧台帳1文書を別集計した。現在の`local-9fe26841-activation1`へ結び付く固定217文書の全cursorが末尾に達していた。

| 現在の保存counter | 行数 |
|---|---:|
| 原本明細 | 2,822 |
| 価格資格成立または旧確定値保持 | 1,064 |
| 価格資格未成立 | 1,758 |
| 未処理 | 0 |

価格状態は完了17文書・要確認200文書。別名義208Aの4行は元原本に残し、価格対象の算術から除外した。未処理0を全価格の資格成立へ読み替えない。新規資格成立行数、全行の現台帳による再資格、全行の現権利根拠再確認は未測定であり、上の1,064には旧確定値保持を含む。新台帳・必要原本の更新時に、通常定期処理が未資格行を再確認する。

最後の読取では業務書込・取得元API・hosted・モデル0。追加の明細ごとのGETや全原本再取得は行わず、原300秒内の通常閉鎖と保存算術を独立に確認した。47窓全体のR2 native要求数・実読取量・実請求額は未測定。

私有保存先: `tmp/feature-audit-20261018/holdings-rights-needed-current-v1/final-price-recovery-metadata-read-v1/`。

- メタデータ結果 `actual-metadata-v1.json`: SHA256 `6c88469fd7d7a804c93255ccc5df96f6fe3737b6b09ef5a7f9866636439844f3`
- 通常閉鎖 `final-metadata-read-known-closure-v1.json`: SHA256 `7707e9dd9c80934d93d6261326ca413fb6e76f5750ed2cdca89e1f72109352d0`
- Root保存物集計 `root-fixed-scope-acceptance-v1.json`: SHA256 `75c6fbb4a045523f18e848c3a45151556fa0b61581e9943a0eafe93aceaf8032`
- 独立保存物照合 `delegate-final-metadata-saved-peer-v1.json`: SHA256 `aed0981bfd8d8c8f8f91a8cde6d4e29c3e1018309f41e57091cea56964048c62`


### 現在の資格未成立1,758行の理由

17:01 JSTに、保存済みの現在の理由だけを通常共有clientで読んだ。固定217文書・同じ台帳marker・未資格checkboxをserver側で絞り、原本・価格数値・Filesを取得しなかった。19query・5,036,421B・8.177秒で全cursorを閉じ、文書別件数が上の保存counterと一致した。原300秒/25query/20MiB内、取得元API・D1・モデル・業務書込0。旧forecastを流用せず、未知分類0だった。

| 保存されていた資格未成立の理由 | 行数 |
|---|---:|
| 分割に関する法的株数・価格basisの根拠不足 | 894 |
| 株数/価格の単位または必要履歴範囲の根拠不足 | 204 |
| 公式日本名による同定が未成立 | 402 |
| 公式英字名による同定が未成立 | 15 |
| 商号変更を含む同定が未成立 | 1 |
| 有効化した台帳内に必要な保存価格原本がない | 82 |
| 期末株数が非開示 | 160 |
| 合計 | 1,758 |

名前の同定不足を非上場へ読み替えず、台帳内の原本不足を取得元の永久欠測・無取引へ変換しない。権利根拠や非開示株数を推定して価格を埋めない。この読取は理由の集計であり、当該行の価格再資格や新たな値の採用ではない。

私有保存先: `tmp/feature-audit-20261018/holdings-rights-needed-current-v1/current-unavailable-reason-read-v1/`。

- 集計 `actual-closed-read/result.json`: SHA256 `8c99d552fbe44dc2b842675c21fef7d34bf4ec51a90f23834a0c5b41ed92aeff`
- 通常閉鎖 `saved-known-closure-v1.json`: SHA256 `1749a1d7c1300c3c4c0e3daeefa949e3ac2bf9b624e2c9ec96617fc9342af289`
- Root保存物照合 `root-reason-acceptance-v1.json`: SHA256 `89082d5f49e703a164ade02661dada643aba60e5eb9f584352c0e0e5fc083c5c`
