# 原文で明示された普通株消却の限定診断

2026-10-17。[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)の保存原本調査から、会社が明記した消却実施日と普通株数だけを同じ通常 `observeIssuedShares` へ追加した。法的効力日・市場権利落日・価格係数へ読み替えず、価格・保有株数を補正しない。全権利処理や本番の次回正常実行の受入ではない。

## 実原本と限定文型

固定3666 manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa` と、既資格735社の保存inventory SHA `0e830222a4b7f2f6741f0c77fe02bbdce8a1ec35fd15431639df0846c2605f57` から同一ZIPを再利用した。正例の原ZIPは変更せずfixtureへ固定し、ZIP/member/history fact/正規化全文SHA・元提出日時をprovenanceへ残す。

| code/doc | 原文の報告消却日 | 明記普通株数 | 同じ表の減少数 |
|---|---|---:|---:|
| 6484/S100YH48 | 2024-01-31 | 24,900株 | △24,900株 |
| 6908/S100Z5N2 | 2025-02-13 | 122,819株 | △122,819株 |
| 7313/S100YCXB | 2025-05-30 | 12,000,000株 | △12,000,000株 |

読む文型は、この実3原本の完全な消却文だけ。「当社は…開催の取締役会決議に基づき、…付で普通株式N株の自己株式を消却いたしました」「…付で実施した、普通株式N株の消却によるものであります」「…付で普通株式N株を消却し、発行済株式総数がN株減少しています」を対象にする。日付/数量の一部分だけを拾って採用しない。

既存option診断が資格化した単一完全history fact・公式namespace・instance/header native context/entity・全文SHAへ再束縛する。保存提出日時がなくnative contextだけの場合、普通株FY factが非一意/単位・精度未資格の場合はHOLD。元HTMLの一意な7列表で株単位、日付・注番号・負の減少数が一意に一致し、最終残高も厳密普通株FY factへ一致することを要求する。千株/丸め・結合セル・壊れた行・複数候補は採用しない。

自己株取得/処分のみはこの診断の非観測。消却への言及があっても子会社・第三者割当・予定/計画・取消/訂正・複合/不明文型はHOLD。決議日と実施日が逆転、FY/提出日時点より未来、表と文の株数・日付・注番号が不一致ならHOLD。市場日付やT+2を生成しない。

6484の旧inventory簡易context投影は2026-06-22だったが、今回の現共有helperによる実ZIP/native定義と元item提出日時は2026-06-23で一致した。旧投影は改変せず保持し、権威として転用していない。

## 通常経路・既存値・予算

追加は同じ `IssuedShareObservation.reportedCancellations`。通常Actions→ingest→publisher、保存prepare、正常resumeは既存の同関数/RecoveryInfoを通る。ingest summaryはstatus/理由/件数だけ併記する。新source GET・DB/DDL・raw二重保管・追加ZIP展開・依存はない。Workerでfull観測を無効とする境界は維持する。

新診断だけの例外はHOLDへ隔離し、旧FY/filing/optionの全値・証拠を保持する。旧基本観測64KiBに加え、optionとcancelは**合計で既存8KiB**を共有する。新診断が入らなければ最小HOLDを試し、それも入らない場合だけ新optional fieldをundefinedにする。この欠測はunknownであり、未観測0件・完了ではない。code/doc/ZIP SHAと `status=held/reason=diagnostic-budget` を構造化operator warnへ必ず出し、silent omissionにしない。既存optionを切り詰めず、RecoveryInfo全体の100要素/400,000B送信前guardも変更しない。

`reportedCancellationDate` は原文の報告実施日、`reportedCancelledShares` は掲載された普通株数。`legalEffectiveDate`/`marketExDate` はnull、`rightsApplication` はunknown。新診断は価格や株数の資格成功を返さない。

## 同じ6実原本での比較

正例3と5820/4568/2375の実6ZIP計6,570,116Bを、旧accepted02deと新sourceへ同じ展開済みMapで各5回、順序交互に渡した。新field以外の**旧全field JSON・option・全source SHAが6件とも完全一致**。新観測の正例は3源だけ。5820は普通株の第三者割当の払込期日/複合期間行で消却非観測、4568はnative history context未資格HOLD、2375は既存6行使期間を保ち消却非観測だった。旧5362行の単位HOLDは変更しない。

| code | 旧→新 CPU中央値(ms) | 新診断追加bytes | option+cancel合計bytes |
|---|---:|---:|---:|
| 6484 | 37.853→37.795 | 1,034 | 1,594 |
| 6908 | 46.446→46.862 | 960 | 1,520 |
| 7313 | 72.798→73.740 | 985 | 1,545 |
| 5820 | 37.057→37.871 | 376 | 924 |
| 4568 | 64.970→64.771 | 238 | 661 |
| 2375 | 52.742→53.501 | 376 | 3,209 |

全比較3.178秒、process peak RSS765,712KiB（TS読込・旧新module/展開Mapを含む）。CPU差が小さいため速度改善を主張しない。全735/市場全量のCPU/RSSやWorker128MiBへ外挿しない。HTTP/model/業務write0。

私有再生 `.runtime/rights-reported-cancellations/source-v1/tmp/cancellation-real6-parity-v1/replay.mjs`、結果 `result-v1.json` SHA `f9eeb83f2dce92deebae811e3bc17e83d4f216dd4f44300ee2c7b45050242ddd`。前後source/入力/lock全SHAを検査する。独立再生は同WTのNixから `node --import tsx tmp/cancellation-real6-parity-v1/replay.mjs --out=<未作成小文字名.json>`。

回帰は実3ZIPの正例、取得/処分の非観測、予定/子会社/第三者割当/取消/種類/千株/小数/日付/表/注番号/FY/単位の負例、新診断例外、合計予算のfault injectionを検査する。通常publisherでも実6908を同RecoveryInfo PATCH/readbackへ渡すprotocol回帰を置く（実Notion送信ではない）。旧option suiteは追加fieldを分離して既存64KiB/72KiB境界を保持する。

Nix関連9 suites /208 testsに加え、既存split-basis/valuationの2 suites /27 testsもPASS（計11 suites /235 tests）。全 `tsc --noEmit`、対象ESLint、diff check PASS。実fixture metadataは正準itemのidentity/提出日時だけのprotocol投影で、原ZIPの物理資格をmock応答で新規証明したとは呼ばない。

rootの独立再生（2026-10-17T10:19:41.884Z）も6源/旧全field・option・source同値/消却3源のみ/HTTP0でPASS。私有 `tmp/cancellation-real6-parity-v1/root-review-v1.json` SHA `464538604108ebe9747a025b4c2edf99a0284f83272e2dacf5536c84dd9ff3d1`、3.059秒/peak RSS817,936KiB。元結果を上書きしていない。
