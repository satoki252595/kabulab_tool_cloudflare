/**
 * 事業タグ判定の前処理: 正規化・文分割・段落分割。
 * 設計: docs/005-yuho-quant-business-tags.md §5.3。
 *
 * ここでの分割・正規化は「絞り込み(prefilter)のための下ごしらえ」であり、
 * 引用として保存する文は常に**原文**から切り出す(オフセットは原文の位置を保つ)。
 */

/** 文分割の結果 1 件。text は原文の [start, end) をそのまま切り出したもの。 */
export interface Sentence {
  index: number;
  start: number;
  end: number;
  text: string;
}

/**
 * 長音・ハイフン・ダッシュ類として揺れうる文字。
 * NFKC 正規化後もこれらは正規化されずに残るため、ここで個別に統一する。
 * (半角カタカナ長音「ｰ」は NFKC で「ー」に既に変換されるが、念のため含めておく)
 */
const DASH_LIKE_CHARS = new Set([
  "ｰ",
  "ー",
  "―",
  "‐",
  "‑",
  "–",
  "—",
  "−",
  "─",
  "〜",
  "~",
]);

/** 片仮名(拡張含む)。長音・ダッシュの前後がこの範囲なら「長音」文脈と判定する。 */
const KATAKANA_RE = /[゠-ヿㇰ-ㇿ]/;

/**
 * 商標・サービスマーク記号 (™ ℠)。NFKC で "TM"/"SM" という ASCII 文字列に
 * 展開されるため、NFKC の前に取り除く。取り除かないと「ABF™」のような表記が
 * "abftm" になり、"ABF" というキーワードの直後に ASCII 文字 (t) が続くと
 * 誤認識されて ASCII 境界規則で弾かれてしまう (実データ: 有報の商標付き固有名詞
 * 「ABF™」「RiboART System®」等は頻出。® © は NFKC で展開されないため対象外)。
 * 記号そのものに語としての意味は無いため、除去してもキーワード照合上の
 * 意味は変わらない (原文からの引用切り出しは splitSentences が原文をそのまま
 * 使うため、この除去の影響を受けない)。
 */
const TRADEMARK_SYMBOL_RE = /[™℠]/g;

/**
 * キーワード照合用の正規化。
 *
 * - 商標・サービスマーク記号 (™℠) の除去 (NFKC 展開による誤境界化を防ぐ)
 * - NFKC (全角英数・半角カナ等の表記ゆれを吸収)
 * - 長音・ハイフン・ダッシュ類は、前後どちらかが片仮名なら長音記号「ー」に、
 *   そうでなければハイフン「-」に統一する
 * - 空白 (半角・全角) の連続は 1 個の半角空白に畳み込む
 * - ASCII 英大文字のみ小文字化 (CJK には大小文字の区別が無いため対象外)
 */
export function normalizeForMatch(s: string): string {
  const nfkc = s.replace(TRADEMARK_SYMBOL_RE, "").normalize("NFKC");
  let out = "";
  for (let i = 0; i < nfkc.length; i++) {
    const ch = nfkc[i];
    if (DASH_LIKE_CHARS.has(ch)) {
      const prev = out.length > 0 ? out[out.length - 1] : "";
      const next = i + 1 < nfkc.length ? nfkc[i + 1] : "";
      out += KATAKANA_RE.test(prev) || KATAKANA_RE.test(next) ? "ー" : "-";
    } else {
      out += ch;
    }
  }
  return out
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** ASCII 英数字 (正規化後なので小文字のみ) */
const ASCII_ALNUM_RE = /[a-z0-9]/;
/** 片仮名の並びだけで出来た語 (長音「ー」を含む) */
const KATAKANA_ONLY_RE = /^[゠-ヿ]+$/;
/** これ以下の長さの片仮名語は、前後が片仮名なら別の語の一部とみなす */
const SHORT_KATAKANA_MAX = 4;

/**
 * 正規化済みの文 `sentence` に、正規化済みのキーワード `keyword` が「語として」
 * 現れるかを判定する (単語帳 v1 はこの規則で実データ 338 社に対して調整した)。
 *
 * 単純な部分一致だと、短い英字や片仮名が別の語の一部に当たる
 * (実測: 「ec」が英単語の途中に、「ソース」が「リソース」に、「リース」が
 * 「リリース」に当たる)。そこで次の境界を要求する:
 * - キーワードの先頭/末尾が ASCII 英数字なら、その外側の文字は英数字でない
 * - 片仮名だけの 4 字以下のキーワードは、前後が片仮名 (長音を含む) でない
 * 漢字は日本語の複合語で切れ目が無いため境界を見ない。
 */
export function matchesKeyword(sentence: string, keyword: string): boolean {
  if (keyword.length === 0) {
    throw new Error("matchesKeyword: 空のキーワード (単語帳の検査漏れ)");
  }
  const firstIsAscii = ASCII_ALNUM_RE.test(keyword[0]);
  const lastIsAscii = ASCII_ALNUM_RE.test(keyword[keyword.length - 1]);
  const shortKatakana = keyword.length <= SHORT_KATAKANA_MAX && KATAKANA_ONLY_RE.test(keyword);
  let from = 0;
  for (;;) {
    const i = sentence.indexOf(keyword, from);
    if (i < 0) return false;
    const before = i > 0 ? sentence[i - 1] : "";
    const after = i + keyword.length < sentence.length ? sentence[i + keyword.length] : "";
    const asciiOk =
      !(firstIsAscii && before !== "" && ASCII_ALNUM_RE.test(before)) &&
      !(lastIsAscii && after !== "" && ASCII_ALNUM_RE.test(after));
    const katakanaOk =
      !shortKatakana ||
      !((before !== "" && KATAKANA_RE.test(before)) || (after !== "" && KATAKANA_RE.test(after)));
    if (asciiOk && katakanaOk) return true;
    from = i + 1;
  }
}

const SENTENCE_END_RE = /[。！？!?]/;

/**
 * 箇条書きの先頭記号 (・ ● ■ / 半角・全角括弧付き数字 / 丸数字①〜⑳)。
 * マッチ長を返す (括弧付き数字は 3〜5 文字になりうるため)。
 */
const BULLET_HEAD_RE = /^(?:[・●■]|[(（][0-90-9]{1,3}[)）]|[①-⑳])/;
const WHITESPACE_RE = /[\s\u3000]/;

/**
 * 位置 i が「箇条書きの先頭」として扱えるかどうか。
 *
 * 「・」は「トラック・バス」のような並列の中点としても頻出するため、
 * 直前が空白(または文頭)のときだけ箇条書きの区切りとして扱う
 * (実データ調査: 有報の flatten 済みテキストは改行が失われ 1 行になっているため、
 * 空白の有無が「先頭かどうか」の実質的な手がかりになる)。
 */
function isBulletStart(text: string, i: number): boolean {
  if (!BULLET_HEAD_RE.test(text.slice(i, i + 5))) return false;
  return i === 0 || WHITESPACE_RE.test(text[i - 1]);
}

function trimmedRange(text: string, start: number, end: number): { start: number; end: number } | null {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  return { start: start + leading, end: end - trailing };
}

/**
 * 文に分ける。
 *
 * 区切り: 。！？!? の直後 / 改行 / 箇条書きの先頭 (・ ● ■ / (1)… / ①… )。
 * 空文は捨てる。オフセットは原文の位置。
 */
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const push = (start: number, end: number) => {
    const range = trimmedRange(text, start, end);
    if (range === null) return;
    sentences.push({
      index: sentences.length,
      start: range.start,
      end: range.end,
      text: text.slice(range.start, range.end),
    });
  };

  let start = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      push(start, i);
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      start = i;
      continue;
    }
    if (SENTENCE_END_RE.test(ch)) {
      let j = i + 1;
      while (j < n && SENTENCE_END_RE.test(text[j])) j++;
      push(start, j);
      i = j;
      start = i;
      continue;
    }
    if (isBulletStart(text, i) && text.slice(start, i).trim().length > 0) {
      push(start, i);
      start = i;
    }
    i++;
  }
  push(start, n);
  return sentences;
}

/**
 * 段落に分ける。
 *
 * 改行があればそれで区切る。EDINET のテキストブロックはテキスト化の過程で
 * 改行が失われ 1 行になっていることが大半のため、改行が 1 つも無い場合は
 * 文単位でグループ化し、400 字を超えないところで新しい段落にする
 * (これはデータの欠損を埋めるフォールバックではなく、「段落」という概念が
 * 元々存在しない原文に対する分割ルールそのもの)。
 */
export function splitParagraphs(text: string): Array<{ start: number; end: number; text: string }> {
  if (/\r\n|\r|\n/.test(text)) {
    const paragraphs: Array<{ start: number; end: number; text: string }> = [];
    const re = /\r\n|\r|\n/g;
    let start = 0;
    let m: RegExpExecArray | null;
    const push = (s: number, e: number) => {
      const range = trimmedRange(text, s, e);
      if (range === null) return;
      paragraphs.push({ start: range.start, end: range.end, text: text.slice(range.start, range.end) });
    };
    while ((m = re.exec(text))) {
      push(start, m.index);
      start = m.index + m[0].length;
    }
    push(start, text.length);
    return paragraphs;
  }

  const sentences = splitSentences(text);
  const groups: Array<{ start: number; end: number; text: string }> = [];
  let groupStart: number | null = null;
  let groupEnd = 0;
  for (const sentence of sentences) {
    if (groupStart === null) {
      groupStart = sentence.start;
      groupEnd = sentence.end;
      continue;
    }
    if (sentence.end - groupStart <= 400) {
      groupEnd = sentence.end;
    } else {
      groups.push({ start: groupStart, end: groupEnd, text: text.slice(groupStart, groupEnd) });
      groupStart = sentence.start;
      groupEnd = sentence.end;
    }
  }
  if (groupStart !== null) {
    groups.push({ start: groupStart, end: groupEnd, text: text.slice(groupStart, groupEnd) });
  }
  return groups;
}
