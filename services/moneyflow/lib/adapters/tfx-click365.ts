/**
 * moneyflow 取得元アダプタ: 東京金融取引所 (TFX) の「くりっく３６５」(取引所FX) /
 * 「くりっく株３６５」(取引所CFD) の出来高推移ページ (`../sources/tfx-click365.ts`) を
 * Phase 1 の Notion 3 DB へつなぐ。
 *
 * 取得元は市場ごとに固定 URL の HTML 1 ページで、中に 4 つの表がある
 * (月次取引数量・年次取引数量・月末建玉・年末建玉。月次は直近7か月、年次は直近3年)。
 * 月次の表は毎月、年次の表は年に 1 回だけ新しい期間が載るので、更新の単位ごとに
 * spec を分ける (1 spec にまとめると、年次の 3 年分を毎月送り直すうえ、年次の表が
 * 更新された版を別バッチとして識別できない):
 *
 *   - `tfx-click365-fx`         … くりっく365 月次 (直近7か月の月間取引数量・月末建玉)
 *   - `tfx-click365-fx-annual`  … くりっく365 年次 (直近3年の年間取引数量・年末建玉)
 *   - `tfx-click365-cfd`        … くりっく株365 月次
 *   - `tfx-click365-cfd-annual` … くりっく株365 年次
 *
 * 冪等キー: 月次 `<spec名>-YYYY-MM` (ページの最新月)、年次 `<spec名>-YYYY` (ページの最新年)。
 * ページには更新日の記載も軽い一覧 API も無いため、`resolve()` で本体ページを 1 回だけ
 * 取得して最新期間からキーを決め、`fetch()` はそのバイト列をそのまま返す
 * (月次 spec と年次 spec は同じページをそれぞれ 1 回ずつ取得する)。
 *
 * 1 バッチで記録するのは「ページに載っている全期間」(月次=7か月、年次=3年)。
 * ページは古い期間から順に消えていくため、毎回すべて送り直して、原資料の訂正と
 * 取込を休んだ月の埋め戻しを upsert で反映する。原資料の「( )1日平均」の行は取り込まない
 * (取引数量を営業日数で割った派生値で、単位「枚/日」は観測ログの単位に無く、
 * くりっく365 月次では入れると 1 バッチ約 690 行になり行数の目安 600 を超えるため)。
 *
 * 単位: 原資料の「枚」のまま (換算なし)。前期比: 記録しない (null)。ページの最古の期間は
 * 前期の値がページに無く null になり、次のバッチでその期間を送り直すと前回の値を null で
 * 上書きしてしまうため、全行 null に揃える (前期との比較は観測ログの前後の期間で行う)。
 * 近似フラグ: true (取引数量は取引の活発さの代理指標、建玉は残高で、どちらも資金の
 * 流れそのものではない)。実測推定: 実測 (TFX の公表値そのもの)。
 */
import {
  TFX_CLICK365_FX_URL,
  TFX_CLICKKABU365_CFD_URL,
  latestTfxPublishedPeriod,
  parseTfxClick365Html,
  resolveTfxClick365Url,
  type TfxClick365Data,
  type TfxMarket,
} from "../sources/tfx-click365.js";
import type { IndicatorDefInput, MoneyflowCategoryKind } from "../../../../src/shared/notion-archive/index.js";
import {
  monthRange,
  requireSpecFile,
  type FetchedBatch,
  type MoneyflowSourceSpec,
  type ObservationDraft,
  type SpecFile,
} from "../source-spec.js";

export const TFX_CLICK365_FX_SPEC_NAME = "tfx-click365-fx";
export const TFX_CLICK365_FX_ANNUAL_SPEC_NAME = "tfx-click365-fx-annual";
export const TFX_CLICK365_CFD_SPEC_NAME = "tfx-click365-cfd";
export const TFX_CLICK365_CFD_ANNUAL_SPEC_NAME = "tfx-click365-cfd-annual";

/** ページの月次の表に載る月数 (2026-09-27 実測)。これ以外なら様式変更として throw する。 */
export const TFX_MONTHLY_WINDOW = 7;
/** ページの年次の表に載る年数 (2026-09-27 実測)。これ以外なら様式変更として throw する。 */
export const TFX_ANNUAL_WINDOW = 3;

/**
 * 更新停止の検知: ページの最新月が「実行月 (日本時間) − N か月」より前なら throw する。
 * 2026-09-27 の取得では 2026-08 分まで載っていた (実行月の前月)。公表のタイミングは
 * 未確認のため 1 か月の遅れまでは許し、それ以上は更新停止・URL 移転を疑って取込を
 * 失敗させる (「取込済み」扱いのまま黙って古い値を見せ続けない — ルール2)。
 */
const MAX_LAG_MONTHS = 2;

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * 取得に使う User-Agent。取得元モジュール (`../sources/tfx-click365.ts`) の UA と同じ値
 * (2026-09-27 の実取得・検証で使った値)。モジュールは UA を export しておらず、取得関数
 * `fetchTfxClick365Page` は本文を文字列 (res.text()) でしか返さない (一次データとして
 * 保管すべき取得したままのバイト列が得られない) ため、アダプタで同じ UA の GET を行う。
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * `parseTfxClick365Html` は引数に取得時刻を要求するが、解析結果の `fetchedAt` 欄に
 * 写すだけで解析には使わない。`toObservations()` は key とバイト列だけから作る純関数で
 * 取得時刻を持たないため、取得時刻ではないことを明示した文字列を渡す (観測行には使わない)。
 */
const FETCHED_AT_UNKNOWN_IN_REPARSE = "取得時刻なし (保管ファイルからの解析)";

// ---------------------------------------------------------------------------
// 区分 (通貨ペア / 銘柄) — 2026-09-27 にページに載っていた表記に固定する
// ---------------------------------------------------------------------------

/** くりっく365 の通貨ペア (原資料の表記・掲載順)。 */
export const TFX_FX_INSTRUMENTS: readonly string[] = [
  "米ドル／円",
  "ユーロ／円",
  "英ポンド／円",
  "豪ドル／円",
  "スイスフラン／円",
  "加ドル／円",
  "NZドル／円",
  "南アランド／円",
  "トルコリラ／円",
  "ノルウェークローネ／円",
  "香港ドル／円",
  "スェーデンクローナ／円",
  "メキシコペソ／円",
  "ポーランドズロチ／円",
  "中国オフショア人民元／円",
  "ハンガリーフォリント／円",
  "チェココルナ／円",
  "ユーロ／米ドル",
  "英ポンド／米ドル",
  "英ポンド／スイスフラン",
  "米ドル／スイスフラン",
  "米ドル／カナダドル",
  "オーストラリアドル／米ドル",
  "ユーロ／スイスフラン",
  "ユーロ／英ポンド",
  "NZドル／米ドル",
  "ユーロ／オーストラリアドル",
  "英ポンド／オーストラリアドル",
  "米ドル／日本円（ラージ）",
  "ユーロ／日本円（ラージ）",
  "英ポンド／日本円（ラージ）",
  "オーストラリアドル／日本円（ラージ）",
  "ユーロ／米国ドル（ラージ）",
];

/** くりっく株365 の銘柄 (原資料の表記・掲載順。末尾の「／26」も原資料のまま)。 */
export const TFX_CFD_INSTRUMENTS: readonly string[] = [
  "日経 225 リセット付証拠金取引／26",
  "日経 225 マイクロ リセット付証拠金取引／26",
  "NYダウ リセット付証拠金取引／26",
  "NASDAQ-100 リセット付証拠金取引／26",
  "ラッセル2000リセット付証拠金取引／26",
  "DAX(R) リセット付証拠金取引／26",
  "FTSE100 リセット付証拠金取引／26",
  "金ETF リセット付証拠金取引／26",
  "銀ETFリセット付証拠金取引／26",
  "プラチナETFリセット付証拠金取引／26",
  "原油ETF リセット付証拠金取引／26",
];

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

const LICENSE_NOTE =
  "利用条件: このページが属するTFXヒストリカルデータベースの注意書きは「著作権はTFXにある」" +
  "「利用は無料で自由に活用できる」とする一方、サイト全体の免責事項は「当サイトの一部又は全部を" +
  "無断で転用・複製することはできません」とし、公開の場での再配布(転載)や商用利用の可否は" +
  "どちらにも書かれていない。TFXに個別に確認するまでは個人利用・非公開の範囲に限り、" +
  "公開面へは出さない。";

const COMMON_NOTES =
  "ページに更新日の記載が無く、毎月いつ更新されるか(公表の遅れ)は未確認" +
  "(2026-09-27時点で2026年8月分・2025年分まで掲載)。最新月が実行月(日本時間)の" +
  "2か月前より古いままなら、更新停止やURL移転を疑って取込を失敗させる。" +
  "表の数・見出し・表示期間(月次は直近7か月、年次は直近3年)が変わった場合は" +
  "様式変更として取込を失敗させる。原資料の「( )1日平均」の行は取り込まない" +
  "(取引数量を営業日数で割った派生値のため、また行数の上限のため)。" +
  "原資料が空欄の期間(その区分の取扱いが無い期間)は0で埋めず記録しない。" +
  "投資部門別(個人・事業者など誰が取引したか)の内訳は公表されない。前期比は記録しない" +
  "(観測ログの前後の期間の値で比べる)。" +
  LICENSE_NOTE;

const FX_SCOPE =
  "取得元: TFX「取引所為替証拠金取引 出来高推移」ページ(HTMLの表)。対象はくりっく365" +
  "(取引所FX)だけで、証券会社・FX会社の店頭FX(取引の大半を占める)は含まない。" +
  "通貨ペアは2026-09-27時点でページにある33種の表記に固定し、それ以外の名前が現れたら" +
  "(新規上場・名称変更)取込を失敗させる(掲載が終わった通貨ペアは記録されなくなるだけ)。" +
  "1枚あたりの通貨の量は通貨ペアで異なるため、通貨ペアどうしの枚数の合計・比較は規模を表さない。";

const CFD_SCOPE =
  "取得元: TFX「取引所株価指数証拠金取引 出来高推移」ページ(HTMLの表)。対象はくりっく株365" +
  "(取引所CFD)だけで、証券会社の店頭CFDや、大阪取引所の日経225先物などは含まない。" +
  "銘柄名は原資料の表記どおりで、末尾の「／26」も含めて2026-09-27時点の11銘柄に固定する。" +
  "「／26」が何を表すかは原資料に説明が無く未確認。表記が変わる(例: 「／27」)と未知の銘柄" +
  "として取込を失敗させるので、そのときに旧表記と同じ区分として続けて扱うかを判断して" +
  "対応表を更新する(同じ月が別の区分名で二重に記録されないよう注意)。" +
  "1枚の大きさは銘柄で異なるため、銘柄どうしの枚数の合計・比較は規模を表さない。";

const MONTHLY_WINDOW_NOTE =
  "ページには直近7か月分しか載らないため、毎月の取込の積み重ねで系列を伸ばす。" +
  "1回の取込ではページに載る7か月分をすべて記録し直す(原資料が過去月を訂正していれば" +
  "上書きされ、取込を休んだ月も6か月前までなら次回に埋まる。それより前は取り戻せない)。";

const ANNUAL_WINDOW_NOTE =
  "ページには直近3年分しか載らない。新しい年の値が表に載ったとき(年1回)にだけ記録し、" +
  "そのとき表にある3年分をすべて記録し直す(同じ最新年のまま行われた訂正は、次の年の" +
  "取込まで反映されない)。年の途中で取扱いが始まった区分は、その年の値が1年分に満たない。" +
  "年次の最新年が月次の最新月と食い違う(例: 2027年1月分が載っているのに2026年の年次が無い)" +
  "場合は、更新漏れ・様式変更として取込を失敗させる。";

const FX_VOLUME_NOT_FLOW =
  "「どれだけ活発に取引されたか」の目安であり、買い越し/売り越し(お金が正味どちら向きに" +
  "動いたか)や、その通貨に新しく流れ込んだ金額ではない(取引には必ず買い手と売り手がいる)。" +
  "枚数は金額ではなく、1枚あたりの通貨の量は通貨ペアごとに異なる(例: 名前に「ラージ」と付く" +
  "通貨ペアは通常の通貨ペアより1枚が大きい)ため、通貨ペアどうしの枚数をそのまま足したり" +
  "比べたりすると規模を取り違える。";

const CFD_VOLUME_NOT_FLOW =
  "「どれだけ活発に取引されたか」の目安であり、買い越し/売り越し(お金が正味どちら向きに" +
  "動いたか)や、日本株・金などに新しく流れ込んだ金額ではない(証拠金取引なので株やETFそのものを" +
  "買うわけではなく、取引には必ず買い手と売り手がいる)。枚数は金額ではなく、1枚の大きさは" +
  "銘柄ごとに異なる(例: 日経225マイクロは日経225より1枚が小さい)ため、銘柄どうしの枚数を" +
  "そのまま足したり比べたりすると規模を取り違える。";

const OI_NOT_FLOW =
  "ある時点の残高(ストック)であり、期間中のお金の流れ(フロー)ではない。前の時点より増えて" +
  "いれば新しく建てられた取引が決済を上回った(ポジションが積み上がった)目安、減っていれば" +
  "巻き戻された目安になるが、買いと売りのどちらの建玉が多いか、誰が持っているかは" +
  "この数字からは分からない。枚数は金額ではない。";

const CFD_WHAT =
  "東京金融取引所(TFX)の取引所CFD「くりっく株365」(日経225・NYダウなどの株価指数や、" +
  "金・原油などのETFの値動きに連動する証拠金取引)";

export const TFX_CLICK365_FX_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "tfx_click365_fx_turnover",
    displayName: "くりっく365 通貨ペア別 月間取引数量",
    requirement: "R3",
    flowType: "売買代金",
    description:
      "東京金融取引所(TFX)の取引所FX「くりっく365」で、1か月間に成立した取引の数量" +
      "(単位: 枚)を通貨ペアごとに合計したもの(1か月間の取引の量=フロー)。" +
      FX_VOLUME_NOT_FLOW +
      "例: 米ドル／円の月間取引数量が30万枚から37万枚に増えたら、くりっく365での米ドル／円の" +
      "売買が活発になったことを示す(円安と円高のどちらに賭けた人が多かったかは分からない)。",
    sourceUrl: TFX_CLICK365_FX_URL,
    license: "personal-only",
    frequency: "月次",
    limitations: FX_SCOPE + MONTHLY_WINDOW_NOTE + COMMON_NOTES,
  },
  {
    key: "tfx_click365_fx_open_interest",
    displayName: "くりっく365 通貨ペア別 月末建玉数量",
    requirement: "R3",
    flowType: "建玉",
    description:
      "くりっく365で、各月末の時点でまだ決済(反対売買)されずに残っている取引の数量" +
      "(建玉、単位: 枚)を通貨ペアごとに示したもの。" +
      OI_NOT_FLOW +
      "1枚の大きさは通貨ペアごとに異なる。例: 米ドル／円の月末建玉が前月末の33万枚から" +
      "35万枚に増えたら、米ドル／円の未決済の取引が2万枚分積み上がったことを示す。",
    sourceUrl: TFX_CLICK365_FX_URL,
    license: "personal-only",
    frequency: "月次",
    limitations:
      "月末時点の値(期間開始=期間終了=その月の末日として記録)。" + FX_SCOPE + MONTHLY_WINDOW_NOTE + COMMON_NOTES,
  },
];

export const TFX_CLICK365_FX_ANNUAL_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "tfx_click365_fx_turnover_annual",
    displayName: "くりっく365 通貨ペア別 年間取引数量",
    requirement: "R3",
    flowType: "売買代金",
    description:
      "くりっく365で、1年間(1〜12月)に成立した取引の数量(単位: 枚)を通貨ペアごとに" +
      "合計したもの(1年間の取引の量=フロー)。" +
      FX_VOLUME_NOT_FLOW +
      "例: ある通貨ペアの年間取引数量が1,000万枚から600万枚に減ったら、くりっく365での" +
      "その通貨ペアの売買が落ち着いたことを示す。",
    sourceUrl: TFX_CLICK365_FX_URL,
    license: "personal-only",
    frequency: "年次",
    limitations:
      "取得元の「取引数量（年次）」の表。2026-09-27時点では中国オフショア人民元／円・" +
      "ハンガリーフォリント／円・チェココルナ／円の2023・2024年が空欄(記録しない)。" +
      FX_SCOPE +
      ANNUAL_WINDOW_NOTE +
      COMMON_NOTES,
  },
  {
    key: "tfx_click365_fx_open_interest_year_end",
    displayName: "くりっく365 通貨ペア別 年末建玉数量",
    requirement: "R3",
    flowType: "建玉",
    description:
      "くりっく365で、各年末の時点でまだ決済(反対売買)されずに残っている取引の数量" +
      "(建玉、単位: 枚)を通貨ペアごとに示したもの。" +
      OI_NOT_FLOW +
      "1枚の大きさは通貨ペアごとに異なる。例: ある通貨ペアの年末建玉が前年末の30万枚から" +
      "40万枚に増えたら、その1年で未決済の取引が10万枚分積み上がったことを示す。",
    sourceUrl: TFX_CLICK365_FX_URL,
    license: "personal-only",
    frequency: "年次",
    limitations:
      "取得元の「建玉数量（年末時点）」の表。年末時点の値(期間開始=期間終了=12月31日として記録)。" +
      "2026-09-27時点では中国オフショア人民元／円・ハンガリーフォリント／円・チェココルナ／円の" +
      "2023・2024年末が空欄(記録しない)。" +
      FX_SCOPE +
      ANNUAL_WINDOW_NOTE +
      COMMON_NOTES,
  },
];

export const TFX_CLICK365_CFD_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "tfx_clickkabu365_cfd_turnover",
    displayName: "くりっく株365 銘柄別 月間取引数量",
    requirement: "R3",
    flowType: "売買代金",
    description:
      CFD_WHAT +
      "で、1か月間に成立した取引の数量(単位: 枚)を銘柄ごとに合計したもの(1か月間の取引の量=フロー)。" +
      CFD_VOLUME_NOT_FLOW +
      "例: 日経225の月間取引数量が100万枚から70万枚に減ったら、くりっく株365での日経225の" +
      "売買が落ち着いたことを示す(値上がりと値下がりのどちらに賭けた人が多かったかは分からない)。",
    sourceUrl: TFX_CLICKKABU365_CFD_URL,
    license: "personal-only",
    frequency: "月次",
    limitations: CFD_SCOPE + MONTHLY_WINDOW_NOTE + COMMON_NOTES,
  },
  {
    key: "tfx_clickkabu365_cfd_open_interest",
    displayName: "くりっく株365 銘柄別 月末建玉数量",
    requirement: "R3",
    flowType: "建玉",
    description:
      CFD_WHAT +
      "で、各月末の時点でまだ決済(反対売買)されずに残っている取引の数量(建玉、単位: 枚)を" +
      "銘柄ごとに示したもの。" +
      OI_NOT_FLOW +
      "1枚の大きさは銘柄ごとに異なる。例: 日経225の月末建玉が前月末の3万枚から3.5万枚に" +
      "増えたら、日経225の未決済の取引が5千枚分積み上がったことを示す。",
    sourceUrl: TFX_CLICKKABU365_CFD_URL,
    license: "personal-only",
    frequency: "月次",
    limitations:
      "月末時点の値(期間開始=期間終了=その月の末日として記録)。" + CFD_SCOPE + MONTHLY_WINDOW_NOTE + COMMON_NOTES,
  },
];

export const TFX_CLICK365_CFD_ANNUAL_INDICATORS: readonly IndicatorDefInput[] = [
  {
    key: "tfx_clickkabu365_cfd_turnover_annual",
    displayName: "くりっく株365 銘柄別 年間取引数量",
    requirement: "R3",
    flowType: "売買代金",
    description:
      CFD_WHAT +
      "で、1年間(1〜12月)に成立した取引の数量(単位: 枚)を銘柄ごとに合計したもの" +
      "(1年間の取引の量=フロー)。" +
      CFD_VOLUME_NOT_FLOW +
      "例: ある銘柄の年間取引数量が200万枚から300万枚に増えたら、くりっく株365での" +
      "その銘柄の売買が活発になったことを示す。",
    sourceUrl: TFX_CLICKKABU365_CFD_URL,
    license: "personal-only",
    frequency: "年次",
    limitations:
      "取得元の「取引数量（年次）」の表。2026-09-27時点では全11銘柄とも2025年分だけに値があり、" +
      "2024・2023年は空欄(記録しない)。その2025年分も1年分ではない: 原資料の年間取引数量を" +
      "1日平均で割ると74〜78営業日分にしかならず(2025年の途中から取引が始まった銘柄とみられる)、" +
      "1年分の値と並べると取引が少ない年に見えてしまう。" +
      CFD_SCOPE +
      ANNUAL_WINDOW_NOTE +
      COMMON_NOTES,
  },
  {
    key: "tfx_clickkabu365_cfd_open_interest_year_end",
    displayName: "くりっく株365 銘柄別 年末建玉数量",
    requirement: "R3",
    flowType: "建玉",
    description:
      CFD_WHAT +
      "で、各年末の時点でまだ決済(反対売買)されずに残っている取引の数量(建玉、単位: 枚)を" +
      "銘柄ごとに示したもの。" +
      OI_NOT_FLOW +
      "1枚の大きさは銘柄ごとに異なる。例: ある銘柄の年末建玉が前年末の1万枚から2万枚に" +
      "増えたら、その1年で未決済の取引が1万枚分積み上がったことを示す。",
    sourceUrl: TFX_CLICKKABU365_CFD_URL,
    license: "personal-only",
    frequency: "年次",
    limitations:
      "取得元の「建玉数量（年末時点）」の表。年末時点の値(期間開始=期間終了=12月31日として記録)。" +
      "2026-09-27時点では全11銘柄とも2025年末だけに値があり、2024・2023年末は空欄(記録しない)。" +
      "取引数量の表から見て、これらの銘柄は2025年の途中から取引が始まったとみられる。" +
      CFD_SCOPE +
      ANNUAL_WINDOW_NOTE +
      COMMON_NOTES,
  },
];

// ---------------------------------------------------------------------------
// 市場ごとの設定
// ---------------------------------------------------------------------------

interface MarketConfig {
  market: TfxMarket;
  monthlySpecName: string;
  annualSpecName: string;
  /** 原資料の表見出し (市場ラベル)。FX と CFD のページの取り違え検知に使う。 */
  marketLabel: string;
  /** エラーメッセージ用の表の呼び名。 */
  pageTitle: string;
  /** 区分の呼び名 (エラーメッセージ用)。 */
  instrumentNoun: string;
  categoryKind: MoneyflowCategoryKind;
  instruments: readonly string[];
  monthlyIndicators: readonly IndicatorDefInput[];
  annualIndicators: readonly IndicatorDefInput[];
  keys: {
    turnover: string;
    openInterest: string;
    turnoverAnnual: string;
    openInterestYearEnd: string;
  };
}

const FX_CONFIG: MarketConfig = {
  market: "click365_fx",
  monthlySpecName: TFX_CLICK365_FX_SPEC_NAME,
  annualSpecName: TFX_CLICK365_FX_ANNUAL_SPEC_NAME,
  marketLabel: "取引所為替証拠金取引（くりっく３６５）",
  pageTitle: "くりっく365 出来高推移 HTML",
  instrumentNoun: "通貨ペア",
  categoryKind: "通貨",
  instruments: TFX_FX_INSTRUMENTS,
  monthlyIndicators: TFX_CLICK365_FX_INDICATORS,
  annualIndicators: TFX_CLICK365_FX_ANNUAL_INDICATORS,
  keys: {
    turnover: "tfx_click365_fx_turnover",
    openInterest: "tfx_click365_fx_open_interest",
    turnoverAnnual: "tfx_click365_fx_turnover_annual",
    openInterestYearEnd: "tfx_click365_fx_open_interest_year_end",
  },
};

const CFD_CONFIG: MarketConfig = {
  market: "clickkabu365_cfd",
  monthlySpecName: TFX_CLICK365_CFD_SPEC_NAME,
  annualSpecName: TFX_CLICK365_CFD_ANNUAL_SPEC_NAME,
  marketLabel: "取引所株価指数証拠金取引（くりっく株３６５）",
  pageTitle: "くりっく株365 出来高推移 HTML",
  instrumentNoun: "銘柄",
  categoryKind: "商品",
  instruments: TFX_CFD_INSTRUMENTS,
  monthlyIndicators: TFX_CLICK365_CFD_INDICATORS,
  annualIndicators: TFX_CLICK365_CFD_ANNUAL_INDICATORS,
  keys: {
    turnover: "tfx_clickkabu365_cfd_turnover",
    openInterest: "tfx_clickkabu365_cfd_open_interest",
    turnoverAnnual: "tfx_clickkabu365_cfd_turnover_annual",
    openInterestYearEnd: "tfx_clickkabu365_cfd_open_interest_year_end",
  },
};

// ---------------------------------------------------------------------------
// 期間ユーティリティ (純関数)
// ---------------------------------------------------------------------------

const YM_RE = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM" を delta か月ずらす。 */
function shiftMonth(yyyyMm: string, delta: number): string {
  const m = YM_RE.exec(yyyyMm);
  if (!m) throw new Error(`shiftMonth: YYYY-MM ではありません: ${yyyyMm}`);
  const index = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** 実行時刻の日本時間の年月 ("YYYY-MM")。 */
function jstYearMonth(now: Date): string {
  const t = now.getTime();
  if (!Number.isFinite(t)) throw new Error(`jstYearMonth: 不正な日時です: ${String(now)}`);
  const jst = new Date(t + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** latest を含む直近 TFX_MONTHLY_WINDOW か月 (古い順)。 */
function monthlyWindow(latest: string): string[] {
  const out: string[] = [];
  for (let i = TFX_MONTHLY_WINDOW - 1; i >= 0; i -= 1) out.push(shiftMonth(latest, -i));
  return out;
}

/** latest を含む直近 TFX_ANNUAL_WINDOW 年 (古い順)。 */
function annualWindow(latest: string): string[] {
  const y = Number(latest);
  const out: string[] = [];
  for (let i = TFX_ANNUAL_WINDOW - 1; i >= 0; i -= 1) out.push(String(y - i));
  return out;
}

function monthFromKey(key: string, specName: string): string {
  const m = new RegExp(`^${specName}-(\\d{4}-\\d{2})$`).exec(key);
  if (!m || !m[1]) {
    throw new Error(`[${specName}] 冪等キーの形式が不正です (${specName}-YYYY-MM であるべき): ${key}`);
  }
  monthRange(m[1]); // 月が 01〜12 であることも検証する
  return m[1];
}

function yearFromKey(key: string, specName: string): string {
  const m = new RegExp(`^${specName}-(\\d{4})$`).exec(key);
  if (!m || !m[1]) {
    throw new Error(`[${specName}] 冪等キーの形式が不正です (${specName}-YYYY であるべき): ${key}`);
  }
  return m[1];
}

/** 一次データとして保管するファイル名 (キーから一意に決まる)。 */
export function tfxPageFilename(key: string): string {
  return `${key}.html`;
}

// ---------------------------------------------------------------------------
// 取得・解析 (共通)
// ---------------------------------------------------------------------------

interface FetchedPage {
  url: string;
  bytes: Uint8Array;
  fetchedAt: string;
}

/**
 * ページを取得したままのバイト列で返す (1 回の GET)。
 * @throws HTTP エラー・本文が空の場合
 */
async function fetchPageBytes(cfg: MarketConfig): Promise<FetchedPage> {
  const url = resolveTfxClick365Url(cfg.market);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`[${cfg.monthlySpecName}] TFX ページの取得に失敗しました: HTTP ${res.status} ${res.statusText} (${url})`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`[${cfg.monthlySpecName}] TFX ページの本文が空です (${url})`);
  }
  return { url, bytes, fetchedAt: new Date().toISOString() };
}

/**
 * バイト列を UTF-8 (ページの meta charset) として解読し、取得元モジュールのパーサで解析する。
 * @throws UTF-8 として不正なバイト列 (置換文字で黙って埋めない)、様式が想定外、
 *   FX と CFD のページの取り違え (表見出しの市場ラベルが違う) の場合
 */
function parsePage(bytes: Uint8Array, cfg: MarketConfig, context: string, fetchedAt: string): TfxClick365Data {
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (e) {
    throw new Error(`${context}: ${cfg.pageTitle} を UTF-8 として解読できません`, { cause: e });
  }
  const data = parseTfxClick365Html(html, cfg.market, resolveTfxClick365Url(cfg.market), fetchedAt);
  if (data.marketLabel !== cfg.marketLabel) {
    throw new Error(
      `${context}: 表見出しの市場ラベルが想定と違います (想定: ${cfg.marketLabel} / 実際: ${data.marketLabel})。` +
        `別の市場のページか、様式変更の可能性があります`
    );
  }
  return data;
}

/**
 * 表のセル群を検証し、`区分|期間` → セルの索引を返す。
 *   - 区分 (通貨ペア/銘柄) がすべて既知の表記である (未知の名前は黙って捨てない)
 *   - 同じ区分・期間のセルが重複しない
 *   - 表の期間がちょうど expectedPeriods (直近の窓) と一致する
 */
function indexCells<C extends { instrument: string; period: string }>(
  cells: readonly C[],
  expectedPeriods: readonly string[],
  cfg: MarketConfig,
  context: string
): Map<string, C> {
  const known = new Set(cfg.instruments);
  const map = new Map<string, C>();
  for (const c of cells) {
    if (!known.has(c.instrument)) {
      throw new Error(
        `${context}: 未知の${cfg.instrumentNoun}です: ${JSON.stringify(c.instrument)} ` +
          `(新規上場・名称変更の可能性。区分の対応表を確認してください)`
      );
    }
    const k = `${c.instrument}|${c.period}`;
    if (map.has(k)) throw new Error(`${context}: 同じ${cfg.instrumentNoun}・期間のセルが重複しています (${k})`);
    map.set(k, c);
  }
  const actual = [...new Set(cells.map((c) => c.period))].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expectedPeriods])) {
    throw new Error(
      `${context}: 表の期間が想定と違います (想定: ${expectedPeriods.join(", ")} / 実際: ${actual.join(", ")})。` +
        `最新期間がキーと食い違うか、表示期間が変わった可能性があります`
    );
  }
  return map;
}

/**
 * 最新期間 (キーの期間) の列に値が 1 つ以上あることを確かめる。
 *
 * 取込フロー (run-spec) は「最後の観測行が観測ログにあれば取込済み」と判定する。
 * 月次は 7 か月・年次は 3 年の窓を毎回送り直すので、前回までのバッチと重ならない行は
 * 最新期間の行だけで、最後の行 (最新期間の建玉) がそれに当たることが完了判定の前提になる。
 * 最新期間の列が全区分とも空欄 (見出しだけ先に出た等) だと、最後の行が前回のバッチでも
 * 書いた古い期間の行になり、途中で失敗したバッチを「取込済み」と誤判定するうえ、後から
 * 値が埋まっても同じキーのまま二度と取り込まれない。未公表の列でキーを作らないよう throw する。
 */
function assertLatestHasValues(
  cells: ReadonlyArray<{ period: string; value: number | undefined }>,
  latest: string,
  context: string
): void {
  if (!cells.some((c) => c.period === latest && c.value !== undefined)) {
    throw new Error(
      `${context}: 最新期間 ${latest} の列に値が 1 つもありません (全区分が空欄)。` +
        `未公表の列か様式変更の可能性があります`
    );
  }
}

/** 取引数量と建玉の両方の表で、最新期間の列に値があることを確かめる (`assertLatestHasValues`)。 */
function assertLatestColumnsFilled(data: TfxClick365Data, kind: "month" | "year", latest: string, context: string): void {
  const volume = kind === "month" ? data.monthlyVolume : data.annualVolume;
  assertLatestHasValues(
    volume.map((c) => ({ period: c.period, value: c.total })),
    latest,
    `${context} ${kind === "month" ? "取引数量（月次）" : "取引数量（年次）"}`
  );
  assertLatestHasValues(
    kind === "month" ? data.monthEndOpenInterest : data.yearEndOpenInterest,
    latest,
    `${context} ${kind === "month" ? "建玉数量（月末時点）" : "建玉数量（年末時点）"}`
  );
}

/**
 * 更新停止の検知 (resolve 時)。
 * @throws 最新月が実行月より後 (ファイルか時計の異常)、または実行月 − MAX_LAG_MONTHS より前 (更新停止の疑い)
 */
function assertFresh(latestMonth: string, now: Date, context: string): void {
  const current = jstYearMonth(now);
  if (latestMonth > current) {
    throw new Error(`${context}: ページの最新月 ${latestMonth} が実行月 ${current} (日本時間) より後です (ページか時計の異常)`);
  }
  const required = shiftMonth(current, -MAX_LAG_MONTHS);
  if (latestMonth < required) {
    throw new Error(
      `${context}: ページの最新月が ${latestMonth} のままです (実行月 ${current} の ${MAX_LAG_MONTHS} か月前 ` +
        `${required} 分まで無い)。TFX の更新停止・URL 移転を確認してください`
    );
  }
}

/**
 * 年次の最新年が月次の最新月と整合するか (resolve 時)。月次の最新月が Y 年 1〜11 月なら
 * 年次は Y−1 年まで、12 月なら Y−1 年 (年次の更新前) か Y 年のはず。
 * @throws それ以外 (年次の表の更新漏れ・様式変更の疑い)
 */
function assertAnnualConsistent(latestYear: string, latestMonth: string, context: string): void {
  const m = YM_RE.exec(latestMonth);
  if (!m) throw new Error(`${context}: 月次の最新月が YYYY-MM ではありません: ${latestMonth}`);
  const monthYear = Number(m[1]);
  const allowed = m[2] === "12" ? [monthYear - 1, monthYear] : [monthYear - 1];
  if (!allowed.includes(Number(latestYear))) {
    throw new Error(
      `${context}: 年次の最新年 ${latestYear} が月次の最新月 ${latestMonth} と整合しません ` +
        `(想定: ${allowed.join(" または ")} 年)。年次の表の更新漏れ・様式変更を確認してください`
    );
  }
}

function buildBatch(args: {
  cfg: MarketConfig;
  specName: string;
  key: string;
  page: FetchedPage;
  latestPeriod: string;
  now: Date;
}): FetchedBatch {
  return {
    key: args.key,
    source: args.page.url,
    metadata: {
      url: args.page.url,
      market: args.cfg.market,
      marketLabel: args.cfg.marketLabel,
      spec: args.specName,
      latestPeriod: args.latestPeriod,
      fetchedAt: args.page.fetchedAt,
      bytes: args.page.bytes.byteLength,
      resolvedAt: args.now.toISOString(),
      license: "personal-only (TFX サイト免責事項: 無断転用・複製不可。公開・商用利用の可否は未確認で TFX へ要確認)",
    },
    files: [{ bytes: args.page.bytes, filename: tfxPageFilename(args.key), contentType: HTML_CONTENT_TYPE }],
  };
}

// ---------------------------------------------------------------------------
// 観測行の組み立て
// ---------------------------------------------------------------------------

function monthlyObservations(cfg: MarketConfig, key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const spec = cfg.monthlySpecName;
  const context = `[${spec}]`;
  const latest = monthFromKey(key, spec);
  const file = requireSpecFile(files, (n) => n === tfxPageFilename(key), `${context} ${cfg.pageTitle}`);
  const data = parsePage(file.bytes, cfg, context, FETCHED_AT_UNKNOWN_IN_REPARSE);
  const periods = monthlyWindow(latest);
  const volume = indexCells(data.monthlyVolume, periods, cfg, `${context} 取引数量（月次）`);
  const openInterest = indexCells(data.monthEndOpenInterest, periods, cfg, `${context} 建玉数量（月末時点）`);
  assertLatestColumnsFilled(data, "month", latest, context);

  const out: ObservationDraft[] = [];
  const common = {
    categoryKind: cfg.categoryKind,
    unit: "枚" as const,
    changeFromPrev: null,
    approximate: true,
    measureKind: "実測" as const,
  };
  for (const period of periods) {
    const { start, end } = monthRange(period);
    for (const instrument of cfg.instruments) {
      const cell = volume.get(`${instrument}|${period}`);
      if (cell === undefined || cell.total === undefined) continue; // ページに無い区分・原資料が空欄
      out.push({
        ...common,
        period,
        periodStart: start,
        periodEnd: end,
        indicatorKey: cfg.keys.turnover,
        category: instrument,
        value: cell.total,
      });
    }
  }
  for (const period of periods) {
    const { end } = monthRange(period);
    for (const instrument of cfg.instruments) {
      const cell = openInterest.get(`${instrument}|${period}`);
      if (cell === undefined || cell.value === undefined) continue; // ページに無い区分・原資料が空欄
      out.push({
        ...common,
        period,
        periodStart: end,
        periodEnd: end,
        indicatorKey: cfg.keys.openInterest,
        category: instrument,
        value: cell.value,
      });
    }
  }
  return out;
}

function annualObservations(cfg: MarketConfig, key: string, files: readonly SpecFile[]): ObservationDraft[] {
  const spec = cfg.annualSpecName;
  const context = `[${spec}]`;
  const latest = yearFromKey(key, spec);
  const file = requireSpecFile(files, (n) => n === tfxPageFilename(key), `${context} ${cfg.pageTitle}`);
  const data = parsePage(file.bytes, cfg, context, FETCHED_AT_UNKNOWN_IN_REPARSE);
  const periods = annualWindow(latest);
  const volume = indexCells(data.annualVolume, periods, cfg, `${context} 取引数量（年次）`);
  const openInterest = indexCells(data.yearEndOpenInterest, periods, cfg, `${context} 建玉数量（年末時点）`);
  assertLatestColumnsFilled(data, "year", latest, context);

  const out: ObservationDraft[] = [];
  const common = {
    categoryKind: cfg.categoryKind,
    unit: "枚" as const,
    changeFromPrev: null,
    approximate: true,
    measureKind: "実測" as const,
  };
  for (const period of periods) {
    for (const instrument of cfg.instruments) {
      const cell = volume.get(`${instrument}|${period}`);
      if (cell === undefined || cell.total === undefined) continue; // ページに無い区分・原資料が空欄
      out.push({
        ...common,
        period,
        periodStart: `${period}-01-01`,
        periodEnd: `${period}-12-31`,
        indicatorKey: cfg.keys.turnoverAnnual,
        category: instrument,
        value: cell.total,
      });
    }
  }
  for (const period of periods) {
    for (const instrument of cfg.instruments) {
      const cell = openInterest.get(`${instrument}|${period}`);
      if (cell === undefined || cell.value === undefined) continue; // ページに無い区分・原資料が空欄
      out.push({
        ...common,
        period,
        periodStart: `${period}-12-31`,
        periodEnd: `${period}-12-31`,
        indicatorKey: cfg.keys.openInterestYearEnd,
        category: instrument,
        value: cell.value,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// spec
// ---------------------------------------------------------------------------

function monthlySpec(cfg: MarketConfig): MoneyflowSourceSpec {
  return {
    name: cfg.monthlySpecName,
    indicators: cfg.monthlyIndicators,
    async resolve(now) {
      const context = `[${cfg.monthlySpecName}]`;
      const page = await fetchPageBytes(cfg);
      const data = parsePage(page.bytes, cfg, context, page.fetchedAt);
      const latest = latestTfxPublishedPeriod(data.monthlyVolume);
      assertFresh(latest, now, context);
      // 値の無い列からキーを作って保管すると、そのキーは後で値が埋まっても取り込まれない
      assertLatestColumnsFilled(data, "month", latest, context);
      const key = `${cfg.monthlySpecName}-${latest}`;
      const batch = buildBatch({ cfg, specName: cfg.monthlySpecName, key, page, latestPeriod: latest, now });
      return { key, fetch: async () => batch };
    },
    toObservations: ({ key, files }) => monthlyObservations(cfg, key, files),
  };
}

function annualSpec(cfg: MarketConfig): MoneyflowSourceSpec {
  return {
    name: cfg.annualSpecName,
    indicators: cfg.annualIndicators,
    async resolve(now) {
      const context = `[${cfg.annualSpecName}]`;
      const page = await fetchPageBytes(cfg);
      const data = parsePage(page.bytes, cfg, context, page.fetchedAt);
      // ページ自体が更新され続けているか (月次の最新月) も確かめる
      const latestMonth = latestTfxPublishedPeriod(data.monthlyVolume);
      assertFresh(latestMonth, now, context);
      const latestYear = latestTfxPublishedPeriod(data.annualVolume);
      assertAnnualConsistent(latestYear, latestMonth, context);
      assertLatestColumnsFilled(data, "year", latestYear, context);
      const key = `${cfg.annualSpecName}-${latestYear}`;
      const batch = buildBatch({ cfg, specName: cfg.annualSpecName, key, page, latestPeriod: latestYear, now });
      return { key, fetch: async () => batch };
    },
    toObservations: ({ key, files }) => annualObservations(cfg, key, files),
  };
}

export const tfxClick365FxSpec: MoneyflowSourceSpec = monthlySpec(FX_CONFIG);
export const tfxClick365FxAnnualSpec: MoneyflowSourceSpec = annualSpec(FX_CONFIG);
export const tfxClick365CfdSpec: MoneyflowSourceSpec = monthlySpec(CFD_CONFIG);
export const tfxClick365CfdAnnualSpec: MoneyflowSourceSpec = annualSpec(CFD_CONFIG);

/** この取得元の全 spec (取込 CLI の登録用)。 */
export const TFX_CLICK365_SPECS: readonly MoneyflowSourceSpec[] = [
  tfxClick365FxSpec,
  tfxClick365FxAnnualSpec,
  tfxClick365CfdSpec,
  tfxClick365CfdAnnualSpec,
];
