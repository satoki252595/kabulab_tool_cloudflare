# sector33-only cadence 証跡 (2026-09-30)

EDINET コードリストからの sector33 差分同期ジョブ
(`sector33_sync`) + 薄い TS 保管 CLI + stock-sync 内 sector step。
実装＋offline tests のみ。live の取得・保管・D1 書込は 0
(実 6 書込は owner の別 preimage-guard grant 待ち)。

## 設計 (Root 承認 scope)

- 順序: [完全性 gate] → [custody] → [target gate] → [write]。
  壊れた世代は custody しない。
- 共有候補検査 (`inspect_codelist_candidates`) を全件 parse 後・limit 前・
  ① upsert 前に master/sector 両 job で必須化。ticker/issuer 重複は STOP、
  `0000` phantom は非候補＋HOLD。last-wins (`_dedup_by_code`) は廃止。
- issuer 資格: qualified sector 入力は literal 有効 EDINET id (`E`+5 桁)
  必須。blank issuer は typed identity HOLD＋sector 除外 (①候補には残す。
  ① schema 改造なし)。不正 nonempty issuer は prewrite STOP。name join 禁止。
- 共有 planner: ticker 重複は sector 成否と独立した seen で STOP
  (unknown-first の見逃しなし)。未知 sector は desired に入れず retain
  (NULL 消去なし)。builder は None・33 業種外名称を拒否する backstop。
- 適格 target のみ (ticker, raw sector) を planner へ。非空白で写像不能な
  sector を持つ target は STOP。空白 sector・不在は保持し、NULL 残存は gap。
- D1 は active-equity current (`is_active = 1 AND instrument_type = 'equity'`、
  値は bind) のみ SELECT し、sector33 差分のみ UPDATE
  (`updated_at` 他は不変)。gap 残存は partial (exit 1) → moneyflow 停止。
- D1 設定は必須、想定外 local・`--limit`・`--codes` は `run_job` 前の
  typed config STOP (exit 2)。保管 CLI 失敗は writer 0。
- 合法欠損 (listed 行の空 ticker) と不正 ticker は typed HOLD/INFO 診断で
  継続し、全 raw invalid STOP にしない。

## stock-sync 配線

- 既存 `sync` job 内、stock daily step の直後に sector step
  (`steps.daily.conclusion == 'success'` かつ `trade_date` 非空)。
  新 workflow・別 job DAG なし。既存 event guard・macro split 不変。
- moneyflow は `needs: sync` のまま (sector 失敗は job 失敗→非進行)。
- 環境は既存 secret の mapping のみ (CF_*/NOTION_*)、新規 secret なし。

## 検証 (offline)

- `pipeline: ruff + pytest` 全緑 (1501 passed / 0 failed / 58 skipped)。
  実フィクスチャ＋実 helper で archive 失敗→writer 0、重複 STOP、
  合法欠損 HOLD、未知 retain、非株式 0、2nd diff 0、sector-only・
  `updated_at` 保護、診断 taxonomy 全種別を cover。
- TS CLI は vitest 7 件。実 shared `verifyArchivedAttachments` を
  stub transport 上で実行し、record 1 回・unique・全 bytes SHA 照合・
  同名 ZIP 重複＋manifest 欠落の拒否を cover (独自照合 loop なし)。

## BLOCKER 対応 (PR213 review)

- (1) TS 独自 list/download/SHA loop を削除し、共有の厳格
  `verifyArchivedAttachments` (unique filename＋full bytes HTTP200・
  length・SHA) を `queryUnique` 後に呼ぶ 1 経路に統合。vitest は実
  verifier 実行 (transport のみ stub) で重複 ZIP・manifest 欠落・
  external・長短・SHA 不一致・DL 失敗を落とす。
- (2) 保管世代 key を `edinet-codelist-{asOf}-{manifest正準12hex}` に
  変更 (`_generation_key`: 不変の capture metadata 派生。`key` 自記は
  digest 対象外)。record 時 `now()` 採番なし、失敗時の別 key 発明なし。
  旧 `edinet-codelist-{asof}` 形と衝突しないため 9/30 pins を保全する。
- 同日 source の正常な繰り返し producer を厳格原本 replay
  (`StrictArchiveDouble`: 単発 record force=false・unique・hosted 層
  全 bytes 照合) で統合対照: 両 run archive 成功 (新世代 key・照合一致)、
  1 回目 N 行書込・2 回目 D1 差分 0、先行 pin bytes 不変。同一 key＋異
  bytes は失敗 (逃げ key なし)、hosted 改竄は SHA で検出、manifest pin
  不一致は producer 検査で検出。
- 外部送受信の追加 0 (source/Notion/D1/R2/dispatch)。D1/R2 実書込 0。
- 通常 3817 件の parse 結果は保持 (合法 preferred/empty/00000 は
  非候補に分離)。
