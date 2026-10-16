# 通常5分足の有限回復に新規開始予算を付ける

既存の手動`target=intra`を固定100コード以内で使う。`intra_max_start_seconds` / `--max-start-seconds`を明示した場合だけ、CLI開始から1〜900整数秒の予算を既存の`scheduledVwapGuard`へ渡す。未指定の通常手動、月水金17時の予定日・受付・23:30期限、取得頻度、共有Yahoo排他、CONC1、取得範囲、原本保管、R2 PUT2は変えない。新しいjobや依存は追加しない。

重複・対象未指定・100コード超・limit併用、定時日付との併用はD1/source前に拒否する。正規active-equityへの所属は従来の通常読取で検査する。同じguardを既存Yahoo認証/間隔待機後の通信直前、各条件付きPUT直前、最終確認で使う。期限到達・時計後退後の新規取得・更新は停止し、取得済みraw custodyとsummaryは保全する。開始済み要求は取消成功とみなさず既存の結果区分を保持する。

開始予算と実時計をsummaryの`finiteStartBudget`へ記録する。これは新規開始を止める期限であり、開始済み応答や必須原本保全を含む処理全体の900秒完了保証ではない。期限後の保全が終わってもexit2で、部分結果を成功にしない。CF proxy内部の上流通信開始時計までの厳密な保証は従来と同様に別問題である。

検証は既存通常mainを通し、原本保管中に予算端へ到達した場合のPUT0/summary保存/exit2、曖昧な対象のsource0、定時・未指定手動の退行なしを確認する。復旧対象1856のうち先頭100だけのpilotと後続1756は、それぞれ原本・R2全読戻しと独立受入後に発行する。初回429/503・unknown/rejectedで後続を停止し、成功済み1830銘柄は再取得しない。

2026-10-16の通常経路監査で、有限手動の`admission`がnullのため通信直前callbackが渡されない不備を修正した。共通Yahoo clientへ常に同じguardを渡し、認証・間隔待機中に有限期限へ達した場合も新規通信を拒否する。未指定手動のguardは既存どおり制約なし。期限到達後のR2 GET/PUT不実行とsummary保存を通常mainの回帰で確認する。有限手動の相対期限は定時の23:30絶対期限を自動付与しないため、夜間回復は実開始時刻からの有限期限が23:30以前になる範囲でのみ別途受け入れる。

## 2026-10-16の本番データ受入

[PR #427](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/427)のexact head `5555df4d2eb6547d4add61acf664fd0bfe0582cf`は全3 check成功後、main `4a9a0102a1847e547fa77b8f205cff00f4a1353a`へマージした。NixのNode22.22.2/pnpm9.15.9で、mainと共通ソース全体・lockが一致する通常`ingest-intra.main()`をローカル実行し、本番R2へ反映した。別の取得・計算・更新ロジックは使っていない。

固定対象は旧run `38547185176.1` の未完1,856件だけ。原summary SHA `88c5af0ddf60d2fb26286a688d4cad295548d2194376f91e0dba3e09610ad137`から先頭100と次100を順に選び、旧成功1,830件・両群の重複0、fresh active-equityへの所属・旧R2全本文/ETagを照合した。各開始直前にActionsの実行中・queued・waiting・pendingのYahooジョブ0を確認し、ローカルYahoo取得を専有した。

| 固定範囲 | 通常run | 実開始→終了（JST） | 新規開始予算 | 書込／独立全読戻し |
|---|---|---|---:|---:|
| index0–99、5831〜6037 | `local-38b99d4d` | 23:20:35.216→23:23:13.164 | 480秒 | 100／100 |
| index100–199、6038〜6227 | `local-bdd7a75f` | 23:24:46.165→23:27:24.873 | 240秒 | 100／100 |

双方ともrange5d・CONC1・原本照合後のPUT2・Notion上限0.6rps。新規開始期限はそれぞれ23:28:35頃／23:28:46頃で、23:30を越えない。errors/empty/invalid/rateLimited/unknown/rejected・Notion再試行・LLM呼出しは全て0。元runの失敗記録は変更していない。

取得原本8gzip（合計646,756B）の全200memberを、独立に保存したproxy応答全文のSHA/実取得時計へ照合し、Notion-hostedの物理全文一致も確認した。summary2件も別読取で物理照合した。R2全POST200件・61,140,120Bは通常writerの全payload SHAと一致し、旧969,163行を再解析して保持期間内の全timestampと共通merge結果の保持を確認した。最新sourceの実取引日は10/16が192件、10/15が5件、10/14が3件であり、原本に無い取引を生成して日付を揃えていない。最新barが古い理由を一律に無取引とは分類しない。

通常2runの増分はproxy GET200・R2 GET200/条件付PUT200・Notion52要求/hosted8GET。独立POST検証はR2 GET200・Notion2要求/hosted2GET。PRE準備は次の未実行30件を含めR2 GET230、D1は準備3読取＋通常2読取。定期頻度・依存・モデル料金の増分は0で、全量所要時間や料金額の保証とは扱わない。

私有受入記録は`tmp/feature-audit-20261016/vwap-intra100-post-readonly-v2/SUCCESS.json`（SHA `84e1343706e167264e390a2d236ff376847a1690becccdad523aa1229ca2abfa`）と`vwap-intra-next100-post-readonly-v1/SUCCESS.json`（SHA `b526ec13bb8abb2d58646777679581cced4fe388e119fe6109d7c9ba8c5156e8`）。原本・署名URL・旧本文はGitへ保存しない。

**残り1,656件は未反映**。次30件（index200–229、6228〜6273）はPREだけを準備したが、先行群の独立受入が23:27:44となり、次群の受付期限23:27:30を越えたためsource/PUT0でHOLDした。最初の600秒案もGitオブジェクト未取得の事前検査で業務通信0のまま停止し、元記録を保持した。日足523A/634A/641Aは保存原本から旧有効日付が欠けるため従来のHOLDを維持する。通常定時の全量完走・全20機能の完了は未受入。
