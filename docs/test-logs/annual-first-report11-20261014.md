# 新規上場11社の有報提出予定・公式IR確認（2026-10-14）

有報欠測の11社を公式IRで確認した。**ビーエイブル（604A）の2026年7月期のみ、有報提出予定2026-10-30を直接確認。残10社の提出予定日は未確定**。決算発表・株主総会の予定を有報提出予定へ置換していない。7/1〜8/13のEDINET 44日窓で120/130が0件という既存検証も、それだけで未提出理由や対象年度を確定しない。

| コード・会社 | 公式資料で確認した決算期 | 通期決算発表 | 有報提出予定 | 公式根拠 |
| --- | --- | --- | --- | --- |
| 558A SQUEEZE | 2026年12月期 | 2027年2月中旬 | 未確定 | [IRカレンダー](https://squeeze-inc.co.jp/ir/calendar/) |
| 589A ネイス | 2026年8月期 | 2026-10-15 17時予定 | 未確定 | [公式IR](https://ne-is.com/ir/)・[同ページの配信カレンダー](https://xml.irpocket.com/589A/JS/calendar-jacal-all.js) |
| 593A ティアフォー | 2026年9月期 | 2026年11月中旬 | 未確定 | [IRカレンダー](https://tier4.co.jp/ir/ir-calendar) |
| 625A Skyfall | 毎年9/30、FAQに2026年9月期の記述 | 2026年11月 | 未確定 | [FAQ](https://skyfall.co.jp/ir-faq/)・[IRカレンダー](https://skyfall.co.jp/ir-calendar/) |
| 621A オーディオストック | 2026年9月期 | 2026年11月中旬 | 未確定 | [IRカレンダー](https://ir.audiostock.co.jp/ir_calendar.html) |
| 618A KOMPEITO | 2026年8月期 | 2026年10月中旬 | 未確定 | [IRカレンダー](https://kompeito.co.jp/ir/calendar/) |
| 604A ビーエイブル | 2026年7月期、非連結 | 2026-09-14公表済み | **2026-10-30予定** | [決算短信表紙](https://contents.xj-storage.jp/xcontents/AS04033/ba47fa20/9280/45d3/9c39/fa99a9a0ffde/140120260914535483.pdf) |
| 622A テクノクラフト | 2026年9月期 | 2026年11月中旬 | 未確定 | [IRカレンダー](https://www.tecraft.co.jp/ir/calendar/) |
| 623A ベルテックス | 2026年11月期 | 2027年1月 | 未確定 | [IRカレンダー](https://vertex-c.co.jp/ir/calendar) |
| 627A akippa | 2026年12月期 | 2027年2月中旬 | 未確定 | [IRカレンダー](https://akippa.co.jp/ir/calendar/) |
| 619A オリバー | 2026年12月期（上場1期） | 毎年2月中旬予定、年は未記載 | 未確定 | [現在の619Aの公式FAQ](https://www.oliverinc.co.jp/ir/faq/) |

604Aの表紙は実会計期間2025-08-01〜2026-07-31、総会予定10/29、提出予定10/30を別々に記載している。今回の資料だけで過去を含む初回提出と断定していない。593A/589Aの現行短信は第3四半期資料であり、全文を確認しても有報提出予定の根拠にはならなかった。

619Aは旧7959の決算期を流用しない。公式カレンダーの動的配信も追跡し、現在の配信3ニュースにcalendar項目がないことを確認したが、全EDINETの未提出証明とは扱わない。622Aのカレンダーには四半期の年表示に不整合があり、原本を保持したまま推定訂正していない。

対応は、604Aの明示予定を監査台帳へ反映し、提出後の通常EDINET取得・原本保存・本文資格を受け入れる。残10社は「提出予定未確定」を維持し、通常取得と公式IRの更新で確認する。架空年度、総会日から逆算した提出日、「新規上場だから未提出」という推測で穴を埋めない。

原本は2026-10-14 17:33〜17:51 JSTに57回の単発HTTP GETで取得（200応答56、探索URLの404応答1）。計3,301,559 bytesを9batchで共有`recordPrimaryData`に物理保管し、`verifyArchivedAttachments`で全文bytes/SHAを再確認した。404は探索失敗として保全し、事実の根拠から除外。原文・取得実体はGitへ追加しない。業務/D1/R2書込・モデル呼出は0。Notionリクエスト数自体は計測していないため、ファイル数から推定しない。最後の3batchはNotion最大0.25 req/sとした。

私有監査receipt: `tmp/feature-audit-20261013/annual-first-report11-v1/research-complete.json`。各fileの公式URL・取得時計・bytes・全SHA・Notion page/key・物理照合結果と、会社別の明示値/未確定を束縛している。604A表紙の物理保管先は[原本batch7](https://www.notion.so/3f9d74ff84cd8161829fd33ae902a2f4)、PDF SHA256は`8cfd46211d578f596c78f25537fbbe0fae676fe51446ac43494d47bb5ed20a1e`。
