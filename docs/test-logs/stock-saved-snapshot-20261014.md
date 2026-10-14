# 株式日次と保存済み一次原本の共有計算 — 2026-10-14

通常の定時実行は `runDailySync → buildSnapshot → fetchStockRawData` のまま、Chart資格化・QuoteSummaryの尺度判定/丸め/年次系列・統合処理を保存原本と共有する。snapshot計算も `buildStockSnapshot` に移し、定時入口が必ず同じ関数を呼ぶ。取得回数、通常の株価/指標/RSI writer、D1保存範囲、既存1%監視閾値、Yahoo全履歴を要求する他callerは変更しない。追加依存/DDL/lock変更なし。

保存入力は `parseSavedStockRawData(code, {chart, summary}, {proxyBase?})`。各原本は `capture` と物理保管receiptの `expectedSha256` / `expectedByteLength` を明示する。対象日本株、HTTP200、上流statusが存在する場合200、8MiB上限、全body SHA/実長、canonical ISO実clock、Chart→Quoteの逐次時計、HTTPS・非標準port/credentials/hash無しの正規Yahoo要求または明示したHTTPS proxy（proxy設定自身のquery/credentials/hashも拒否）、5y/1d/events/modules、原本日足時刻がcapture以前であることを検査する。JSONは検証済みbytesから読む。fetch、現時刻によるcapture作成、書込は行わない。

`buildStockSnapshot(stockId, code, sector, expectedDate, raw, jssAnnualRows?, chartRaw?)` は対象日の実終値を確認し、通常の日次計算をそのまま行う。株式ID/業種/正本年次行は実DBから別途束縛する。8303の過去調整終値異常は原SHA付き5y RSI HOLDを保持し、旧RSI行/時計を更新しない。直近130本の当日OHLCV・財務・短期指標と、5y RSI履歴の資格は分離したまま。元Chart/Quoteのcaptureclockは証拠として保持し、再取得時刻へ置き換えない。既writerの `fetched_at` / `computed_at` は従来の保存/計算clockであり、原本取得clockとは区別する。

CIは公開可能範囲を最小化した既存の実数値projectionだけを使用。全原本JSONは公開Gitへ入れない。定時取得と保存入力の全列同値、proxy明示条件、SHA/bytes/HTTP/銘柄/窓/modules/実clock不一致の通信0 STOP、通常定時→同じpure snapshot→同じD1指標値、旧RSI不変を回帰で確認する。架空の本番データやfetch stubを使用した本番補完は追加しない。

私有 `stock-saved-pure-offline-v3` の実原本検証では、保存part20の全gzip SHAと8303のChart66,935B/Quote9,470Bの全body SHAを束縛。元clockは10:15:47.400Z / 10:15:48.285Z。全1,221本、過去245本の負adj、直近130本、当日終値1,478.5円を新pure入口で再現した。外部/Notion/R2 GET・モデル・業務書込は全0。以前のv3 21ファイル/commit `9e59a22` と私有全原本検証receiptは不変保全した。

本番8303補完はこの計算を使用する限定計画で別途受け入れる。物理PRE、fresh全列CAS、既writerが発行するSQLのD1原子確定、POST全列検証が必要。全銘柄再取得、古い原本を新しい取得に見せるfetch stub、独立した財務/指標計算・writerは使用しない。この変更時点の本番業務書込は0であり、8303復旧完了とは数えない。

検証: Nix Node22.22.2 / pnpm9.15.9で関連17suite・254tests、全体tsc、owned ESLint、diff-check PASS。snapshot計算本文、QuoteSummary計算本文、writer以降の全コードは前commitとbyte一致を私有receiptへ固定した。通常経路の外部取得/通信増分0、保存入口は解析時の全SHA照合だけで外部通信0。本番適用・再dispatch・Notion mutationは実施していない。
