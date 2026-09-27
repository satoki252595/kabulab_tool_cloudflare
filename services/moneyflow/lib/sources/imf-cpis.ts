/**
 * 取得元: IMF CPIS (Coordinated Portfolio Investment Survey)
 *
 * 何のデータか: IMF (国際通貨基金) が加盟各国から集める対外証券投資の**残高**
 * (ストック) 調査。「日本の投資家が海外のどの国・地域の証券をどれだけ保有しているか」
 * (資産, Assets) と「海外の投資家が日本の証券をどれだけ保有しているか」(負債の
 * 相手国内訳。IMF が Assets 側の報告を国ごとに集計し直した Derived 系列) の両方を、
 * 相手国・地域別 (COUNTERPART_AREA) かつ資産クラス別 (Equity / Debt Securities /
 * Total) に提供する。
 *
 * 計画書 (notion-velvet-goose.md) の要件対応表では R4「日本⇔海外」のうち
 * 「世界の概況」枠 (近似のみ。すべて残高で真のフローではない) に対応する。
 *
 * ## URL 解決について (このモジュール固有の事情)
 * 依頼取得元インベントリの `url` 欄が指す `https://data.imf.org/en/datasets/
 * IMF.STA:CPIS` は 2026-09-27 時点で HTTP 404 (実在しない)。IMF 自身の旧 SDMX API
 * (dataservices.imf.org) は DNS 解決不可 (廃止済み)。後継の新 IMF Data API
 * (portal.api.imf.org 系) はベータポータルへのサインイン登録が必須で、
 * このセッションでは未登録のため到達を確認できなかった。
 *
 * 唯一、無料・無登録・SDMX 相当の JSON で機械可読に取得できた経路が、
 * フランス銀行傘下の CEPREMAP が運営する非営利オープンデータプロジェクト
 * DBnomics (https://db.nomics.world/IMF/CPIS) — 取得元インベントリの `url` 欄
 * 自身もこの URL を代替として挙げている。DBnomics 公式 (db.nomics.world/about)
 * は「DBnomics が配信するデータは元の提供元 (ここでは IMF) と同じライセンス・
 * 利用条件に従う」と明記しており (集約データベース自体は ODbL)、IMF CPIS の
 * 利用条件 (無料・出典明記必須) をそのまま引き継ぐ。
 *
 * ## 既知の制約 (2026-09-27 実機確認・重要)
 * DBnomics 上の CPIS データセットのメタデータ (`updated_at`) は 2025-04-08 で
 * 止まっている。実際に JP→US・JP→World・US→JP など複数系列の最新観測が
 * 揃って 2024-S1 で止まっていることを確認した。つまり
 * **本モジュールの「最新期」は「DBnomics が最後にミラーした時点での最新」であり、
 * 「IMF が実際に公表した最新」ではない。** IMF 本体の公表からさらに数か月〜
 * 1年以上遅れている可能性がある。この乖離を埋める代替の無登録経路は
 * 今回の調査では見つからなかった (制約として `docs` 等に残すこと)。
 * フォールバックで埋めず、「DBnomics 側で観測できた最新」をそのまま返す
 * (ルール2)。
 *
 * ## 頻度
 * データセット説明 (notes) は「年次調査は 2001 年〜、半期調査は 2013 年〜」と
 * 記載するが、実際に取得した系列には 1997-S2 の観測も存在した (年次のみの
 * 時代の値を便宜上 S2 ラベルに載せていると見られる)。四半期 (Quarterly) の
 * 系列は存在しない (依頼文の「四半期」という表現は誤りで、正しくは「半期」)。
 * 年次 (FREQ=A) は半期の年末値 (S2) と完全一致する重複系列のため、本モジュールは
 * 半期 (FREQ=B) のみを対象にする。
 * ただし 2013 年より前の "YYYY-S1" は半期調査の正式開始前に一部の国だけが
 * 報告した試行分で網羅範囲が違う (世界計が 1/40 程度に落ちる) ため取り込まない
 * (IMF_CPIS_SEMIANNUAL_START_YEAR 参照)。年次調査時代の値は "YYYY-S2" (年末値)
 * に載っており、前後の期の間隔は 2012 年以前が 1 年、2013 年以降が半年になる。
 */

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** このモジュールが対応する頻度は半期のみ (上記コメント参照)。 */
export type ImfCpisFreq = "B";

/** 資産の向き。どちらも REF_AREA=JP に固定し、COUNTERPART_AREA を相手国にする。 */
export type ImfCpisDirection =
  /** 日本の投資家が保有する海外証券の残高 (保有先国別)。IMF の Assets 系列。 */
  | "jp_holds_abroad"
  /** 海外の投資家が保有する日本証券の残高 (投資元国別)。IMF の Derived Liabilities 系列。 */
  | "world_holds_jp";

export type ImfCpisAssetClass = "total" | "equity" | "debt";

export type ImfCpisFlowType =
  | "net_flow"
  | "gross_turnover"
  | "holdings_stock"
  | "positions"
  | "fund_flow"
  | "estimated"
  | "price_only";

/** この取得元が生成する指標の定義 (観測ログ DB の「指標定義」に対応)。 */
export interface ImfCpisIndicatorDef {
  key: string;
  displayName: string;
  requirements: readonly string[];
  /** 何を測るか (固定語彙)。IMF CPIS はすべて残高 (ストック) で、フローではない。 */
  flowType: ImfCpisFlowType;
  /** 平易な説明 + 財務的に正確な定義 (ルール7 のバルーンヘルプに転用できる文面)。 */
  description: string;
  unit: "USD";
  sourceUrl: string;
  usageTerms: string;
  frequency: "semiannual";
  limitations: string;
}

/** パース済みの 1 レコード (国・地域 × 資産クラス × 期間 × 値)。 */
export interface ImfCpisRecord {
  /** この取得元が定義する指標キー (IMF_CPIS_INDICATORS のいずれか)。 */
  indicatorKey: string;
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  /** 対象期間。"YYYY-S1" (1〜6月末時点) / "YYYY-S2" (7〜12月末時点)。 */
  period: string;
  /**
   * IMF CPIS の REF_AREA/COUNTERPART_AREA コード (相手国・地域)。
   * ISO 3166-1 alpha-2 相当だが、"W00" (世界計) 等の IMF 独自の集計コードも
   * 含む。名称への変換はここでは行わない (誤訳・恣意的な補完を避けるため。
   * 表示名が要るなら呼び出し側の責務とする)。
   */
  counterpartArea: string;
  /** 残高 (ストック)。単位は USD (現地通貨建てではなく IMF が USD 換算した値)。 */
  valueUsd: number;
  /** この系列の DBnomics 上の完全な series_code (来歴確認・デバッグ用)。 */
  seriesCode: string;
}

/** 観測ログ DB へ書く縦持ちの行 (期間・指標キー・区分・値・単位・近似/推定)。 */
export interface ImfCpisObservationRow {
  period: string;
  indicatorKey: string;
  /** 区分 (このモジュールでは国・地域コード)。 */
  category: string;
  value: number;
  unit: "USD";
  /** 近似フラグ。CPIS は残高であり真のフロー (資金の純流入出) ではないため常に true。 */
  isApproximate: true;
  /**
   * 実測/推定。`jp_holds_abroad` (日本が自ら報告した資産保有) は実測 (false)。
   * `world_holds_jp` は IMF が他国の Assets 報告を鏡写しして算出した Derived
   * 系列であり、日本自身が国別に公表した統計ではないため推定 (true) として扱う。
   */
  isEstimated: boolean;
}

export interface ImfCpisFetchRequest {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  /** 相手国・地域コードの一覧。省略時は IMF_CPIS_DEFAULT_COUNTERPART_AREAS。 */
  counterpartAreas?: readonly string[];
}

export interface ImfCpisFetchResult {
  /** 実際に叩いた URL (複数チャンクに分割した場合は配列)。 */
  urls: string[];
  records: ImfCpisRecord[];
  /**
   * 要求したのに応答に含まれなかった series_code (DBnomics 上に系列が存在しない
   * 組み合わせ。例: CPIS に参加していない国・地域を投資元とする Derived 系列)。
   * 黙って欠落させず、呼び出し側がログ/通知できるよう明示的に返す (ルール2)。
   */
  missingSeriesCodes: string[];
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

export const IMF_CPIS_DATASET = "IMF/CPIS";
export const IMF_CPIS_API_BASE = "https://api.db.nomics.world/v22/series";
export const IMF_CPIS_SOURCE_URL = "https://db.nomics.world/IMF/CPIS";

// DBnomics は通常の公開 JSON API であり、JPX 統計ページのような UA ベースの
// bot 対策 (WAF) は確認されなかった (2026-09-27 実機確認: UA なしの curl でも
// HTTP 200)。そのためブラウザ偽装 UA ではなく、API 利用マナーとして素性が
// わかる UA 文字列だけを名乗る。個人を特定できる情報 (メールアドレス等) は
// 外部サービスへ送らない。
export const IMF_CPIS_USER_AGENT =
  "kabulab-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

// DBnomics のバッチ取得 (series_ids) は URL クエリ 1 本にまとめて叩けるが、
// 際限なく増やすと URL 長がプロキシ等の実務的な上限に近づく。1 回のリクエストに
// 詰め込む系列数を安全側に固定するチャンクサイズ (経験則。DBnomics の公式ドキュメントに
// 明記された上限は見つからなかったため、保守的な値を採る)。
export const IMF_CPIS_MAX_SERIES_PER_REQUEST = 60;

/**
 * 既定で問い合わせる相手国・地域コード。
 *
 * IMF CPIS は 249 の国・地域コードを持つが、個人用ダッシュボードとして毎回
 * 全件を取得する意味は薄く、計画書が見込む観測ログの行数感 (年間数千行) を
 * 大きく超えてしまう。ここでは実機検証 (2024-S1, JP→World) で確認した
 * 「日本の対外証券投資の相手国として残高が大きい国・地域」を中心に、
 * G7 + 投資信託/ファンドの設立地としてクロスボーダー統計に頻出する国
 * (ケイマン諸島・ルクセンブルク・アイルランド) + アジア主要国を選んだ。
 * "W00" は IMF CPIS の世界計コード (国別内訳の合計と突き合わせる検算用)。
 *
 * **これは IMF が定めた「主要国」リストではなく、実装上のキュレーションである。**
 * 呼び出し側は `ImfCpisFetchRequest.counterpartAreas` で自由に上書きできる。
 */
export const IMF_CPIS_DEFAULT_COUNTERPART_AREAS = [
  "W00",
  "US",
  "KY",
  "GB",
  "LU",
  "IE",
  "FR",
  "DE",
  "NL",
  "CH",
  "AU",
  "CA",
  "HK",
  "SG",
  "KR",
  "TW",
  "CN",
] as const;

/** direction × assetClass → IMF SDMX の INDICATOR コード。 */
const INDICATOR_CODE: Record<
  ImfCpisDirection,
  Record<ImfCpisAssetClass, string>
> = {
  jp_holds_abroad: {
    total: "I_A_T_T_T_BP6_USD",
    equity: "I_A_E_T_T_BP6_USD",
    debt: "I_A_D_T_T_BP6_USD",
  },
  world_holds_jp: {
    total: "I_L_T_T_T_BP6_DV_USD",
    equity: "I_L_E_T_T_BP6_DV_USD",
    debt: "I_L_D_T_T_BP6_DV_USD",
  },
};

interface IndicatorMeta {
  key: string;
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  isEstimated: boolean;
}

/** IMF SDMX の INDICATOR コード文字列 → このモジュールの指標メタ情報。 */
const INDICATOR_LOOKUP = new Map<string, IndicatorMeta>();
for (const direction of ["jp_holds_abroad", "world_holds_jp"] as const) {
  for (const assetClass of ["total", "equity", "debt"] as const) {
    const code = INDICATOR_CODE[direction][assetClass];
    const key = `imf_cpis_${direction === "jp_holds_abroad" ? "jp_assets" : "jp_liabilities"}_${assetClass}`;
    INDICATOR_LOOKUP.set(code, {
      key,
      direction,
      assetClass,
      isEstimated: direction === "world_holds_jp",
    });
  }
}

const ASSET_CLASS_JA: Record<ImfCpisAssetClass, string> = {
  total: "株式・投資信託受益証券と債券の合計",
  equity: "株式・投資信託受益証券のみ",
  debt: "債券 (長期・短期の合計) のみ",
};

/**
 * この取得元が export する指標定義 (観測ログ DB の「指標定義」DB に対応)。
 * 6 種類 = 向き (日本→海外 / 海外→日本) × 資産クラス (合計/株式/債券)。
 */
export const IMF_CPIS_INDICATORS: readonly ImfCpisIndicatorDef[] = (
  ["jp_holds_abroad", "world_holds_jp"] as const
).flatMap((direction) =>
  (["total", "equity", "debt"] as const).map((assetClass): ImfCpisIndicatorDef => {
    const meta = INDICATOR_LOOKUP.get(INDICATOR_CODE[direction][assetClass])!;
    const isAbroad = direction === "jp_holds_abroad";
    // CPIS は外貨準備 (reserve assets) として保有される証券を対象外とする
    // (IMF CPIS Guide。外貨準備分は別調査 SEFER で集計)。日本の外貨準備
    // (約1.2兆ドル、大半が外国債券) はこの残高に含まれない。
    // Liabilities (Derived) 側の「日本の証券」は日本の居住者 (企業・政府など)
    // が発行した証券であり、「日本国内で保有」された証券という意味ではない。
    const subject = isAbroad
      ? "日本の投資家 (企業・金融機関・個人など。ただし国の外貨準備は含まない) が保有する海外で発行された証券"
      : "海外の投資家が保有する日本の企業・政府などが発行した証券 (日本株・日本国債など)";
    const breakdown = isAbroad ? "保有先の国・地域別" : "投資元の国・地域別";
    const provenance = isAbroad
      ? "日本自身が IMF に報告した実測値。"
      : "日本自身が国別に集計・公表した統計ではなく、IMF が各国の『資産保有』報告を鏡写しして算出した推定値 (Derived)。";
    return {
      key: meta.key,
      displayName: `IMF CPIS ${isAbroad ? "対外証券投資残高" : "対日証券投資残高"} (${ASSET_CLASS_JA[assetClass]}・${breakdown})`,
      requirements: ["R4"],
      flowType: "holdings_stock",
      description:
        `${subject} (${ASSET_CLASS_JA[assetClass]}) の『残高』(ある時点で保有している額) を、${breakdown}示します。` +
        `半年に一度 (6月末・12月末時点) IMF (国際通貨基金) が世界各国の当局から集めて集計する国際調査 (CPIS) に基づきます。` +
        `${provenance}` +
        " 注意: これは『いくら新しく売買したか』(フロー) ではなく『今どれだけ持っているか』(ストック) です。" +
        "株価や為替レートが動くだけでも、実際の売買がなくても残高は変わります。",
      unit: "USD",
      sourceUrl: IMF_CPIS_SOURCE_URL,
      usageTerms:
        "無料。IMF (原典) の利用条件を継承し、出典明記が必要 (attribution_required)。" +
        "取得は IMF 直接ではなく DBnomics (CEPREMAP運営の非営利オープンデータプロジェクト) 経由のミラー配信で、" +
        "DBnomics 公式 (db.nomics.world/about) は『配信するデータは元の提供元と同じライセンス・利用条件に従う』と明記している" +
        " (集約データベース自体は ODbL)。本プロジェクトでは個人利用の範囲に限って使う。",
      frequency: "semiannual",
      limitations:
        "残高 (ストック) であり真の資金フローではない近似指標 (計画書 R4『世界の概況』枠)。" +
        "DBnomics 側のミラー更新が IMF 本体の公表より数か月〜1年以上遅れている場合がある" +
        " (2026-09-27 実機確認: 複数系列で最新観測が 2024-S1 止まり)。" +
        " CPIS は外貨準備として保有される証券を対象外とする (IMF CPIS Guide)。" +
        (isAbroad
          ? " 日本の外貨準備 (財務省・日銀が持つ外国債券など) はこの残高に含まれない。"
          : " 海外の中央銀行が外貨準備として持つ日本国債等は含まれず、CPIS に参加していない国・地域の保有分や、" +
            "対象国が守秘義務等でIMFに非開示とした保有分も反映されない (Derived系列のため。過小評価の方向にバイアスしうる)。"),
    };
  })
);

// ---------------------------------------------------------------------------
// URL 解決
// ---------------------------------------------------------------------------

/** direction/assetClass/相手国から DBnomics の series_code (FREQ.REF_AREA.INDICATOR.REF_SECTOR.COUNTERPART_SECTOR.COUNTERPART_AREA) を組み立てる。 */
export function buildImfCpisSeriesCode(params: {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  counterpartArea: string;
  freq?: ImfCpisFreq;
}): string {
  const freq = params.freq ?? "B";
  const area = params.counterpartArea.trim();
  if (!/^[A-Z0-9_]{2,8}$/.test(area)) {
    throw new Error(
      `IMF CPIS: 相手国・地域コードの形式が不正です: "${params.counterpartArea}"`
    );
  }
  const indicator = INDICATOR_CODE[params.direction][params.assetClass];
  // REF_SECTOR / COUNTERPART_SECTOR は常に "T" (Total Holdings) に固定する。
  // 部門別 (中央銀行・保険等) の内訳は今回のスコープ外。
  return `${freq}.JP.${indicator}.T.T.${area}`;
}

/** series_code の配列から DBnomics のバッチ取得 URL を組み立てる (パラメータのみ・純関数)。 */
export function buildImfCpisUrl(seriesCodes: readonly string[]): string {
  if (seriesCodes.length === 0) {
    throw new Error("IMF CPIS: series_codes が空です");
  }
  const ids = seriesCodes
    .map((code) => `${IMF_CPIS_DATASET}/${code}`)
    .join(",");
  const params = new URLSearchParams({ series_ids: ids, observations: "1" });
  return `${IMF_CPIS_API_BASE}?${params.toString()}`;
}

/** 系列コードの配列を IMF_CPIS_MAX_SERIES_PER_REQUEST 件ずつに分割する。 */
export function chunkImfCpisSeriesCodes(
  seriesCodes: readonly string[],
  size: number = IMF_CPIS_MAX_SERIES_PER_REQUEST
): string[][] {
  if (size <= 0) {
    throw new Error(`IMF CPIS: チャンクサイズは正の整数にすること: ${size}`);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < seriesCodes.length; i += size) {
    chunks.push(seriesCodes.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// パーサ (純関数)
// ---------------------------------------------------------------------------

const PERIOD_RE = /^(\d{4})-S([12])$/;

/**
 * IMF の半期 CPIS が正式に始まった年 (データセット notes: "semiannual data
 * beginning 2013")。それより前の "YYYY-S1" 観測は正式調査ではなく一部の国だけが
 * 任意報告した試行分で、網羅範囲が年末値 (S2) と比較にならない。
 * 2026-09-27 実データ: 海外→日本 (Derived, 世界計 W00) は 2008-S2=1,166.0B USD,
 * 2009-S1=25.4B, 2009-S2=1,150.2B … 2012-S1=32.1B と、S1 だけ 1/40 程度に
 * 落ち込む (報告国が少ないだけで、残高が実際に減ったわけではない)。
 * 本物の「世界計」と誤認させない・前期比を壊さないため、2013 年より前の S1 は
 * 取り込まない (年次調査時代の S2 = 年末値は正式な年次 CPIS なので残す)。
 */
export const IMF_CPIS_SEMIANNUAL_START_YEAR = 2013;

/** DBnomics の series.docs から series_code を取り出す (形状は parseImfCpisResponse で検証済みの前提)。 */
function responseSeriesCodes(json: unknown): { codes: string[]; numFound: unknown } {
  const series = (json as { series: { docs: Array<{ series_code: string }>; num_found?: unknown } })
    .series;
  return { codes: series.docs.map((d) => d.series_code), numFound: series.num_found };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * DBnomics `/v22/series` の応答 (JSON.parse 済み) を型付きレコードへ変換する
 * 純関数パーサ。想定と違う形 (キー欠落・型不一致・未知の INDICATOR・
 * FREQ が B でない 等) は必ず throw する (ルール2: 無効値で埋めて続行しない)。
 *
 * 欠損値 (IMF が守秘義務で非開示にした組み合わせ) は JSON 上 `null` として
 * 配列に現れることがある。これは「形式違反」ではなく CPIS では正常な状態
 * なので throw せず、そのデータ点だけ読み飛ばす (0 や既定値で埋めない)。
 */
export function parseImfCpisResponse(json: unknown): ImfCpisRecord[] {
  if (!isRecord(json) || !isRecord(json.series)) {
    throw new Error(
      "IMF CPIS (DBnomics): 応答形式が想定と異なります (series オブジェクトが見つかりません)"
    );
  }
  const docs = json.series.docs;
  if (!Array.isArray(docs)) {
    throw new Error(
      "IMF CPIS (DBnomics): 応答形式が想定と異なります (series.docs が配列ではありません)"
    );
  }

  const records: ImfCpisRecord[] = [];

  for (const doc of docs) {
    if (!isRecord(doc)) {
      throw new Error("IMF CPIS (DBnomics): series.docs の要素がオブジェクトではありません");
    }
    const seriesCode = doc.series_code;
    if (typeof seriesCode !== "string") {
      throw new Error("IMF CPIS (DBnomics): series_code が文字列ではありません");
    }
    const dims = doc.dimensions;
    if (!isRecord(dims)) {
      throw new Error(
        `IMF CPIS (DBnomics): dimensions が見つかりません (series_code=${seriesCode})`
      );
    }
    const freq = dims.FREQ;
    if (freq !== "B") {
      // 想定外の頻度 (例: 四半期 Q や年次 A) が混ざっていたら、取得側の
      // クエリ組み立てが壊れているサインなので黙って無視せず throw する。
      throw new Error(
        `IMF CPIS (DBnomics): 想定外の FREQ です (半期 "B" のみ対応): ${String(freq)} (series_code=${seriesCode})`
      );
    }
    const refArea = dims.REF_AREA;
    if (refArea !== "JP") {
      throw new Error(
        `IMF CPIS (DBnomics): 想定外の REF_AREA です (JP のみ対応): ${String(refArea)} (series_code=${seriesCode})`
      );
    }
    const indicatorCode = dims.INDICATOR;
    if (typeof indicatorCode !== "string") {
      throw new Error(
        `IMF CPIS (DBnomics): INDICATOR が文字列ではありません (series_code=${seriesCode})`
      );
    }
    const meta = INDICATOR_LOOKUP.get(indicatorCode);
    if (!meta) {
      // 未知の INDICATOR コード = IMF/DBnomics 側の様式変更の可能性が高い。
      // 別の指標として誤収載するより、ここで止めて人に気づかせる。
      throw new Error(
        `IMF CPIS (DBnomics): 未知の INDICATOR コードです (様式変更の可能性): ${indicatorCode} (series_code=${seriesCode})`
      );
    }
    // 部門 (REF_SECTOR / COUNTERPART_SECTOR) は常に "T" (Total Holdings) の系列だけを
    // 扱う。中央銀行・保険など部門別の系列が紛れ込むと、INDICATOR が同じため
    // 「合計」として誤収載されてしまうので、ここで止める。
    if (dims.REF_SECTOR !== "T" || dims.COUNTERPART_SECTOR !== "T") {
      throw new Error(
        `IMF CPIS (DBnomics): 想定外の部門です (REF_SECTOR/COUNTERPART_SECTOR は "T" のみ対応): ` +
          `${String(dims.REF_SECTOR)}/${String(dims.COUNTERPART_SECTOR)} (series_code=${seriesCode})`
      );
    }
    const counterpartArea = dims.COUNTERPART_AREA;
    if (typeof counterpartArea !== "string" || counterpartArea.length === 0) {
      throw new Error(
        `IMF CPIS (DBnomics): COUNTERPART_AREA が文字列ではありません (series_code=${seriesCode})`
      );
    }

    const periods = doc.period;
    const values = doc.value;
    if (!Array.isArray(periods) || !Array.isArray(values)) {
      throw new Error(
        `IMF CPIS (DBnomics): period/value が配列ではありません (series_code=${seriesCode})`
      );
    }
    if (periods.length !== values.length) {
      throw new Error(
        `IMF CPIS (DBnomics): period と value の長さが一致しません (series_code=${seriesCode}, ` +
          `period=${periods.length}, value=${values.length})`
      );
    }

    for (let i = 0; i < periods.length; i++) {
      const period = periods[i];
      const value = values[i];
      if (typeof period !== "string" || !PERIOD_RE.test(period)) {
        throw new Error(
          `IMF CPIS (DBnomics): 期間表記が YYYY-S1/YYYY-S2 形式ではありません: ${String(period)} (series_code=${seriesCode})`
        );
      }
      const m = PERIOD_RE.exec(period)!;
      if (m[2] === "1" && Number(m[1]) < IMF_CPIS_SEMIANNUAL_START_YEAR) {
        // 半期調査の正式開始前の S1 (一部報告国のみの試行分)。上の定数コメント参照。
        continue;
      }
      if (value === null || value === undefined) {
        // 守秘義務等による非開示。フォールバックで 0 埋めせず読み飛ばす。
        continue;
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(
          `IMF CPIS (DBnomics): 値が有限の数値ではありません: ${String(value)} (series_code=${seriesCode}, period=${period})`
        );
      }
      records.push({
        indicatorKey: meta.key,
        direction: meta.direction,
        assetClass: meta.assetClass,
        period,
        counterpartArea,
        valueUsd: value,
        seriesCode,
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

/**
 * IMF CPIS (DBnomics 経由) を取得し、型付きレコードへパースして返す。
 *
 * 複数の direction/assetClass/相手国の組み合わせを 1 回の呼び出しにまとめられる
 * (内部で IMF_CPIS_MAX_SERIES_PER_REQUEST 件ずつのバッチ HTTP リクエストに
 * チャンク分割する。「1 回の実行で必要最小限のアクセス」の方針に沿い、
 * 相手国 1 件ごとに別リクエストを打つ実装にはしない)。
 *
 * @throws HTTP エラー / 応答形式が想定と異なる場合 (ルール2: フォールバックしない)
 */
export async function fetchImfCpis(
  requests: readonly ImfCpisFetchRequest[],
  opts: { freq?: ImfCpisFreq; fetchImpl?: typeof fetch } = {}
): Promise<ImfCpisFetchResult> {
  if (requests.length === 0) {
    throw new Error("IMF CPIS: requests が空です");
  }
  const freq = opts.freq ?? "B";
  const doFetch = opts.fetchImpl ?? fetch;

  const seriesCodes = requests.flatMap((req) => {
    const areas = req.counterpartAreas ?? IMF_CPIS_DEFAULT_COUNTERPART_AREAS;
    if (areas.length === 0) {
      throw new Error(
        `IMF CPIS: counterpartAreas が空です (direction=${req.direction}, assetClass=${req.assetClass})`
      );
    }
    return areas.map((area) =>
      buildImfCpisSeriesCode({
        direction: req.direction,
        assetClass: req.assetClass,
        counterpartArea: area,
        freq,
      })
    );
  });

  const chunks = chunkImfCpisSeriesCodes(seriesCodes);
  const urls: string[] = [];
  const records: ImfCpisRecord[] = [];
  const missingSeriesCodes: string[] = [];

  for (const chunk of chunks) {
    const url = buildImfCpisUrl(chunk);
    urls.push(url);
    const res = await doFetch(url, {
      headers: { "User-Agent": IMF_CPIS_USER_AGENT, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `IMF CPIS (DBnomics) HTTP エラー: ${res.status} ${res.statusText} (${url})`
      );
    }
    const json: unknown = await res.json();
    records.push(...parseImfCpisResponse(json));

    // 要求した系列と応答の系列を突き合わせる。取りこぼし (ページング打ち切り)・
    // 要求外/重複の系列は様式異常として止め、存在しない系列は明示的に返す。
    const { codes: returned, numFound } = responseSeriesCodes(json);
    if (typeof numFound === "number" && numFound > returned.length) {
      throw new Error(
        `IMF CPIS (DBnomics): 応答が途中で打ち切られています (num_found=${numFound}, docs=${returned.length}, ${url})`
      );
    }
    const requested = new Set(chunk);
    const seen = new Set<string>();
    for (const code of returned) {
      if (!requested.has(code)) {
        throw new Error(`IMF CPIS (DBnomics): 要求していない系列が返されました: ${code} (${url})`);
      }
      if (seen.has(code)) {
        throw new Error(`IMF CPIS (DBnomics): 同じ系列が重複して返されました: ${code} (${url})`);
      }
      seen.add(code);
    }
    missingSeriesCodes.push(...chunk.filter((code) => !seen.has(code)));
  }

  return { urls, records, missingSeriesCodes };
}

// ---------------------------------------------------------------------------
// 期間・公表判定
// ---------------------------------------------------------------------------

export const IMF_CPIS_PERIODICITY = "semiannual" as const;

/** "YYYY-S1"/"YYYY-S2" を年・半期に分解する。形式が違えば throw する。 */
export function parseImfCpisPeriod(period: string): { year: number; half: 1 | 2 } {
  const m = PERIOD_RE.exec(period);
  if (!m) {
    throw new Error(
      `IMF CPIS: 半期の期間表記 (YYYY-S1/YYYY-S2) ではありません: ${period}`
    );
  }
  return { year: Number(m[1]), half: Number(m[2]) as 1 | 2 };
}

/** 2 つの半期ラベルを時系列順に比較する (a が新しければ正の値)。 */
export function compareImfCpisPeriods(a: string, b: string): number {
  const pa = parseImfCpisPeriod(a);
  const pb = parseImfCpisPeriod(b);
  if (pa.year !== pb.year) return pa.year - pb.year;
  return pa.half - pb.half;
}

/** 与えた半期ラベルの次 (S1→同年S2, S2→翌年S1) を返す。 */
export function nextImfCpisPeriod(period: string): string {
  const { year, half } = parseImfCpisPeriod(period);
  return half === 1 ? `${year}-S2` : `${year + 1}-S1`;
}

/** 観測期間の集合から最新のものを返す。空配列なら undefined (憶測で埋めない)。 */
export function latestImfCpisPeriod(periods: readonly string[]): string | undefined {
  if (periods.length === 0) return undefined;
  return periods.reduce((latest, p) =>
    compareImfCpisPeriods(p, latest) > 0 ? p : latest
  );
}

/** 日付 (UTC) が属する半期ラベルを返す (1〜6月→S1, 7〜12月→S2)。カレンダー計算のみで公表可否は判定しない。 */
export function currentImfCpisPeriodLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const half: 1 | 2 = month <= 6 ? 1 : 2;
  return `${year}-S${half}`;
}

/**
 * targetPeriod が records に実在するか (＝取得元から見て「公表済み」か) を、
 * 実測データの有無だけで判定する。日付からの憶測はしない (ルール2)。
 *
 * 注意 (このモジュール固有の制約): ここでの「公表済み」は「DBnomics のミラーに
 * 反映済み」の意味であり、IMF 本体がまだ公表していないのか、公表済みだが
 * DBnomics 側のミラー更新が遅れているだけなのかは、この関数だけからは
 * 区別できない (モジュール先頭のコメント「既知の制約」を参照)。
 */
export function isImfCpisPeriodPublished(
  records: readonly { period: string }[],
  targetPeriod: string
): boolean {
  return records.some((r) => r.period === targetPeriod);
}

// ---------------------------------------------------------------------------
// 観測ログ用の縦持ち変換
// ---------------------------------------------------------------------------

/** パース済みレコードを、観測ログ DB へ書く縦持ちの行に変換する。 */
export function toImfCpisObservationRows(
  records: readonly ImfCpisRecord[]
): ImfCpisObservationRow[] {
  return records.map((r) => ({
    period: r.period,
    indicatorKey: r.indicatorKey,
    category: r.counterpartArea,
    value: r.valueUsd,
    unit: "USD",
    isApproximate: true,
    isEstimated: r.direction === "world_holds_jp",
  }));
}
