import { BASE_PATH } from "../../base-path.js";
import { layout, h, fmtSignedPct, fmtYen, tip } from "./layout.js";

export type AnomalyType = "momentum" | "small-cap" | "low-vol" | "post-earnings";

export interface EmhRow {
  code: string;
  name: string;
  sector: string | null;
  /** モメンタム: 累積リターン (小数) / 小型株: 時価総額 / 低ボラ: ATR pct */
  metric: number | null;
  /** 補助メトリクス */
  secondary: number | null;
  /** 現在株価 */
  price: number | null;
}

export interface EmhPageProps {
  query: {
    type: AnomalyType;
    window: number;
    limit: number;
    smallCapMaxOku: number;
    lowVolMaxAtrPct: number;
  };
  rows: EmhRow[];
  /** 集計対象母数 (DB 上で条件を満たした全件数。ranking はこの中から limit 件を返す) */
  totalMatched: number;
  /** 集計時の参考メタ情報 */
  meta: {
    /**
     * 数値の出所の最新日付。momentum では投影 (`p_momentum.as_of`) の最大値、
     * それ以外のタブでは `MAX(swing_daily_ohlcv.date)`。
     */
    latestDate: string | null;
    /** 集計に使用した銘柄全体の数 (core_stocks の active かつ equity の件数) */
    universeSize: number;
    /**
     * 投影行数 (= 有効な終値列を持つ銘柄数)。momentum 以外のタブは投影を
     * 読まないので 0。0 のときは投影に関する表示を出さない。
     */
    projectedStocks: number;
    /**
     * 投影が持つ最長の終値本数。**window の実効上限**。
     * 保持が 90 営業日なので実測では約 89 で、UI の max=100 は実データ上
     * ほぼ必ず 0 件になる。この値を出さないと「条件に合う銘柄が無い」のか
     * 「そもそも本数が足りない」のかが画面から判別できない。
     */
    maxBars: number;
  };
}

export function emhPage(props: EmhPageProps): string {
  const q = props.query;

  const tabs: Array<{ key: AnomalyType; label: string; sub: string }> = [
    { key: "momentum", label: "モメンタム", sub: `${q.window}日リターン Top` },
    { key: "small-cap", label: "小型株効果", sub: `時価総額 < ${q.smallCapMaxOku} 億` },
    { key: "low-vol", label: "低ボラ", sub: `ATR% < ${q.lowVolMaxAtrPct.toFixed(2)}%` },
    { key: "post-earnings", label: "PEAD (簡易)", sub: "直近ファンダ更新銘柄" },
  ];
  const tabsHtml = tabs
    .map((t) => {
      const url = `${BASE_PATH}/emh?type=${t.key}&window=${q.window}&limit=${q.limit}&smallCapMaxOku=${q.smallCapMaxOku}&lowVolMaxAtrPct=${q.lowVolMaxAtrPct}`;
      return `<a href="${url}" class="chip ${q.type === t.key ? "active" : ""}" title="${h(t.sub)}">${h(t.label)}</a>`;
    })
    .join("");

  const filterForm = `
<form class="form-box" data-label="FILTER" method="GET" action="${BASE_PATH}/emh">
  <input type="hidden" name="type" value="${h(q.type)}">
  ${
    q.type === "momentum"
      ? `<div class="form-field">
           <label>集計 window (営業日)</label>
           <input type="number" step="5" name="window" value="${q.window}" min="20" max="100">
           <span class="hint">${
             props.meta.maxBars > 0
               ? `入力上限は 100 だが、実データの最長は <strong>${props.meta.maxBars} 本</strong> (保持 90 営業日)。これを超える window は 0 件になる`
               : "最大 100 日 (swing.daily_ohlcv の保持上限)"
           }</span>
         </div>`
      : ""
  }
  ${
    q.type === "small-cap"
      ? `<div class="form-field">
           <label>時価総額閾値 (億円)</label>
           <input type="number" step="50" name="smallCapMaxOku" value="${q.smallCapMaxOku}" min="10" max="50000">
         </div>`
      : ""
  }
  ${
    q.type === "low-vol"
      ? `<div class="form-field">
           <label>${tip("ATR% 閾値", "ATR(14) ÷ 終値 × 100。日中値動き幅 (%) の目安。1% 未満は超低ボラ、3% 以上は高ボラ。")} (%)</label>
           <input type="number" step="0.1" name="lowVolMaxAtrPct" value="${q.lowVolMaxAtrPct}" min="0.1" max="50">
           <span class="hint">% 値 (1.5 = 1.5%、デフォルト 1.5)。目安: 0.5 で超低ボラ、3.0 で広めに抽出</span>
         </div>`
      : ""
  }
  <div class="form-field">
    <label>表示件数</label>
    <input type="number" step="10" name="limit" value="${q.limit}" min="10" max="500">
    <span class="hint">最大 500 (silent 切り捨て防止)</span>
  </div>
  <button type="submit" class="form-submit">適用</button>
</form>
`;

  // Headers vary per anomaly. low-vol の "ATR%" にはツールチップを付ける
  const labels: Record<AnomalyType, { metric: string; secondary: string }> = {
    momentum: { metric: "累積リターン", secondary: "リスク調整スコア" },
    "small-cap": { metric: "時価総額", secondary: "前日比%" },
    "low-vol": {
      metric: tip("ATR%", "ATR(14) ÷ 終値 × 100。日中値動き幅 (%) の目安。"),
      secondary: "20日リターン",
    },
    "post-earnings": { metric: "更新時刻", secondary: "前日比%" },
  };
  const metricLabel = labels[q.type].metric;
  const secondaryLabel = labels[q.type].secondary;

  const tableRows = props.rows
    .map((r, idx) => {
      const cells = formatCells(q.type, r);
      const metricCell = cells.metric;
      const secondaryCell = cells.secondary;

      return `<tr>
        <td>${idx + 1}</td>
        <td><a href="${BASE_PATH}/dcf?code=${h(r.code)}">${h(r.code)}</a></td>
        <td>${h(r.name)}</td>
        <td>${h(r.sector ?? "—")}</td>
        <td class="num">${r.price !== null ? Math.round(r.price).toLocaleString("ja-JP") : "—"}</td>
        <td class="num">${metricCell}</td>
        <td class="num">${secondaryCell}</td>
      </tr>`;
    })
    .join("");

  // metricLabel は tip() を含む可能性があるため raw HTML として埋める (内部固定値で XSS 経路なし)
  const tableBlock = props.rows.length === 0
    ? `<div class="empty">該当銘柄なし</div>`
    : `<div class="table-wrap">
         <table>
           <thead>
             <tr>
               <th>#</th><th>コード</th><th>銘柄名</th><th>セクター</th>
               <th class="num">株価</th>
               <th class="num">${metricLabel}</th>
               <th class="num">${secondaryLabel}</th>
             </tr>
           </thead>
           <tbody>${tableRows}</tbody>
         </table>
       </div>`;

  const description: Record<AnomalyType, string> = {
    momentum:
      "過去の上昇銘柄が次も上昇しやすい現象。Notion ガイドの「6〜12ヶ月モメンタム」を、保持されている最新 90 営業日ぶんの終値から推定する (6〜12ヶ月には届かない)。リスク調整スコアは累積リターン / 年率ボラ。集計は日次 sync が銘柄ごとに 1 行へ畳んだ投影を読む。",
    "small-cap":
      "時価総額の小さい銘柄に流動性プレミアムがあり、リスク調整後で大型株を上回る現象。閾値はデフォルト 500 億円。",
    "low-vol":
      "低ボラ銘柄の方が高ボラ銘柄よりリスク調整後リターンで上回るアノマリー。ATR(14)/終値 比で低ボラ銘柄を抽出する。",
    "post-earnings":
      "好決算後 60 日にわたり株価上昇が継続する PEAD。決算カレンダーが取れないため、core.stock_financials.fetched_at の更新時刻を簡易代理として、直近で更新された銘柄を表示する。本来の PEAD 判定とは異なる点に注意。",
  };

  const body = `
<div class="hero">
  <div class="inner">
    <div class="label"><span class="label-text">004 / EMH ANOMALY</span><span>RISK · α</span></div>
    <h1>EMH<br>アノマリー探索.</h1>
    <p class="lead">効率的市場仮説のもとで実証されている「市場の歪み (アノマリー)」を、kabulab DB の実銘柄からスクリーニング。モメンタム / 小型株 / 低ボラ / PEAD (簡易) を 4 種から選択できる。</p>
  </div>
</div>

<div class="container">
  <div class="chip-row">${tabsHtml}</div>
  <p style="font-size:14px;color:var(--text-secondary);margin:8px 0 16px;line-height:1.7">${h(description[q.type])}</p>

  ${filterForm}

  <div class="section-label">004 / RANKING — TOP ${q.limit}</div>
  <h2>${h(tabs.find((t) => t.key === q.type)?.label ?? "")}</h2>
  <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px">
    集計対象: ${props.meta.universeSize.toLocaleString("ja-JP")} 銘柄 / 該当: ${props.totalMatched.toLocaleString("ja-JP")} 件
    / 表示: ${Math.min(q.limit, props.rows.length).toLocaleString("ja-JP")} 件
    ${props.meta.latestDate ? ` / 最新日付: ${h(props.meta.latestDate)}` : ""}
    ${
      props.meta.projectedStocks > 0
        ? ` / 終値列を持つ銘柄: ${props.meta.projectedStocks.toLocaleString("ja-JP")} 件 (最長 ${props.meta.maxBars} 本)`
        : ""
    }
  </p>
  ${
    // 投影がまだ 1 行も無い状態を明示する。「集計対象 3,715 銘柄 / 該当 0 件」だけ
    // だと「3,715 件を調べて誰も条件を満たさなかった」と読めてしまうが、実際は
    // **1 件も調べていない**。0011 を当てた直後や、日次 sync が未走の間に必ず通る。
    q.type === "momentum" && props.meta.projectedStocks === 0
      ? `<div class="notice"><strong>モメンタムの投影がまだ作られていません</strong> —
           集計は日次 sync (平日 21:00 UTC) が銘柄ごとに 1 行へ畳んだ投影 (p_momentum) を
           読みます。この表が空の間は、条件を満たす銘柄が無いのではなく
           <strong>まだ 1 件も集計していない</strong>状態です。次の日次 sync で埋まります。</div>`
      : // window が実データの本数を超えている状態を明示する。以前は「該当 0 件」と
        // 出るだけで、アノマリーが無いのか本数が足りないのかが分からなかった。
        q.type === "momentum" && props.meta.maxBars > 0 && q.window > props.meta.maxBars
      ? `<div class="notice"><strong>window=${q.window} は実データの最長 ${props.meta.maxBars} 本を超えています</strong> —
           この条件を満たす銘柄は存在しません。swing.daily_ohlcv の保持は 90 営業日なので、
           <a href="${BASE_PATH}/emh?type=momentum&window=${props.meta.maxBars}&limit=${q.limit}&smallCapMaxOku=${q.smallCapMaxOku}&lowVolMaxAtrPct=${q.lowVolMaxAtrPct}">window=${props.meta.maxBars}</a> まで下げてください。</div>`
      : ""
  }
  ${
    props.totalMatched > q.limit
      ? `<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
           <strong>${(props.totalMatched - q.limit).toLocaleString("ja-JP")} 件</strong> が表示外です。<a href="${BASE_PATH}/emh?type=${q.type}&limit=${Math.min(props.totalMatched, 500)}&window=${q.window}&smallCapMaxOku=${q.smallCapMaxOku}&lowVolMaxAtrPct=${q.lowVolMaxAtrPct}">もっと見る (limit=${Math.min(props.totalMatched, 500)})</a>
         </p>`
      : ""
  }
  ${tableBlock}
</div>
`;

  return layout(`EMH ${tabs.find((t) => t.key === q.type)?.label} | 004 KABULAB`, body, "emh");
}

/** type 別にメトリクス/サブメトリクスのセル表示を組み立てる */
function formatCells(type: AnomalyType, r: EmhRow): { metric: string; secondary: string } {
  if (type === "momentum") {
    const cls = (r.metric ?? 0) > 0 ? "good" : (r.metric ?? 0) < 0 ? "bad" : "";
    return {
      metric: `<span class="${cls}">${fmtSignedPct(r.metric, 2)}</span>`,
      secondary: r.secondary !== null ? r.secondary.toFixed(2) : "—",
    };
  }
  if (type === "small-cap") {
    const cls = (r.secondary ?? 0) > 0 ? "good" : (r.secondary ?? 0) < 0 ? "bad" : "";
    return {
      metric: r.metric !== null ? fmtYen(r.metric) : "—",
      secondary:
        r.secondary !== null
          ? `<span class="${cls}">${(r.secondary > 0 ? "+" : "") + r.secondary.toFixed(2)}%</span>`
          : "—",
    };
  }
  if (type === "low-vol") {
    const cls = (r.secondary ?? 0) > 0 ? "good" : (r.secondary ?? 0) < 0 ? "bad" : "";
    // r.metric は atr_pct (% 値、例: 1.5 = 1.5%)。fmtPct は decimal × 100 する関数なので、
    // ここでは toFixed で直接 % 表示する。
    // 低ボラ文脈: <1% を緑強調 (好ましい)、>3% を赤 (高ボラ寄り、本来除外されるはずの境界)
    const metricCls =
      r.metric !== null && Number.isFinite(r.metric)
        ? r.metric < 1.0
          ? "good"
          : r.metric > 3.0
          ? "bad"
          : ""
        : "";
    return {
      metric:
        r.metric !== null && Number.isFinite(r.metric)
          ? `<span class="${metricCls}">${r.metric.toFixed(2)}%</span>`
          : "—",
      secondary:
        r.secondary !== null
          ? `<span class="${cls}">${fmtSignedPct(r.secondary, 2)}</span>`
          : "—",
    };
  }
  // post-earnings
  const cls = (r.secondary ?? 0) > 0 ? "good" : (r.secondary ?? 0) < 0 ? "bad" : "";
  return {
    metric:
      r.metric !== null
        ? new Date(r.metric).toLocaleString("ja-JP", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—",
    secondary:
      r.secondary !== null
        ? `<span class="${cls}">${(r.secondary > 0 ? "+" : "") + r.secondary.toFixed(2)}%</span>`
        : "—",
  };
}
