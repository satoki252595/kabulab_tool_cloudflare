import { layout, h, tip } from "./layout.js";
import { BASE_PATH } from "../../base-path.js";

/** ホームページ */
export function homePage(props: {
  totalStocks: number;
  blueChipCount: number;
  lastUpdate: string | null;
}): string {
  const { totalStocks, blueChipCount, lastUpdate } = props;

  const presetCard = (p: {
    num: string;
    label: string;
    title: string;
    desc: string;
    href: string;
  }) => `
    <a href="${h(p.href)}" class="card-link" style="text-decoration:none">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border-soft)">
          <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);font-weight:700;letter-spacing:0.08em">
            PRESET ${h(p.num)} / ${h(p.label)}
          </span>
          <span style="font-family:var(--font-mono);font-size:18px;color:var(--text)">→</span>
        </div>
        <h3>${h(p.title)}</h3>
        <p style="margin-top:6px">${h(p.desc)}</p>
      </div>
    </a>`;

  const body = `
    <div class="hero">
      <div class="inner">
        <div class="label">
          <span class="label-text">001 / RSI SCREENING</span>
          <span>${lastUpdate ? `UPDATED ${h(lastUpdate)}` : new Date().getFullYear()}</span>
        </div>
        <h2>底値圏の優良株を、<br>データで見つける。</h2>
        <p class="lead">
          過去5年間の${tip("rsi", "RSI")}${tip("percentile", "パーセンタイル")}で「今が5年で何%の底値水準か」を定量化。
          ${tip("operatingMarginTtm", "営業利益率")}と売上高の上昇トレンドで${tip("blueChip", "優良株")}のみを抽出します。
        </p>
        <div class="stats">
          <div class="stat">
            <span class="num">${totalStocks.toLocaleString()}</span>
            <span class="lbl">Stocks</span>
          </div>
          <div class="stat">
            <span class="num">${blueChipCount.toLocaleString()}</span>
            <span class="lbl">${tip("blueChip", "Blue Chips")}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="container">
      <div class="section-label">001 / About</div>
      <h2 style="margin:0 0 16px">このサービスについて</h2>
      <div class="card" style="margin-bottom:32px">
        <p style="font-size:15px;color:var(--text-secondary);line-height:1.8">
          日本の個別株を対象に、<strong style="color:var(--text)">${tip("rsi", "RSI")}(2週間・2ヶ月・半年)</strong>
          が過去5年の分布において下位何%にあるかを算出し、
          <strong style="color:var(--text)">「過去5年で最も底値圏にある銘柄」</strong>をスクリーニングします。
          さらに、${tip("operatingMarginTtm", "営業利益率")}が一定以上かつ売上高も増加基調の
          <span class="badge badge-good" style="margin:0 4px">${tip("blueChip", "優良株")}</span>
          のみをフィルタすることで、一時的な下落中の成長銘柄を発見できます。
        </p>
        <p style="font-size:13px;color:var(--text-muted);margin-top:12px;line-height:1.7">
          画面上の <strong style="color:var(--text)">点線が引かれた用語</strong> にカーソルを合わせる (タッチデバイスではタップ) と、
          専門用語の意味と数値の目安が表示されます。
        </p>
      </div>

      <div class="section-label">002 / Quick Presets</div>
      <h2 style="margin:0 0 16px">プリセット検索</h2>
      <div style="display:grid;grid-template-columns:1fr;gap:16px">
        ${presetCard({
          num: "A",
          label: "Bottom 5% / Blue Chip",
          title: "底値圏の優良株 (下位5%)",
          desc: "3期間のいずれかで過去5年の下位5%にある優良銘柄",
          href: `${BASE_PATH}/screening?period=min&percentileMax=5&blueChip=true`,
        })}
        ${presetCard({
          num: "B",
          label: "Short-term / 10D",
          title: "短期 (2週) が底値の優良株",
          desc: "RSI(10日)が過去5年の下位10%",
          href: `${BASE_PATH}/screening?period=10&percentileMax=10&blueChip=true`,
        })}
        ${presetCard({
          num: "C",
          label: "Long-term / 120D",
          title: "長期 (半年) が底値の優良株",
          desc: "RSI(120日)が過去5年の下位10% — 長期トレンドの転換点",
          href: `${BASE_PATH}/screening?period=120&percentileMax=10&blueChip=true`,
        })}
        ${presetCard({
          num: "D",
          label: "All Stocks / Bottom 20%",
          title: "全銘柄の底値圏 (下位20%)",
          desc: "優良株フィルタなしで幅広く検索",
          href: `${BASE_PATH}/screening?period=min&percentileMax=20&blueChip=false`,
        })}
      </div>
    </div>
  `;

  return layout("RSI Screening | KABULAB", body, "home");
}
