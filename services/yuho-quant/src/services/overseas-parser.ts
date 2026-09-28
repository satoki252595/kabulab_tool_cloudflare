/**
 * 有価証券報告書から「海外売上高（地域別売上高）」を構造化する決定論的パーサ。
 *
 * 実データ調査 (tmp/probe-overseas.ts, EDINET 実有報) の結果、海外（地域別）
 * 売上の開示は概ね次の系統に集約される。どれにも確信を持って当てはまらない
 * 表は **でっち上げず** status で明示する (CLAUDE.md ルール1/2)。
 *
 *  GEO_ROWS — 地域=行 (現行・新収益認識基準の主流):
 *    「主たる地域市場」「地域ごとの情報」「地域別」見出しの下に、行ラベルが
 *    地域 (日本/本邦・アジア・北米・欧州・中国・その他…) の表。値列は
 *      - 合計列 (報告セグメント×地域 マトリクスの「合計/連結財務諸表計上額」)
 *      - 当期列 (前期/当期の2年表)
 *      - 単一数値列
 *    のいずれか。総額は「外部顧客への売上高/顧客との契約から生じる収益/合計」
 *    行。例: S100W16I, S100W0UT, S100W179。
 *
 *  GEO_COLS — 地域=列:
 *    ヘッダに地域 (日本/本邦 + 海外地域) が並び、「外部顧客への売上高(or 営業
 *    収益/合計)」行が地域別の値、「連結/合計」列が総額。例: S100W20H(任天堂),
 *    S100Y8NY(トヨタ・営業収益建て), S100W1Q5。
 *
 * いずれも **海外売上高 = 開示された海外地域行(列)の合計**、比率 = 海外売上高 /
 * 連結売上高。地域別内訳は副次情報 (詳細表示用)。
 *
 * 注: 旧基準の「海外売上高」注記 (海外地域別 [金額,割合%]) は新収益認識基準への
 * 移行で現行有報からはほぼ消滅しており (調査した実有報 280 件で 0 件)、実 fixture
 * で固定できないため本パーサは対象外とする (ルール: fixture 無しの推測実装はしない)。
 *
 * 正しい列/行を選べたかは「地域行の合計 ≈ 開示された集計行」で検証し、
 * 一致しなければ却下する (誤読を数値化しない = ルール1/2)。「うち、米国」等の
 * 内訳行や「その他の収益」は地域に含めない (二重計上・非地域分の混入を避ける)。
 *
 * EDINET 由来の汎用ユーティリティ (ZIP 展開・HTML テーブル化・数値正規化) は
 * 受注パーサ (order-parser) と同じ `./edinet/*` を共用する。本ファイルは海外
 * 売上高 固有の構造化のみを担い、受注と同じ有報 1 通から並行して構造化される。
 */
import { unzip } from "./edinet/zip.js";
import {
  tableToGridExpanded,
  parseJpNumber,
  unitToYenFactor,
} from "./edinet/html-table.js";

export type RegionKind = "domestic" | "overseas" | "overseas_total" | "total";

export interface OverseasFact {
  /** 表記そのままの地域名 (例: "本邦", "アジア", "北米", "海外売上高合計", "連結売上高") */
  regionName: string;
  regionKind: RegionKind;
  /** 売上高 (表の単位のまま。欠損は null = 0 で埋めない) */
  salesAmount: number | null;
  /** 連結売上高に占める割合 (%)。開示があるときのみ。無ければ null */
  ratioPct: number | null;
  /** 金額単位ラベル (例: "百万円") */
  unitLabel: string;
  /** 単位 → 円 への倍率 */
  unitYenFactor: number;
  /** この行が属する会計期末 YYYY-MM-DD */
  fiscalYearEnd: string;
  /** 連結=true / 個別=false / 判定不能=null (推測しない) */
  isConsolidated: boolean | null;
}

export type OverseasParseStatus =
  | "ok_geo_rows"
  | "ok_geo_cols"
  | "geo_present_unstructured"
  | "no_overseas_table";

/**
 * 照合の証明 (DB 保存対象外)。消去・調整を加えた地域合計と開示総額の照合に
 * 使った調整額・丸め方式・和区間/総額区間の基数を保存前検証へ運ぶ
 * (7203 Toyota 型: 地域合計は消去前のため調整なしでは総額を上回る。
 * 検証側で推測させない)。3 reducer と保存検証は同一の区間照合を使う。
 */
export interface OverseasProof {
  reconciliationAdjustment: number;
  mode: RoundingMode;
  /** 和区間 (= 地域印刷セル + 調整脚の区間の和。parse 側で確定)。 */
  sumLo: number;
  sumHi: number;
  /** 総額セルの区間。total 欠損 (9147 系) は null。 */
  totalLo: number | null;
  totalHi: number | null;
}

export interface OverseasExtraction {
  status: OverseasParseStatus;
  facts: OverseasFact[];
  honbunFile: string | null;
  tablesScanned: number;
  proof?: OverseasProof;
}

/** 1表の構造化結果。facts と照合の証明を対で返す */
interface ParsedTable {
  facts: OverseasFact[];
  proof: OverseasProof;
  /**
   * 値列/値行の見出しテキスト (期首確定鎖の第1段)。rows は pick した値列の
   * colHeader、cols は値行の行テキスト。LVA5 級の2期比較表は表外表題が
   * stale (交互節表題の直前=前期) でも値列頭の当連結@pe で T 確定する。
   */
  valueAxisHeader?: string;
}

/**
 * 海外（地域別）売上 開示の有無を判定する語 (CSV 事前判定・本文選択で共用)。
 * これは「重い XBRL を落とすか / どの本文を見るか」のゲートに過ぎず、実際の
 * 構造化は後段の厳密分類で確信が持てた表だけ行う (ルール1/2)。
 */
export const RX_OVERSEAS_KEYWORD =
  /海外売上高|海外売上収益|海外への売上|地域ごとの情報|主たる地域市場|所在地別|仕向地別|地域別.{0,4}(売上|収益|情報)|国又は地域|本邦/;

/** 海外地域 (本邦/日本 以外) を表す語 */
const RX_OVERSEAS_REGION =
  /北米|南米|中南米|北中米|中米|米州|米大陸|アメリカ大陸|米国|アメリカ|欧州|ヨーロッパ|欧米|アジア|オセアニア|大洋州|アフリカ|中近東|中東|中国|中華圏|香港|韓国|台湾|タイ|ベトナム|インド|インドネシア|シンガポール|フィリピン|マレーシア|アセアン|モンゴル|スイス|EMEA|ドイツ|英国|フランス|イタリア|スペイン|オランダ|メキシコ|ブラジル|カナダ|豪州|オーストラリア|海外/;
/** 国内を表す語 (これに完全一致する行/列が domestic) */
const RX_DOMESTIC = /^(日本|本邦|国内|日本国内|わが国|我が国)$/;
/** 集計行/列 (地域ではない)。営業収益建て(トヨタ等の地域別営業概況)も含む */
const RX_AGGREGATE =
  /^(外部顧客への売上高|外部顧客に対する売上高|外部顧客への売上収益|外部顧客に対する売上収益|外部顧客への営業収益|外部顧客に対する営業収益|顧客との契約から生じる収益|売上高合計|売上収益合計|営業収益合計|連結収益合計|営業収益|合計|総合計|総計|計|連結|連結売上高|連結計|連結財務諸表計上額)$/;
/** 「その他」系 (地域ブロック内なら overseas, 収益/事業文脈なら除外) */
const RX_OTHER_REGIONISH = /^(その他|その他の地域|その他地域|その他海外|外国|諸外国|直接輸出|輸出)$/;
/**
 * 総額列の見出し (連結/合計/計)。S100FHUH で実証: 当連結の報告セグメント表は
 * 連結列が「連結損益計算書 計上額」、小計列が「計」で、旧正規表現
 * (連結財務諸表計上額|^連結$|^合計$|連結計上額) はどちらにも一致せず
 * aggregates が空 → total が regionSum に後退し、調整額 +27 を抱えて
 * total < adjustedSum − bound で当期表を誤殺、前期表に後退していた。
 * 「連結…計上額」(中間8字まで) と bare-計を拾う。後段の照合が証明する。
 */
const RX_TOTAL_COL = /連結.{0,8}計上額|^連結$|^合計$|連結計上額|^計$/;
/**
 * 実績系の表題語。見出し window (表直前400字→末尾160字) は表題そのものではなく
 * 前表の説明文を含み得るため、単純な含有ではなく **最寄り (最後) の表題語** で
 * 判定する (例: 「生産実績と同様、販売実績は…」と書かれた販売表を誤って落とさない)。
 */
const RX_RESULT_CAPTION = /(生産実績|販売実績|受注実績)/g;
/**
 * 生産実績表か (生産高は売上高ではないので候補にしない)。S100OE0P 等 (5013) で
 * 実証: セグメント別の生産実績表と販売実績表が同点で並び、文書順のタイブレークで
 * 生産実績表が勝って生産高を海外売上高として誤採用していた。最寄り表題語が
 * 生産実績のときだけ落とし、「生産、受注及び販売の状況」のような節見出し
 * (実績つき表題語なし) や販売実績表には発火しない。
 */
function isProductionTable(heading: string): boolean {
  let last: string | null = null;
  for (const m of heading.matchAll(RX_RESULT_CAPTION)) last = m[1];
  return last === "生産実績";
}
/**
 * 非売上 metric の表か (非流動資産・減損損失の地域別表は売上高ではないので候補に
 * しない)。S100G2DL 等で実証:「(5) 非流動資産(…)の地域別情報」表 (日本
 * 1847464/その他 144889/合計 1992354) は算術整合するため検証を通り抜け、約2兆円
 * の資産額が連結売上高として保存されていた (dup なし・#150 不発・検証も不発)。
 * S100J2FF/S100L227/S100VYQN では減損損失表 (場所×減損損失) が同様に誤採用。
 * B2 と同じ最寄り (最後) の metric 名詞で判定する (例: 「売上収益及び非流動資産
 * の地域別内訳…①外部顧客からの売上収益」と書かれた売上表を誤って落とさない。
 * S100AJAN で固定)。「記載を省略」文中の名詞は不開示であり後続の表を指さない
 * ので除外して判定する (S100QHOQ: 省略宣言の後の当期売上表を誤殺しない)。
 * 該当名詞が窓内になければ abstain (現状維持)。
 */
const RX_METRIC_NOUN =
  /(売上高|売上収益|販売高|営業収益|外部顧客からの収益|収益|非流動資産|減損損失|有形固定資産|無形資産)/g;
/** 省略宣言文 (中の metric 名詞は不開示であり後続の表を指さない) */
const RX_OMISSION_CLAUSE = /[^。]*(記載|開示)を省略[^。]*(。|$)/g;
function isNonSalesMetricTable(heading: string): boolean {
  const affirmed = heading.replace(RX_OMISSION_CLAUSE, " ");
  let last: string | null = null;
  let lastIdx = -1;
  for (const m of affirmed.matchAll(RX_METRIC_NOUN)) {
    last = m[1];
    lastIdx = m.index ?? -1;
  }
  const isClassicAsset = last === "非流動資産" || last === "減損損失";
  const isTangibleAsset = last === "有形固定資産" || last === "無形資産";
  if (!isClassicAsset && !isTangibleAsset) return false;
  // 有形固定資産/無形資産は地域別資産表の表題 (S100DCF4/S100W3QI/S100AM9X) と
  // セグメント注の調整額 prose (「有形固定資産及び無形固定資産の増加額には…」)
  // の両方に出る。prose は次表 (当期の売上表) の窓に必ず紛れ込むため、表題
  // パターン (近傍に地域別/所在地別/内訳/残高/帳簿価額、かつ増加額/調整額/
  // 償却/含んでを含まない) のときだけ落とす (S100QG12/S100RS6X の売上表を誤殺
  // しない。S100W20H の joint 表題「売上高ならびに有形固定資産」も近傍に
  // 地域別がないため abstain)。
  if (isTangibleAsset) {
    // 表題尾は資産名詞の後ろに伸びる (…無形資産の帳簿価額の地域別内訳) ので
    // 後方窓を広げる。前方の所在地別の…にも対応。前後いずれかに footnote 語
    // (増加額/調整額/償却/含んで) があれば prose として abstain する。
    const near = affirmed.slice(Math.max(0, lastIdx - 12), lastIdx + 40);
    if (!/(地域別|所在地別|内訳|残高|帳簿価額)/.test(near)) return false;
    if (/(増加額|調整額|償却|含んで)/.test(near)) return false;
    return true;
  }
  // 売上+資産の joint 表題 (「売上収益及び非流動資産」) は後続表が売上部・
  // 資産部のどちらか表題から決められない → abstain して表の内容に決めさせる。
  // 売上名詞と資産名詞の間が短い接続句 (ならびに/及び/及び) のときだけ
  // abstain し、凡例を挟んだ別表題は落とす。
  const RX_SALES = /売上高|売上収益|販売高|営業収益|外部顧客からの収益|収益/g;
  let salesIdx = -1;
  for (const m of affirmed.matchAll(RX_SALES)) salesIdx = m.index ?? -1;
  if (salesIdx >= 0 && salesIdx < lastIdx) {
    const between = affirmed.slice(salesIdx, lastIdx).replace(/[\s\u3000]/g, "");
    if (
      between.length <= 24 &&
      /(ならびに|並びに|及び|及び)/.test(between)
    ) {
      return false;
    }
  }
  return true;
}
/**
 * 受注・繰越 (手持ち工事) の表か。繰越工事高・受注高は売上高ではなく手持ち
 * 残高なので候補にしない (S100TP3I: 繰越工事高の国内/海外/計表が ^計$ 総額列
 * で算術整合し、受注残高 2,198,120 を連結売上高として誤採用していた)。
 * B2 と同じ最寄り (最後) の表題語で判定する (「受注及び販売の状況」の節見出し
 * の下の販売実績表は落とさない。販売/売上/収益の表題語が後ろにあれば不発)。
 */
const RX_BACKLOG_CAPTION = /(繰越工事高|繰越高|繰越受注高|受注高|受注残高|手持工事高|販売実績|売上高|売上収益|営業収益|収益)/g;
function isBacklogTable(heading: string): boolean {
  let last: string | null = null;
  for (const m of heading.matchAll(RX_BACKLOG_CAPTION)) last = m[1];
  return (
    last === "繰越工事高" ||
    last === "繰越高" ||
    last === "繰越受注高" ||
    last === "受注高" ||
    last === "受注残高" ||
    last === "手持工事高"
  );
}

function norm(s: string): string {
  return s.replace(/[\s\u3000]/g, "");
}

/** 全角数字 ０-９ を半角へ */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0)
  );
}

/** 全角ラテン Ａ-Ｚａ-ｚ を半角へ (Ｓ100ＡＫＥＥ ＥＭＥＡ対策) */
function toHalfWidthLatin(s: string): string {
  return s.replace(/[Ａ-Ｚａ-ｚ]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - 0xfee0)
  );
}

/** ラベル比較用の正規化: 全角数字・ラテン→半角、全角括弧→半角 */
function normLabelWidth(s: string): string {
  return toHalfWidthLatin(toHalfWidthDigits(s)).replace(/[（）]/g, (d) =>
    d === "（" ? "(" : ")"
  );
}

function detectUnitOrNull(
  text: string
): { label: string; factor: number } | null {
  for (const u of ["百万円", "千円", "億円", "円"]) {
    if (text.includes(u)) return { label: u, factor: unitToYenFactor(u) };
  }
  return null;
}

function detectConsolidated(headerText: string): boolean | null {
  if (/連結/.test(headerText)) return true;
  if (/事業年度/.test(headerText) && !/連結/.test(headerText)) return false;
  return null;
}

/** 末尾の単位括弧 ((百万円) 等) と注番号を除いた表示用ラベル */
function cleanLabel(name: string): string {
  // 先に幅正規化: 全角注番号「（注）１」(S100ACAR) が半角専用の注除去を
  // 素通りして「その他」列の分類を壊すのを防ぐ。末尾 ※類 (脚注参照) も落とす。
  const w = normLabelWidth(name);
  return w
    .replace(/[\s\u3000※＊*☆★]+\s*$/u, "")
    .replace(/[（(](?:単位[:：]?)?(?:百万円|千円|億円|円)[)）]?\s*$/u, "")
    .replace(/[(]注[)0-9]*\s*$/u, "")
    .replace(/[\s\u3000]+/g, "")
    .trim();
}

type RegionRole = "domestic" | "overseas" | "aggregate" | "other";

function classifyRegion(rawLabel: string): RegionRole {
  const s = cleanLabel(rawLabel);
  if (s === "") return "other";
  // 「(南北アメリカの)うち、米国」等の内訳行は親地域の一部 = 二重計上回避で除外
  if (/うち/.test(s)) return "other";
  if (RX_DOMESTIC.test(s)) return "domestic";
  // 「その他の収益」等は集計でも地域でもない → other (除外)
  if (/^その他の収益$/.test(s)) return "other";
  // 契約小計は接尾辞・動詞つきが多い (を分解した情報/収益合計/注/引用+
  // 会計基準名/認識した・された/売上収益/主な・経常。S100OJ6E/S100TRBB/
  // S100TSSV)。含有で集計扱いする。うち内訳は上の除外が先に勝つ。
  if (
    /顧客との契約から(の)?(生じ[るた]|認識した|認識された)?(主な|経常)?(収益|売上収益)/.test(
      s
    )
  )
    return "aggregate";
  if (RX_AGGREGATE.test(s)) return "aggregate";
  if (RX_OTHER_REGIONISH.test(s)) return "overseas"; // 暫定。ブロック検証で確定
  if (RX_OVERSEAS_REGION.test(s)) return "overseas";
  return "other";
}

/**
 * 表示丸めの方式。資料の端数注記 (provenanceつき) でのみ確定し、注記なし・
 * 矛盾注記は "unknown" (Gate3)。unknown は実 quantum が支持し得る方式
 * (切捨/四捨五入) の区間を包摂し、任意の追加誤差は足さない。
 */
export type RoundingMode = "truncate" | "round" | "unknown";

/** 印刷セル 1 個の値と quantum (表示単位での最小目盛 = 10^-小数桁数)。 */
export interface CellAmount {
  value: number;
  quantum: number;
}

/**
 * parseJpNumber と同一の受理/欠損判定で、値に加え quantum を返す sibling。
 * 共有の parseJpNumber (受注パスと共用) は触らない。小数セル ("12.5") は
 * quantum 0.1。整数セルは 1。
 */
export function parseJpNumberCell(raw: string): CellAmount | null {
  const value = parseJpNumber(raw);
  if (value === null) return null;
  const digits = raw
    .replace(/[\s\u3000]/g, "")
    .replace(/[△▲＋+−\-,，]/g, "");
  const m = /\.(\d+)$/.exec(digits);
  const decimals = m ? m[1].length : 0;
  return { value, quantum: 10 ** -decimals };
}

/**
 * 資料の端数注記から丸め方式を確定する (provenance = 一致箇所の原文)。
 * - 切捨: 「百万円未満を切り捨てて記載」系 (S100DDYF/S100NRWW の実文言。
 *   「100株未満は切り捨て」の株数注記は金額単位を要求して除外)。
 * - 四捨五入: 同形の標準文言。
 * - 両方検出 (要約/連結で方式が違う等)・検出なし → unknown。
 */
export function detectRoundingMode(text: string): {
  mode: RoundingMode;
  provenance: string | null;
} {
  const trunc = /(百万円|千円|億円|円)未満.{0,12}(切り捨て|切捨)/.exec(text);
  const round = /(百万円|千円|億円|円)未満.{0,12}四捨五入/.exec(text);
  if (trunc && round) return { mode: "unknown", provenance: null };
  if (trunc) return { mode: "truncate", provenance: trunc[0].slice(0, 60) };
  if (round) return { mode: "round", provenance: round[0].slice(0, 60) };
  return { mode: "unknown", provenance: null };
}

/** 区間演算の浮動小数許容 (小数 quantum の 0.1 系誤差のみ吸収する微小値)。 */
const INTERVAL_EPS = 1e-9;

/**
 * 印刷セル 1 個の真値区間 (表示単位・閉区間)。切捨は magnitude 側へ片寄り
 * (負セルは [v-q, v])、四捨五入は対称、unknown は両方式の和包摂。
 */
export function cellInterval(
  value: number,
  quantum: number,
  mode: RoundingMode
): [number, number] {
  if (mode === "round") return [value - quantum / 2, value + quantum / 2];
  if (mode === "truncate") {
    return value >= 0
      ? [value, value + quantum]
      : [value - quantum, value];
  }
  return value >= 0
    ? [value - quantum / 2, value + quantum]
    : [value - quantum, value + quantum / 2];
}

/** 和の区間 = 区間の和 (線形性。各印刷セルを exactly once だけ入れること)。 */
export function sumInterval(
  cells: readonly CellAmount[],
  mode: RoundingMode
): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const c of cells) {
    const [clo, chi] = cellInterval(c.value, c.quantum, mode);
    lo += clo;
    hi += chi;
  }
  return [lo, hi];
}

export function intervalsOverlap(
  a: readonly [number, number],
  b: readonly [number, number]
): boolean {
  return a[0] <= b[1] + INTERVAL_EPS && b[0] <= a[1] + INTERVAL_EPS;
}

/**
 * 地域行の合計と開示総額の整合チェック (Gate3)。印刷セルの区間の和と開示
 * 総額セルの区間が重なるときだけ一致とみなす。純計算中間値 (regionSum 等)
 * 自体に quantum は付けない — 区間は印刷セルからのみ組み立てる
 * (二重算入なし)。親採用時は親セル自身の区間だけを入れ、子は leaf→subtotal
 * の別照合でのみ使い再加算しない。
 * 保存パスの片側検査はこの重なりに置換される: 開示総額は非地域収益を含む
 * 得るため、総額セル区間が和区間を上回る側は開いたまま (橋渡し別途)、
 * 和区間が総額セル区間を上回る側は丸め物理で閉じる。
 */
export function cellsConsistent(
  sumCells: readonly CellAmount[],
  totalCell: CellAmount,
  mode: RoundingMode
): boolean {
  if (totalCell.value <= 0) return false;
  return intervalsOverlap(
    sumInterval(sumCells, mode),
    cellInterval(totalCell.value, totalCell.quantum, mode)
  );
}

/** 製品/用途・非売上 metric の section 標識 (この section の行は売上 block ではない) */
const RX_NON_SALES_SECTION = /営業利益|用途別|財又はサービス|製品ライン/;
/** 小計行 (block 終端。小計は全体集計ではないので集計検証には使わない) */
const RX_SHOKEI = /小計/;
/** 消去/調整行 (地域計に加算して block 合計と照合する) */
const RX_ELIMINATION = /消去|調整額/;
/** 収益認識 triplet の非地域脚 (契約小計→外部顧客総額の橋渡し。開示値のみ加算) */
const RX_OTHER_REVENUE =
  /^(その他の収益|その他収益|その他の源泉から認識した収益|その他の契約から認識した収益)$/;
/** セグメント注記の非地域列 (事業単位。地理が定まらないため fact 化しない) */
const RX_BUSINESS_COL = /事業|サービス/;
/** 非地域列から除く (計時内訳・metric 列は加算すると二重計上になる) */
const RX_NONGEO_EXCL =
  /財又はサービス|一時点|一定の期間|売上|収益|利益|損失|資産|負債|費用|償却|減損|のれん|引当|税|配当/;
/** 小計・総額列 (葉ではなく和。葉数え・非地域加算の対象外) */
const RX_AGG_COL =
  /小計|合計|総計|累計|中計|セグメント計(?![一-龯々〆〤ぁ-んァ-ヶ])|部門計(?![一-龯々〆〤ぁ-んァ-ヶ])|計[（(]|計$|^計(?![一-龯々〆〤ぁ-んァ-ヶ])|連結|外部顧客/;
/** 全社・本社共通 (地理不明の会社共通分。照合のみに使い fact 化しない) */
const RX_COMPANY_COMMON = /全社|本社/;
/** 会社総額スコープの集計 (地域小計と区別する。S100YCID) */
function isCompanyAggLabel(label: string): boolean {
  return /連結|外部顧客/.test(label);
}
/** 地域×項目 対の metric 区分 (売上高行だけ読む。利益行は混ぜない) */
const RX_SALES_METRIC = /売上高|売上収益|営業収益/;
const RX_PROFIT_METRIC = /営業利益|事業利益/;

type MetricKind = "sales" | "profit" | null;

/** col1 の metric 区分。売上高系/営業利益系のどちらでもなければ null */
function metricOf(sub: string): MetricKind {
  const n = norm(sub);
  if (RX_SALES_METRIC.test(n)) return "sales";
  if (RX_PROFIT_METRIC.test(n)) return "profit";
  return null;
}

/**
 * section 見出し行か。col0 が地域でも集計でもなく、行全体に数値が無い行。
 * 例: 売上高 / 営業利益・損失(△) / 主たる地域市場 / 用途別の販売。
 */
function sectionLabelOf(row: string[]): string | null {
  if (classifyRegion(row[0] ?? "") !== "other") return null;
  const name = cleanLabel(row[0] ?? "");
  if (name === "") return null;
  if (row.some((c) => parseJpNumber(c) !== null)) return null;
  return name;
}

/**
 * 同一表から同一地域名が複数値で出ていないか。全取込経路 (ingest.ts /
 * backfill-overseas.ts / backfill-missing-docs.ts) は (会計期末, 地域名) の
 * 先頭採用で重複を落とすため、重複があると集計が dedup 前の水増し合計で確定し、
 * 保存後に地域計≠合計の乖離を生む (aggregate-before-dedup。S100J2E7 で実証)。
 * 同一表内の重複地域名は 2 次元表 (地域×品目等) を単一値列で読んだ曖昧さの
 * 徴候であり、捏造補正も任意合算もせず表ごと却下する (ルール1/2)。
 */
function hasDuplicateRegionNames(facts: OverseasFact[]): boolean {
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.regionKind !== "domestic" && f.regionKind !== "overseas") continue;
    if (seen.has(f.regionName)) return true;
    seen.add(f.regionName);
  }
  return false;
}

interface Honbun {
  name: string;
  html: string;
}

function pickHonbunHtml(entries: Map<string, Buffer>): Honbun | null {
  const names = [...entries.keys()];
  const honbun = names.filter(
    (n) =>
      /PublicDoc\//i.test(n) &&
      /honbun/i.test(n) &&
      /jpcrp030000-asr/i.test(n) &&
      /\.html?$/i.test(n)
  );
  const pubHtml = names.filter(
    (n) => /PublicDoc\//i.test(n) && /\.html?$/i.test(n)
  );
  const list = honbun.length > 0 ? honbun : pubHtml;
  if (list.length === 0) return null;
  // 海外/地域 開示語を含む本文を優先
  for (const n of list) {
    const html = entries.get(n)!.toString("utf8");
    if (RX_OVERSEAS_KEYWORD.test(html)) return { name: n, html };
  }
  return { name: list[0], html: entries.get(list[0])!.toString("utf8") };
}

// ---------------------------------------------------------------------------
// 値列の選定 (地域=行 のとき)
// ---------------------------------------------------------------------------

interface ColPick {
  col: number;
  /** この値列が「総額(合計/連結)」を表すか (=地域行の値がセグメント横断合計) */
  isAggregateCol: boolean;
}

function buildColHeader(headerRows: string[][], width: number): string[] {
  const colHeader: string[] = [];
  for (let ci = 0; ci < width; ci++) {
    colHeader[ci] = norm(headerRows.map((r) => r[ci] ?? "").join(""));
  }
  return colHeader;
}

/**
 * 地域=行 の値列を決める。優先: 合計/連結列 → 当期列 → 単一数値列。
 * 確信が持てない (候補が複数/0) ときは null。
 */
function pickValueColForRows(
  colHeader: string[],
  dataRows: string[][],
  reportYear: number
): ColPick | null {
  const width = colHeader.length;
  const EXCL = /調整額?|セグメント間|内部売上|内部取引|消去|前年比|増減|構成比|割合|％|%/;

  // 1) 合計/連結 列
  const aggCols: number[] = [];
  for (let ci = 0; ci < width; ci++) {
    const h = colHeader[ci];
    if (EXCL.test(h)) continue;
    if (/合計$|^合計|連結.{0,8}計上額|^連結$|連結計上額/.test(h)) aggCols.push(ci);
  }
  if (aggCols.length === 1) return { col: aggCols[0], isAggregateCol: true };
  // 集計列が複数 (合計 + 連結計上額の併記) のときは会社スコープの連結列を
  // 優先する (S100OC7S: 合計 40,900 と連結損益計算書計上額 40,900 の併記で
  // 旧単一条件が不発 → 後段に落ちて値列なし却下になっていた。連結列は通常
  // 最右だが語で選ぶ。同語重複は従来どおり後段へ)。
  if (aggCols.length > 1) {
    const renketsu = aggCols.filter((ci) => /連結/.test(colHeader[ci]));
    if (renketsu.length === 1) return { col: renketsu[0], isAggregateCol: true };
    const goukei = aggCols.filter((ci) => /合計/.test(colHeader[ci]));
    if (goukei.length === 1) return { col: goukei[0], isAggregateCol: true };
  }

  // 2) 当期 (報告対象年) 列。前期列が併記される 2 年表向け。
  const curCols: number[] = [];
  for (let ci = 0; ci < width; ci++) {
    const h = toHalfWidthDigits(colHeader[ci]);
    if (EXCL.test(h)) continue;
    if (
      /当連結会計年度|当事業年度|当期|当中間/.test(h) ||
      new RegExp(`${reportYear}年`).test(h)
    ) {
      curCols.push(ci);
    }
  }
  if (curCols.length === 1) return { col: curCols[0], isAggregateCol: false };

  // 3) 単一数値列 (地域行に数値がある列が 1 本だけ)
  const regionRows = dataRows.filter(
    (r) => classifyRegion(r[0] ?? "") === "domestic" || classifyRegion(r[0] ?? "") === "overseas"
  );
  if (regionRows.length === 0) return null;
  const numericCols: number[] = [];
  for (let ci = 1; ci < width; ci++) {
    if (EXCL.test(colHeader[ci])) continue;
    const n = regionRows.filter((r) => parseJpNumber(r[ci] ?? "") !== null).length;
    if (n >= Math.max(2, Math.ceil(regionRows.length / 2))) numericCols.push(ci);
  }
  if (numericCols.length === 1) return { col: numericCols[0], isAggregateCol: false };
  return null;
}

// ---------------------------------------------------------------------------
// GEO_ROWS: 地域 = 行
// ---------------------------------------------------------------------------

function tryGeoRows(
  gridX: string[][],
  fiscalYearEnd: string,
  heading: string,
  mode: RoundingMode
): ParsedTable | null {
  const flat = gridX.map((r) => r.join("")).join("");
  // 単位は表外の見出し ((単位：百万円) 等) に書かれることが多い → heading も見る
  const unit = detectUnitOrNull(flat) ?? detectUnitOrNull(heading);
  if (!unit) return null;

  // section 分割: 非売上 section (製品/用途・営業利益) の行範囲を除外し、残りを
  // 売上 block 候補として読む。小計行が残れば block 合算 (B1) を試みる。
  const labelIdx: Array<{ idx: number; marked: boolean }> = [];
  gridX.forEach((row, idx) => {
    const label = sectionLabelOf(row);
    if (label !== null) {
      labelIdx.push({ idx, marked: RX_NON_SALES_SECTION.test(norm(label)) });
    }
  });
  const excluded = new Set<number>();
  labelIdx.forEach((l, li) => {
    if (!l.marked) return;
    const end = li + 1 < labelIdx.length ? labelIdx[li + 1].idx : gridX.length;
    for (let i = l.idx; i < end; i++) excluded.add(i);
  });

  // 行ラベルの地域分類 (除外範囲は other 扱い)
  const roles = gridX.map((r, i) =>
    excluded.has(i) ? "other" : classifyRegion(r[0] ?? "")
  );
  const hasDomestic = roles.includes("domestic");
  const overseasCount = roles.filter((x) => x === "overseas").length;
  if (!hasDomestic || overseasCount < 1) return null;

  // ヘッダ境界 = 最初に数値セルを持つ行。これより上が列見出し。
  // 「収益分解」表は (主要な財/サービス ブロック) + (主たる地域市場 ブロック) が
  // 同じ列見出し (報告セグメント + 合計) を共有して縦に積まれるため、最初の地域行
  // ではなく最初の数値行を境界にしないと、製品ブロックの数値が見出しを汚す。
  const firstNum = gridX.findIndex(
    (r) => r.slice(1).some((c) => parseJpNumber(c) !== null)
  );
  if (firstNum < 0) return null;
  const headerRows = gridX.slice(0, firstNum);
  const width = Math.max(...gridX.map((r) => r.length));
  const colHeader = buildColHeader(headerRows, width);
  const reportYear = Number(fiscalYearEnd.slice(0, 4));

  const pick = pickValueColForRows(colHeader, gridX.slice(firstNum), reportYear);
  if (!pick) return null;
  const vc = pick.col;

  // 集計行 (顧客との契約から生じる収益 / 外部顧客への売上高 / 合計 / 連結 / 計) を
  // すべて控える。地域行は「顧客との契約」水準で按分され、「外部顧客への売上高」
  // はそれに非地域分の『その他の収益』を足した広い総額になることがあるため、
  // 検証は「地域合計がいずれかの集計行と一致するか」で行う。
  const aggregates: Array<{ label: string; value: number; quantum: number }> = [];
  const consolidated = detectConsolidated(gridX.flat().join(" "));
  interface Entry {
    idx: number;
    role: "domestic" | "overseas";
    name: string;
    /** 曖昧さ解消列 (col1)。2-D 製品軸・階層子ラベル・metric 区分に使う */
    sub: string;
    value: number;
    /** 印刷セルの quantum (Gate3。合算出力は子 quantum の合計を持つ)。 */
    quantum: number;
  }
  const entries: Entry[] = [];
  const shokei: Array<{ idx: number; value: number; quantum: number }> = [];
  const elimCells: CellAmount[] = [];
  const otherRevenueCells: CellAmount[] = [];
  const companyCommonCells: CellAmount[] = [];
  let hasBusinessRows = false;
  // 最初の集計行より後の地域行は別 block (S100TYYR: 事業 block の「その他」
  // 4953 を地域に混入させない)。小計は block 終端ではなく block 内区切り。
  let seenAggRow = false;

  for (let i = firstNum; i < gridX.length; i++) {
    if (excluded.has(i)) continue;
    const row = gridX[i];
    if (row.length <= vc) continue;
    const role = roles[i];
    const cell = parseJpNumberCell(row[vc] ?? "");
    const v = cell?.value ?? null;
    const normLabel = norm(row[0] ?? "");
    // 非地域の実数行 (事業セグメント等) の有無。P-metric で集計行がない表の
    // total 欠損判定に使う (地域外の売上がある表で地域計を総額にしない)。
    if (role === "other" && v !== null && !RX_ELIMINATION.test(normLabel)) {
      hasBusinessRows = true;
    }
    // 収益認識 triplet の非地域脚 (契約小計→外部顧客総額の橋渡し。S100PUMS)。
    // 集計にも地域にも数えない (classifyRegion の other 扱いと一致)。
    if (
      role === "other" &&
      v !== null &&
      cell !== null &&
      RX_OTHER_REVENUE.test(cleanLabel(row[0] ?? ""))
    ) {
      otherRevenueCells.push({ value: cell.value, quantum: cell.quantum });
    }
    // 全社・本社共通行 (地理不明の会社共通分。S100AGPO: 合計に含まれる 9)。
    // 集計行より前 (同一 block) のものだけ照合に加え、fact 化はしない。
    if (
      role === "other" &&
      v !== null &&
      cell !== null &&
      !seenAggRow &&
      // 消去行は elim 脚が持つため全社共通に重ねない (S100DA2Y「消去又は
      // 全社」の二重計上を Gate3 の区間照合が摘出。1行は1脚だけ)。
      !RX_ELIMINATION.test(normLabel) &&
      RX_COMPANY_COMMON.test(cleanLabel(row[0] ?? ""))
    ) {
      companyCommonCells.push({ value: cell.value, quantum: cell.quantum });
    }
    if (RX_SHOKEI.test(normLabel)) {
      // 小計の値が読めない block 構成は検証不能 → 却下 (fail-closed)
      if (v === null || cell === null || !Number.isInteger(v)) return null;
      shokei.push({ idx: i, value: v, quantum: cell.quantum });
      continue;
    }
    if (role === "aggregate") {
      // block 境界は地域行の後でのみ有効。先頭の総額行 (S100APSL の営業収益)
      // は前 block の尾ではなく表頭なので境界にしない (全地域の誤除外防止)。
      if (entries.length > 0) seenAggRow = true;
      if (
        v !== null &&
        cell !== null &&
        /外部顧客|顧客との契約|合計|連結|^計$/.test(normLabel)
      ) {
        aggregates.push({ label: normLabel, value: v, quantum: cell.quantum });
      }
      continue;
    }
    if (RX_ELIMINATION.test(normLabel)) {
      if (v !== null && cell !== null) {
        elimCells.push({ value: cell.value, quantum: cell.quantum });
      }
      continue;
    }
    // P/L 表は地域別収益の開示ではない (S100YCP3: 営業収益/費用/利益の損益要約
    // に日本/海外行があり費用内訳のその他 348 を混入して読めていた)。費用明細
    // を持つ P/L 型だけ落とす (利益対照の P-metric 表は殺さない)。
    if (
      role === "other" &&
      v !== null &&
      /^営業費用/.test(cleanLabel(row[0] ?? ""))
    ) {
      return null;
    }
    if (seenAggRow) continue;
    if (role !== "domestic" && role !== "overseas") continue;
    if (v === null || cell === null) continue;
    if (!Number.isInteger(v)) return null; // 小数 = % 列誤認 → 却下
    const name = cleanLabel(row[0] ?? "");
    if (name === "") continue;
    entries.push({ idx: i, role, name, sub: row[1] ?? "", value: v, quantum: cell.quantum });
  }

  if (shokei.length > 0) {
    const b1 = finishShokeiBlocks(
      entries,
      shokei,
      aggregates,
      unit,
      fiscalYearEnd,
      consolidated,
      mode
    );
    if (b1) return { ...b1, valueAxisHeader: colHeader[vc] ?? "" };
    return null;
  }

  // 重複地域名の解決: metric 対・2-D 製品軸・階層ラベルのいずれかで証明できなければ
  // 曖昧表として却下 (aggregate-before-dedup の防止。#150 の guard を弱めない)。
  let useEntries = entries;
  let metricPruned = false;
  const entryNames = entries.map((e) => e.name);
  if (new Set(entryNames).size !== entryNames.length) {
    if (elimCells.some((c) => c.value !== 0)) return null; // 消去つき重複は未証明の組合せ → 却下
    const resolved = resolveDupEntries(entries, aggregates, mode);
    if (!resolved) return null;
    useEntries = resolved.entries;
    metricPruned = resolved.metricPruned;
  }

  const facts: OverseasFact[] = useEntries.map((e) => ({
    regionName: e.name,
    regionKind: e.role,
    salesAmount: e.value,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  }));
  let domesticSum = 0;
  let regionSum = 0;
  for (const e of useEntries) {
    if (e.role === "domestic") domesticSum += e.value;
    regionSum += e.value;
  }

  if (facts.length < 2 || domesticSum <= 0) return null;
  // 同一表内の重複地域名は曖昧表 (aggregate-before-dedup の原因) として却下
  if (hasDuplicateRegionNames(facts)) return null;
  // 2-D 合計列の葉数え: 値列が合計列なら地域値はセグメント横断の和なので、
  // 丸め許容は合算前の葉セル数で決める (S100PUMS: 4行×(3〜4列)=13葉)。
  // 葉和と開示小計が懸け離れた行があれば表が自己矛盾 → 却下 (S100PV48)。
  // 重複解消済み (grouping 側で葉を数え直し済み) の表には適用しない。
  if (
    new Set(entryNames).size === entryNames.length &&
    /小計|合計|総計|累計|計$|^計/.test(colHeader[vc] ?? "")
  ) {
    // 調整額・消去列は表により葉 (合計に和算。S100OH0Q: 合計=葉+調整額) と
    // メモ (和算外) の両形がある。両方の葉集合で検証し、いずれかで全行が
    // 通れば採用する (両方通れば広い方。どちらも通らなければ自己矛盾)。
    const leafSets: number[][] = [[], []];
    for (let ci = 1; ci < width; ci++) {
      if (ci === vc) continue;
      const h = colHeader[ci] ?? "";
      if (RX_AGG_COL.test(h)) continue;
      if (
        /セグメント間|内部売上|内部取引|前年比|増減|構成比|割合|％|%/.test(h)
      )
        continue;
      leafSets[1].push(ci);
      if (!RX_ELIMINATION.test(h) && !/調整額?|消去/.test(h)) leafSets[0].push(ci);
    }
    // 見出しも全地域行の値も同一の列は重複掲示 (S100O7VN の航空宇宙 2 列)。
    // 二重計上しないよう先勝ちで間引く。見出し比較は単位片を除去して行う:
    // 結合セルの展開ずれで「（単位；千円）種結晶」と「種結晶」のように単位片の
    // 有無だけが違う同一列が生じ (S100YJVF)、除去なしでは重複を見逃して
    // 二重計上 → F7 葉照合の誤殺 (当期表を落として前期表に後退) になる。
    const dedupCols = (cols: number[]): number[] => {
      const seen = new Set<string>();
      const out: number[] = [];
      for (const ci of cols) {
        const sig =
          (colHeader[ci] ?? "")
            .replace(/（単位[^）]*）/g, "")
            .replace(/\(単位[^)]*\)/g, "") +
          "|" +
          useEntries
            .map((e) => {
              const c = parseJpNumberCell(gridX[e.idx][ci] ?? "");
              return c === null ? "null" : `${c.value}/${c.quantum}`;
            })
            .join(",");
        if (!seen.has(sig)) {
          seen.add(sig);
          out.push(ci);
        }
      }
      return out;
    };
    leafSets[0] = dedupCols(leafSets[0]);
    leafSets[1] = dedupCols(leafSets[1]);
    // 葉→開示小計の edge 検証 (Gate3)。feeder 葉セルの区間の和と開示小計
    // セル自身の区間の重なりで照合する (独立印刷 subtotal は自身の cell
    // precision で照合)。葉の quantum は raw cell 由来の実値
    // (parseJpNumberCell。"12.0" は q=0.1 であり 1 に置換しない。
    // Number("12.0") は整数に見える罠に注意)。% 列は leafSets 側で
    // header により除外済みのため値での整数 filter はしない。
    // 採用するのは小計セル自身であり、feeder 葉は和区間に再加算しない
    // (親採用時子再加算なし)。
    const verify = (leafCols: number[]): boolean => {
      if (
        !leafCols.some((ci) =>
          useEntries.some((e) => parseJpNumber(gridX[e.idx][ci] ?? "") !== null)
        )
      )
        return false;
      for (const e of useEntries) {
        const cells = leafCols
          .map((ci) => parseJpNumberCell(gridX[e.idx][ci] ?? ""))
          .filter((x): x is CellAmount => x !== null);
        if (cells.length === 0) continue;
        if (
          !cellsConsistent(
            cells,
            { value: e.value, quantum: e.quantum },
            mode
          )
        ) {
          return false;
        }
      }
      return true;
    };
    const leavesNoElim = verify(leafSets[0]);
    const leavesWithElim = verify(leafSets[1]);
    // 葉セルを持つ表でどちらの集合も通らなければ自己矛盾で却下する
    // (S100PV48)。
    const eitherHasFeeder =
      leafSets[0].some((ci) =>
        useEntries.some((e) => parseJpNumber(gridX[e.idx][ci] ?? "") !== null)
      ) ||
      leafSets[1].some((ci) =>
        useEntries.some((e) => parseJpNumber(gridX[e.idx][ci] ?? "") !== null)
      );
    if (eitherHasFeeder && !leavesNoElim && !leavesWithElim) {
      // 開示小計 vs 葉和の不一致: 開示総額を裁定者にする。地域の開示小計の和が
      // 会社総額 (外部顧客/連結/合計行) と整合すれば葉セル側の誤記として開示
      // 小計を信頼し (S100R9AG: アジア葉 5,793 vs 小計 5,973、総額 29,461 とは
      // 小計側が Δ2 で整合)、整合しなければ自己矛盾で却下する (S100PV48:
      // 日本小計 7,923,007 vs 葉和 7,932,007、総額 28,965,063 とは葉側が整合し
      // 開示小計は Δ9002 で不整合 → 却下を維持)。
      const arbiterAgg =
        aggregates.find((a) => /外部顧客/.test(a.label)) ??
        aggregates.find((a) => /連結|合計/.test(a.label)) ??
        null;
      // R9AG (Δ2 受理)/PV48 (Δ9002 却下) の pin は立つ。
      if (
        !arbiterAgg ||
        !cellsConsistent(
          [
            ...useEntries.map((e) => ({ value: e.value, quantum: e.quantum })),
            ...elimCells,
            ...otherRevenueCells,
            ...companyCommonCells,
          ],
          { value: arbiterAgg.value, quantum: arbiterAgg.quantum },
          mode
        )
      ) {
        return null;
      }
    }
  }
  // 検証: 地域合計が開示集計のいずれかと一致すること (= 正しい列・block を
  // 読み地域を取りこぼしていない証明)。地域スコープの集計に素の合計で先に
  // 照合する (S100YCID: 調整額を地域計に巻き込む適用範囲誤りを防ぐ)。
  // 消去つき照合はフォールバック (7203 Toyota 型: 消去前スコープの地域計)。
  const companyAgg =
    aggregates.find((a) => /外部顧客/.test(a.label)) ??
    aggregates.find((a) => /連結/.test(a.label)) ??
    null;
  const entryCells: CellAmount[] = useEntries.map((e) => ({
    value: e.value,
    quantum: e.quantum,
  }));
  const matchedRegional = aggregates.find(
    (a) =>
      !isCompanyAggLabel(a.label) &&
      cellsConsistent(
        [...entryCells, ...companyCommonCells],
        { value: a.value, quantum: a.quantum },
        mode
      )
  );
  const matchedElim = aggregates.find((a) =>
    cellsConsistent(
      [...entryCells, ...elimCells],
      { value: a.value, quantum: a.quantum },
      mode
    )
  );
  let matched = matchedRegional ?? matchedElim ?? null;
  // 会社総額との橋渡し: 地域小計で完全性が証明済みでも、総額セルが会社
  // スコープで小計と懸け離れていたら、開示の非地域脚 (その他の収益・調整額・
  // 消去・全社共通) で橋渡しできなければ却下 (脱落か表違い。推測しない)。
  let bridged = false;
  if (matchedRegional && companyAgg && companyAgg !== matchedRegional) {
    if (
      cellsConsistent(
        [...entryCells, ...elimCells, ...otherRevenueCells, ...companyCommonCells],
        { value: companyAgg.value, quantum: companyAgg.quantum },
        mode
      )
    ) {
      bridged = true;
    } else if (matchedElim) {
      matched = matchedElim;
    } else {
      return null;
    }
  }
  if (aggregates.length > 0 && !matched) return null;
  // 分母 (連結売上高): 実際の総売上 = 外部顧客への売上高 を最優先。無ければ
  // 連結/合計、無ければ一致した集計、無ければ地域合計。ただし metric 除去後の
  // 残りに非地域の実数行 (事業セグメント等) があり集計行がない表は、地域計が
  // 会社全体を表さないため total を欠損にする (捏造しない。S100VI7V で実証)。
  const totalAgg =
    aggregates.find((a) => /外部顧客/.test(a.label)) ??
    aggregates.find((a) => /連結|合計/.test(a.label)) ??
    matched ??
    null;
  const total =
    totalAgg?.value ?? (metricPruned && hasBusinessRows ? null : regionSum);
  // 証明の調整脚は検証済みの脚だけ (消去 + 橋渡し済み非地域収益 + 地域照合済み全社共通)。
  // 和区間は地域印刷セル + 調整脚の区間の和 (純計算中間値に quantum は付けない)。
  // 一致集計と異なる総額セルを使っても中間項は足さない (総額セルは1表示セル)。
  const sumOf = (cells: readonly CellAmount[]): number =>
    cells.reduce((a, c) => a + c.value, 0);
  const adjCells: CellAmount[] = [
    ...elimCells,
    ...(bridged ? otherRevenueCells : []),
    ...(matched === matchedRegional ? companyCommonCells : []),
  ];
  const reconAdjustment = sumOf(adjCells);
  const proofCells: CellAmount[] = [...entryCells, ...adjCells];
  const [proofSumLo, proofSumHi] = sumInterval(proofCells, mode);
  // 海外売上高 = 開示された海外地域行の合計 (= regionSum − 国内)。total − 国内に
  // すると「その他の収益」等の非地域分を海外に混入させるため使わない (ルール1)。
  const overseasTotal = regionSum - domesticSum;
  if (overseasTotal <= 0) return null;
  const totalCell: CellAmount | null =
    total !== null && totalAgg
      ? { value: totalAgg.value, quantum: totalAgg.quantum }
      : null;
  if (totalCell && !intervalsOverlap([proofSumLo, proofSumHi], cellInterval(totalCell.value, totalCell.quantum, mode)))
    return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct:
      total !== null && total > 0
        ? +((overseasTotal / total) * 100).toFixed(1)
        : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  // total 欠損 (metric 除去 + 非地域行あり) は null。printed 総額セルなしの
  // computed total (= regionSum) は和区間自身を運ぶ (重なりは恒真)。
  const [totalLo, totalHi] =
    total === null
      ? [null, null]
      : totalCell
        ? cellInterval(totalCell.value, totalCell.quantum, mode)
        : [proofSumLo, proofSumHi];
  return {
    facts,
    proof: {
      reconciliationAdjustment: reconAdjustment,
      mode,
      sumLo: proofSumLo,
      sumHi: proofSumHi,
      totalLo,
      totalHi,
    },
    valueAxisHeader: colHeader[vc] ?? "",
  };
}

/**
 * B1: 小計終端の複数 block (収益 category 別など) を合算する。各 block が自小計と
 * 一致し、かつ小計の合計が grand 集計 (開示総額) と一致するときだけ、地域ごとに
 * block 間合算する (S100QIEX で実証: 小計A 2112769 + 小計B 377295 = 外部顧客
 * 2490064)。検証に1つでも失敗したら null (捏造合算しない)。
 */
function finishShokeiBlocks(
  entries: Array<{ idx: number; role: "domestic" | "overseas"; name: string; value: number; quantum: number }>,
  shokei: Array<{ idx: number; value: number; quantum: number }>,
  aggregates: Array<{ label: string; value: number; quantum: number }>,
  unit: { label: string; factor: number },
  fiscalYearEnd: string,
  consolidated: boolean | null,
  mode: RoundingMode
): ParsedTable | null {
  const bounds = shokei.map((s) => s.idx).sort((a, b) => a - b);
  // 最終小計より後の地域行は所属 block 不明 → 却下
  if (entries.some((e) => e.idx > bounds[bounds.length - 1])) return null;
  let prev = -1;
  const groups = new Map<string, { kind: "domestic" | "overseas"; sum: number }>();
  for (const s of shokei) {
    const block = entries.filter((e) => e.idx > prev && e.idx < s.idx);
    prev = s.idx;
    // 同一 block 内の重複地域名は 2-D 等の未証明構造 → 却下
    const blockNames = block.map((e) => e.name);
    if (new Set(blockNames).size !== blockNames.length) return null;
    // block 葉セルの区間の和と小計セル自身の区間の重なり (Gate3)。
    if (
      !cellsConsistent(
        block.map((e) => ({ value: e.value, quantum: e.quantum })),
        { value: s.value, quantum: s.quantum },
        mode
      )
    )
      return null;
    for (const e of block) {
      const g = groups.get(e.name);
      if (g && g.kind !== e.role) return null; // block 間で内外区分が矛盾 → 却下
      if (g) g.sum += e.value;
      else groups.set(e.name, { kind: e.role, sum: e.value });
    }
  }
  // grand: 小計の合計が開示総額のいずれかと一致すること (総額の捏造なし)
  const grand = aggregates.find((a) =>
    cellsConsistent(
      shokei.map((s) => ({ value: s.value, quantum: s.quantum })),
      { value: a.value, quantum: a.quantum },
      mode
    )
  );
  if (!grand) return null;

  let domesticSum = 0;
  let regionSum = 0;
  const facts: OverseasFact[] = [...groups].map(([name, g]) => {
    if (g.kind === "domestic") domesticSum += g.sum;
    regionSum += g.sum;
    return {
      regionName: name,
      regionKind: g.kind,
      salesAmount: g.sum,
      ratioPct: null as number | null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    };
  });
  if (facts.length < 2 || domesticSum <= 0) return null;
  if (hasDuplicateRegionNames(facts)) return null;
  const overseasTotal = regionSum - domesticSum;
  const total = grand.value;
  // 和区間は全 block 葉印刷セル (合算前の exactly-once)。grand 照合済みの
  // 小計セルは和に再加算しない (二重算入なし)。
  const [proofSumLo, proofSumHi] = sumInterval(
    entries.map((e) => ({ value: e.value, quantum: e.quantum })),
    mode
  );
  const [totalLo, totalHi] = cellInterval(grand.value, grand.quantum, mode);
  if (overseasTotal <= 0 || !intervalsOverlap([proofSumLo, proofSumHi], [totalLo, totalHi]))
    return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct: total > 0 ? +((overseasTotal / total) * 100).toFixed(1) : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  return {
    facts,
    proof: {
      reconciliationAdjustment: 0,
      mode,
      sumLo: proofSumLo,
      sumHi: proofSumHi,
      totalLo,
      totalHi,
    },
  };
}

interface DupEntry {
  idx: number;
  role: "domestic" | "overseas";
  name: string;
  sub: string;
  value: number;
  quantum: number;
}

/**
 * 重複地域名の解決。col1 (sub) の形で以下を区別し、証明できる形だけ entries を
 * 正規化する。どれにも当てはまらなければ null (曖昧表として却下)。
 * - P-metric: sub が売上高/営業利益の対 → 売上高行だけ残す (S100VI7V で実証)
 * - P-2D: sub が品目ラベル (非地域・非集計・非数値・非 metric・非空・(地域, sub)
 *   一意) → 地域ごとに合算し、合算が開示集計と一致すること (S100J2E7 で実証)
 * - P-hier: sub が子地域ラベル (一意) → 子ラベルで読替え、leaf 合計が開示集計と
 *   一致すること (S100OJV9 で実証)
 */
function resolveDupEntries(
  entries: DupEntry[],
  aggregates: Array<{ label: string; value: number; quantum: number }>,
  mode: RoundingMode
): { entries: DupEntry[]; metricPruned: boolean } | null {
  // P-metric: 全行の sub が metric 対で、売上/利益の両方があれば利益行を除く
  const metrics = entries.map((e) => metricOf(e.sub));
  if (
    metrics.every((m) => m !== null) &&
    metrics.includes("sales") &&
    metrics.includes("profit")
  ) {
    const kept = entries.filter((_, i) => metrics[i] === "sales");
    const names = kept.map((e) => e.name);
    if (new Set(names).size !== names.length) return null;
    return { entries: kept, metricPruned: true };
  }
  // P-2D: sub が品目ラベル → 地域ごとに合算
  const subRoles = entries.map((e) => classifyRegion(e.sub));
  const pairs = entries.map((e) => `${e.name}|${e.sub}`);
  const pairsUnique = new Set(pairs).size === pairs.length;
  const isProduct2D =
    pairsUnique &&
    entries.every(
      (e, i) =>
        cleanLabel(e.sub) !== "" &&
        parseJpNumber(e.sub) === null &&
        subRoles[i] !== "domestic" &&
        subRoles[i] !== "overseas" &&
        subRoles[i] !== "aggregate" &&
        metricOf(e.sub) === null
    );
  if (isProduct2D) {
    const groups = new Map<
      string,
      { kind: "domestic" | "overseas"; sum: number; width: number; idx: number }
    >();
    for (const e of entries) {
      const g = groups.get(e.name);
      if (g) {
        g.sum += e.value;
        g.width += e.quantum;
      } else groups.set(e.name, { kind: e.role, sum: e.value, width: e.quantum, idx: e.idx });
    }
    // 分割の証明: 合算前 leaf セルの区間の和が開示集計のいずれかと重なること。
    // 合算出力は子 quantum の合計幅を持つ (純計算値への quantum 付与ではなく
    // 子印刷セルの exactly-once 計上)。
    if (
      !aggregates.some((a) =>
        cellsConsistent(
          entries.map((e) => ({ value: e.value, quantum: e.quantum })),
          { value: a.value, quantum: a.quantum },
          mode
        )
      )
    ) {
      return null;
    }
    return {
      entries: [...groups].map(([name, g]) => ({
        idx: g.idx,
        role: g.kind,
        name,
        sub: "",
        value: g.sum,
        quantum: g.width,
      })),
      metricPruned: false,
    };
  }
  // P-hier: sub が子地域ラベル (一意) → 子ラベルで読替え
  const isHier =
    pairsUnique &&
    subRoles.every((r) => r === "domestic" || r === "overseas") &&
    new Set(entries.map((e) => cleanLabel(e.sub))).size === entries.length;
  if (isHier) {
    const leaf = entries.map((e) => ({
      idx: e.idx,
      role: (classifyRegion(e.sub) === "domestic"
        ? "domestic"
        : "overseas") as "domestic" | "overseas",
      name: cleanLabel(e.sub),
      sub: "",
      value: e.value,
      quantum: e.quantum,
    }));
    if (leaf.some((e) => e.name === "")) return null;
    if (
      !aggregates.some((a) =>
        cellsConsistent(
          leaf.map((e) => ({ value: e.value, quantum: e.quantum })),
          { value: a.value, quantum: a.quantum },
          mode
        )
      )
    )
      return null;
    return { entries: leaf, metricPruned: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GEO_COLS: 地域 = 列
// ---------------------------------------------------------------------------

function tryGeoCols(
  gridX: string[][],
  fiscalYearEnd: string,
  heading: string,
  mode: RoundingMode
): ParsedTable | null {
  const flat = gridX.map((r) => r.join("")).join("");
  const unit = detectUnitOrNull(flat) ?? detectUnitOrNull(heading);
  if (!unit) return null;
  const width = Math.max(...gridX.map((r) => r.length));

  // 地域名を含むヘッダ行を探す (日本/本邦 列 + 海外地域 列)
  let headerIdx = -1;
  let colRole: RegionRole[] = [];
  for (let ri = 0; ri < Math.min(gridX.length, 6); ri++) {
    const roles = gridX[ri].map((c) => classifyRegion(c));
    const dom = roles.filter((x) => x === "domestic").length;
    const ovs = roles.filter((x) => x === "overseas").length;
    if (dom >= 1 && ovs >= 1) {
      headerIdx = ri;
      colRole = roles;
      break;
    }
  }
  if (headerIdx < 0) return null;

  // 総額列 (連結/合計) を特定
  let totalCol = -1;
  for (let ci = 0; ci < width; ci++) {
    const h = norm(gridX[headerIdx][ci] ?? "");
    if (RX_TOTAL_COL.test(h)) totalCol = ci;
  }

  // 値行 = 「外部顧客への売上高 / 外部顧客に対する売上高 / 売上高 / 合計」行
  let valueRow = -1;
  for (let i = headerIdx + 1; i < gridX.length; i++) {
    const lbl = norm(gridX[i][0] ?? "");
    if (/外部顧客への(売上高|売上収益|営業収益)|外部顧客に対する(売上高|売上収益|営業収益)/.test(lbl)) {
      valueRow = i;
      break;
    }
  }
  if (valueRow < 0) {
    for (let i = headerIdx + 1; i < gridX.length; i++) {
      const lbl = norm(gridX[i][0] ?? "");
      if (/^(売上高|売上収益|営業収益|合計|計)$/.test(lbl)) {
        valueRow = i;
        break;
      }
    }
  }
  if (valueRow < 0) return null;

  // 集計列 (連結/合計) と消去列 (調整額/消去) を収集。行パスと同型に、
  // 地域合計 (+消去) がいずれかの集計列と一致することを要求する
  // (S100Y53G: 地域 569330 + 調整額 36 ≈ 連結 569370)。
  const aggregates: Array<{ label: string; value: number; quantum: number }> = [];
  const elimCells: CellAmount[] = [];
  for (let ci = 0; ci < width; ci++) {
    const h = norm(gridX[headerIdx][ci] ?? "");
    const acell = parseJpNumberCell(gridX[valueRow][ci] ?? "");
    if (acell === null) continue;
    if (RX_TOTAL_COL.test(h)) {
      aggregates.push({ label: h, value: acell.value, quantum: acell.quantum });
    } else if (RX_ELIMINATION.test(h)) {
      elimCells.push({ value: acell.value, quantum: acell.quantum });
    }
  }

  const consolidated = detectConsolidated(gridX.flat().join(" "));
  const EXCL = /調整額?|セグメント間|内部|消去|割合|％|%/;
  // セグメント注記か (地域注記を兼ねる。S100ACAR は地域注記を省略し本表参照)。
  const headText = gridX
    .slice(0, headerIdx + 1)
    .map((r) => r.join(""))
    .join("");
  const hasKeiCol = gridX[headerIdx].some((c) => /^計$/.test(cleanLabel(c)));
  const isSegmentNote =
    /報告セグメント/.test(headText) && (totalCol >= 0 || hasKeiCol);
  const nonGeoSegCells: CellAmount[] = [];
  interface Col {
    index: number;
    name: string;
    kind: "domestic" | "overseas";
    value: number | null;
    /** 子印刷セルの quantum 合計幅 (grouping で合算したら子の合計。件数n ではない) */
    qw: number;
  }
  const cols: Col[] = [];
  for (let ci = 0; ci < width; ci++) {
    if (ci === totalCol) continue;
    const h = norm(gridX[headerIdx][ci] ?? "");
    const hClean = cleanLabel(gridX[headerIdx][ci] ?? "");
    // セグメント注記の非地域列 (その他・事業単位・全社共通) は地理が定まら
    // ないため fact 化せず照合にだけ加える (S100ACAR その他 1748、
    // S100IWKH スポーツ施設事業 512497)。海外売上高は地理列のみの下限。
    // 小計・総額列は和なので除く (報告セグメント計の二重計上防止)。
    if (
      isSegmentNote &&
      !RX_AGG_COL.test(h) &&
      !RX_ELIMINATION.test(h) &&
      !EXCL.test(h) &&
      (RX_OTHER_REGIONISH.test(hClean) ||
        RX_COMPANY_COMMON.test(hClean) ||
        RX_BUSINESS_COL.test(hClean)) &&
      !RX_NONGEO_EXCL.test(hClean)
    ) {
      const ncell = parseJpNumberCell(gridX[valueRow][ci] ?? "");
      if (ncell !== null && !Number.isInteger(ncell.value)) return null;
      if (ncell !== null) {
        nonGeoSegCells.push({ value: ncell.value, quantum: ncell.quantum });
      }
      continue;
    }
    const role = colRole[ci];
    if (role !== "domestic" && role !== "overseas") continue;
    if (EXCL.test(h)) continue;
    const vcell = parseJpNumberCell(gridX[valueRow][ci] ?? "");
    if (vcell !== null && !Number.isInteger(vcell.value)) return null;
    cols.push({
      index: ci,
      name: cleanLabel(gridX[headerIdx][ci] ?? ""),
      kind: role,
      value: vcell?.value ?? null,
      qw: vcell?.quantum ?? 0,
    });
  }
  // P-hier-cols: 親ラベル重複は子階層 (次行) で grouping する。複数列の親は
  // 子が非空・非数値・群内一意のときだけ合算できる (S100DDYF/S100Y53G で実証)。
  // 証明できなければ曖昧表として却下。
  let useCols = cols.filter((c) => c.value !== null);
  const colNames = cols.map((c) => c.name);
  if (new Set(colNames).size !== colNames.length) {
    const child = gridX[headerIdx + 1];
    if (!child || totalCol < 0) return null;
    const counts = new Map<string, number>();
    for (const c of cols) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
    const groups = new Map<
      string,
      { kind: "domestic" | "overseas"; sum: number; qw: number; subs: string[] }
    >();
    for (const c of cols) {
      const rawSub = child[c.index] ?? "";
      if (EXCL.test(norm(rawSub))) continue; // 子が調整額等 → leaf 除外
      const sub = cleanLabel(rawSub);
      if ((counts.get(c.name) ?? 0) > 1) {
        if (
          sub === "" ||
          parseJpNumber(rawSub) !== null ||
          (groups.get(c.name)?.subs.includes(sub) ?? false)
        ) {
          return null;
        }
      }
      const g = groups.get(c.name);
      if (g) {
        if (c.value !== null) {
          g.sum += c.value;
          g.qw += c.qw;
        }
        g.subs.push(sub);
      } else {
        groups.set(c.name, {
          kind: c.kind,
          sum: c.value ?? 0,
          qw: c.value !== null ? c.qw : 0,
          subs: [sub],
        });
      }
    }
    // 全 leaf 欠損の親は落とす (0 で埋めない。検証が守る)
    useCols = [...groups]
      .filter(([, g]) => g.qw > 0)
      .map(([name, g]) => ({
        index: -1,
        name,
        kind: g.kind,
        value: g.sum as number | null,
        qw: g.qw,
      }));
  }
  const facts: OverseasFact[] = [];
  let domesticSum = 0;
  let regionSum = 0;
  for (const c of useCols) {
    const v = c.value;
    if (v === null) continue;
    if (c.kind === "domestic") domesticSum += v;
    regionSum += v;
    facts.push({
      regionName: c.name,
      regionKind: c.kind,
      salesAmount: v,
      ratioPct: null,
      unitLabel: unit.label,
      unitYenFactor: unit.factor,
      fiscalYearEnd,
      isConsolidated: consolidated,
    });
  }
  if (facts.length < 2 || domesticSum <= 0) return null;
  // 同一表内の重複地域名は曖昧表 (aggregate-before-dedup の原因) として却下
  if (hasDuplicateRegionNames(facts)) return null;

  // 列セルの quantum は raw cell 由来の実値 (grouping 済みは子の合計幅)。
  const colCells: CellAmount[] = [];
  for (const c of useCols) {
    if (c.value === null) continue;
    colCells.push({ value: c.value, quantum: c.qw });
  }
  const adjCells: CellAmount[] = [...elimCells, ...nonGeoSegCells];
  const matched = aggregates.find((a) =>
    cellsConsistent(
      [...colCells, ...adjCells],
      { value: a.value, quantum: a.quantum },
      mode
    )
  );
  if (aggregates.length > 0 && !matched) return null;
  const totalAgg =
    aggregates.find((a) => /連結/.test(a.label)) ??
    aggregates.find((a) => /合計/.test(a.label)) ??
    matched ??
    null;
  const total = totalAgg?.value ?? regionSum;
  const [proofSumLo, proofSumHi] = sumInterval([...colCells, ...adjCells], mode);
  const totalCell: CellAmount | null = totalAgg
    ? { value: totalAgg.value, quantum: totalAgg.quantum }
    : null;
  if (
    totalCell &&
    !intervalsOverlap(
      [proofSumLo, proofSumHi],
      cellInterval(totalCell.value, totalCell.quantum, mode)
    )
  )
    return null;
  // 海外売上高 = 開示された海外地域列の合計 (= regionSum − 国内)。
  const overseasTotal = regionSum - domesticSum;
  if (overseasTotal <= 0) return null;

  facts.push({
    regionName: "海外売上高",
    regionKind: "overseas_total",
    salesAmount: overseasTotal,
    ratioPct: total > 0 ? +((overseasTotal / total) * 100).toFixed(1) : null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  facts.push({
    regionName: "連結売上高",
    regionKind: "total",
    salesAmount: total,
    ratioPct: null,
    unitLabel: unit.label,
    unitYenFactor: unit.factor,
    fiscalYearEnd,
    isConsolidated: consolidated,
  });
  const sumOf = (cells: readonly CellAmount[]): number =>
    cells.reduce((a, c) => a + c.value, 0);
  const [totalLo, totalHi] = totalCell
    ? cellInterval(totalCell.value, totalCell.quantum, mode)
    : [proofSumLo, proofSumHi];
  return {
    facts,
    proof: {
      reconciliationAdjustment: sumOf(adjCells),
      mode,
      sumLo: proofSumLo,
      sumHi: proofSumHi,
      totalLo,
      totalHi,
    },
    valueAxisHeader: gridX[valueRow]?.join("") ?? "",
  };
}

/**
 * 保存前検証 (ingest + 全 backfill caller の共通境界)。parser 出力を保存してよい
 * 集合か検査し、違反があれば throw する。caller は先頭行 dedup で回復させず、
 * 例外時は parse_error + facts 空で保存する (欠損は欠損のまま)。
 * - (会計期末, 地域名) の重複なし
 * - 単位・会計期末・連結区分の混在なし
 * - 海外売上高 = 海外地域行の合計 (完全分解の一致要求)
 * - 連結売上高 (開示あり) は proof の和区間と総額区間の重なりで照合する
 *   (Gate3。3 reducer と同一関数)。開示なし (9147 系) は total 欠損を許す
 *   (捏造しない)。facts の地域合計 + 調整額は proof の基数と exact 一致する
 *   こと (caller の dedup 落ち等の欠損は基数不一致で throw)。
 * - 比率は両非欠損のとき海外/連結から再計算一致
 * - 地域行なしの集計のみ/空集合は検証対象外 (pass)。未構造化の空保存は通す。
 */
export function validateOverseasSaveSet(
  facts: OverseasFact[],
  proof: OverseasProof | undefined
): void {
  const keys = facts.map((f) => `${f.fiscalYearEnd} ${f.regionName}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("保存集合に重複地域があります。");
  }
  if (new Set(facts.map((f) => f.unitYenFactor)).size > 1) {
    throw new Error("保存集合に単位の混在があります。");
  }
  if (new Set(facts.map((f) => f.fiscalYearEnd)).size > 1) {
    throw new Error("保存集合に会計期末の混在があります。");
  }
  if (new Set(facts.map((f) => String(f.isConsolidated))).size > 1) {
    throw new Error("保存集合に連結区分の混在があります。");
  }
  const regions = facts.filter(
    (f) => f.regionKind === "domestic" || f.regionKind === "overseas"
  );
  if (regions.length === 0) return; // 集計のみ/空集合は対象外
  if (regions.some((f) => f.salesAmount === null)) {
    throw new Error("保存集合に欠損の地域売上があります。");
  }
  let domesticSum = 0;
  let overseasSum = 0;
  for (const f of regions) {
    if (f.regionKind === "domestic") domesticSum += f.salesAmount as number;
    else overseasSum += f.salesAmount as number;
  }
  const regionSum = domesticSum + overseasSum;
  const ot = facts.find((f) => f.regionKind === "overseas_total");
  const total = facts.find((f) => f.regionKind === "total");
  if (!ot || ot.salesAmount === null || ot.salesAmount !== overseasSum) {
    throw new Error("保存集合の海外売上高が地域合計と一致しません。");
  }
  // proof は必須。facts-only 呼出し (fallback 丸め) は STOP (parse_error へ)。
  // 3 caller (ingest/backfill-overseas/backfill-missing) は proof を渡す。
  if (!proof) {
    throw new Error("保存集合の proof がありません。");
  }
  // 基数の一致: facts の地域合計 + 調整額は proof の和区間の中心に exact 一致
  // すること (caller の dedup 落ち等の欠損・改変はここで throw)。
  const adjusted = regionSum + proof.reconciliationAdjustment;
  if (!(proof.sumLo - INTERVAL_EPS <= adjusted && adjusted <= proof.sumHi + INTERVAL_EPS)) {
    throw new Error("保存集合の地域合計が proof の和区間に収まりません。");
  }
  if (total && total.salesAmount !== null) {
    if (proof.totalLo === null || proof.totalHi === null) {
      throw new Error("保存集合の連結売上高に対応する proof の総額がありません。");
    }
    // 3 reducer と同一の重なり照合 (Gate3)。
    if (
      !intervalsOverlap(
        [proof.sumLo, proof.sumHi],
        [proof.totalLo, proof.totalHi]
      )
    ) {
      throw new Error("保存集合の連結売上高が地域合計と整合しません。");
    }
  }
  const ratio =
    total && total.salesAmount !== null && total.salesAmount > 0
      ? +((overseasSum / total.salesAmount) * 100).toFixed(1)
      : null;
  if (ot.ratioPct !== ratio) {
    throw new Error("保存集合の比率が再計算と一致しません。");
  }
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 位置情報つきで <table> を **全ネスト階層** で抜き出し、直前テキスト(見出し)も
 * 拾う。iXBRL の地域別売上表は外側のレイアウト表に **入れ子** で埋まっている
 * ことが多く (実有報で確認)、外側だけ見ると巨大ラッパに埋もれて構造化できない。
 * スタックで開始タグを積み、閉じタグで対応を取り、各階層の table を **内側から
 * 順に** 返す (より具体的な内側の表を先に試す)。見出しは各 table の開始直前
 * テキストから取る (内側の表ではセルの見出しになることもある)。
 */
function tablesWithHeading(
  html: string
): Array<{ table: string; heading: string; wide: string; start: number }> {
  const out: Array<{
    table: string;
    heading: string;
    wide: string;
    start: number;
  }> = [];
  const re = /<\/?table\b[^>]*>/gi;
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-zA-Z#0-9]+;/g, " ")
      .replace(/[\s\u3000]+/g, " ")
      .trim();
  while ((m = re.exec(html)) !== null) {
    if (m[0][1] === "/") {
      const start = stack.pop();
      if (start === undefined) continue; // 壊れた HTML 防御
      const table = html.slice(start, re.lastIndex);
      const before = html.slice(Math.max(0, start - 400), start);
      const heading = strip(before).slice(-160);
      // wide: 期首継承 (inheritSourceFiscal) 専用の広窓。表題近接型
      // (TTUY/AO7M: 52-791 文字前) に加え、節表題型 (E00766 の(2)地域別の
      // 内訳ペア: 節表題が 25676-25680 文字前) も拾う。T 側は終期=pe の
      // 照合で保護される (不一致→unknown)。Z 側は pe 以前で確定。
      const wideBefore = html.slice(Math.max(0, start - 60000), start);
      const wide = strip(wideBefore);
      out.push({ table, heading, start, wide });
    } else {
      stack.push(m.index);
    }
  }
  return out;
}

/**
 * 同一有報に地域別売上の表は複数ある (連結/個別・前期/当期・収益分解/セグメント
 * 情報)。最初に当たった表ではなく、**当期・連結・地域注記** に最も近い候補を
 * 選ぶための採点。誤った表 (個別・前期) の値を出さないための要 (ルール1)。
 */
function scoreCandidate(
  heading: string,
  flat: string,
  _status: OverseasParseStatus
): number {
  const ctx = heading + " " + flat;
  const hasCurrent = /当連結会計年度|当事業年度|当期/.test(ctx);
  const hasPrior = /前連結会計年度|前事業年度|前期/.test(ctx);
  let s = 0;
  if (/連結/.test(ctx)) s += 6;
  if (/個別|単体/.test(ctx) && !/連結/.test(ctx)) s -= 4;
  if (hasCurrent) s += 4;
  if (hasPrior && !hasCurrent) s -= 6; // 前期のみ = 旧年度の表
  if (/地域ごとの情報|地域別|主たる地域市場|所在地別/.test(ctx)) s += 3;
  if (/外部顧客/.test(flat)) s += 2;
  // 正準の地理開示 (地域注記) をセグメント注記・販売実績表より優先する。
  // S100G3BR で実証: 当連結セグメント表 (c2, score 12: 連結+当期+窓汚染の
  // 外部顧客) が「(4) 地域に関する情報」表 (c3, score 10) に勝ち、セグメント
  // 切り (日本/北米/アジア/中国 + 非地域その他 7,880) を地域別売上として誤採用
  // していた (c2 は domestic+overseas_total≠total の Δ7,881 不整合、c3 は完全
  // 整合)。表題窓に地域注記の題名がある候補を +4 する。当/前ペアは同種注記
  // なので対称 (期間優先は保たれる)。個別/前期ペナルティより小さく、連結+
  // 当期 (+10) には単独で勝てない (期間・連結の誤選択は起こさない)。
  // 「(2) 地域別の内訳」はセグメント注記の小題 (R98H: セグメント切り日本
  // 100383 と地域注記切り日本 100547 が総額同値で脚不一致) のため正準から
  // 除く。セグメント切りの表は地域注記が共存すれば負け、単独なら残る。
  if (
    /地域ごとの情報|地域に関する情報|地域別に関する情報|地域別情報/.test(
      heading
    )
  )
    s += 4;
  return s;
}

/**
 * type=1 ZIP から海外（地域別）売上を構造化する。確信が持てない表は status で
 * 明示し数値を捏造しない (ルール1/2)。
 */
export function parseOverseasData(
  zipBuf: Buffer,
  reportPeriodEnd: string
): OverseasExtraction {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportPeriodEnd)) {
    throw new Error(`reportPeriodEnd 形式が不正: ${reportPeriodEnd}`);
  }
  const entries = unzip(zipBuf);
  const picked = pickHonbunHtml(entries);
  if (!picked) {
    return {
      status: "no_overseas_table",
      facts: [],
      honbunFile: null,
      tablesScanned: 0,
    };
  }
  // 端数注記は有報全体の表示方針のため全文書で確定する (注記が表と別
  // ファイルでも拾う。DDYF/NRWW で実証)。表だけの fixture 呼びは
  // parseOverseasHtml 側で当該 html から確定する。
  const names = [...entries.keys()].filter(
    (n) => /PublicDoc\//i.test(n) && /\.html?$/i.test(n)
  );
  const filingText = names.map((n) => entries.get(n)!.toString("utf8")).join("\n");
  const { mode } = detectRoundingMode(filingText);
  const r = parseOverseasHtml(picked.html, reportPeriodEnd, { roundingMode: mode });
  return { ...r, honbunFile: picked.name };
}

/**
 * 候補 facts の正規化比較キー。会計期末・連結区分・単位・行区分・地域名・
 * 値・比率を regionKind/regionName 順に並べて結合する。
 */
function normFactsKey(facts: OverseasFact[]): string {
  return [...facts]
    .sort((a, b) =>
      a.regionKind < b.regionKind
        ? -1
        : a.regionKind > b.regionKind
          ? 1
          : a.regionName < b.regionName
            ? -1
            : a.regionName > b.regionName
              ? 1
              : 0
    )
    .map(
      (f) =>
        `${f.fiscalYearEnd}|${String(f.isConsolidated)}|${f.unitLabel}|${f.regionKind}|${f.regionName}|${String(f.salesAmount)}|${String(f.ratioPct)}`
    )
    .join(";");
}

/** 注記種 (正準の地域注記タイトルを先に見る。注 prose 中の報告セグメントに負けない) */
function noteClassOf(heading: string): "CHIIKI" | "SEG" | "UNK" {
  if (
    /地域ごとの情報|地域に関する情報|地域別に関する情報|地域別情報|地域別の内訳|地域別内訳/.test(
      heading
    )
  )
    return "CHIIKI";
  if (/報告セグメント|セグメント情報|販売実績/.test(heading)) return "SEG";
  return "UNK";
}

/** 期表示語クラス (表題窓+表文面)。T=当期のみ Z=前期のみ TZ=両方 -=なし */
function periodWordClassOf(heading: string, flat: string): string {
  const ctx = heading + " " + flat;
  const t = /当連結会計年度|当事業年度|当期/.test(ctx);
  const z = /前連結会計年度|前事業年度|前期/.test(ctx);
  return t && z ? "TZ" : t ? "T" : z ? "Z" : "-";
}

interface PeriodPairCand {
  status: OverseasParseStatus;
  facts: OverseasFact[];
  proof: OverseasProof;
  start: number;
  heading: string;
  flat: string;
  wide: string;
  axis: string;
}

/** 表文面に非売上 metric の標識 (IFRS 移行日列・資産/減損の語) があるか */
function hasMetricMarkers(flat: string): boolean {
  return /移行日|非流動資産|減損損失|有形固定資産|無形資産/.test(flat);
}

/**
 * 売上種別/集計範囲 (contract)。採用行ラベル・近接 caption・表文面の明示のみ
 * から定める (資料にない contract は捏造しない — Gate2):
 * - "company": セグメント間内部売上/振替を含む全社スコープ (計は全社計)。
 * - "contract": 顧客との契約から生じる収益の分解スコープ。
 * - "ext": 外部顧客への売上高ライン (単独)。
 * - "mixed": 内部と契約の両信号が同表に混在 (競合時は STOP)。
 * - "unknown": 上記の明示なし。
 * 外部顧客・顧客との契約・セグメント間を含む売上を混同しない。同一 FY/
 * scope でも contract が違えば別 group (TA7H: 収益認識 A/B="contract" と
 * セグメント C/D="company" を分離し、脚同値でも収束させない)。
 */
export type SalesContract =
  | "company"
  | "contract"
  | "ext"
  | "mixed"
  | "unknown";

export function contractOf(
  facts: OverseasFact[],
  heading: string,
  flat: string
): SalesContract {
  const adopted = facts.map((f) => f.regionName).join(" ");
  const ctx = `${heading} ${flat} ${adopted}`;
  const internal = /セグメント間/.test(ctx);
  const crev = /顧客との契約/.test(ctx);
  if (internal && crev) return "mixed";
  if (internal) return "company";
  if (crev) return "contract";
  if (/外部顧客/.test(ctx)) return "ext";
  return "unknown";
}

/** 和暦の開始西暦 (元年=1)。終期の pe 照合用。 */
const ERA_START_YEAR: Record<string, number> = {
  明治: 1868,
  大正: 1912,
  昭和: 1926,
  平成: 1989,
  令和: 2019,
};

/** 終期 chunk (平成28年3月31日 / 2023年3月31日) を ISO へ。失敗時 null。 */
function endDateChunkToIso(chunk: string): string | null {
  const c = toHalfWidthDigits(chunk).replace(/[\s\u3000]/g, "");
  const m = /(明治|大正|昭和|平成|令和)?(\d+|元)年(\d+)月(\d+)日/.exec(c);
  if (!m) return null;
  const y = m[2] === "元" ? 1 : Number(m[2]);
  const western = m[1] ? ERA_START_YEAR[m[1]] + y - 1 : y;
  if (!Number.isFinite(western)) return null;
  return `${western}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`;
}

/** pe 引数の ISO 正規化 (YYYY-M-D → YYYY-MM-DD)。 */
function normPeriodEnd(pe: string): string {
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(pe);
  if (!m) return pe;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

export interface SourceFiscal {
  side: "T" | "Z";
  /** 実終期日 (ISO)。単一年号軸など日付を確定できないときは null (side のみ)。 */
  date: string | null;
}

/**
 * 期の確定結果。`null` = unknown (期表示なし。弱い文脈へ fall through 可)、
 * `"mismatch"` = 明示の矛盾 (当ラベルなのに終期≠pe・未来日等。弱い文脈の
 * 推測採用に戻さず候補除外まで sticky に伝播する — Gate1)。
 */
export type FiscalResolution = SourceFiscal | "mismatch" | null;

/**
 * 期首継承: 表直前の広窓から最も近い ranged 表題
 * (前|当)(連結会計年度|事業年度|会計年度)(自…至…) を拾い、その表の期
 * (T=当期 / Z=前期) を印刷ラベルから継承する。文書順 proxy ではない。
 * 括弧は全角・半角の両式 (TA7H: 半角 (自 2023年１月21日 至 2024年１月20日))。
 * 期数式 (第27期(自…至…)。TSNG/W7ZO/YHFZ の収益認識ペア) も終期で判定する。
 * - T: 終期が pe と一致するときだけ確定 (不一致=別 section の表題→mismatch)。
 * - Z: 終期が pe より前のときだけ確定 (pe 以降=矛盾→mismatch)。
 * - ranged 表題なし / 終期パース不能 → null (unknown)。
 * 実証: R98H (前@2022-03-31→Z / 当@2023-03-31=pe→T)、TTUY、AO7M、TA7H。
 */
export function inheritSourceFiscal(
  wide: string,
  reportPeriodEnd: string
): FiscalResolution {
  const w = toHalfWidthDigits(wide);
  const re =
    /(?:(前|当)(連結会計年度|事業年度|会計年度)?|第\d+期)\s*[（(]\s*自[^）)]{0,60}?至([^）)]{0,60}?)[）)]/g;
  let m: RegExpExecArray | null;
  let last: { side: "T" | "Z" | null; chunk: string } | null = null;
  while ((m = re.exec(w)) !== null) {
    last = {
      side: m[1] === undefined ? null : m[1] === "当" ? "T" : "Z",
      chunk: m[3],
    };
  }
  if (!last) return null;
  const date = endDateChunkToIso(last.chunk);
  if (!date) return null;
  const pe = normPeriodEnd(reportPeriodEnd);
  // 期数式はラベル側がなく終期のみ: 終期=pe→T、終期<pe→Z。
  if (last.side === null) {
    if (date === pe) return { side: "T", date };
    return date < pe ? { side: "Z", date } : "mismatch";
  }
  if (last.side === "T") return date === pe ? { side: "T", date } : "mismatch";
  return date < pe ? { side: "Z", date } : "mismatch";
}

/**
 * 表内 fiscal: 表文面 (flat) の ranged 表題が全会一致のときだけ確定する。
 * 表自身の頭に当/前表題を持つ表 (W92F: 表内に当連結@pe) は表題が definitive
 * で、表外の stale な前期表題 (W92F: 60KB 窓内の前@2024-03-31) より優先する。
 * 2期比較列 (TZ 混在)・日付不一致は null (非全会一致→表外継承へ)。
 */
export function unanimousFlatFiscal(
  flat: string,
  reportPeriodEnd: string
): FiscalResolution {
  const w = toHalfWidthDigits(flat);
  const re =
    /(?:(前|当)(連結会計年度|事業年度|会計年度)?|第\d+期)\s*[（(]\s*自[^）)]{0,60}?至([^）)]{0,60}?)[）)]/g;
  let m: RegExpExecArray | null;
  const sides = new Set<"T" | "Z">();
  const pe = normPeriodEnd(reportPeriodEnd);
  let count = 0;
  let firstDate = "";
  while ((m = re.exec(w)) !== null) {
    count++;
    const date = endDateChunkToIso(m[3]);
    if (!date) return null;
    if (count === 1) firstDate = date;
    const label = m[1] === undefined ? null : m[1] === "当" ? "T" : "Z";
    if (label === "T") {
      if (date !== pe) return "mismatch";
      sides.add("T");
    } else if (label === "Z") {
      if (!(date < pe)) return "mismatch";
      sides.add("Z");
    } else {
      if (date === pe) sides.add("T");
      else if (date < pe) sides.add("Z");
      else return null;
    }
  }
  if (count === 0 || sides.size !== 1) return null;
  const side = [...sides][0];
  return { side, date: side === "T" ? pe : firstDate };
}

/**
 * 値軸 fiscal: pick した値列/値行の見出しから期を確定する。
 * ranged 表題の全会一致があればそれを使い、なければ印刷日 (年月日) を保持し、
 * 年月は明示の期末表記 (期/期末/現在/末日/末) に限り月末化する。素の「年月」
 * (例: 2025年3月) の一律月末化は補作のためしない (Gate1)。年のみ (月なし)
 * は単一年で side のみ確定し date=null (pe 日付への補完捏造はしない)。
 * 印刷日が pe より未来の明示矛盾は "mismatch" (弱文脈へ戻さない)。
 * LVA5 級の2期比較表は値列頭の当連結@pe で T 確定する (表外交互表題の
 * stale Z より値軸が強い)。
 */
export function axisFiscal(
  axisHeader: string,
  reportPeriodEnd: string
): FiscalResolution {
  const ranged = unanimousFlatFiscal(axisHeader, reportPeriodEnd);
  if (ranged) return ranged;
  const w = toHalfWidthDigits(axisHeader).replace(/[\s\u3000]/g, "");
  const pe = normPeriodEnd(reportPeriodEnd);
  // 印刷日 (年月日) があればその日を保持する。複数異日付は比較軸で非全会一致。
  const days = new Set<string>();
  for (const m of w.matchAll(/(明治|大正|昭和|平成|令和)?(\d+|元)年(\d+)月(\d+)日/g)) {
    const y = m[2] === "元" ? 1 : Number(m[2]);
    const western = m[1] ? ERA_START_YEAR[m[1]] + y - 1 : y;
    const month = Number(m[3]);
    const day = Number(m[4]);
    if (!Number.isFinite(western) || month < 1 || month > 12 || day < 1 || day > 31)
      continue;
    days.add(
      `${western}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    );
  }
  if (days.size === 1) {
    const date = [...days][0];
    if (date === pe) return { side: "T", date };
    if (date < pe) return { side: "Z", date };
    return "mismatch";
  }
  if (days.size > 1) return null;
  // 素の年月 (明示の期末表記なし) がある軸は unknown のまま年 side へ
  // 落とさない (Solレビュー: 裸年月がある場合「年のみ」分岐へ落とさず
  // unknown を維持)。年月日は上で処理済みのため、年月+非マーカーの有無
  // だけを見る (マーカーつきとの混在も unknown。fail-closed)。
  if (
    /(明治|大正|昭和|平成|令和)?(\d+|元)年(\d+)月(?!期末|期|末日|末現在|現在|末)/.test(w)
  ) {
    return null;
  }
  // 年月は明示の期末表記に限り月末化する (2025年3月期→2025-03-31)。
  // 年月日 (…月…日) は上で処理済みのためここでは拾わない。
  const ends = new Set<string>();
  for (const m of w.matchAll(
    /(明治|大正|昭和|平成|令和)?(\d+|元)年(\d+)月(期末|期|末日|末現在|現在|末)/g
  )) {
    const y = m[2] === "元" ? 1 : Number(m[2]);
    const western = m[1] ? ERA_START_YEAR[m[1]] + y - 1 : y;
    const month = Number(m[3]);
    if (!Number.isFinite(western) || month < 1 || month > 12) continue;
    const lastDay = new Date(western, month, 0).getDate();
    ends.add(
      `${western}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
    );
  }
  if (ends.size === 1) {
    const date = [...ends][0];
    if (date === pe) return { side: "T", date };
    if (date < pe) return { side: "Z", date };
    return "mismatch";
  }
  if (ends.size > 1) return null;
  // 年月なし→単一年で side のみ (date=null)。値列がその年の値であることは
  // 確定するが日付は印刷されていない (億円シリーズ: 年列の前期値を Z 除外)。
  const years = new Set<number>();
  for (const m of w.matchAll(/(明治|大正|昭和|平成|令和)?(\d+|元)年/g)) {
    const y = m[2] === "元" ? 1 : Number(m[2]);
    const western = m[1] ? ERA_START_YEAR[m[1]] + y - 1 : y;
    if (Number.isFinite(western)) years.add(western);
  }
  if (years.size !== 1) return null;
  const peY = Number(normPeriodEnd(reportPeriodEnd).slice(0, 4));
  const y = [...years][0];
  if (y === peY) return { side: "T", date: null };
  if (y < peY) return { side: "Z", date: null };
  return null;
}

/**
 * 候補 fiscal の確定鎖: 値軸見出し → 表内全会一致 → 表外広窓の最寄り。
 * 値軸 (pick した値列/値行の頭) は候補値そのものの期を示すため最も強い。
 * 表内表題は表自身の期を示し、表外の stale 表題より強い。
 * 全て unknown なら null。強い側の "mismatch" は弱い側の確定で上書きせず
 * そのまま返す (明示矛盾を弱文脈の推測採用に戻さない — Gate1)。
 */
export function resolveCandidateFiscal(
  axisHeader: string,
  flat: string,
  wide: string,
  reportPeriodEnd: string
): FiscalResolution {
  const axis = axisFiscal(axisHeader, reportPeriodEnd);
  if (axis === "mismatch" || axis) return axis;
  const flatRes = unanimousFlatFiscal(flat, reportPeriodEnd);
  if (flatRes === "mismatch" || flatRes) return flatRes;
  return inheritSourceFiscal(wide, reportPeriodEnd);
}

/**
 * 候補の sourceFiscal キー。継承できれば実終期日 (ISO。T/Z へ潰さない)、
 * できなければ期表示語クラス (pw:T/Z/TZ/-) で group 化する。TZ 汚染ペア・
 * 同期間ペアは同 group 内のキー不一致→STOP に流れる。
 */
function sourceFiscalKey(c: PeriodPairCand, pe: string): string {
  const inh = resolveCandidateFiscal(c.axis, c.flat, c.wide, pe);
  if (inh === "mismatch") return "mm";
  if (inh) return inh.date ?? inh.side;
  return `pw:${periodWordClassOf(c.heading, c.flat)}`;
}

/**
 * 継承 tiebreak: 同点2候補が同 status・同注記種・同連結区分・同単位・
 * 両 metric-clean で、一方が継承 T・他方が継承 Z のときだけ T 側を採る。
 * 順序も metric-clean 優先も使わない (CMLA 型は R1-grid が up-front 除去、
 * TA7H 型=共に継承 T はキー不一致→STOP)。1つでも gate を外したら null。
 */
function pickCurrentOfFiscalPair(
  tops: PeriodPairCand[],
  pe: string
): PeriodPairCand | null {
  if (tops.length !== 2) return null;
  const [a, b] = tops;
  if (a.status !== b.status) return null;
  if (noteClassOf(a.heading) !== noteClassOf(b.heading)) return null;
  const consolA = a.facts[0]?.isConsolidated ?? null;
  const consolB = b.facts[0]?.isConsolidated ?? null;
  if (consolA !== consolB) return null;
  const unitA = a.facts[0]?.unitLabel ?? null;
  const unitB = b.facts[0]?.unitLabel ?? null;
  if (unitA !== unitB) return null;
  // 同一 contract の T/Z ペアに限る (Gate2。違う集計範囲の表同士の
  // 総額比較は無意味なため STOP へ流す)。
  if (contractOf(a.facts, a.heading, a.flat) !== contractOf(b.facts, b.heading, b.flat))
    return null;
  if (hasMetricMarkers(a.flat) || hasMetricMarkers(b.flat)) return null;
  const inhA = resolveCandidateFiscal(a.axis, a.flat, a.wide, pe);
  const inhB = resolveCandidateFiscal(b.axis, b.flat, b.wide, pe);
  if (!inhA || !inhB || inhA === "mismatch" || inhB === "mismatch") return null;
  if (inhA.side === inhB.side) return null;
  const totA = a.facts.find((f) => f.regionKind === "total")?.salesAmount ?? null;
  const totB = b.facts.find((f) => f.regionKind === "total")?.salesAmount ?? null;
  if (totA === null || totB === null || totA === totB) return null;
  return inhA.side === "T" ? a : b;
}

/**
 * 本文 iXBRL の HTML 文字列から海外（地域別）売上を構造化する。
 * テストは公開済み有報の実テーブル fixture をここへ直接食わせる。
 */
export function parseOverseasHtml(
  html: string,
  reportPeriodEnd: string,
  opts: { roundingMode?: RoundingMode } = {}
): Omit<OverseasExtraction, "honbunFile"> {
  const mode = opts.roundingMode ?? detectRoundingMode(html).mode;
  const tables = tablesWithHeading(html);
  let tablesScanned = 0;
  let sawGeoSignal = false;

  interface Cand {
    status: OverseasParseStatus;
    facts: OverseasFact[];
    proof: OverseasProof;
    score: number;
    start: number;
    heading: string;
    flat: string;
    wide: string;
    axis: string;
  }
  const candidates: Cand[] = [];
  const buffered: {
    status: OverseasParseStatus;
    facts: OverseasFact[];
    proof: OverseasProof;
    axis: string;
    start: number;
    heading: string;
    flat: string;
    wide: string;
  }[] = [];

  for (const { table, heading, wide, start } of tables) {
    const rawGrid = tableToGridExpanded(table);
    if (rawGrid.length < 2) continue;
    // 全角数字・ラテンの半角化 (全パス共通)。S1009XV6 の「その他 ５」等、
    // 全角数字セルが parseJpNumber を素通りして行脱落→総額不一致を起こす。
    // 括弧・符号類は触らない (注除去・△▲負数判定の現状を変えない)。
    const grid = rawGrid.map((r) =>
      r.map((c) => toHalfWidthLatin(toHalfWidthDigits(c)))
    );
    const flat = grid.map((r) => r.join("")).join("");
    // 生産実績表は売上高の開示ではないので候補にしない (監査の取りこぼし集計にも
    // 入れない = sawGeoSignal を立てない。販売実績表など正規の売上表は別 fixture で固定)。
    if (isProductionTable(heading)) continue;
    // R1: 非流動資産・減損損失の地域別表も売上高の開示ではないので候補にしない
    // (S100G2DL/S100J2FF で実証の dup なし live 誤 pick。算術整合するため検証は
    // 通り抜ける。売上表の誤殺防止は S100AJAN ほか全母集団 re-run で固定)。
    if (isNonSalesMetricTable(heading)) continue;
    // 受注・繰越表も売上高の開示ではないので候補にしない (S100TP3I)。
    if (isBacklogTable(heading)) continue;
    // R1-grid: 表頭 (先頭2行) に減損損失・非流動資産がある表も非売上表として候補に
    // しない。入れ子の内側表は見出し窓に表題が入らず heading-R1 をすり抜けるため
    // (S100O4SN で実証: 内側表の窓は style 屑+単位のみで abstain し減損表を採用)。
    // 売上表の表頭にこの2語は来ない (セグメント資産等の行は表の下部)。
    const headCells = grid.slice(0, 2).map((r) => r.join("")).join("");
    if (/減損損失|非流動資産|有形固定資産|無形資産/.test(headCells)) continue;
    // R1-wide: narrow 見出し窓 (160字) に metric 名詞がなく、表頭に移行日列が
    // あり、広窓 (4000字) の最寄り metric 名詞が資産の表は非売上表として落とす
    // (S100CMLA 後表: narrow は style 屑+単位で abstain するが wide 末尾の
    // 小題「非流動資産」が最寄り資産名詞。joint-abstain は近接 joint のみ)。
    // 表頭の移行日だけでは落とさない: IFRS 移行年の売上表も移行日列を持つ
    // (S100AI6T: 移行日/前/当の3期比較・地域別売上。wide 最寄りは売上)。
    if (
      /移行日/.test(headCells) &&
      [...heading.matchAll(RX_METRIC_NOUN)].length === 0 &&
      isNonSalesMetricTable(wide)
    )
      continue;
    const regionish =
      RX_OVERSEAS_REGION.test(flat) || /本邦|日本|海外売上高/.test(flat);
    if (!regionish) continue;
    tablesScanned++;

    let cand: {
      status: OverseasParseStatus;
      facts: OverseasFact[];
      proof: OverseasProof;
      axis: string;
    } | null = null;
    {
      const rows = tryGeoRows(grid, reportPeriodEnd, heading, mode);
      if (rows)
        cand = {
          status: "ok_geo_rows",
          facts: rows.facts,
          proof: rows.proof,
          axis: rows.valueAxisHeader ?? "",
        };
    }
    if (!cand) {
      const cols = tryGeoCols(grid, reportPeriodEnd, heading, mode);
      if (cols)
        cand = {
          status: "ok_geo_cols",
          facts: cols.facts,
          proof: cols.proof,
          axis: cols.valueAxisHeader ?? "",
        };
    }
    if (cand) {
      buffered.push({ ...cand, start, heading, flat, wide });
    } else if (/日本|本邦/.test(flat) && RX_OVERSEAS_REGION.test(flat)) {
      // 日本(本邦) + 海外地域 + 数値 はあるが構造化できなかった → 取りこぼし候補
      sawGeoSignal = true;
    }
  }

  // 期首フィルタ (全候補共通・Gate1): 各候補の印刷 provenance を report header
  // (pe) と照合する。printed 期が Z (前期) と確定した表・明示矛盾 (mismatch)
  // の表だけ候補にしない (明確な前期/矛盾のみ除外)。facts.fiscalYearEnd は
  // pe 固定のため、前期表を残すと単独 best・score 差 best で前期値が当期
  // として保存される (tie 時の継承だけでは防げない)。T は終期=pe 検証済み。
  // unknown は比較前に落とさず残す (Solレビュー1)。最高点に unknown が
  // 残り明示候補と共存したら provenance 曖昧として後段で STOP する
  // (score だけでの unknown 採用も、highest-unknown を削っての T 都合採用
  // もしない)。明示表示が文書内に皆無のときは report header provenance
  // (当該有報=pe 期の開示) で unknown 単独採用し得る。
  // 確定鎖は値軸→表内→表外 (stale な表外表題より値軸/表内が強い)。
  // 除外で候補が尽きても sawGeoSignal が STOP (未構造化) へ流す。
  {
    const inhs = buffered.map((b) =>
      resolveCandidateFiscal(b.axis, b.flat, b.wide, reportPeriodEnd)
    );
    for (let i = 0; i < buffered.length; i++) {
      const b = buffered[i];
      const inh = inhs[i];
      if (inh === "mismatch" || (inh && inh.side === "Z")) {
        sawGeoSignal = true;
        continue;
      }
      candidates.push({
        status: b.status,
        facts: b.facts,
        proof: b.proof,
        axis: b.axis,
        score: scoreCandidate(b.heading, b.flat, b.status),
        start: b.start,
        heading: b.heading,
        flat: b.flat,
        wide: b.wide,
      });
    }
  }

  if (candidates.length > 0) {
    // 当期・連結・地域注記に最も近い候補を採用。同点は文書の早い方 (連結注記は
    // 個別注記より前に出る) を優先する。ただし同点 top が同一期間/scope の売上
    // metric で値が矛盾する表同士のときは文書順で選ばず未構造化にする (同値は
    // 代表に収束)。矛盾候補の先頭採用は aggregate-before-dedup と同型の誤り。
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const best = candidates[0];
    const tops = candidates.filter((c) => c.score === best.score);
    // provenance 曖昧の STOP (Solレビュー1の(b)): 最高点に fiscal-unknown が
    // 残り、明示 (T/side-only) 候補と共存したら STOP する。unknown を score
    // だけで採用することも、highest-unknown を削って T を都合採用することも
    // しない。明示が皆無の文書では unknown 単独が report header provenance
    // で採用され得る (後段の既存経路)。
    {
      const fiscalOf = (c: Cand): FiscalResolution =>
        resolveCandidateFiscal(c.axis, c.flat, c.wide, reportPeriodEnd);
      const topsHasUnknown = tops.some((c) => fiscalOf(c) === null);
      const survivorsHasExplicit = candidates.some((c) => fiscalOf(c) !== null);
      if (topsHasUnknown && survivorsHasExplicit) {
        return { status: "geo_present_unstructured", facts: [], tablesScanned };
      }
    }
    if (tops.length > 1) {
      // 不明/混在の contract で競合する候補は STOP (Gate2。曖昧な表の中から
      // 都合の良い候補を選ばない。単独候補の unknown は report header
      // provenance で残す = Gate1 の期首フィルタ)。
      if (
        tops.some((c) => {
          const k = contractOf(c.facts, c.heading, c.flat);
          return k === "unknown" || k === "mixed";
        })
      ) {
        return { status: "geo_present_unstructured", facts: [], tablesScanned };
      }
      // 最高点群を (sourceFiscal, 連結区分, 単位, contract) で group 化し、
      // 各 group 内の全 facts を全比較する。best 対他だけの比較では第3者
      // 同士の矛盾を見逃す。単一 group + 全キー一致→先頭に収束 (metric
      // 標識ありは R1 すり抜けの証拠なので収束させず STOP)。group 内
      // 不一致→STOP。複数 group→継承 tiebreak (T/Z のみ) か STOP。
      // contract (Gate2) が違う表は脚同値でも収束させない (TA7H)。
      const groupOf = (c: Cand): string => {
        const f0 = c.facts[0];
        const scope = f0
          ? `${String(f0.isConsolidated)}|${f0.unitLabel}`
          : "empty";
        return `${sourceFiscalKey(c, reportPeriodEnd)}|${scope}|${contractOf(c.facts, c.heading, c.flat)}`;
      };
      const groups = new Map<string, Cand[]>();
      for (const c of tops) {
        const k = groupOf(c);
        const g = groups.get(k);
        if (g) g.push(c);
        else groups.set(k, [c]);
      }
      let internalConflict = false;
      for (const g of groups.values()) {
        const keys = g.map((c) => normFactsKey(c.facts));
        if (!keys.every((k) => k === keys[0])) {
          internalConflict = true;
          break;
        }
      }
      if (internalConflict) {
        return { status: "geo_present_unstructured", facts: [], tablesScanned };
      }
      if (groups.size === 1) {
        // 全 top が同一 group・同一キー。metric 標識つきの収束は
        // 非売上値の保存になり得るので STOP (fail-closed)。
        if (tops.some((c) => hasMetricMarkers(c.flat))) {
          return { status: "geo_present_unstructured", facts: [], tablesScanned };
        }
        return {
          status: best.status,
          facts: best.facts,
          tablesScanned,
          proof: best.proof,
        };
      }
      // 複数 group: 継承 T/Z ペアだけ T 側を採る (S100R98H/S100TU43/
      // S100W4M7/S100YJKO の E00766 4期連続 + S100AO7M/S100TTUY で実証。
      // 経営指標の売上高系列で継承 T=当期を確認)。それ以外は STOP。
      // 文書順 proxy・metric-clean 優先は使わない。TA7H 型 (共に継承 T)・
      // TZ 汚染ペアは同 group 不一致→STOP に流れる。
      const current = pickCurrentOfFiscalPair(tops, reportPeriodEnd);
      if (current) {
        return {
          status: current.status,
          facts: current.facts,
          tablesScanned,
          proof: current.proof,
        };
      }
      return { status: "geo_present_unstructured", facts: [], tablesScanned };
    }
    return {
      status: best.status,
      facts: best.facts,
      tablesScanned,
      proof: best.proof,
    };
  }

  return {
    status: sawGeoSignal ? "geo_present_unstructured" : "no_overseas_table",
    facts: [],
    tablesScanned,
  };
}
