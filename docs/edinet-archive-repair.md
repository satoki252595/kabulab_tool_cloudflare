# EDINET ZIPの有限・source-only復旧

`pnpm yuho:repair:zip` は、明示した最大5通についてCSV/type5とXBRL/type1の物理原本を通常の`recordEdinetZip`へ保存する。D1の文書・facts・本文索引・抽出状態や、Notion補足本文・タグは変更しない。LLMは使わない。

修復にも、通常取込・欠測補完と同じ`edinetArchiveMetadata`を使う。証券コード`secCode`と期首`periodStart`を含む8項目は、取得済みの同じ一次EDINET metadataから渡す。D1には生の`secCode`がないため、銘柄コードから末尾0を付けて再構成しない。通常取込の途中失敗でCSVだけ保管する経路でも、期首を欠落させない。原文の明示nullはnull、項目自体の欠落は停止とする。

## 保存済みの日付一覧receiptがある場合

`.env`に既存の型付きEDINET/D1/Notion設定が必要。CLIは起動時に`.env`を明示ロードする。`--source-snapshot`は通常`captureListSnapshot`が返す**snapshotだけ**のJSONとし、所有者本人・通常ファイル・0600・64KiB以下、SHA256完全一致を要求する。Notionに保存したgzip/原HTTP本文も、既存`readListSnapshot`のbytes/SHA/date/type/count検証を通す。receiptだけから未保存の原一覧を生成しない。

```bash
nix develop -c pnpm yuho:repair:zip --doc=S100YF41 --source-snapshot=tmp/edinet-6963-source/receipt.json --source-snapshot-sha256=<receiptの実SHA256>
```

原一覧の同じdocIDが一意で、通常有報の様式・明示CSV提供・取下げ/情報修正/不開示flagが0であることを確認する。D1はdocIDで先に絞り、主体・明示証券コード・期首/期末・提出時計を照合し、現行issuer逆引きとreported-HOLDも確認する。**指定した全通の資格がそろってから**新しいZIPの取得を始める。複数指定は同じ提出日のreceiptで検証できる文書だけとし、別の日は別receipt・別の有限実行にする。

`--force`は受け付けない。既存type別keyは通常の冪等処理へ渡すが、`skipped_existing`はmetadata欠落の修復証明ではない。既存行が不完全なら、所属/状態・旧metadata・実ZIPを限定読取で特定してから別途判断する。今回の契約修正は既存metadataの一括補記や所属付替えをしない。終了後は[補足39本文の読取診断](supplement-text-audit.md)など、実際のconsumerの厳格資格で受け入れる。

通常type5/type1と途中CSV保管の**すべて**で、保管/readbackの例外は次の通へ進まず停止する。保管結果不明を既知失敗へ読み替えない。同じCLIを自動再送せず、旧ログ・receipt・既存rawを保持して送信結果を照合する。EDINETの既知404はclientで原HTTP本文を保管した後だけ未提供件数に計上し、架空ZIPや空本文で成功にしない。

## receiptがない場合の最小取得

対象の提出日だけ、既存`captureListSnapshot(date)`で公式日付一覧を1回取得・物理保存する。次の例はその後すぐ対象docIDへ絞り、receiptを新規ファイルへ保存する。全市場のZIP取得・長期間の一覧探索・D1への変更観測INSERTは行わない。既存の結果不明がある実行は、この例を再送して回避しない。

```bash
mkdir -m 700 tmp/edinet-6963-source
umask 077
nix develop -c node --env-file=.env --import tsx --input-type=module <<'JS'
import { captureListSnapshot } from './services/yuho-quant/src/services/edinet/list-snapshot.ts';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const { list, snapshot } = await captureListSnapshot('2026-06-19');
if (list.results.filter(row => row.docID === 'S100YF41').length !== 1) throw new Error('source_document_not_unique');
const bytes = JSON.stringify(snapshot) + '\n';
writeFileSync('tmp/edinet-6963-source/receipt.json', bytes, { flag: 'wx', mode: 0o600 });
console.info('receipt_sha256=' + createHash('sha256').update(bytes).digest('hex'));
JS
```

この取得例・復旧CLIは自動で実行されない。原一覧の取得/物理保存が不明なら停止し、同じ手順を盲再送しない。既存receiptが有れば取得例は不要。必要な通信は対象日ごとの公式一覧1回＋その原本保管/検証、復旧対象1通ごとのCSV/XBRL各最大1回＋通常Notion保管/物理検証と少量D1 SELECT。通常日次取込のHTTP回数は増えず、有料API・モデル・新しい定期ジョブは追加しない。

## 固定5診断からの次の対象

| コード / docID | 保存根拠と次の操作 | 未完の境界 |
|---|---|---|
| 6963 / S100YF41 | 提出日2026-06-19。保存済み旧type1 ZIPと生の`secCode=69630`・期首2025-04-01あり。適格な同日一覧receiptで新CLIを有限実行する候補 | scope3はtyped原本の所属/状態guardで停止。行不在・parent/status不正の内訳はまだ未確定。旧bare-keyはtype5完成証明にしない |
| 2683 / S100Y5OG | 提出日2026-05-22、`secCode=26830`・期首2025-03-01。同様に当日だけのreceiptを使う | 同上。旧ZIPはXBRLでありCSV提供の証明ではない |
| 3840 / S100YKGU | 提出日2026-06-25、`secCode=38400`・期首2025-04-01。同様に当日だけのreceiptを使う | 同上。法的issuer不一致や原本永久消失は証明されていない |
| 3776 / S100WZGB | 同issuer E05494・FY2025-12-31の情報修正。通常catchupの既存`requalifyInformationEdit`だけが、原一覧/観測・現issuer・全facts/本文・保存type1/5を同値照合して解決する | 保存済み資格記録は通常parserの既存status/抽出元不一致でHOLD。単純ZIP修復、`--force`、観測削除では解除しない。通常CLIに任意1code指定はなく、限定実施が必要なら同じ関数へ明示原観測を渡す既存経路を用いる |

旧`backfill-overseas.ts`の新規ダウンロード枝は、生の一次一覧metadataを持たない。D1から補作して厳格本文readerに適格とすることはできない。本手順や通常取込が保存する一次metadataと混同しない。保存済み原本を読む既存海外補完経路、通常reader、issuer/HOLD/unknown guardは変更しない。

実装検証は保存済み6963のmetadata/CSV/XBRLとオフラインの明示protocol投影を用いる。既存データの復旧完了・全市場の充足は、このPRのテスト成功だけでは宣言しない。
