# 保有原表の商号変更注を価格主体の資格へ渡す

2026-10-18。2502/S100YVTZ・期末2025-12-31の原表には、銘柄名に注2/3が付いた二行と、同じ株式保有TextBlock内に旧名・新名・商号変更日を明記する完全な文がある。銘柄名から注だけを削除して推測照合する処理は追加しない。

## 採用する原文形

注番号と旧名が同じ原表行に対応し、「旧名は○年○月○日付で新名に商号変更しております。」という実施済みの完全な一文が一意の場合だけ診断へ残す。予定、合併・譲渡、未来日付、不正日付、注番号や旧名の不一致、重複・相反する追記は採らない。現在の公式銘柄表に新名の適格上場主体が一意にある場合だけ価格候補へ進め、英字名・保存価格・分割単位の資格は既存条件を維持する。

`ShareholdingsExtraction.nameChanges` を原表の診断として追加し、各`Shareholding`の値・名称・原表列・順序とfactsSHA/checkpointは変更しない。資格済み価格には`priceSource.nameChange`として元ZIP/member/節全文/該当文のSHA、旧名・新名、注番号、実施日と実contextを保持する。新名だけを理由に金額・価格・英字名を生成しない。

## 訂正原本の時計

当該原本のfilename日付は2026-08-12、instanceとheaderの`FilingDateInstant`は双方2026-07-27だった。旧`readFilingDateInstant`は提出日時資格としてfilenameとinstantの一致を要求し、今回もnullのまま保つ。

新しい`readReportedFilingInstant`は同じ既存context readerが確認したissuer/stem・両原本一致の実contextを、`clockKind: reported_context`と`sourceFilenameDate`を持つ別観測として返す。新しい提出時計には読み替えない。商号変更日はreported instantとfilename日付の双方以前を必須とし、相反するheader/instanceはnullにする。

## 保存原本による結果と限界

旧active snapshot 37202207552.1/session2026-10-02と、同snapshotの公式銘柄表asOf2026-10-13に限定して純再生した。218sourceのうち208Aを除いた217source/2822行の保存ZIPを全てqueueのZIP SHA・facts/orderへ照合し、旧947資格済み結果を全て同値に保った。別途1911を除く適用候補は216source/2777行・旧qualified928であり、この純再生は価格公開の承認ではない。

追加診断は2502の二注だけ。サッポロの新商号は公式2501へ同定できるが分割時点の単位資格でHOLD、サントリーの新商号は固定したFSA原本の英字名欄が空でHOLDとなり、今回の追加算定は0件。後者は英字名の原典が世界に存在しないという主張ではない。別issuer原本を使うには、その日本語名・主体・提出時点を別途資格化する必要がある。翻訳・近似名・比率の推測は行わない。

217 sourceの旧parserと新parserを同じ保存bytesで3回比較し、診断以外の全出力が一致した。中央値は旧2279.2ms、新2460.8ms（差181.6ms、約0.84ms/source）、同round差の中央値198.8ms。通常日足producerと並行したローカル計測であり、本番の遅延・料金保証ではない。純価格再生は9.49秒、HTTP/DB/Notion/model/業務writeは0。

CIは実二注の断片文法投影と負例を検査する。保存ZIP・現FSAを使う回帰はprivate原本が存在する場合だけ実行し、CIで原本資格を確認したとは扱わない。

通常publisher/価格resumeは同じ保存ZIPから再解析した`parsed.nameChanges`を価格loaderとqualifierへ渡す。loaderの必要chunk選定・公式英字名選定と評価は`resolveHoldingPriceIdentity`を共用し、注を渡さない旧callerは従来どおり直接一致だけを使う。直接候補が既にある場合は、一意でなくても注を別主体の代替にしない。保存原本prepareの価格診断にも同じ注を渡す。追加source/API/DB/Notion/modelは0、価格読取は既存chunk/byte予算に従う。配備、新active世代でのfresh資格、実価格writerの受入はまだ別途必要であり、全権利処理・全価格セルの完了とは呼ばない。

1911除外は上記純再生の適用候補集計であり、共有コードの恒久blacklistではない。通常価格resumeの`maxRows`は件数予算であり、固定銘柄の選択ではない。実適用時は入口queueと既存exact-doc状態guardを確認し、原一覧状態が未資格なら既存HOLD、正常source/価格pendingと資格化された場合は通常の対象として扱う。過去のunknown解消証跡を現在の原一覧状態の資格に流用しない。

保存証跡（private、Git非収録）:

- `tmp/feature-audit-20261018/holdings-rights-needed-current-v1/price-needed217-name-change-v2.private.json` SHA `424dbefd839dd58457771d7d1eb94869aeed9caaed4857736be9dd69d10fd033`
- `name-change-paired-v1/result.private.json` SHA `b79efc78eaa752b2d03c6c75d5c6282a7f13c6066a764649ba55a68453a4fc9c`
