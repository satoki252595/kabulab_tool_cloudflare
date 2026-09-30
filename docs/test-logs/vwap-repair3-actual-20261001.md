# VWAP 3件の現物修復と通常入口の再入

## 実操作

2026-09-30 UTC（消費者確認の一部は10月1日JST）に、既存の保存原文だけから全10年の日足を再構築した。外部の新規Yahoo取得は行っていない。

- 3件の現在のR2本文を各1回READし、旧診断の全SHAと一致。実ETagと取得時計を判定前に私有保存。
- 前画像・候補・操作器・全SHAの21ファイルをZIPとmanifestで物理保管。shared record force:false、実record10/readback5、添付全文および全21memberのSHA一致。
- 取得時の不透明ETagをIf-Matchにしたwhole-object PUTを各1回。3件すべて既知成功。その後の各1回READが凍結候補全文と一致。再送なし。
- 保存したNEWPOSTを実通常 `ingest-daily.main()` に戻し、同じ保存原文を再生した。実凍結plan時計を使うoffline同一run検証で、3件すべてskipped、throwing PUT senderへの呼出し0。実3695母集団への所属も保存済み全snapshotで確認した。

日足は提供元OHLCVを使い、配当等を含む調整終値をVWAP入力にしない。実原文の調整終値は保管済み。要求範囲外の旧70行を各対象で明示破棄し、範囲内の実在日付はすべて新原文で置換した。不正な旧調整終値が発生した歴史的原因は未確定。

## Consumer確認

許可された4 GETのみ実行（3 daily / 1 intra）。最初のdailyでは、修復後に取得時計・原文SHAが更新されていたため、旧候補との全文比較を停止した。元のSTOP・原文・判定を保持した。

既存scheduled run `36730312678` はmain `1e81a10` で14:35:50Zに開始し、14:36:07Zから通常daily処理を実行中だった。現物の価格・出来高・日付・分割は修復候補と全一致。新しいproofの10y・symbol・calendar・span・split一致を確認し、取得済み本文を新しい適格観測として扱った。新しいYahoo原文そのものを再取得して帰属確認したわけではない。

残るdaily2件も全businessとstrict proofが一致し、intraの零分割対象はqualified:true（6848bars）。cache bypass・同URL再送・Yahoo proxy GETは行っていない。定時runの完了とsummaryの物理保管はこの4 GETだけでは証明しない。元の失敗runも再実行していない。

## 同様の株数基準の穴

共有zeroSplitCoveredは保存5分足の窓内だけで分割を検査していた。窓終了後から現在の日足の最終日までに分割がある場合も、旧5分足の基準は未確認のためHOLDが必要。検査終点を日足最終日に修正した。

保存済み実10y原文の分割日と実session timestampを使い、分割前の窓投影はHOLD、分割後の最終session投影は適格を検証した。これは範囲境界の検証であり、5分足wireの調整仕様を証明したものではない。新たな係数による価格・出来高補正は導入していない。

## Pinsと検証

- 実PUT器: `49bb2192df46f84fbfe2657a83cc10778486ae3f030e9406eb2e9693c7cd0375`
- PUT packet: `bf4ffa10a065d30bdcc2f17f91b8bd29a8a20b00036fc1a8fb07ee9a7ff7f228`
- 前画像ZIP: `c22abd6a69a076f35897a414c007c1c8a174feaded302c4a76b5013d1679c4c1`
- 前画像manifest: `9837a36a7eb95e77d6c0c1648cdad8445f131060efcf9315131d70832a2c45df`
- Nix focused normal-main/intra-basis: 35 passed、実fixture利用、skip0。
- Nix full: 251 files / 4109 passed / 389 skipped。tsc・lintともexit0。
- 原文・金融値・ETag・本番全snapshotはGitに保存していない。通常dispatch追加0。
