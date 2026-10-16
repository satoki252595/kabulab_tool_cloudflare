# 保有価格の市場権利落日と法的分割日（2026-10-17）

今回の権利処理検証で新たに受け入れた本番価格は0件。係数補正・価格再取得・業務反映は行っていない。

保存済み1799/第一建設工業の有報S100YILNには、2026-03-31の守谷商会7,000株と帳簿価額41,790,000円がある。1798/守谷商会の同期期末有報S100YDA3は、当期の `NotesRegardingIssuedSharesAndTreasurySharesTextBlock` に「当社は2026年４月１日付で普通株式１株につき５株の割合で株式分割を行っていますが、上記事項は当該株式分割前の株式数を基準としています。」と明記する。同じ原本の普通株期末factは2,260,000株。保存Yahoo原文は市場日2026-03-30、比率5を観測し、期末closeは1194である。旧共通資格は `split.date > FY` だけを拒否するため、1194×7,000をqualifiedとして返した。この境界では株数と価格の単位一致を主張できない。

新しい共通資格は、市場日付を法的効力日へ読み替えない。同じ最新issuer・証券コード・公式商号・提出日・価格captureに束縛した保存有報を使い、既存のduration context readerと普通株fact observerで明示文型を確認する。同じFYの分割前株数、法的日付がFY後、対応比率の市場観測がFY以前である場合は根拠SHA付きの型付きHOLDを返す。通常publisherは有限windowの価格書込み・結果未確定markerより前に止め、旧株数・価格・原本列とprice cursorを保つ。通信/破損/ACK不明はこの型へ付け替えない。

分割観測があるが法的日付・株数単位を確定できない場合はunavailableのままで、過去のsplit日付だけで安全と推定しない。原bookValueによる代用、close/adjclose差からの推定、比率の再適用はしない。split0の従来正常資格は維持する。全権利イベントや全銘柄の価格単位を解決した変更ではない。

通常Node loaderは英字名不一致の既存issuer読取経路を保持する。canonical splitは明示`cacheOnly`で、同runのcode/capture cacheに資格済みissuer原本が既にある場合だけ再利用し、cold/未資格cacheからD1/Notion ZIP読取を始めない。証拠無しはunknown unavailableを維持し、停止したtransport promiseを再送・既知値へ変換しない。通常本番のcold canonicalに既存verified cacheがあるとは主張しない。既存alias読取は256MiB・実時間予算と書込直前latest再確認を維持し、再利用した証拠も同じlatest gateを通す。split0と期末後splitのcanonical候補にはcache参照targetも加えない。EDINET/Yahooへの追加GET、モデル、新依存、DDLはない。

保存済み22,755候補と同じ116 gzip（173,188,326 bytes）を共通資格へ純replayした影響は小さくない。旧qualified12,209行のうち6,847行は価格・値を含む全資格結果が同値、5,362行（1,108保有会社・743 issuer）は法的日付/株数単位の証拠不足で新たにunavailableとなる。誤価格が5,362行確定したという意味ではない。直近splitの暦年がFYより5年以上前の2,382行、1〜4年前の2,437行、同暦年の543行を含む。年数は影響説明用であり、資格の近接日数heuristicではない。過去splitだけでも単位根拠が無ければ保留する範囲を意図的に残している。旧stopped289行はaliasを未資格のまま停止状態を保持する。

初案でsplitだけを理由にissuer原本を読む場合、同じ保存候補のissuer/capture対象は旧alias33から825へ増え、追加792対象（候補6,447行）になった。HOLD理由を増やすためだけの追加ZIP読取は採用しなかった。現実装では792対象を全てcache-onlyとするため、cold時の追加D1/Notion ZIP読取は0、通常の新規issuer読取対象は既存alias33のまま。missing FYバー等で既に価格unavailableの行もcache-only選定に含むため、792は新unavailable行のissuer743とは異なる。実cronの要求数・全量所要を保証する数字ではない。runを跨ぐ共有cacheはない。本番全量の期限内受入と価格の単位証拠整備は未完である。

純比較はNixで22.040秒、peak RSS 627,179,520 bytes、HTTP/model/write0。これは旧候補factsを再利用した全量のローカル診断で、通常cronの実測ではない。owner ZIP 3.1GBの全再解析とfresh Notion照合は行っていない。private `tmp/feature-audit-20261017/holdings-rights-date-investigation-v1/impact-v1/result.json` SHA `5b9d18d75c53d21987682f5c5cbde2986c5e064380193d2fc6b2aab65f7f3745`、旧全候補SHA `07c066b97e35deaf1a4563861a2957ec9a1c966be861f1927525111828eaf015`。全116 gzipとcode listの全SHAは再検査した。issuer証拠を付けない比較のため、known mismatchの内訳はこの5,362行から推測せず、別の実1798 fixtureだけで実証している。

初案の比較receiptは不変で保存した。現normal issuer loaderへ追加792全対象をcold cache-onlyで渡した別Nix純実行は、verified証拠0、HTTP/D1/Notion ZIP読取0、256MiB予算不減を確認した。`impact-v1/revised-cache-only-result.json` SHA `69f6cceb548e96a15892562f178c34428818a55af281a2d2b9ea0b5b8e3c049e`。実1798 fixtureのwarm試験は、既存normal loaderを保存原本で明示prewarmしてからcache-onlyでknown HOLDになることを確認した構造試験であり、本番でcanonical issuerをprewarmした実績ではない。

fixture `services/yuho-quant/src/tests/fixtures/holdings-split-1798/` はowner/issuerの完全ZIP、完全価格gzipと当時の公式code listを保持する。主なSHA:

| 原本 | SHA-256 |
| --- | --- |
| 1799/S100YILN ZIP | `91730bbd2194014df2d442376647adfe3bff10ee653d9074c83a97019cabb4e9` |
| 1798/S100YDA3 ZIP | `01d2c3b0046b1b1e99d300155629fb604104f350ef8cb9608b14cdc5e0974e0c` |
| 全価格gzip | `4b8e37e6231db3cdec8f3f7850b0959ce7cf9bf85dee47de25153a4ea9563b2c` |
| 1798 raw body | `62ad3b17c528bb5e89ae781746f350932da60a9152992d53b13fc5bfdc2914ef` |

Nixで関連10 suites/185 tests、全型検査、変更ファイルlintを確認。実原本の法的4/1・市場3/30・FY3/31を再現し、異なる主体/FY/ratio/予定表現/子会社/注記/context/namespace/重複は既知不一致に昇格しない。共通queueはHOLD時の価格書込み0・旧cursor/他props保持を確認し、同じmessageの通常Errorは既存unknown STOPとなる。normal issuer loaderのcold/warm/capture相違/transport unknownも実原本で確認した。schema1の権利原値・raw bytes/SHA・旧receiptは変更せず、通常Chart再解析も前後同値。

一次資料の[株式分割の会社通知](https://www2.jpx.co.jp/disc/17980/140120260209551207.pdf)と[JPX 2026年3月権利落一覧](https://www.jpx.co.jp/english/markets/statistics-equities/monthly/vk0khi000001acd3-att/17_kenri2603.pdf)にも法的4/1と市場3/30の区別がある。これらのPDFは調査参照のみで、ローカルnative PDF/SHAを受入根拠に数えていない。実装の法的日付根拠は上記保存issuer ZIPである。

## 743発行体の保存原本と1723の別明示文型

旧5,362行に対応する743 issuerを、同じ固定3666 manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa` と保存type1だけで監査した。735源は現共通DEI資格もverified、7源は既存`unproven_prior_hold`を保持、7183はこのmanifestの原本が欠測である。未資格をverifiedへ昇格していない。663 issuerの発行済・自己株注記に対象語があり、前期・当期を含む注記候補は株式分割254、新株予約権133、増資7、併合3件だった。これは法的イベント数・実施件数や全市場coverageではない。

実1723/S100YH9O（E00313、FY2026-03-31）は、同じissuerの当期durationに2026-04-01、普通株1株から4株、記載株数は分割前という注記を明示する。「行っております。上記の事項 は、…基準としております」という実在する別文型だけを既存`observePreSplitFiscalYearBasis`へ追加した。DEI・単一instance/stem・当期duration・普通株の厳密期末fact・namespace・一意性・日付・比率の資格は変更しない。単なる分割記載、予定、子会社、一部対象、併合・増資をこの文型へ拡げない。

1723 ZIP SHA `49926b2b4fe590a0561573b211ff5583b397568086c0864ef23e61823cc398c1`、683,618B。instance SHA `9f8e0c1c94dc4721de84dc59456306e6c07ab9957c472e7fb3bc2070d513cf69`、注記fact SHA `efba6676be842a907a832b50775729c1e59d7899a3f010e378d4b189c8d85b16`。同じ原本の普通株期末factは16,395,000株。無加工ZIPと来歴を`fixtures/holdings-split-1723/`へ収録した。原取得時計はこのfixtureで再資格化しておらずunknownを維持する。既保存価格影響projectionは同symbolの市場日2026-03-30・比率4・raw body SHA `13732612f8d9ba93182e9ae6a8ba7162fd4b4d830722a9112f9dcfe846d55ead`を参照するが、価格原文をこのfixtureに収録したとは扱わない。

同じ743集合の前後比較で新たに根拠が得られたのは1723だけ。旧1798の結果と他740源・欠測1源の状態/注記/原本SHAは同値で、確定したbasisは1源から2源になった。1723の価格候補3行のうち、owner期末も2026-03-31である範囲に限って法的日付との不一致を検討できる。他FYへ転用しない。normal loaderのcold cache-onlyは追加原本読取0のままなので、この変更だけで本番1723の証拠があるとは主張しない。旧5,362行のunavailable、価格未受入、source/株数/価格の原値を保持する。

その他は追加の公式資格が必要である。5940には2024-10-01の10株から1株という併合記載があり、6706の「併合前後」は過去の信託自己株への言及だった。2752の増加は公募・第三者割当・行使・報酬による複合で、8425には払込期日の記載がある。語の検出や集計増減から、当期全株の法的効力日・権利落日・普通株単位・価格係数を確定しない。株数履歴・原HTML表・訂正/取消関係・種類別時点が必要で、本文に無い値はLLMでも補わない。Yahoo OHLCV/配当額の株数basis、全増資/予約権/会社分割、原本欠測は引き続き[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)の残件である。

保存729,218,576B、展開7,683,973,017Bを逐次処理し、4GiB RSS監視/Node heap3GiBで旧31.825秒・peak505.3MiB、新33.175秒・peak493.0MiB。単発の同条件local比較であり本番上限を保証しない。最初のprivate auditorはsubstring保持でOOMしたため旧失敗を保全し、小JSON投影を逐次保存する別namespaceで比較した。本番parserのOOM実績とは区別する。新GET/モデル/依存/DDL/本番書込0、既存展開Mapの再利用で追加unzip0。純監査旧SHA `83801a5d21e40b4af8f38fdaa5d2c0c3e427d5f6796b9bc5004fafa012c01eed`、新SHA `f7f9fd2b470fdcb6e327b33db3533e79a3e981c313105e5c87e91b3450dbab44`。

実1723の別文型、元1798、普通株observer、cache cold/warmの関連3 suites/31 testsがNixでPASS。次の正常定期実行・本番での新根拠保存・全価格の受入は別に検証する。
