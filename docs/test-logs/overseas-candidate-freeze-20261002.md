# 海外売上・次候補の読み取り範囲固定（2026-10-02 JST）

初回 pilot を除く次候補 **15 通**を、既存の実 EDINET fixture と現行 parser の結果から固定した。最大 20 通の上限以内であり、件数を補うための候補追加は行っていない。下記の候補抽出・metadata読取は各実行時点の記録であり、その段階では原本の再取得・資格成立・本番修復を行っていない。後続の限定phase1では[原本全文照合15通・数値資格9通/HOLD6通](overseas-next15-custody-20261002.md)を確認した。D1修復は別段階である。

## 抽出条件と実観測

- fixture は現行 parser で numeric positive、保存集合検証を通過し、全 facts が連結、選択候補が 1 件、連結 scope と当期末が明示一致したものに限定した。fixture の SHA を再照合した。
- 公開済み exact closed44 の 44 ID 集合と照合し、全候補がその集合外であることを確認した。旧 exact closed59 packet は未復元のため、closed59 membership は全件 **UNKNOWN**。旧 raw inventory への所属・過去の未知結果との関係も **UNKNOWN** のままである。
- 固定 ID 集合に対する D1 SELECT は documents と facts の **2 回だけ**。documents **15 行 × 全 16 列（240 cells）**、facts **82 行 × 全 12 列（984 cells）**を private に保存した。欠落文書・集合外 facts・親 ID/stock ID の不整合はなかった。
- 本番の現在 status が negative の候補も 2 通ある。部分 fixture の positive は候補選定の根拠であり、fresh full ZIP の numeric 資格を代替しない。
- 原 HTTP response bytes、request SQL/binds、開始・完了時刻、HTTP status/date は 2 件とも private に保持した。captured metadata の実時刻は `2026-10-01T17:28:45.072Z`〜`2026-10-01T17:28:45.547Z`（JST 翌日）。各 response は HTTP 200 / body success。
- 追加 D1 読み取りなしの offline 検証で、全列、全件数、厳密 ID 集合、fixture SHA、HTTP bytes/SHA、private file mode 0600 を照合した。

## 公開する集計と SHA-256

個別銘柄・実数値・原文・private HTTP 本文はこの記録に含めない。

| private evidence | bytes | SHA-256 |
| --- | ---: | --- |
| full documents/facts preimages | 53,755 | `2aea5a0310889ae9552421506793aa4bc8bd73b3d3e6a50906cb0229cd3dca9c` |
| exact candidate scope report | 7,380 | `52c5f7bd055c8589e12d1cbf7b827e2f9f10419c048d201dd234eeb84f61583a` |
| scoped SELECT-only capture module | 5,296 | `a995b46f6314227283c376de430a6882fda024a54f70efdc7a084e67de70371a` |
| documents original HTTP bytes | 9,407 | `312e0a77b8ea244315018fac30a9242d1fbd61e561177e683dcdffce512f0075` |
| facts original HTTP bytes | 21,567 | `6473d24f9d039bd7774a47ead46399ffd9ebe929ad7270b189f24c45f1977bf8` |

この候補固定作業の source GET **0**、Notion API **0**、本番 mutation **0**。private PRE の物理保管はまだ行っていない。当初の D1 snapshot では current typed type1 key は **NOT_CHECKED**。その後の限定 metadata 読取は下記の別 ledger に記録した。

## current typed-key metadata の限定読取（2026-10-02 JST）

- 既存 `findBackupRowsByKeys` を使い、固定 15 通の type1 key だけを 1 OR query で照会した。既存 DB ID は過去の成功 metadata 読取の原 response/ledger SHA を pin とし、別 DB・別 key・DB/page 作成を native 通信前に拒否した。
- 実 Notion API **2 回**（正確タイトル search 1、exact 15-key query 1）。children/database GET 0、query pagination 0、再試行 0。予定上限は native 12 / query 1 で固定した。初回 pilot の旧 metadata 9 件とは別 ledger であり、件数を混合していない。
- 現在の type1 key は **欠落 13 / recorded かつ hosted 添付あり 2**。記録済み 2 件は immutable として追加 source GET 0 の対象外にする。これは metadata 行の観測であり、既存添付の全 bytes readback・原本数値の資格成立を示さない。
- 開始・完了の実時刻は `2026-10-01T17:59:07.424Z`〜`2026-10-01T17:59:08.522Z`。両 HTTP 200、strict list envelope / query 全行の identity・Key・Status・Files・Metadata 検証を通過した。duplicate、無関係 key、上限超過、不正形状、HTTP 失敗・未知結果では STOP し再試行しない。
- 原 request/response 4 files、予約・捕捉 4 files、PLAN、findings の計 10 private files を mode 0600（dir 0700）で保持し、全 bytes/SHA・実 clock・固定 key 集合を追加 API 0 で照合した。guard の 15 offline gates と型検査、独立 read-only review も PASS。
- この追加作業の source/hosted GET **0**、D1 additional **0**、Notion mutation **0**、new key **0**。欠落 13 通の fresh full ZIP 数値資格は全て **未成立**。別初回 pilot でも fresh full ZIP の物理保管・readback と numeric 資格 HOLD は分かれており、部分 fixture の positive を full ZIP 資格へ拡張しない。
- closed59 membership、旧 raw inventory 所属、旧の実予約台帳の復元は依然 **UNKNOWN**。この metadata 読取で過去の未知 POST を不存在と証明したり、旧 UNKNOWN latch を解除したりはしていない。

| private metadata evidence | bytes | SHA-256 |
| --- | ---: | --- |
| scoped read PLAN | 1,444 | `99c898481199154805a16454ac208ba26c82196101ea1fb710a7f68423960c96` |
| findings（13 missing / 2 immutable） | 3,535 | `3651b10faf76d23ed732e86e01cafcdd04171517e7eb5345e963cfc9251b728f` |
| discovery original HTTP bytes | 430,263 | `5bd8f478dae1ccb0d279f0a7c4578d8ef3a3ea19a8cf3ea92d28d735f07da1e3` |
| exact query original HTTP bytes | 8,999 | `16f9ffd44f88816697844de851c4df21630c0f4d3fc66e93ae13522529561185` |

## 再開条件

欠落 13 通について、旧 UNKNOWN latch の扱い、fresh full source の当期・連結・地域/単位資格、PRE 原 HTTP を含む物理保管と全 bytes readback、root の限定 writer grant を満たしてから実行範囲を確定する。既存 current type1 key が記録済みの 2 通は、その候補への source GET 0 のまま対象外とする。全候補を欠落原本や修復済みと推定しない。
