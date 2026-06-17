/**
 * 投資初心者向け用語バルーンヘルプ — kabulab 共通コンポーネント
 * (CLAUDE.md ルール7 の正準実装)。
 *
 * `?` マークは付けない。**用語そのもの** (点線アンダーライン) を
 * マウスオーバー / フォーカス / タップすると平易な解説バルーンが出る。
 * 001 RSI / 002 お宝優待の `.tip` / `.tip-text` と見た目・操作を統一。
 *
 * JS 不要・CSS のみ。`overflow` を持つ祖先 (例: 横スクロール表
 * `.table-wrap{overflow-x:auto}`) でも切れないよう、バルーンは語の
 * **下** に出す (001/002 は上出しだが overflow 祖先が無いため問題ない。
 * 共通実装は表ヘッダー等でも安全な下出しを既定とする)。
 *
 * 使い方:
 *   import { termTip, TERM_TIP_STYLES } from "../../../../src/shared/term-tip.js";
 *   // <style> に ${TERM_TIP_STYLES} を 1 度だけ差し込む
 *   `<th>${termTip("CAGR", "年平均成長率。複数年の伸びを1年あたり…")}</th>`
 */

/** 最小 HTML エスケープ (属性・本文兼用) */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 用語 + バルーンヘルプを生成する。
 * @param label 画面に出る用語 (これ自体がトリガ。点線下線が付く)
 * @param text  初心者向けの平易な解説。空なら下線なしの素のラベルを返す
 * @param align 既定は中央寄せ。表の **右端付近の列** は "right" を指定して
 *              バルーンを右端に寄せ、画面外へのはみ出しを防ぐ
 */
export function termTip(
  label: string,
  text: string,
  align: "center" | "right" = "center"
): string {
  if (!text) return esc(label);
  const cls = align === "right" ? "tip tip-r" : "tip";
  return `<span class="${cls}" tabindex="0" role="note" aria-label="${esc(label)}: ${esc(text)}">${esc(label)}<span class="tip-text" role="tooltip">${esc(text)}</span></span>`;
}

/**
 * 共通 CSS。ページの <style> に 1 度だけ差し込む。配色・角丸・影は
 * Editorial Swiss Grid トークンを使用 (グロー/ソフトシャドウ無し)。
 */
export const TERM_TIP_STYLES = `
.tip{position:relative;display:inline-block;cursor:help;border-bottom:2px dotted var(--text-secondary);font-weight:600}
.tip .tip-text{visibility:hidden;opacity:0;position:absolute;z-index:50;top:calc(100% + 10px);left:50%;transform:translateX(-50%);width:max-content;max-width:min(300px,calc(100vw - 32px));background:var(--bg-invert);color:var(--text-invert);font-size:13px;font-weight:400;line-height:1.65;letter-spacing:0;text-transform:none;text-align:left;white-space:normal;word-break:break-word;padding:13px 15px;border:2px solid var(--border);border-radius:var(--radius);box-shadow:5px 5px 0 0 var(--border);transition:opacity .15s ease-out;pointer-events:none;font-family:var(--font-body,inherit)}
.tip .tip-text::after{content:'';position:absolute;bottom:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-bottom-color:var(--bg-invert)}
/* 右端付近の列: バルーンを右寄せして画面外はみ出しを防ぐ */
.tip.tip-r .tip-text{left:auto;right:0;transform:none;max-width:min(300px,calc(100vw - 32px))}
.tip.tip-r .tip-text::after{left:auto;right:22px;transform:none}
.tip:hover .tip-text,.tip:focus .tip-text,.tip:focus-within .tip-text,.tip:active .tip-text{visibility:visible;opacity:1}
/* ヘッダー内は組版を継承しつつ、点線は高齢層が気付ける濃さを保つ */
th .tip,thead .tip{font-weight:inherit;border-bottom-color:var(--text-secondary)}
@media(max-width:600px){.tip .tip-text,.tip.tip-r .tip-text{left:0;right:auto;transform:none;font-size:13px;max-width:min(280px,calc(100vw - 32px))}.tip .tip-text::after,.tip.tip-r .tip-text::after{left:22px;right:auto;transform:none}}
`;
