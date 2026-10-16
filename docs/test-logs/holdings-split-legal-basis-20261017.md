# 保有価格の市場権利落日と法的分割日（2026-10-17）

本番価格の受入は0のまま。係数補正・価格再取得・業務反映は行っていない。

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
