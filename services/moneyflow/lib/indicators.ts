/**
 * moneyflow (008) の指標定義カタログ (Phase 1: R1 東証33業種)。
 *
 * ここに定義した内容を `ensureIndicatorDefsDb()` + `upsertIndicatorDef()` で
 * Notion「資金フロー｜指標定義」DB へ同期する (`scripts/moneyflow/ingest.ts`)。
 *
 * 重要な誤解の否定 (計画書「構成」節・「結論」節に基づく。ルール1の精神で
 * 噛み砕きと引き換えに誤った定義を教えない):
 *   - 二次市場 (取引所での売買) では、業種全体の「純流入額」は原理的にゼロ
 *     (買い手の代金と売り手の受取が同額。誰かが買えば同額を誰かが売っている)。
 *     よって本カタログの指標はどれも「純流入額」そのものではない。
 *   - 売買代金は「その業種にどれだけ注目・資金が動いたか」の代理指標であり、
 *     買い越し/売り越し (ネットの資金の向き) ではない。
 *   - 時価総額の増減には、株価変動・増資・自社株買い・上場区分変更の影響が
 *     混ざる (「資金の移動」だけを表さない)。
 *   - 空売り比率は「空売りの多さ」の比率であり、金額そのものの流入出ではない。
 */
import type {
  IndicatorDefInput,
  MoneyflowFrequency,
  MoneyflowLicense,
  MoneyflowRequirement,
} from "../../../src/shared/notion-archive/moneyflow.js";

const JPX_PERSONAL_ONLY: MoneyflowLicense = "personal-only";
const R1: MoneyflowRequirement = "R1";
const WEEKLY: MoneyflowFrequency = "週次";
const MONTHLY: MoneyflowFrequency = "月次";

/**
 * 既存 D1 (`swing_daily_ohlcv` × `core_stocks.sector`) 由来の指標の出典。
 * 「出典URL」は Notion 側で url 型プロパティのため、実際にリンクできる値のみを
 * 入れる (ルール1: 由来の説明文を URL 型の列に混ぜない)。取得元の説明は各指標の
 * `limitations` に平文で書く。
 */
const D1_SECTOR_TURNOVER_SOURCE_URL =
  "https://github.com/satoki252595/kabulab_tool_cloudflare/blob/main/docs/moneyflow.md";

export const MONEYFLOW_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "sector_turnover",
    displayName: "業種別売買代金",
    requirement: R1,
    flowType: "売買代金",
    description:
      "その業種に属する銘柄の株価×出来高を1週間分足し合わせた合計額。" +
      "「その業種にどれだけ売買が集中したか(注目度)」の目安であり、買い越し/売り越し" +
      "(お金が正味どちら向きに動いたか)ではない。取引所での売買は必ず買い手と売り手が" +
      "同額を取引するため、業種全体で見た「純流入額」は理屈のうえで常にゼロになる。" +
      "例: A業種の売買代金が先週の2倍になっても、それは「A業種にお金が流れ込んだ」" +
      "のではなく「A業種の株の売り買いが活発になった」ことを意味する。",
    sourceUrl: D1_SECTOR_TURNOVER_SOURCE_URL,
    license: JPX_PERSONAL_ONLY,
    frequency: WEEKLY,
    limitations:
      "取得元: 既存 D1 (swing_daily_ohlcv) × JPX 33業種区分 (core_stocks.sector)。" +
      "対象は東証の内国普通株のみ(ETF/REIT/外国株は含まない)。同じ株を1日に何度も" +
      "売買すると回転売買の分だけ売買代金が膨らむため、実際の投資額より大きく出る" +
      "ことがある。",
  },
  {
    key: "sector_turnover_share",
    displayName: "業種別売買代金シェア",
    requirement: R1,
    flowType: "シェア",
    description:
      "全業種の売買代金合計に占める、その業種の売買代金の割合(%)。" +
      "「相対的にどの業種に注目が集まっているか」を見る指標で、業種別売買代金と同じく" +
      "買い越し/売り越しではない。例: 電気機器のシェアが15%から20%に増えても、それは" +
      "他の業種と比べて電気機器の売買がより活発になったことを示すだけで、電気機器に" +
      "「お金が入ってきた」ことの証明にはならない。",
    sourceUrl: D1_SECTOR_TURNOVER_SOURCE_URL,
    license: JPX_PERSONAL_ONLY,
    frequency: WEEKLY,
    limitations:
      "取得元: 既存 D1 swing_daily_ohlcv × JPX 33業種区分 (sector_turnover の派生)。" +
      "sector_turnover と同じ限界を引き継ぐ。",
  },
  {
    key: "sector_up_turnover",
    displayName: "業種別 上昇日の売買代金",
    requirement: R1,
    flowType: "売買代金",
    description:
      "その業種の銘柄のうち、前の取引日より株価(終値)が上がった日の売買代金だけを" +
      "足し合わせた額。上昇日の売買代金が下落日より大きければ「買いの勢いが強かった" +
      "目安」と読めるが、これも個別銘柄ごとの前日比による按分であり、業種全体の" +
      "資金の純流入を意味しない(取引には必ず売り手がいる)。",
    sourceUrl: D1_SECTOR_TURNOVER_SOURCE_URL,
    license: JPX_PERSONAL_ONLY,
    frequency: WEEKLY,
    limitations:
      "取得元: 既存 D1 swing_daily_ohlcv (前日終値との比較) × JPX 33業種区分。" +
      "前の取引日のデータが無い銘柄(新規上場直後等)はどちらにも数えない。前日と" +
      "同値の日もどちらにも数えない。",
  },
  {
    key: "sector_down_turnover",
    displayName: "業種別 下落日の売買代金",
    requirement: R1,
    flowType: "売買代金",
    description:
      "その業種の銘柄のうち、前の取引日より株価(終値)が下がった日の売買代金だけを" +
      "足し合わせた額。sector_up_turnover と対で見て「買いと売りどちらの勢いが" +
      "強かったか」の目安にする指標で、業種全体の資金の純流入/純流出そのものではない。",
    sourceUrl: D1_SECTOR_TURNOVER_SOURCE_URL,
    license: JPX_PERSONAL_ONLY,
    frequency: WEEKLY,
    limitations:
      "取得元: 既存 D1 swing_daily_ohlcv (前日終値との比較) × JPX 33業種区分。" +
      "sector_up_turnover と同じ限界を引き継ぐ。",
  },
  {
    key: "sector_market_cap",
    displayName: "業種別時価総額 (プライム市場)",
    requirement: R1,
    flowType: "残高",
    description:
      "その業種に属する銘柄の「株価×発行済株式数」を月末時点で足し合わせた額" +
      "(残高=ストック。ある一時点でのお金の置き場所の大きさで、1か月間の資金の" +
      "流れ=フローではない)。前月比の増減を見れば規模の変化は分かるが、増減には" +
      "株価の値上がり・値下がり、増資、自社株買い、上場区分の変更なども混ざるため、" +
      "「業種にお金が流れ込んだ額」だけを表す数値ではない。",
    sourceUrl: "https://www.jpx.co.jp/markets/statistics-equities/misc/07.html",
    license: JPX_PERSONAL_ONLY,
    frequency: MONTHLY,
    limitations:
      "業種内訳があるのはプライム市場のみ(時価総額ベースで市場全体の約97%・" +
      "社数ベースでは約4割)。スタンダード/グロース/TOKYO PRO Marketの企業は" +
      "業種別の内訳に含まれない。",
  },
  {
    key: "sector_short_selling_ratio",
    displayName: "業種別空売り比率 (月次集計)",
    requirement: R1,
    flowType: "比率",
    description:
      "その業種の売買代金のうち、空売り(株を借りて先に売る取引)がどれだけの" +
      "割合を占めるかを1か月分の合計で計算した値(0〜100%)。比率が高いほど" +
      "「その業種を将来値下がりすると見て売る取引」が活発だったことを示す。" +
      "空売りは信用取引を含むが、金額そのものの流入出ではなく、あくまで" +
      "売買のうちの比率(何%が空売りだったか)を表す指標。",
    sourceUrl: "https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html",
    license: JPX_PERSONAL_ONLY,
    frequency: MONTHLY,
    limitations:
      "日次の値を単純平均せず、1か月分の空売り売買代金合計÷売買代金合計(加重平均)" +
      "で計算する(出来高の少ない日の比率が過大に効くのを避けるため)。ETF・REIT・" +
      "優先出資証券は「その他(33業種外)」にまとめられ、33業種の値には含まれない。",
  },
] as const;
