# 海外 closed-44 本番修復・POST閉鎖

2026-09-30 UTC（2026-10-01 JST）。PR239のLOCAL検証とは別の、固定パケットによる1回の実作業記録。

## 実行結果

- fresh PREは2 SELECT、full16文書44件とall12 facts274行を観測。全44件が資格化パケットの旧状態と一致した。
- 15:45:41.061–15:45:46.561 UTCの実行はD1 HTTP54回、全200。44 atomic batches／144 SQL、POST2 SELECT、L2履歴3 SELECT、upsert3文、sweep1文、L2 POST1 SELECT。各文書batchの先頭でfull16/all12の件数・両方向EXCEPTを断定した。
- APPLIED44、POST44文書／62 facts。12 numericと32 honest unstructuredを通常共有保存変換で保存。32件は未知を正直に保存し、旧数値全てが誤りとは主張しない。
- scoped10銘柄に通常の `rebuildYuhoGrowthProjection` を実行。実履歴から7行を生成し、対象の古い3行をsweep（実応答 `changes=3`）。全32列の実POSTが同じproducerの生成値と一致した。
- 実POST44をそのまま同じ `applyOneDoc` へ渡し、44 MATCH／送信0／HOLD0。これは文書修復writerの再入検証であり、L2 producer全体の再入ゼロを意味しない。

PRE＋本作業のD1実計56回。追加EDINET/Yahoo取得、R2、dispatchは0。元の59一次原本と74READ baseline保管を再実行していない。

## 一次証拠・保管

新しい観測・実行証拠は既存shared Notion archive窓口を使い、force:false、既存DBのみ、known returnをdurable保存してからunique/full readbackを検証した。UNKNOWN時の再送やnew keyは行っていない。

既存59件はEDINET一次原本の件数。PRE19／POST331はD1観測・SQL・実行証跡ZIPのメンバー数であり、EDINET原本件数ではない。

| Stage | Full ZIP SHA256 | Bytes／members | Actual native |
| --- | --- | --- | --- |
| PRE | `4d436884b08a8d73e82d52fedcf5b3bb149ba59fb952dcd360a056a260be3f49` | 84119／19 | Notion10＋hosted1（15:19:59.702 UTC完了） |
| POST | `0e6f9bb38a1e5a9179b18121a73ddbd585786449c243bd9f6d16d7aed0671f67` | 232781／331 | Notion10＋hosted1（15:52:07.917 UTC完了） |

同じhosted readbackの全文bytesから全member名一意性・長さ・SHAを照合（PRE18 payload＋manifest、POST330 payload＋manifest）。追加downloadは0。POST inner manifest SHA: `107994faa781d5a95d1c4879b7c3164a833218ad4378a32c6da22053f2e9591f`。

## 固定pinsと追跡

- Operational tree: `0a5af0abd494b14eb69168c2a59051528af1e082`（PR239はmain `991c8f01cfcebd980251a36e34fd5508aca09b96`へmerge）。通常producerの実ソース19 module pinsを実行前に照合。
- Qualification: `c7c0b56fdd7bf1c06cf7d249e65df70c635e41ed95a323791c3272dad2c7f3dd`。
- Plan: `cea70d62792997d98d0770df8ecefb5aa70f3779306367b4fd2cf3f1d5355d35`。Fresh PRE: `a7fd7477fb161997bf4c1f074223670d85c806699d08978f98d280444390cf52`。
- Private writer: `edc602228c0eb66a9d0c6391ccccd158ac57ce5c5561d640a241d12903a9269b`。Wire: `3a3a2d4f887bba1aa5e8c123c40633b94e7ef7b66214c80c27fe95dd0bb5f5b8`。
- Actual report: `5a4c74730b07a2e4a5239877f68da7e96e1ef2c5088073f45172bc28b7be6857`。Actual writer reentry proof: `498da0f611012a0f3f8ff229276fe76f023a988c4f5416e609dc3c337f570983`。
- 全HTTP requests/reservations/raw responses、安全なreceipt headers、全POST、SQL/module pins、再入証跡はprivate0600で保持し、POST ZIPに封止。財務原文・数値・秘密はGitに置かない。

## 範囲と限界

修復したのは資格化・一次保管済み59件中のchanged44件。資格評価時点のMATCH15件は書込対象外。L2は対象10銘柄の全履歴を既存producerで処理し、SQL範囲は対象外を含めない。全3675件の修復完了や、未資格の原本・過去取得時計の補完、L2全体の再入ゼロは主張しない。

公開CLIの `--live` は引き続き明示STOP。実作業は別途レビュー・限定承認されたprivate thin runnerで実行し、元の消費済みcounterや証拠をresetしていない。
