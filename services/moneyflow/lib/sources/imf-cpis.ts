/**
 * 取得元: IMF PIP (Portfolio Investment Positions by Counterpart Economy, 旧称 CPIS)
 * 公式 SDMX 3.0 API — https://api.imf.org/external/sdmx/3.0 (匿名・登録不要)
 *
 * 何のデータか: IMF (国際通貨基金) が加盟各国から集める対外証券投資の**残高**
 * (ストック) 調査。「日本の投資家が海外のどの国・地域の証券をどれだけ保有しているか」
 * (資産, Assets) と「海外の投資家が日本の証券をどれだけ保有しているか」(負債の
 * 相手国内訳。IMF が Assets 側の報告を国ごとに集計し直した Derived 系列) の両方を、
 * 相手国・地域別かつ資産クラス別 (Equity / Debt Securities / Total) に提供する。
 *
 * 計画書 (notion-velvet-goose.md) の要件対応表では R4「日本⇔海外」のうち
 * 「世界の概況」枠 (近似のみ。すべて残高で真のフローではない) に対応する。
 *
 * ## 公式口への移行 (2026-09-28 実機確認)
 * 旧実装は DBnomics (CEPREMAP 運営の非営利ミラー) 経由で IMF CPIS を取得していた。
 * ミラーの更新は 2025-04-08 で止まり、複数系列の最新観測が 2024-S1 止まりだった。
 * 2026-09-28 に IMF 公式 SDMX 3.0 API の匿名到達を確認し、本モジュールは公式口専用に
 * 書き換えた。ミラーの URL・系列コード・パーサは残さない (黙った付替え防止のため
 * 公式・ミラーの混在経路を作らない。旧ミラー応答を本モジュールに渡すと様式異常で
 * throw する)。
 *
 * 公式契約 (一次証拠: dataflow `IMF.STA:PIP` v5.0.0 / DSD `IMF.STA:DSD_PIP` v5.0.0 /
 * `CL_PIP_COUNTRY` v2.0.0 / `CL_PIP_INDICATOR` v4.0.0 / `CL_ACCOUNTING_ENTRY` /
 * `CL_SECTOR` / `CL_FREQ` の実応答。一次データ保管への実体アーカイブは P1 枠で実施):
 * - データキー順: COUNTRY.ACCOUNTING_ENTRY.INDICATOR.SECTOR.COUNTERPART_SECTOR.
 *   COUNTERPART_COUNTRY.FREQUENCY (+ 観測次元 TIME_PERIOD)。応答の keyPosition 0〜6
 *   で実測どおり。
 * - 固定次元: COUNTRY=JPN (日本) / SECTOR=S1 (Total economy) /
 *   COUNTERPART_SECTOR=S1 / FREQUENCY=S (Half-yearly, semester)。
 * - 方向と指標の対応 (意味同一を実測で証明した範囲のみ。旧ミラー 2024-S1 値との突合):
 *   - jp_holds_abroad (資産・報告値): A + P_TOTINV_P_USD / P_F51_P_USD / P_F3_P_USD。
 *     応答属性 DERIVATION_TYPE=O (Reported official data)。
 *   - world_holds_jp (負債・Derived): L + P_TOTINV_P_SCC_USD / P_F51_P_SCC_USD /
 *     P_F3_P_SCC_USD。応答属性 DERIVATION_TYPE=SCC・DV_TYPE=SCC
 *     (IMF Staff calculations, derived from counterpart data)。
 *   - 旧ミラー Derived (I_L_*_DV_USD) と公式 _SCC_USD の 2024-S1 値は相手国別
 *     (米国: 合計・株式・債券) でセント単位まで完全一致。世界計は改訂差
 *     (+4.73%) あり。資産側は合計 −0.17%、株式/債券の内訳に ±2% の改訂
 *     (合計は安定) あり。改訂差は値の書換えであり系列の意味変更ではない。
 * - 結合してはならないもの (無根拠の同一視を禁止):
 *   JPN.L.P_TOTINV_P_USD (報告負債) は世界計で Derived の +28.6%、
 *   米国相手国別で +22% と大きく異なり、別の概念 (日本自身の報告値) である。
 *   本モジュールの対応表に L + 非SCC 指標は存在せず、要求も解釈もできない。
 * - PIP の全 60 指標は "Positions" (残高) で、フロー指標は無い。flowType
 *   holdings_stock を維持する。
 * - 単位: 応答属性 UNIT=USD (US dollar)。OBS_VALUE は米ドルそのままの値で、
 *   係数を掛けない。根拠: (a) ミラー値とのセント単位の一致、(b) 小数点以下
 *   3 桁 (セント精度) の値、(c) SCALE=6 を 10^6 の乗数と解釈すると世界 GDP の
 *   40 倍超になり不可能。SCALE は表示用メタデータとして「6」のみ受理し、
 *   それ以外の値・未知の単位が来たら throw する (様式変更の検知)。
 * - 相手国コードは公式 3 文字 (USA・CYM・GBR・…・G001=World。名称を codelist で
 *   確認済み)。要求側は旧来の 2 文字コード (US・KY・GB・…・W00) のまま受け、
 *   対応表で変換する (対応表に無いコードは throw し、推測で補わない)。
 *   台湾 (TWN) の Derived 系列は応答に存在しない (台湾は IMF 非加盟で CPIS に
 *   報告しないため IMF が集め直せない)。欠落として明示し、行は作らない。
 * - 系列ごとの最新期は揃わない (2026-09-28 実測: 資産側は全 17 相手国が 2025-S1、
 *   Derived 側は AU・SG が 2024-S2 止まり)。「日本・世界計の最新期」を全部の
 *   最新期とみなさない。最新期は要求系列の実観測から求め、応答に明示された
 *   TIME_PERIOD だけで期間を絞る。
 * - startPeriod/endPeriod クエリは公式 API に無視される (2024-S1 のみに絞る指定で
 *   全 38 期が返ることを実測)。本モジュールは期間クエリを送らない。
 *   lastNObservations は有効だが、遅延系列の取漏れを避けるため全履歴を取得して
 *   呼び出し側 (アダプタ) が応答明示の期間で絞る。
 * - 応答ごとに structures[].links の Dataflow/DSD の URN
 *   (IMF.STA:PIP(5.0.0) / IMF.STA:DSD_PIP(5.0.0)) を検証する。
 *   版が変わったら止めて人に気づかせる (黙った追従をしない)。
 *
 * ## 頻度
 * 半期 (S) のみ。2013 年より前の "YYYY-S1" は半期調査の正式開始前に一部の国だけが
 * 報告した試行分で網羅範囲が違う (世界計が 1/40 程度に落ちる) ため取り込まない
 * (IMF_CPIS_SEMIANNUAL_START_YEAR 参照。公式の Derived 世界計にも同じ試行分が
 * 含まれることを実測したため、規則は公式口でも維持する)。年次調査時代の値は
 * "YYYY-S2" (年末値) に載っており、前後の期の間隔は 2012 年以前が 1 年、
 * 2013 年以降が半年になる。
 */

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** 資産の向き。どちらも COUNTRY=JPN に固定し、COUNTERPART_COUNTRY を相手国にする。 */
export type ImfCpisDirection =
  /** 日本の投資家が保有する海外証券の残高 (保有先国別)。IMF の Assets 系列 (報告値)。 */
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
  /** 何を測るか (固定語彙)。IMF PIP はすべて残高 (ストック) で、フローではない。 */
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
   * IMF の相手国・地域コード (旧来の 2 文字表記。例: "US"・"W00")。
   * 下流 (アダプタの日本語区分名) との互換のために残す。公式 3 文字コードとの
   * 対応は COUNTERPART_AREA_MAP (名称を codelist で確認済みの範囲のみ)。
   */
  counterpartArea: string;
  /** 公式 COUNTERPART_COUNTRY コード (3 文字。例: "USA"・"G001")。 */
  counterpartCountry: string;
  /** 残高 (ストック)。単位は USD (IMF が USD 換算した値そのまま。係数なし)。 */
  valueUsd: number;
  /** この系列の公式データキー (来歴確認・デバッグ用)。 */
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
  /** 近似フラグ。pip は残高であり真のフロー (資金の純流入出) ではないため常に true。 */
  isApproximate: true;
  /**
   * 実測/推定。`jp_holds_abroad` (日本が自ら報告した資産保有。DERIVATION_TYPE=O)
   * は実測 (false)。`world_holds_jp` は IMF が他国の Assets 報告を鏡写しして
   * 算出した Derived 系列 (DERIVATION_TYPE=SCC・DV_TYPE=SCC) であり、日本自身が
   * 国別に公表した統計ではないため推定 (true) として扱う。
   */
  isEstimated: boolean;
}

export interface ImfCpisFetchRequest {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  /** 相手国・地域コードの一覧 (旧来の 2 文字表記)。省略時は IMF_CPIS_DEFAULT_COUNTERPART_AREAS。 */
  counterpartAreas?: readonly string[];
}

export interface ImfCpisFetchResult {
  /** 実際に叩いた URL (要求ごとに 1 本。複数相手国は `+` で束ねる)。 */
  urls: string[];
  records: ImfCpisRecord[];
  /**
   * 要求したのに応答に含まれなかった公式データキー (公式側に系列が存在しない
   * 組み合わせ。例: 台湾の Derived 系列)。
   * 黙って欠落させず、呼び出し側がログ/通知できるよう明示的に返す (ルール2)。
   */
  missingSeriesCodes: string[];
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

export const IMF_CPIS_API_BASE = "https://api.imf.org/external/sdmx/3.0";
export const IMF_CPIS_DATAFLOW_AGENCY = "IMF.STA";
export const IMF_CPIS_DATAFLOW_ID = "PIP";
export const IMF_CPIS_DATAFLOW_VERSION = "5.0.0";
export const IMF_CPIS_DSD_ID = "DSD_PIP";
export const IMF_CPIS_DSD_VERSION = "5.0.0";
/** 一次メタデータ (データセット頁)。"Portfolio Investment Positions by Counterpart Economy (formerly CPIS)"。 */
export const IMF_CPIS_SOURCE_URL = "https://data.imf.org/en/datasets/IMF.STA:PIP";

// 公式 SDMX API は匿名で到達できる (2026-09-28 実機確認)。API 利用マナーとして
// 素性がわかる UA 文字列だけを名乗る。個人を特定できる情報 (メールアドレス等) は
// 外部サービスへ送らない。
export const IMF_CPIS_USER_AGENT =
  "kabulab-moneyflow/1.0 (+https://kabulab-cf.satoki252595.workers.dev/)";

/** 1 回のリクエストに束ねる相手国の上限。URL 長の実務的な上限に近づけないための安全側の固定値。 */
export const IMF_CPIS_MAX_SERIES_PER_REQUEST = 60;

/**
 * 既定で問い合わせる相手国・地域コード (旧来の 2 文字表記)。
 *
 * IMF pip は 353 の国・地域コードを持つが、本ダッシュボードとして毎回
 * 全件を取得する意味は薄く、計画書が見込む観測ログの行数感 (年間数千行) を
 * 大きく超えてしまう。ここでは実機検証 (2024-S1, JP→World) で確認した
 * 「日本の対外証券投資の相手国として残高が大きい国・地域」を中心に、
 * G7 + 投資信託/ファンドの設立地としてクロスボーダー統計に頻出する国
 * (ケイマン諸島・ルクセンブルク・アイルランド) + アジア主要国を選んだ。
 * "W00" は旧 CPIS の世界計コード (公式では "G001"。国別内訳の合計と突き合わせる検算用)。
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

/**
 * 旧来の 2 文字コード → 公式 COUNTERPART_COUNTRY (3 文字) の対応表。
 * 全 17 件の名称を `CL_PIP_COUNTRY` v2.0.0 の実応答で確認済み
 * (例: CYM=Cayman Islands・G001=World・TWN=Taiwan Province of China)。
 * 表に無いコードは throw し、ISO 変換の推測で補わない (ルール2)。
 */
const COUNTERPART_AREA_MAP: ReadonlyMap<string, string> = new Map([
  ["W00", "G001"],
  ["US", "USA"],
  ["KY", "CYM"],
  ["GB", "GBR"],
  ["LU", "LUX"],
  ["IE", "IRL"],
  ["FR", "FRA"],
  ["DE", "DEU"],
  ["NL", "NLD"],
  ["CH", "CHE"],
  ["AU", "AUS"],
  ["CA", "CAN"],
  ["HK", "HKG"],
  ["SG", "SGP"],
  ["KR", "KOR"],
  ["TW", "TWN"],
  ["CN", "CHN"],
]);

/** 公式 COUNTERPART_COUNTRY → 旧来の 2 文字コード (応答の復号用)。 */
const COUNTERPART_COUNTRY_RMAP: ReadonlyMap<string, string> = new Map(
  [...COUNTERPART_AREA_MAP.entries()].map(([legacy, official]) => [official, legacy] as const)
);

/** direction × assetClass → 公式の ACCOUNTING_ENTRY・INDICATOR・期待する DERIVATION_TYPE。 */
interface OfficialSeriesDef {
  accountingEntry: "A" | "L";
  indicator: string;
  derivation: "O" | "SCC";
}

const OFFICIAL_SERIES_DEF: Record<ImfCpisDirection, Record<ImfCpisAssetClass, OfficialSeriesDef>> = {
  jp_holds_abroad: {
    total: { accountingEntry: "A", indicator: "P_TOTINV_P_USD", derivation: "O" },
    equity: { accountingEntry: "A", indicator: "P_F51_P_USD", derivation: "O" },
    debt: { accountingEntry: "A", indicator: "P_F3_P_USD", derivation: "O" },
  },
  world_holds_jp: {
    total: { accountingEntry: "L", indicator: "P_TOTINV_P_SCC_USD", derivation: "SCC" },
    equity: { accountingEntry: "L", indicator: "P_F51_P_SCC_USD", derivation: "SCC" },
    debt: { accountingEntry: "L", indicator: "P_F3_P_SCC_USD", derivation: "SCC" },
  },
};

interface IndicatorMeta {
  key: string;
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  isEstimated: boolean;
}

/** 公式の (ACCOUNTING_ENTRY, INDICATOR) → このモジュールの指標メタ情報。表に無い組み合わせ (例: L + 非SCC 指標) は要求も解釈もできない。 */
const INDICATOR_LOOKUP = new Map<string, IndicatorMeta>();
for (const direction of ["jp_holds_abroad", "world_holds_jp"] as const) {
  for (const assetClass of ["total", "equity", "debt"] as const) {
    const def = OFFICIAL_SERIES_DEF[direction][assetClass];
    const key = `imf_cpis_${direction === "jp_holds_abroad" ? "jp_assets" : "jp_liabilities"}_${assetClass}`;
    INDICATOR_LOOKUP.set(`${def.accountingEntry}.${def.indicator}`, {
      key,
      direction,
      assetClass,
      isEstimated: direction === "world_holds_jp",
    });
  }
}

/** 応答に要求する固定次元の値。 */
const FIXED_DIMS = {
  country: "JPN",
  sector: "S1",
  counterpartSector: "S1",
  frequency: "S",
} as const;

/** 応答に要求する属性値 (実測で確定した範囲のみ)。 */
const EXPECTED_ATTRS = {
  unit: "USD",
  /** 表示用スケール。OBS_VALUE に掛ける係数ではない (モジュール先頭の根拠参照)。 */
  scale: "6",
  flowStockEntry: "P",
} as const;

const ASSET_CLASS_JA: Record<ImfCpisAssetClass, string> = {
  total: "株式・投資信託受益証券と債券の合計",
  equity: "株式・投資信託受益証券のみ",
  debt: "債券 (長期・短期の合計) のみ",
};

/**
 * この取得元が export する指標定義 (観測ログ DB の「指標定義」DB に対応)。
 * 6 種類 = 向き (日本→海外 / 海外→日本) × 資産クラス (合計/株式/債券)。
 * 指標キーは旧ミラー時代と同一 (系列の意味同一を実測で証明した範囲で維持する)。
 */
export const IMF_CPIS_INDICATORS: readonly ImfCpisIndicatorDef[] = (
  ["jp_holds_abroad", "world_holds_jp"] as const
).flatMap((direction) =>
  (["total", "equity", "debt"] as const).map((assetClass): ImfCpisIndicatorDef => {
    const def = OFFICIAL_SERIES_DEF[direction][assetClass];
    const meta = INDICATOR_LOOKUP.get(`${def.accountingEntry}.${def.indicator}`)!;
    const isAbroad = direction === "jp_holds_abroad";
    // pip は外貨準備 (reserve assets) として保有される証券を対象外とする
    // (IMF CPIS Guide。外貨準備分は別調査 SEFER で集計)。日本の外貨準備
    // (約1.2兆ドル、大半が外国債券) はこの残高に含まれない。
    // Liabilities (Derived) 側の「日本の証券」は日本の居住者 (企業・政府など)
    // が発行した証券であり、「日本国内で保有」された証券という意味ではない。
    const subject = isAbroad
      ? "日本の投資家 (企業・金融機関・個人など。ただし国の外貨準備は含まない) が保有する海外で発行された証券"
      : "海外の投資家が保有する日本の企業・政府などが発行した証券 (日本株・日本国債など)";
    const breakdown = isAbroad ? "保有先の国・地域別" : "投資元の国・地域別";
    const provenance = isAbroad
      ? "日本自身が IMF に報告した実測値 (公式応答の DERIVATION_TYPE=O)。"
      : "日本自身が国別に集計・公表した統計ではなく、IMF が各国の『資産保有』報告を鏡写しして算出した推定値 (Derived。公式応答の DERIVATION_TYPE=SCC・DV_TYPE=SCC)。";
    return {
      key: meta.key,
      displayName: `IMF CPIS ${isAbroad ? "対外証券投資残高" : "対日証券投資残高"} (${ASSET_CLASS_JA[assetClass]}・${breakdown})`,
      requirements: ["R4"],
      flowType: "holdings_stock",
      description:
        `${subject} (${ASSET_CLASS_JA[assetClass]}) の『残高』(ある時点で保有している額) を、${breakdown}示します。` +
        `半年に一度 (6月末・12月末時点) IMF (国際通貨基金) が世界各国の当局から集めて集計する国際調査 (pip。旧称 CPIS) の公式 API 直接取得に基づきます。` +
        `${provenance}` +
        " 注意: これは『いくら新しく売買したか』(フロー) ではなく『今どれだけ持っているか』(ストック) です。" +
        "株価や為替レートが動くだけでも、実際の売買がなくても残高は変わります。",
      unit: "USD",
      sourceUrl: IMF_CPIS_SOURCE_URL,
      usageTerms:
        "無料。IMF (原典) の利用条件に従い、出典明記が必要 (attribution_required)。" +
        "IMF 公式 SDMX API から直接取得する。",
      frequency: "semiannual",
      limitations:
        "残高 (ストック) であり真の資金フローではない近似指標 (計画書 R4『世界の概況』枠)。" +
        "IMF は公表後に過去値を改訂することがあり、同じ期の値が後の取得で変わる場合がある (改訂時は上書きで取り込む)。" +
        "相手国ごとの最新期は揃わないことがあり (報告遅延の国がある)、遅れている系列の未公表の期は行を作らない (0 で埋めない)。" +
        "pip は外貨準備として保有される証券を対象外とする (IMF CPIS Guide)。" +
        (isAbroad
          ? " 日本の外貨準備 (財務省・日銀が持つ外国債券など) はこの残高に含まれない。"
          : " 海外の中央銀行が外貨準備として持つ日本国債等は含まれず、pip に参加していない国・地域の保有分や、" +
            "対象国が守秘義務等でIMFに非開示とした保有分も反映されない (Derived系列のため。過小評価の方向にバイアスしうる)。"),
    };
  })
);

// ---------------------------------------------------------------------------
// URL 解決
// ---------------------------------------------------------------------------

function requireOfficialCounterpart(area: string): string {
  const official = COUNTERPART_AREA_MAP.get(area);
  if (!official) {
    throw new Error(
      `IMF pip: 未知の相手国・地域コードです (対応表にありません): "${area}"`
    );
  }
  return official;
}

/** direction/assetClass/相手国 (旧来の 2 文字表記) から公式のデータキー 1 本を組み立てる。 */
export function buildImfCpisDataKey(params: {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  counterpartArea: string;
}): string {
  const def = OFFICIAL_SERIES_DEF[params.direction]?.[params.assetClass];
  if (!def) {
    throw new Error(
      `IMF pip: 未知の direction/assetClass です: ${String(params.direction)}/${String(params.assetClass)}`
    );
  }
  const cty = requireOfficialCounterpart(params.counterpartArea);
  return `JPN.${def.accountingEntry}.${def.indicator}.S1.S1.${cty}.S`;
}

/**
 * 同じ direction/assetClass の相手国を `+` で束ねたバッチ用データキーを組み立てる。
 * 公式 API は COUNTERPART_COUNTRY の複数値 (`USA+GBR+…`) を 1 リクエストで受け付ける
 * (2026-09-28 実機確認: 17 件束ねて HTTP 200)。
 */
export function buildImfCpisBatchKey(params: {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  counterpartAreas: readonly string[];
}): string {
  if (params.counterpartAreas.length === 0) {
    throw new Error("IMF pip: counterpartAreas が空です");
  }
  const def = OFFICIAL_SERIES_DEF[params.direction]?.[params.assetClass];
  if (!def) {
    throw new Error(
      `IMF pip: 未知の direction/assetClass です: ${String(params.direction)}/${String(params.assetClass)}`
    );
  }
  const ctys = params.counterpartAreas.map(requireOfficialCounterpart);
  return `JPN.${def.accountingEntry}.${def.indicator}.S1.S1.${ctys.join("+")}.S`;
}

/**
 * バッチ用データキーから公式 SDMX API の取得 URL を組み立てる (パラメータのみ・純関数)。
 * 期間クエリ (startPeriod/endPeriod) は付けない — 公式 API に無視されることが実証済みで、
 * 付けても絞られないのに「絞った」と誤認させるため。応答の TIME_PERIOD で絞る。
 * `dimension_at_observation=AllDimensions` は応答の形状 (系列×観測の二次元) を固定する
 * ために必ず付ける (実測した形状)。
 */
export function buildImfCpisUrl(batchKey: string): string {
  if (batchKey.length === 0) {
    throw new Error("IMF pip: データキーが空です");
  }
  return (
    `${IMF_CPIS_API_BASE}/data/dataflow/${IMF_CPIS_DATAFLOW_AGENCY}/${IMF_CPIS_DATAFLOW_ID}/` +
    `${IMF_CPIS_DATAFLOW_VERSION}/${batchKey}?dimension_at_observation=AllDimensions`
  );
}

/** 相手国の一覧を IMF_CPIS_MAX_SERIES_PER_REQUEST 件ずつに分割する。 */
export function chunkImfCpisCounterparts(
  counterpartAreas: readonly string[],
  size: number = IMF_CPIS_MAX_SERIES_PER_REQUEST
): string[][] {
  if (size <= 0) {
    throw new Error(`IMF pip: チャンクサイズは正の整数にすること: ${size}`);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < counterpartAreas.length; i += size) {
    chunks.push(counterpartAreas.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// パーサ (純関数・公式 SDMX-JSON 専用)
// ---------------------------------------------------------------------------

const PERIOD_RE = /^(\d{4})-S([12])$/;

/**
 * IMF の半期調査が正式に始まった年。公式の Derived 世界計にも 2013 年より前の
 * "YYYY-S1" 試行分 (一部の国だけの任意報告。例: 公式応答に 2009-S1 が含まれる)
 * が載っているため、旧ミラー時代と同じ規則で取り込まない。
 * 年次調査時代の S2 = 年末値は正式な年次値なので残す。
 */
export const IMF_CPIS_SEMIANNUAL_START_YEAR = 2013;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 期待する要求内容 (単一次元の検証と欠落系列の突き合わせ用)。 */
export interface ImfCpisParseExpected {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  /** 要求した相手国 (旧来の 2 文字表記)。 */
  counterpartAreas: readonly string[];
}

export interface ImfCpisParseResult {
  records: ImfCpisRecord[];
  /** 応答に含まれた公式データキー (観測値が全部欠損の系列も含む)。 */
  returnedKeys: string[];
  /** 要求したが応答に無かった公式データキー。 */
  missingSeriesCodes: string[];
}

interface SdmxDim {
  id: string;
  keyPosition: number;
  values: Array<{ id?: unknown; value?: unknown }>;
}

/**
 * 公式 SDMX-JSON の data 応答 (JSON.parse 済み) を型付きレコードへ変換する
 * 純関数パーサ。想定と違う形 (dataflow/DSD の URN・次元の順序や値・属性の
 * 単位/導出区分・未知の相手国・期間表記・値の型) は必ず throw する
 * (ルール2: 無効値で埋めて続行しない)。
 *
 * 欠損値 (IMF が守秘義務で非開示にした組み合わせ) は観測配列に現れないか
 * `null` として現れる。これは「形式違反」ではなく正常な状態なので throw せず、
 * そのデータ点だけ読み飛ばす (0 や既定値で埋めない)。
 */
export function parseImfCpisResponse(
  json: unknown,
  expected: ImfCpisParseExpected
): ImfCpisParseResult {
  const tag = "IMF pip (公式 SDMX)";
  const def = OFFICIAL_SERIES_DEF[expected.direction]?.[expected.assetClass];
  if (!def) {
    throw new Error(`${tag}: 未知の direction/assetClass です`);
  }
  const expectedOfficials = expected.counterpartAreas.map(requireOfficialCounterpart);
  const requested = new Set(expectedOfficials);

  if (!isRecord(json) || !isRecord(json.data)) {
    throw new Error(`${tag}: 応答形式が想定と異なります (data オブジェクトが見つかりません)`);
  }
  // 専用の単一応答のみ受理する。複数 dataSets/structures は混在スコープであり、
  // 先頭選択で黙って採用しない (ルール2)。
  const dataSets = json.data.dataSets;
  if (!Array.isArray(dataSets) || dataSets.length !== 1 || !isRecord(dataSets[0])) {
    throw new Error(
      `${tag}: 応答形式が想定と異なります (data.dataSets が単一の要素ではありません)`
    );
  }
  const structures = json.data.structures;
  if (!Array.isArray(structures) || structures.length !== 1 || !isRecord(structures[0])) {
    throw new Error(
      `${tag}: 応答形式が想定と異なります (data.structures が単一の要素ではありません)`
    );
  }
  const ds0 = dataSets[0] as Record<string, unknown>;
  if (ds0.structure !== 0) {
    throw new Error(
      `${tag}: dataSets[0].structure が単一 structure (0) を指していません: ${String(ds0.structure)}`
    );
  }
  const st = structures[0] as Record<string, unknown>;

  // --- dataflow/DSD の URN 検証 (版の黙った追従をしない) ---
  const links = st.links;
  if (!Array.isArray(links)) {
    throw new Error(`${tag}: structures[0].links が配列ではありません`);
  }
  const urns = links.map((l) => (isRecord(l) && typeof l.urn === "string" ? l.urn : ""));
  const wantFlow = `Dataflow=${IMF_CPIS_DATAFLOW_AGENCY}:${IMF_CPIS_DATAFLOW_ID}(${IMF_CPIS_DATAFLOW_VERSION})`;
  const wantDsd = `DataStructure=${IMF_CPIS_DATAFLOW_AGENCY}:${IMF_CPIS_DSD_ID}(${IMF_CPIS_DSD_VERSION})`;
  if (!urns.some((u) => u.endsWith(wantFlow))) {
    throw new Error(`${tag}: dataflow の URN が想定 (${wantFlow}) と違います: ${urns.join(" / ") || "(なし)"}`);
  }
  if (!urns.some((u) => u.endsWith(wantDsd))) {
    throw new Error(`${tag}: DSD の URN が想定 (${wantDsd}) と違います: ${urns.join(" / ") || "(なし)"}`);
  }

  // --- 系列次元の検証 (順序・位置・固定値) ---
  const dimensions = st.dimensions;
  if (!isRecord(dimensions) || !Array.isArray(dimensions.series)) {
    throw new Error(`${tag}: dimensions.series が配列ではありません`);
  }
  const seriesDims = dimensions.series as SdmxDim[];
  const wantDims: Array<{ id: string; keyPosition: number }> = [
    { id: "COUNTRY", keyPosition: 0 },
    { id: "ACCOUNTING_ENTRY", keyPosition: 1 },
    { id: "INDICATOR", keyPosition: 2 },
    { id: "SECTOR", keyPosition: 3 },
    { id: "COUNTERPART_SECTOR", keyPosition: 4 },
    { id: "COUNTERPART_COUNTRY", keyPosition: 5 },
    { id: "FREQUENCY", keyPosition: 6 },
  ];
  if (seriesDims.length !== wantDims.length) {
    throw new Error(`${tag}: 系列次元の数が想定 (${wantDims.length}) と違います: ${seriesDims.length}`);
  }
  const dimValues = new Map<string, string[]>();
  for (let i = 0; i < wantDims.length; i++) {
    const dim = seriesDims[i] as SdmxDim;
    const want = wantDims[i]!;
    if (!isRecord(dim) || dim.id !== want.id || dim.keyPosition !== want.keyPosition) {
      throw new Error(
        `${tag}: 系列次元 #${i} が想定 (${want.id}@${want.keyPosition}) と違います`
      );
    }
    if (!Array.isArray(dim.values)) {
      throw new Error(`${tag}: 系列次元 ${want.id} の values が配列ではありません`);
    }
    const ids = dim.values.map((v) => (isRecord(v) && typeof v.id === "string" ? v.id : ""));
    if (ids.some((id) => id === "")) {
      throw new Error(`${tag}: 系列次元 ${want.id} に文字列でない値があります`);
    }
    dimValues.set(want.id, ids);
  }
  const requireSingleton = (id: string, want: string): void => {
    const ids = dimValues.get(id)!;
    if (ids.length !== 1 || ids[0] !== want) {
      throw new Error(
        `${tag}: 系列次元 ${id} が想定 (${want} のみ) と違います: ${ids.join(",") || "(空)"}`
      );
    }
  };
  requireSingleton("COUNTRY", FIXED_DIMS.country);
  requireSingleton("ACCOUNTING_ENTRY", def.accountingEntry);
  requireSingleton("INDICATOR", def.indicator);
  requireSingleton("SECTOR", FIXED_DIMS.sector);
  requireSingleton("COUNTERPART_SECTOR", FIXED_DIMS.counterpartSector);
  requireSingleton("FREQUENCY", FIXED_DIMS.frequency);

  // 指標の対応表に無い (ACCOUNTING_ENTRY, INDICATOR) は解釈しない。
  // 単一次元が上の検証を通れば対応表に必ず載るはずだが、二重化して保証する。
  const meta = INDICATOR_LOOKUP.get(`${def.accountingEntry}.${def.indicator}`);
  if (!meta || meta.direction !== expected.direction || meta.assetClass !== expected.assetClass) {
    throw new Error(
      `${tag}: 未知の (ACCOUNTING_ENTRY, INDICATOR) です (様式変更の可能性): ${def.accountingEntry}.${def.indicator}`
    );
  }

  const counterpartValues = dimValues.get("COUNTERPART_COUNTRY")!;
  for (const cty of counterpartValues) {
    if (!requested.has(cty)) {
      throw new Error(`${tag}: 要求していない相手国が返されました: ${cty}`);
    }
    if (!COUNTERPART_COUNTRY_RMAP.has(cty)) {
      // 要求集合に載るのは対応表の値だけなので、ここには通常到達しない。
      // 到達したら対応表と要求の不整合であり、推測で復号しない。
      throw new Error(`${tag}: 対応表に無い相手国コードです (復号できません): ${cty}`);
    }
  }

  // --- 観測次元 (TIME_PERIOD のみ) ---
  const obsDims = dimensions.observation;
  if (!Array.isArray(obsDims) || obsDims.length !== 1 || !isRecord(obsDims[0]) || obsDims[0].id !== "TIME_PERIOD") {
    throw new Error(`${tag}: 観測次元が想定 (TIME_PERIOD のみ) と違います`);
  }
  const obsValues = obsDims[0].values;
  if (!Array.isArray(obsValues)) {
    throw new Error(`${tag}: TIME_PERIOD の values が配列ではありません`);
  }
  const periods = obsValues.map((v) => (isRecord(v) && typeof v.value === "string" ? v.value : ""));
  if (periods.some((p) => p === "")) {
    throw new Error(`${tag}: TIME_PERIOD に文字列でない値があります`);
  }

  // --- 属性の検証 (単位・スケール・残高区分・導出区分) ---
  const attrs = st.attributes;
  if (!isRecord(attrs)) {
    throw new Error(`${tag}: attributes がオブジェクトではありません`);
  }
  const attrValues = new Map<string, string[]>();
  // 応答順の属性 (id + 値一覧)。系列・観測の位置指定値の照合用。
  const orderedAttrs: Record<"dimensionGroup" | "series" | "observation", Array<{ id: string; values: string[] }>> = {
    dimensionGroup: [],
    series: [],
    observation: [],
  };
  for (const group of ["dimensionGroup", "series", "observation"] as const) {
    const list = attrs[group];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      throw new Error(`${tag}: attributes.${group} が配列ではありません`);
    }
    for (const a of list) {
      if (!isRecord(a) || typeof a.id !== "string") {
        throw new Error(`${tag}: attributes.${group} の要素に id がありません`);
      }
      const vals = Array.isArray(a.values)
        ? a.values.map((v) => (isRecord(v) && typeof v.id === "string" ? v.id : ""))
        : [];
      if (vals.some((v) => v === "")) {
        throw new Error(`${tag}: 属性 ${a.id} に文字列でない値があります`);
      }
      attrValues.set(a.id, [...(attrValues.get(a.id) ?? []), ...vals]);
      orderedAttrs[group].push({ id: a.id, values: vals });
    }
  }
  const requireAttr = (id: string, want: readonly string[]): void => {
    const got = attrValues.get(id) ?? [];
    const ok = got.length === want.length && got.every((v, i) => v === want[i]);
    if (!ok) {
      throw new Error(
        `${tag}: 属性 ${id} が想定 (${want.join(",") || "(空)"}) と違います: ${got.join(",") || "(空)"}`
      );
    }
  };
  requireAttr("UNIT", [EXPECTED_ATTRS.unit]);
  requireAttr("SCALE", [EXPECTED_ATTRS.scale]);
  requireAttr("FLOW_STOCK_ENTRY", [EXPECTED_ATTRS.flowStockEntry]);
  requireAttr("DERIVATION_TYPE", [def.derivation]);
  // DV_TYPE は資産側 (報告値) には無く、Derived 側には SCC が付く (実測どおり)。
  requireAttr("DV_TYPE", def.derivation === "SCC" ? ["SCC"] : []);

  /**
   * 位置指定の属性値配列を検証する。各要素は null (無指定) か、対応する属性の
   * 値一覧への有効な整数添字でなければならず、未知の単位・導出区分を黙認しない。
   * 長さの不一致 (属性の増減) も様式変更として止める。
   *
   * 唯一の例外: 観測値なし行の STATUS 位置の "C" リテラル
   * (`[null, null, 0, "C"]` の形。19 captures 中 26 件で観測。すべて値なし)。
   * 意味は未定義 (CL_OBS_STATUS 1.1.0 に "C" は無い) のため意味付けはせず、
   * 値は作らない (null として読み飛ばす) ので誤表示の恐れがない。
   * 他の属性・他の文字列・値を持つ行の旗・値一覧がある属性への直書き・
   * 系列/次元グループ位置の直書き (いずれも未観測) は止めて再評価させる。
   */
  const requireAttrIndexes = (
    arr: unknown,
    attrs: ReadonlyArray<{ id: string; values: readonly string[] }>,
    where: string,
    obsValueNull: boolean
  ): void => {
    if (!Array.isArray(arr) || arr.length !== attrs.length) {
      throw new Error(
        `${tag}: ${where} の属性配列の長さが想定 (${attrs.length}) と違います`
      );
    }
    for (let i = 0; i < attrs.length; i++) {
      const v = arr[i];
      if (v === null || v === undefined) continue;
      const catalogue = attrs[i]!.values;
      if (typeof v === "string") {
        if (obsValueNull && catalogue.length === 0 && attrs[i]!.id === "STATUS" && v === "C") continue;
        throw new Error(
          `${tag}: ${where} の属性 ${attrs[i]!.id} に直書き値があります (受理できない): ${v}`
        );
      }
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= catalogue.length) {
        throw new Error(
          `${tag}: ${where} の属性位置 ${i} が許可カタログの範囲外です: ${String(v)}`
        );
      }
    }
  };

  // 次元グループ属性 (UNIT ほか) の実値を照合する (直書きは受理しない)。
  const dimGroupAttrs = ds0.dimensionGroupAttributes;
  if (dimGroupAttrs !== undefined) {
    if (!isRecord(dimGroupAttrs)) {
      throw new Error(`${tag}: dataSets[0].dimensionGroupAttributes がオブジェクトではありません`);
    }
    for (const [gk, gv] of Object.entries(dimGroupAttrs)) {
      requireAttrIndexes(gv, orderedAttrs.dimensionGroup, `次元グループ属性 ${gk}`, false);
    }
  }

  // --- 系列の復号 ---
  // TIME_PERIOD 値の重複 (同一期の二重観測) は、下流の validateDrafts が
  // 冪等キー (period|indicatorKey|category) の重複として拒む (共通 gate)。
  // ここでは重複排除も上書きもせず、観測のままレコード化する。
  const series = (dataSets[0] as Record<string, unknown>).series;
  if (!isRecord(series)) {
    throw new Error(`${tag}: dataSets[0].series がオブジェクトではありません`);
  }
  const records: ImfCpisRecord[] = [];
  const returnedKeys: string[] = [];
  const seen = new Set<string>();
  for (const [seriesKey, sv] of Object.entries(series)) {
    if (!isRecord(sv)) {
      throw new Error(`${tag}: 系列 ${seriesKey} がオブジェクトではありません`);
    }
    const parts = seriesKey.split(":");
    if (parts.length !== wantDims.length || parts.some((p) => !/^\d+$/.test(p))) {
      throw new Error(`${tag}: 系列キー ${seriesKey} が 7 要素の位置指定ではありません`);
    }
    const idx = parts.map(Number);
    // 単一次元の位置はすべて 0 のはず。0 以外は混在スコープ (要求外の値) として止める。
    for (const [pos, dimId] of [[0, "COUNTRY"], [1, "ACCOUNTING_ENTRY"], [2, "INDICATOR"], [3, "SECTOR"], [4, "COUNTERPART_SECTOR"], [6, "FREQUENCY"]] as const) {
      if (idx[pos] !== 0) {
        throw new Error(`${tag}: 系列 ${seriesKey} の ${dimId} が要求値ではありません (混在スコープ)`);
      }
    }
    const ctyPos = idx[5]!;
    if (ctyPos < 0 || ctyPos >= counterpartValues.length) {
      throw new Error(`${tag}: 系列 ${seriesKey} の相手国位置 ${ctyPos} が範囲外です`);
    }
    const official = counterpartValues[ctyPos]!;
    const legacy = COUNTERPART_COUNTRY_RMAP.get(official)!;
    const singleKey = buildImfCpisDataKey({
      direction: expected.direction,
      assetClass: expected.assetClass,
      counterpartArea: legacy,
    });
    if (seen.has(singleKey)) {
      throw new Error(`${tag}: 同じ系列が重複して返されました: ${singleKey}`);
    }
    seen.add(singleKey);
    returnedKeys.push(singleKey);

    // 系列属性の実値 (SCALE ほか) を許可カタログに照合する (直書きは受理しない)。
    requireAttrIndexes(sv.attributes, orderedAttrs.series, `系列 ${seriesKey}`, false);
    const observations = sv.observations;
    if (!isRecord(observations)) {
      throw new Error(`${tag}: 系列 ${seriesKey} の observations がオブジェクトではありません`);
    }
    for (const [obsIdxRaw, ov] of Object.entries(observations)) {
      if (!/^\d+$/.test(obsIdxRaw)) {
        throw new Error(`${tag}: 系列 ${seriesKey} の観測位置 ${obsIdxRaw} が数値ではありません`);
      }
      const obsIdx = Number(obsIdxRaw);
      if (obsIdx < 0 || obsIdx >= periods.length) {
        throw new Error(`${tag}: 系列 ${seriesKey} の観測位置 ${obsIdx} が範囲外です`);
      }
      const period = periods[obsIdx]!;
      if (!PERIOD_RE.test(period)) {
        throw new Error(`${tag}: 期間表記が YYYY-S1/YYYY-S2 形式ではありません: ${period} (${singleKey})`);
      }
      const m = PERIOD_RE.exec(period)!;
      if (m[2] === "1" && Number(m[1]) < IMF_CPIS_SEMIANNUAL_START_YEAR) {
        // 半期調査の正式開始前の S1 (一部報告国のみの試行分)。上の定数コメント参照。
        continue;
      }
      if (!Array.isArray(ov) || ov.length === 0) {
        throw new Error(`${tag}: 観測値の形が想定と違います (${singleKey}, period=${period})`);
      }
      const raw = ov[0];
      // 観測配列の先頭が値、残りが観測属性 (DERIVATION_TYPE ほか) の実値。
      // 値なし行の STATUS "C" リテラル (観測した唯一の例外。意味は未定義) のみ許す。
      requireAttrIndexes(
        ov.slice(1),
        orderedAttrs.observation,
        `観測 ${singleKey} ${period}`,
        raw === null || raw === undefined
      );
      if (raw === null || raw === undefined) {
        // 守秘義務等による非開示。フォールバックで 0 埋めせず読み飛ばす。
        continue;
      }
      if (typeof raw === "string" && raw.trim() === "") {
        // Number("") は 0 になる。空・空白の観測値を 0 円として捏造しない。
        throw new Error(
          `${tag}: 値が空・空白の文字列です (0 として読まない): (${singleKey}, period=${period})`
        );
      }
      const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isFinite(value)) {
        throw new Error(
          `${tag}: 値が有限の数値ではありません: ${String(raw)} (${singleKey}, period=${period})`
        );
      }
      records.push({
        indicatorKey: meta.key,
        direction: meta.direction,
        assetClass: meta.assetClass,
        period,
        counterpartArea: legacy,
        counterpartCountry: official,
        valueUsd: value,
        seriesCode: singleKey,
      });
    }
  }

  const missingSeriesCodes = expectedOfficials
    .filter((o) => ![...seen].some((k) => k.endsWith(`.${o}.S`)))
    .map(
      (o) =>
        `JPN.${def.accountingEntry}.${def.indicator}.S1.S1.${o}.S`
    );

  return { records, returnedKeys, missingSeriesCodes };
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

/**
 * IMF pip (公式 SDMX API) を取得し、型付きレコードへパースして返す。
 *
 * 複数の direction/assetClass/相手国の組み合わせを 1 回の呼び出しにまとめられる
 * (同じ direction/assetClass の相手国は `+` で束ねて 1 リクエストにする。
 * 「1 回の実行で必要最小限のアクセス」の方針に沿い、相手国 1 件ごとに
 * 別リクエストを打つ実装にはしない)。
 *
 * @throws HTTP エラー / 応答形式が想定と異なる場合 (ルール2: フォールバックしない)
 */
export async function fetchImfCpis(
  requests: readonly ImfCpisFetchRequest[],
  opts: { fetchImpl?: typeof fetch } = {}
): Promise<ImfCpisFetchResult> {
  if (requests.length === 0) {
    throw new Error("IMF pip: requests が空です");
  }
  const doFetch = opts.fetchImpl ?? fetch;

  const urls: string[] = [];
  const records: ImfCpisRecord[] = [];
  const missingSeriesCodes: string[] = [];

  for (const req of requests) {
    const areas = req.counterpartAreas ?? IMF_CPIS_DEFAULT_COUNTERPART_AREAS;
    if (areas.length === 0) {
      throw new Error(
        `IMF pip: counterpartAreas が空です (direction=${req.direction}, assetClass=${req.assetClass})`
      );
    }
    for (const chunk of chunkImfCpisCounterparts([...areas])) {
      const url = buildImfCpisUrl(
        buildImfCpisBatchKey({
          direction: req.direction,
          assetClass: req.assetClass,
          counterpartAreas: chunk,
        })
      );
      urls.push(url);
      const res = await doFetch(url, {
        headers: { "User-Agent": IMF_CPIS_USER_AGENT, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(
          `IMF pip (公式 SDMX) HTTP エラー: ${res.status} ${res.statusText} (${url})`
        );
      }
      const json: unknown = await res.json();
      const parsed = parseImfCpisResponse(json, {
        direction: req.direction,
        assetClass: req.assetClass,
        counterpartAreas: chunk,
      });
      records.push(...parsed.records);
      missingSeriesCodes.push(...parsed.missingSeriesCodes);
    }
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
      `IMF pip: 半期の期間表記 (YYYY-S1/YYYY-S2) ではありません: ${period}`
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
 * 注意: 系列ごとに最新期は揃わない (報告遅延の相手国がある) ため、
 * 「ある系列で公表済み」は「全部の系列で公表済み」を意味しない。
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
