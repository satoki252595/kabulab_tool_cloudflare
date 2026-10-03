/**
 * 推定金額の決定論ガード (`estimated-value-guard.ts`) のテスト。
 *
 * 既存の sanitize/抽選/外貨テストの掲載文はすべて架空 (出典サイトの文面は
 * 使わない)。company 名目認定のテストは raw34 の原文抜粋 (JSON pointer を
 * cited。本文内に inline) を使い、該当形が raw34 に無い分岐だけ合成文で
 * 補う (「合成」と明示。実 fixture とは主張しない)。
 */
import { describe, expect, it } from "vitest";
import {
  extractQuantities,
  extractStrictYenAmounts,
  extractYenAmounts,
  extractYenSpans,
  headedDescription,
  isLotteryPrizeAmount,
  isUnconvertedForeignAmount,
  qualifyCompanyNominal,
  qualifyCompanyPerGrantValue,
  sanitizeEstimatedValue,
  splitHeadedDescription,
  trustedCompanyYieldValue,
  type CompanyNominalVerdict,
} from "../../data-scripts/estimated-value-guard.js";

describe("extractYenAmounts (全角数字の正規化)", () => {
  it("全角数字を半角として読む", () => {
    // 旧実装は「４万円」を "52万円" = 520,000 と誤読していた
    expect(extractYenAmounts("架空宿泊券 ４万円相当")).toEqual([40000]);
    expect(extractYenAmounts("架空商品券 ３,０００円分")).toEqual([3000]);
    expect(extractYenAmounts("架空ギフト ２０万円相当")).toEqual([200000]);
  });

  it("半角の従来挙動は不変", () => {
    expect(extractYenAmounts("架空ギフト 3,000円相当")).toEqual([3000]);
    expect(extractYenAmounts("旅行券 20万円相当")).toEqual([200000]);
    expect(extractYenAmounts("架空優待券 2枚")).toEqual([]);
  });

  it("抽出位置を返す (金額と当選人数の隣接判定用)", () => {
    const spans = extractYenSpans("抽選で8名に15万円相当の架空ギフト券");
    expect(spans.map((s) => s.value)).toEqual([150000]);
    const [s] = spans;
    expect("抽選で8名に15万円相当の架空ギフト券".slice(s.index, s.end)).toBe("15万円");
  });
});

describe("複合円額の拒否 (合成。未対応表記の部分額を採らない)", () => {
  const context = { minShares: [100], recordMonths: [3] };

  it.each([
    ["1万5千円相当", 5000],
    ["1万5000円相当", 5000],
    ["5千500円相当", 500],
    ["1万5千500円相当", 500],
    ["１万５千円相当", 5000],
    ["1 万 5 千 円相当", 5000],
  ] as const)("%s の tail を円額候補・低額値にしない", (description, tail) => {
    expect(extractYenSpans(description)).toEqual([]);
    expect(extractYenAmounts(description)).toEqual([]);
    expect(extractStrictYenAmounts(description)).toEqual([]);
    expect(sanitizeEstimatedValue(description, tail)).toBeNull();
    expect(verdictOf(qualifyCompanyNominal(description, tail))).toBe("hold:unsupported_compound_yen");
    // 複合額の足し算を新たに実装したわけではなく、全額候補も保留する。
    expect(qualifyCompanyNominal(description, 15000).qualified).toBe(false);
  });

  it("券・単価・明示積・見出し経路でも部分額を認定しない", () => {
    for (const description of ["1万5千円券3枚", "1枚当たり1万5千円相当の券3枚", "1万5千円×3枚"]) {
      expect(verdictOf(qualifyCompanyNominal(description, 15000))).toBe("hold:unsupported_compound_yen");
      expect(verdictOf(qualifyCompanyPerGrantValue(description, 15000, context))).toBe("hold:unsupported_compound_yen");
    }
    for (const description of [headedDescription("1万5千円券", "3枚"), headedDescription("500円券", "1万5千円相当")]) {
      expect(verdictOf(qualifyCompanyPerGrantValue(description, 15000, context))).toBe("hold:unsupported_compound_yen");
    }
    expect(verdictOf(qualifyCompanyPerGrantValue("3枚", 15000, { ...context, headings: ["1万5千円券"] }))).toBe(
      "hold:unsupported_compound_yen"
    );
    expect(trustedCompanyYieldValue({ description: "1万5千円相当", estimatedValue: 5000, estimateValueSource: "company" }, context)).toBeNull();
    // 別の対応済み金額があっても部分摘みで company に上げない。
    expect(extractYenAmounts("1万5千円相当。500円相当")).toEqual([]);
    expect(verdictOf(qualifyCompanyNominal("1万5千円相当。500円相当", 500))).toBe("hold:unsupported_compound_yen");
  });

  it("単一単位の円額と券×数量は維持する", () => {
    for (const [description, value] of [["1万円相当", 10000], ["5千円相当", 5000]] as const) {
      expect(extractYenAmounts(description)).toEqual([value]);
      expect(extractStrictYenAmounts(description)).toEqual([value]);
      expect(sanitizeEstimatedValue(description, value)).toBe(value);
      expect(verdictOf(qualifyCompanyNominal(description, value))).toBe("qualified:face-literal");
    }
    for (const description of ["500円券3枚", "500円×3枚", "1枚当たり500円相当の券3枚"]) {
      expect(verdictOf(qualifyCompanyNominal(description, 1500))).toBe("qualified:coupon-unit");
    }
    expect(verdictOf(qualifyCompanyPerGrantValue(headedDescription("500円券", "3枚"), 1500, context))).toBe("qualified:coupon-unit");
  });
});

describe("extractQuantities (全角数字の正規化)", () => {
  it("全角数字を半角として読む", () => {
    // 旧実装は「２枚」を 50 枚と誤読し、50 倍の grounding 乗数を許していた
    expect(extractQuantities("架空優待券 ２枚")).toEqual([2]);
  });

  it("人数の単位 (名) は数量にしない (当選人数で金額を掛けない)", () => {
    // 「1万円相当 各5名」の 5 で 50,000 円 (賞金総額) を根拠づけない。
    // 人数は金額の単位と掛からない。
    expect(extractQuantities("架空ギフト 1万円相当 各5名")).toEqual([]);
    expect(extractQuantities("架空優待券 2枚")).toEqual([2]);
    expect(sanitizeEstimatedValue("架空ギフト 1万円相当 各5名", 50000)).toBeNull();
  });
});

describe("sanitizeEstimatedValue (0・負値の拒否)", () => {
  it("0・負・小数を null にする (スキーマの positive と二重化)", () => {
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 0)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", -100)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 10.5)).toBeNull();
    expect(sanitizeEstimatedValue("架空ギフト 3,000円相当", 3000)).toBe(3000);
  });
});

describe("isLotteryPrizeAmount (抽選賞品の機械判定)", () => {
  it("R1: 賞品表の金額 (○○円相当:N名) を弾く", () => {
    const desc = "80,000円相当:40名\n30,000円相当:90名\n抽選で付与。";
    expect(isLotteryPrizeAmount(desc, 80000)).toBe(true);
    expect(isLotteryPrizeAmount(desc, 30000)).toBe(true);
  });

  it("R1: N名に○○円 (当選配布) を弾く", () => {
    expect(isLotteryPrizeAmount("抽選で8名に15万円相当の架空ギフト券", 150000)).toBe(true);
  });

  it("R2: 総額表示 + 各N名の配分表を弾く", () => {
    const desc = "◇抽選で総額900万円相当の架空ポイントを進呈。\n1、8万円相当 各10名\n2、2万円相当 各40名";
    expect(isLotteryPrizeAmount(desc, 9000000)).toBe(true);
  });

  it("抽選語が無ければ弾かない", () => {
    expect(isLotteryPrizeAmount("8万円相当 各10名", 80000)).toBe(false);
  });

  it("固定分との併記は弾かない (23 件の適正行に相当)", () => {
    // 固定ギフト + 抽選宿泊の併記。固定分の金額は通す
    expect(
      isLotteryPrizeAmount(
        "架空電子マネー 2,000円相当、割引券、体験チケット (抽選で各店舗につき1名)",
        2000
      )
    ).toBe(false);
    // 固定セット + 抽選の上限つき添え物
    expect(
      isLotteryPrizeAmount("架空干物セット 5,000円相当。珍味小箱は抽選で上限 1,000個", 5000)
    ).toBe(false);
    // 固定ギフトの総額 + 無関係な抽選 (R2 の各N名条件で除外)
    expect(isLotteryPrizeAmount("総額5000円相当のギフト。抽選で1組に旅行券", 5000)).toBe(false);
  });

  it("各株主・名義・条件人数は当選人数に数えない", () => {
    expect(isLotteryPrizeAmount("抽選あり。各株主1名に食事券 1,000円相当", 1000)).toBe(false);
    expect(isLotteryPrizeAmount("抽選あり。2名で来店時に使える 1,000円相当券", 1000)).toBe(false);
    expect(isLotteryPrizeAmount("抽選あり。同伴者1名まで使える 1,000円相当券", 1000)).toBe(false);
  });

  it("離れた抽選記述は対象外 (生成側の仕様遵守に委ねる残件)", () => {
    // 50万円相当と抽選が別文。機械判定の対象外であることを固定する
    const desc = "※抽選で20名に商品を提供。\n◇契約の際に50万円相当の商品券を贈呈。";
    expect(isLotteryPrizeAmount(desc, 500000)).toBe(false);
  });

  it("R1 は文境界を跨がない (別文の固定分+抽選は弾かない)", () => {
    // gap「。抽選で」= 5 文字。文境界カット前は誤って弾く形
    expect(isLotteryPrizeAmount("架空ギフト1,000円相当。抽選で5名に旅行券", 1000)).toBe(false);
    expect(isLotteryPrizeAmount("架空ギフト1,000円相当\n抽選で5名に旅行券", 1000)).toBe(false);
  });

  it("R1 は同一文内の隣接を弾く (純抽選の実形 4 行の形)", () => {
    // 賞品表「金額:人数」+ 別文の抽選 (実命中 2 行の形)
    expect(isLotteryPrizeAmount("80,000円相当:40名。抽選で付与", 80000)).toBe(true);
    // 当選配布 (実命中 1 行の形)
    expect(isLotteryPrizeAmount("抽選で8名に15万円相当", 150000)).toBe(true);
  });

  it("別文の当選人数つき賞品は対象外と固定する (機械判定の既知の見逃し)", () => {
    // 純抽選だが金額と当選人数が別文。文境界カットで通す側に倒れる。
    // 離隔抽選 (7578/7791 型) と同じく生成仕様 + 人手確認の対象。
    expect(isLotteryPrizeAmount("賞品は8万円相当。30名に抽選で贈呈", 80000)).toBe(false);
  });
});

describe("sanitizeEstimatedValue (抽選賞品の統合)", () => {
  it("抽選賞品を金額帯によらず null にする (5 万円未満も)", () => {
    expect(sanitizeEstimatedValue("抽選で8名に15万円相当の架空ギフト券", 150000)).toBeNull();
    expect(sanitizeEstimatedValue("抽選で5名に3,000円相当の架空商品券", 3000)).toBeNull();
  });

  it("固定分との併記は通す", () => {
    expect(
      sanitizeEstimatedValue("架空デジタルギフト 1,000円相当 (抽選で宿泊券も)", 1000)
    ).toBe(1000);
  });
});

describe("isUnconvertedForeignAmount (外貨額面の未換算)", () => {
  it("外貨額面と一致する低額の値を弾く (147A: USD額面→円の混同)", () => {
    expect(isUnconvertedForeignAmount("架空クーポン 25USD×4=100USD", 100)).toBe(true);
    expect(isUnconvertedForeignAmount("架空クーポン 25USD×4=100USD", 25)).toBe(true);
    expect(sanitizeEstimatedValue("架空クーポン 25USD×4=100USD", 100)).toBeNull();
  });

  it("円額面と一致する値は通す (外貨との併記)", () => {
    expect(isUnconvertedForeignAmount("100USD (約15,000円相当) の架空クーポン", 15000)).toBe(false);
    expect(sanitizeEstimatedValue("100USD (約15,000円相当) の架空クーポン", 15000)).toBe(15000);
  });

  it("外貨額面と無関係の値は判定しない", () => {
    expect(isUnconvertedForeignAmount("架空ギフト 3,000円相当", 3000)).toBe(false);
    expect(isUnconvertedForeignAmount("100USD相当の架空クーポン", 3000)).toBe(false);
  });
});

/** verdict の要約 (qualified + rule/code)。 */
function verdictOf(v: CompanyNominalVerdict): string {
  return v.qualified ? `qualified:${v.rule}` : `hold:${v.code}`;
}

/**
 * 以降の認定テストの掲載文は raw34 (pinned upstream capture) の原文抜粋で、
 * JSON pointer を cited する。DB 保存形 (description + "\n" + notes。`benefitRowsOf`
 * と同じ結合) で渡す。合成文は「合成」と明示した describe にだけ置く
 * (raw34 に該当形が無い分岐のカバーのため。実 fixture とは主張しない)。
 */
const RAW = {
  /** raw34 5929.json /benefits/0/description + /notes。単一 tier の額面。 */
  5929: "【2年未満保有株主】\n500円相当\n■継続保有期間について\n保有期間は株主番号で管理し、毎年3月末日、9月末日の権利確定日毎に同一の株主番号であることを確認できる株主様の保有期間をカウントいたします。従来から同一の株主番号で保有されている株主様は、従来の保有期間もカウントいたします。",
  /** raw34 5929.json /benefits/1/description + /notes。2 tier (2年未満/以上)。 */
  "5929 two": "【2年未満保有株主】\n500円相当\n【2年以上保有株主】\n2,000円相当\n■継続保有期間について\n保有期間は株主番号で管理し、毎年3月末日、9月末日の権利確定日毎に同一の株主番号であることを確認できる株主様の保有期間をカウントいたします。従来から同一の株主番号で保有されている株主様は、従来の保有期間もカウントいたします。",
  /** raw34 6551.json /benefits/0/description + /notes。単一 tier の額面。 */
  6551: "【半年以上保有】\n8,000円相当\n※デジタルギフトは、暗号資産、QUO カード Pay、Amazon ギフトカード、PayPay マネーライトほか複数先を予定。\n\n■継続保有期間について\n 毎年３月末時点、９月末時点の当社株主名簿に連続して２回の記載または記録された株主様が対象となります。",
  /** raw34 7075.json /benefits/0/description + /notes。per-grant と年間合計の併記。 */
  7075: "【半年以上保有】\n6,500円相当（年間　13,000円相当）\n■継続保有期間について\n毎年３月31日、９月30日を基準日とし、当社株主名簿に記載された500株以上保有の株主様のうち、継続して半年以上保有する株主様を対象といたします。なお、継続して半年以上保有する株主様とは、３月31日、９月30日の当社株主名簿に、同一株主番号で2回以上連続して500株以上の保有が記載または記録されている株主様といたします。優待品の送付時期については５月下旬を予定しております。\n\n■贈呈時期\n中間期12月、期末：6月",
  /** raw34 7512.json /benefits/0/description + /notes。総額 + 内訳 + 利用条件。 */
  7512: "2,500円相当(100円×25枚)\n※1,000円[税込]以上の場合につき、\n1,000円毎に1枚利用できる。",
  /** raw34 8153.json /benefits/0/description + /notes。枚数 tier + notes の単価。 */
  8153: "【3年未満保有】\n2枚（年間 4枚）\n【3年以上保有】\n3枚（年間 6枚）\n◆利用可能店舗\nモスグループ店舗、ミスタードーナツ店舗(一部店舗を除く)\n※1枚当たり500円相当\n※株主優待券を、モスカード（アプリ含む）の「ＭＯＳポイント」に交換することができます。\n\n■継続保有期間について\n毎年3月末日及び9月末日の当社株主名簿に同一株主番号で7回以上連続して記載又は記録され、かつ同期間の保有株式数が継続して100株以上である株主の方が対象です。\n\n《発行時期・有効期限》\n確定日3月末：6月発行・翌年3月末まで\n確定日9月末：11月発行・翌年9月末まで",
  /** raw34 3935.json /benefits/1/description。2 tier + 単価×数量の内訳 (notes 除く)。 */
  3935: "【1年未満保有】\n10,000円相当\n（5,000円相当×2枚）\n【1年以上保有】\n15,000円相当\n（5,000円相当×3枚）",
  /** raw34 3935.json /benefits/1/description + /notes (全文)。 */
  "3935 full": "【1年未満保有】\n10,000円相当\n（5,000円相当×2枚）\n【1年以上保有】\n15,000円相当\n（5,000円相当×3枚）\n◇クーポンは、当社サービス『まるくじ』『くじコレ』（インターネットで購入できるハズレなしのオンラインくじサービス）での決済に利用可能。\n※1 回の会計につき、利用クーポンは 1 枚のみ。クーポンには有効期限があります。\n\n■継続保有期間について\n継続保有期間１年以上とは、毎年基準日である２月末日及び８月 31 日現在の株主名簿に同一株主番号で、所定の株数の保有が３回以上連続して記載又は記録されることをいいます。",
  /** raw34 3447.json /benefits/0/description + /notes。≒レート + 選択肢。 */
  3447: "【初年度付与】\n5,000ポイント\n【1年以上保有】\n5,500ポイント\n※保有するポイント数に応じて、電子マネーへの交換、お米やブランド牛などのこだわりグルメ、スイーツや飲食類、銘酒、家電製品、選べる体験ギフトなど5,000種類以上の商品からお好みの商品を選択可能。社会貢献活動への寄付も選択可。\n\n※ポイントの繰越はできません。\n\n※1ポイント≒1円相当。\n\n※プレミアム優待倶楽部では、株主優待ポイントを共通株主優待コイン「WILLsCoin」と交換することができる。WILLsCoinは個人株主向け会員制サイト「プレミアム優待倶楽部PORTAL」にて優待商品と交換することができる。\n\n■継続保有期間について\n2023年以降、9月末日の株主名簿に、同一株主番号で連続2回以上かつ1,000株以上お持ちの株主様として記載された方を対象といたします。",
  /** raw34 8255.json /benefits/0/description + /notes。4 点からの選択。 */
  8255: "◆以下より1点を選択\n1、優待券　5枚※\n2、QUOカード　300円相当\n1、買物割引券（長期優遇制度あり）\n※1枚当たり100円相当。1,000円以上の買い物につき1,000円ごとに1枚使用可能。\n《利用可能期間》\n確定日3月末：翌年1月31日まで\n確定日9月末：翌年7月31日まで\n2、QUOカード\n3、新潟産コシヒカリ \n4、自社開発商品詰合せ",
  /** raw34 8551.json /benefits/0/description + /notes。2 点からの選択。 */
  8551: "◇どちらかを選択\n①3枚(0.2%上乗せ)※300万円まで\n②3,000円相当\n※2026年10月1日を効力発生日とする1：3の株式分割が予定されています。\n※必要株数は分割後を表示しています。\n◇株主優遇定期預金作成優待券、または地域特産品を選択。\n①《株主優遇定期預金作成優待券》\n・贈呈時期\n2026年6月下旬\n《定期預金種類・取扱い時期》\n・スーパー定期預金（証書式）期間 1年\n・2026年7月1日から1年間\n※「ひまわりポイントサービス」の 3ステップ以上に適用している 「定期預金金利優遇サービス」は対象外。\n②《地域特産品》\nカタログ掲載の特産品（東日本大震災復興応援につながる地場産品を中心に選定）または、寄付。\n\n※保有期間1年以上の株主が対象。\n■継続保有期間について\n3月31日および9月30日の株主名簿に連続3回以上、同一株主番号にて記載されている株主さま。",
  /** raw34 4911.json /benefits/0/description + /notes。選択制 + 厳密レート。 */
  4911: "【1年超保有株主】\n◇（選択制）\n1,500ポイント、自社商品、寄付\n※1ポイント1円相当\n※商品は「資生堂オンラインストア」で販売していない資生堂パーラーの商品等。\n※前年と当年の12月末時点の所有株数が異なる場合、いずれか少ない方の株数の属する優待対象となります。いずれかの時点でご所有株数が 100 株未満であった場合は優待の対象とはなりません。\n※優待品については、定時株主総会決議通知にご案内を同封する予定。\n\n■継続保有期間について\n「当社株式をご所有」とは、基準日時点における株主名簿に記載されていることを意味します。前年と当年の12月末の両時点のご所有株式数に応じた区分での優待の対象となります。",
  /** raw34 4911.json /benefits/0/notes のレート文を verbatim 抜粋。 */
  "4911 rate": "※1ポイント1円相当",
  /** raw34 7476.json /benefits/0/description + /notes。QUO + ≒注記。 */
  7476: "【半年以上保有】\nQUOカード（1,000円相当）\n◇ポイントは専用webサイトに掲載の食料品・日用品を含む自社取扱品の中から、商品を選択可能。\n（1ポイント≒1円相当）\n\n■継続保有期間について\n毎年９月末日を長期保有株主優待制度の基準日として、同一の株主番号で、毎年３月末日及び９月末日の株主名簿に、継続して記載されることといたします。\n※優待内容は９月末日時点の株主名簿に記載されている株数にて決定いたします。\n\n【送付時期】\n12月上旬",
  /** raw34 3512.json /benefits/1/description + /notes。2 tier (1年以上/3年以上)。 */
  3512: "【1年以上保有株主】\n1,000円相当\n【3年以上保有株主】\n2,000円相当\n■継続保有期間について\n継続保有期間1年以上3年未満：毎年3月31日及び9月30日の株主名簿に同一の株主番号で3回以上7回未満連続して株主名簿に記載または記録された株主さま\n継続保有期間3年以上：毎年3月31日及び9月30日の株主名簿に同一の株主番号で7回以上連続して株主名簿に記載または記録された株主さま\nなお、保有株式数の確認は、優待の対象となる3月末時点で行います。\n\n■贈呈時期\n毎年6月下旬",
  /** raw34 8084.json /benefits/1/description + /notes。2 tier (3年未満/以上)。 */
  8084: "【3年未満保有】\n3,000円相当\n【3年以上保有】\n5,000円相当\n※2026年10月1日を効力発生日とする1：2の株式分割が予定されています。\n※必要株数は分割後を表示しています。実質的な変更はありません。\n■継続保有期間について\n｢継続保有期間3年以上｣とは､毎年3月31日現在の株主名簿に記載又は記録され､かつ3月31日現在の株主名簿に､同一の株主番号で連続して4回以上記載又は記録された場合といたします｡\n\n■贈呈時期\n毎年6月",
  /** raw34 3467.json /benefits/0/description + /notes。単一額面 + 経過措置の注記。 */
  3467: "1,000円相当\n■継続保有期間について\n継続して２年以上保有とは、３月末日及び９月末日の当社株主名簿に、同一の株主番号で各保有株式区分以上の株式を保有していることが連続５回以上記載または記録されていることをいいます。\n※2028年3月31日の基準日より実施。経過措置期間として2026年3月31日は、保有期間を問わず。2027年3月31日は、【1年以上保有】が対象。\n\n■贈呈時期\n毎年6月の定時株主総会終了後に送付する決議通知に同封。",
  /** raw34 3467.json /benefits/1/description + /notes。2 tier (2年未満/以上)。 */
  "3467 two": "【2年未満保有】\n1,000円相当\n【2年以上保有】※\n3,000円相当\n■継続保有期間について\n継続して２年以上保有とは、３月末日及び９月末日の当社株主名簿に、同一の株主番号で各保有株式区分以上の株式を保有していることが連続５回以上記載または記録されていることをいいます。\n※2028年3月31日の基準日より実施。経過措置期間として2026年3月31日は、保有期間を問わず。2027年3月31日は、【1年以上保有】が対象。\n\n■贈呈時期\n毎年6月の定時株主総会終了後に送付する決議通知に同封。",
};

describe("qualifyCompanyNominal (額面 scope の同定。原文抜粋)", () => {
  it("単一 tier の額面を通す (5929/6551/7075)", () => {
    expect(verdictOf(qualifyCompanyNominal(RAW["5929"], 500))).toBe("qualified:face-literal");
    expect(verdictOf(qualifyCompanyNominal(RAW["6551"], 8000))).toBe("qualified:face-literal");
    expect(verdictOf(qualifyCompanyNominal(RAW["7075"], 6500))).toBe("qualified:face-literal");
  });

  it("年間合計は annual。原文に無い陳腐値は根拠なしで落とす (7075)", () => {
    // 13,000 は年間合計。5,000 は DB の陳腐値で原文に無い (raw 6,500/13,000)。
    expect(verdictOf(qualifyCompanyNominal(RAW["7075"], 13000))).toBe("hold:annual");
    expect(verdictOf(qualifyCompanyNominal(RAW["7075"], 5000))).toBe("hold:no_per_grant_face");
  });

  it("利用条件額は額面にしない。総額は通す (7512)", () => {
    // 1,000 は利用条件 ([税込]以上・毎に)。2,500 は総額。
    expect(verdictOf(qualifyCompanyNominal(RAW["7512"], 1000))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal(RAW["7512"], 2500))).toBe("qualified:face-literal");
  });

  it("単価だけでは受益全体にならない (8153: 単価 500 も cross-clause の積も HOLD)", () => {
    // 500 は notes の単価 (1枚当たり)。3枚との対応は別 clause で機械的に決めない。
    // 人手監査は 500×3=1,500 を deterministic と認定したが、生産ガードは HOLD。
    expect(verdictOf(qualifyCompanyNominal(RAW["8153"], 500))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal(RAW["8153"], 1500))).toBe("hold:no_per_grant_face");
  });

  it("額面候補が複数あれば部分も合計も作らない (3935 description)", () => {
    // 額面 {10,000, 5,000, 15,000}。5,000 は内訳の unit、15,000 は片 tier の総額で、
    // どちらも受益全体ではない (合算もしない)。監査 QUALIFIED (15,000) からの転換。
    expect(verdictOf(qualifyCompanyNominal(RAW["3935"], 5000))).toBe("hold:multi_face_components");
    expect(verdictOf(qualifyCompanyNominal(RAW["3935"], 15000))).toBe("hold:multi_face_components");
    expect(verdictOf(qualifyCompanyNominal(RAW["3935"], 10000))).toBe("hold:multi_face_components");
  });

  it("≒レート・選択肢は HOLD (3447/8255/8551/4911)", () => {
    expect(verdictOf(qualifyCompanyNominal(RAW["3447"], 5500))).toBe("hold:approx");
    expect(verdictOf(qualifyCompanyNominal(RAW["8255"], 300))).toBe("hold:choice");
    expect(verdictOf(qualifyCompanyNominal(RAW["8551"], 3000))).toBe("hold:choice");
    // 4911 は厳密レートがあっても選択制 (人手監査と同じ HOLD)。
    expect(verdictOf(qualifyCompanyNominal(RAW["4911"], 1500))).toBe("hold:choice");
  });

  it("レート自体は受益全体の額ではない (4911 のレート文抜粋)", () => {
    expect(verdictOf(qualifyCompanyNominal(RAW["4911 rate"], 1))).toBe("hold:no_per_grant_face");
  });

  it("別 clause の≒でも落とす (7476。監査 QUALIFIED からの転換。安全側)", () => {
    expect(verdictOf(qualifyCompanyNominal(RAW["7476"], 1000))).toBe("hold:approx");
  });

  it("null・0・不一致値は HOLD (5929)", () => {
    expect(verdictOf(qualifyCompanyNominal(RAW["5929"], null))).toBe("hold:no-value");
    expect(verdictOf(qualifyCompanyNominal(RAW["5929"], 0))).toBe("hold:no-value");
    expect(verdictOf(qualifyCompanyNominal(RAW["5929"], 501))).toBe("hold:no_per_grant_face");
  });
});

describe("qualifyCompanyNominal (合成。raw34 に該当形なし)", () => {
  it("同一 clause の厳密レート×ポイントを通す。別 clause は落とす", () => {
    expect(verdictOf(qualifyCompanyNominal("1,000ポイント(1ポイント1円相当)", 1000))).toBe("qualified:points-rate");
    expect(verdictOf(qualifyCompanyNominal("5,500ポイント。\n※1ポイント1円", 5500))).toBe("hold:no_per_grant_face");
  });

  it("同一 clause の券額面×数量を通す。単価だけは unit_partial", () => {
    expect(verdictOf(qualifyCompanyNominal("500円券3枚", 1500))).toBe("qualified:coupon-unit");
    expect(verdictOf(qualifyCompanyNominal("500円券3枚", 500))).toBe("hold:unit_partial");
    expect(verdictOf(qualifyCompanyNominal("500円券\n■3枚", 1500))).toBe("hold:no_per_grant_face");
  });

  it("範囲・合計・転売・付帯は HOLD", () => {
    expect(verdictOf(qualifyCompanyNominal("1,000〜2,000円相当の優待品", 2000))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("合計5,000円相当の詰合せ", 5000))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("転売相場3,000円の優待品", 3000))).toBe("hold:resale");
    expect(verdictOf(qualifyCompanyNominal("QUOカード1,000円相当。さらに優待品も", 1000))).toBe("hold:addon");
  });

  it("小数の断片を金額・数量・レートにしない", () => {
    // 未対応の小数トークンは拒否 (小数演算はしない。整数部の切り出しは捏造)。
    expect(verdictOf(qualifyCompanyNominal("0.5円相当", 5))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("0．5円相当", 5))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("2.5ポイント(1ポイント1円相当)", 5))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("1枚当たり500円相当の優待券×2.5枚", 1000))).toBe(
      "hold:no_per_grant_face"
    );
  });

  it("桁の一部の 1 を基数にしない", () => {
    expect(verdictOf(qualifyCompanyNominal("5001ポイント1円相当", 5001))).toBe("hold:no_per_grant_face");
    expect(verdictOf(qualifyCompanyNominal("21枚当たり500円相当の優待品3点", 1500))).toBe("hold:no_per_grant_face");
  });
});

describe("qualifyCompanyPerGrantValue (共有厳密判定。原文抜粋)", () => {
  const single100 = { minShares: [100], recordMonths: [3] };

  it("単一 context の額面は通す (5929/7075)", () => {
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["5929"], 500, single100))).toBe("qualified:face-literal");
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["7075"], 6500, { minShares: [500], recordMonths: [3] }))).toBe(
      "qualified:face-literal"
    );
  });

  it("同一文言で株数条件が混ざれば group 全体 HOLD (5929)", () => {
    const v = qualifyCompanyPerGrantValue(RAW["5929"], 500, { minShares: [100, 1000], recordMonths: [3] });
    expect(verdictOf(v)).toBe("hold:mixed_share_context");
  });

  it("複数月 + 候補額2種類は HOLD。単一候補は通す (3512/5929)", () => {
    expect(
      verdictOf(qualifyCompanyPerGrantValue(RAW["3512"], 2000, { minShares: [300], recordMonths: [3, 9] }))
    ).toBe("hold:multi_month_amounts");
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["5929"], 500, { minShares: [100], recordMonths: [3, 9] }))).toBe(
      "qualified:face-literal"
    );
  });

  it("文言自体の複数 tier + 候補額2種類は HOLD (要約を見ないので回避不能)", () => {
    // この関数は要約を引数に取らない — 要約から tier ラベルを消しても回避できない。
    const ctx300 = { minShares: [300], recordMonths: [3] };
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["3512"], 2000, ctx300))).toBe("hold:ambiguous_condition_tiers");
    expect(
      verdictOf(qualifyCompanyPerGrantValue(RAW["8084"], 5000, { minShares: [2000], recordMonths: [3] }))
    ).toBe("hold:ambiguous_condition_tiers");
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["3467 two"], 3000, ctx300))).toBe(
      "hold:ambiguous_condition_tiers"
    );
    expect(
      verdictOf(qualifyCompanyPerGrantValue(RAW["5929 two"], 2000, { minShares: [1000], recordMonths: [3] }))
    ).toBe("hold:ambiguous_condition_tiers");
    // 3935 全文: qualifier は複数額面で落とし、共有判定は tier でも落とす (二重)。
    // 監査 QUALIFIED (15,000) からの転換。3512/8084/3467-300 も監査 QUALIFIED からの転換。
    expect(verdictOf(qualifyCompanyNominal(RAW["3935 full"], 15000))).toBe("hold:multi_face_components");
    expect(
      verdictOf(qualifyCompanyPerGrantValue(RAW["3935 full"], 15000, { minShares: [500], recordMonths: [2] }))
    ).toBe("hold:ambiguous_condition_tiers");
  });

  it("金額が1種類なら tier 注記があっても落とさない (3467 単一額面)", () => {
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["3467"], 1000, single100))).toBe("qualified:face-literal");
  });

  it("単一候補の複数 tier は qualifier に委ねる (8153 は額面なしで HOLD)", () => {
    // 候補額 500 のみ。tier 規則は素通りし、qualifier が単価/cross-clause で落とす。
    expect(verdictOf(qualifyCompanyPerGrantValue(RAW["8153"], 1500, single100))).toBe("hold:no_per_grant_face");
  });
});

describe("headed-description 契約 (見出し persist + 本文分離)", () => {
  // 実ソース由来の最小引用: SOURCE42 custody
  // (pageId 3ebd74ff-84cd-81bf-8e54-d50e20e42340 / 9616.json benefits[0]・4680.json)。
  const H9616 = "株主優待割引（電子チケット）";
  const B9616 = "2,000円相当\n※電子チケットの利用が困難な場合は、紙の優待券を発行。";

  it("空でない見出しは必ず persist し bytes を全保持する (空見出しだけ素の本文)", () => {
    const stored = headedDescription("優待券", "優待券 3,000円相当");
    expect(stored.startsWith("【種別：")).toBe(true);
    expect(splitHeadedDescription(stored)).toEqual({
      heading: "優待券",
      body: "優待券 3,000円相当",
      malformed: false,
    });
    for (const h of ["表A】追記", "見出し\n二行目", '割引"特"別']) {
      const s = splitHeadedDescription(headedDescription(h, "本文 1,000円相当"));
      expect(s).toEqual({ heading: h, body: "本文 1,000円相当", malformed: false });
    }
    expect(headedDescription("", "本文 1,000円相当")).toBe("本文 1,000円相当");
  });

  it("壊れた headed 契約は正の全文にしない (HOLD で止める)", () => {
    // 文中の marker は無視して素通し (legacy 互換)。
    expect(splitHeadedDescription("本文\n【種別：x】").malformed).toBe(false);
    for (const bad of ["【種別：xxx】\n3,000円相当", "【種別：\n3,000円相当", "【種別：\"未閉じ\n3,000円相当"]) {
      expect(splitHeadedDescription(bad).malformed).toBe(true);
      expect(verdictOf(qualifyCompanyPerGrantValue(bad, 3000, { minShares: [100], recordMonths: [3] }))).toBe(
        "hold:malformed_headed_contract"
      );
    }
  });

  it("9616 実ソース: 券額面は保持し、真の割引は HOLD (joint の両方向)", () => {
    const v = qualifyCompanyPerGrantValue(headedDescription(H9616, B9616), 2000, {
      minShares: [100],
      recordMonths: [3, 9],
    });
    expect(verdictOf(v)).toBe("qualified:face-literal");
    const d = qualifyCompanyPerGrantValue(headedDescription("優待割引", "20%割引\n直営店で利用可"), 1000, {
      minShares: [100],
      recordMonths: [3],
    });
    expect(verdictOf(d)).toBe("hold:discount");
    // 本文が face-literal で通っても、割引見出し + joint 無換金性は先に止める。
    const b = qualifyCompanyPerGrantValue(headedDescription("優待割引", "3,000円の優待券"), 3000, {
      minShares: [100],
      recordMonths: [3],
    });
    expect(verdictOf(b)).toBe("hold:discount");
  });

  it("4680 実ソース原文: 型付き券 unit × 単一数量だけ coupon-unit 規則が通す", () => {
    // sh100: heading「500円割引券」+ body「1枚」+ 利用条件注記 (原文そのまま)。
    const b100 =
      "1枚\n※1、1,000円以上の利用につき1日1枚利用可能。\n（アミューズメント利用料・その他対象外あり）";
    const v = qualifyCompanyPerGrantValue(headedDescription("500円割引券", b100), 500, {
      minShares: [100],
      recordMonths: [3, 6, 9, 12],
    });
    expect(verdictOf(v)).toBe("qualified:coupon-unit");
    // sh300: 「3枚」+ 利用条件「1日1枚」で数量が曖昧 → 適用しない (explicit HOLD)。
    const b300 =
      "3枚\n※1、1,000円以上の利用につき1日1枚利用可能。\n（アミューズメント利用料・その他対象外あり）";
    const w = qualifyCompanyPerGrantValue(headedDescription("500円割引券", b300), 1500, {
      minShares: [300],
      recordMonths: [3, 6, 9, 12],
    });
    expect(verdictOf(w)).not.toContain("qualified");
    // generic な見出し通貨は額面にしない (trap)。
    const t = qualifyCompanyPerGrantValue(headedDescription("株主優待3,300円相当", "入会金無料"), 3300, {
      minShares: [100],
      recordMonths: [3],
    });
    expect(verdictOf(t)).toBe("hold:no_per_grant_face");
  });

  it("本文 negative は authoritative: unit×数量が一致しても choice 本文は通さない (共有 backend 境界)", () => {
    // 共有呼び出し境界 trustedCompanyYieldValue (monthly/recompute 経路) で確認する。
    const v = trustedCompanyYieldValue(
      {
        description: headedDescription("3,000円券", "AまたはBから選択 1枚"),
        estimatedValue: 3000,
        estimateValueSource: "company",
      },
      { minShares: [100], recordMonths: [3] }
    );
    expect(v).toBeNull();
  });

  it("抽選は見出し scope で HOLD (見出しに金額・人数が無くても問わない)", () => {
    // 実形: 7578「抽選式株主優待（参加口数）」+ 本文「1口」。
    const v = qualifyCompanyPerGrantValue(headedDescription("抽選式株主優待（参加口数）", "1口"), 1000, {
      minShares: [100],
      recordMonths: [3],
    });
    expect(verdictOf(v)).toBe("hold:lottery");
    // ctx 見出し経路 (carry) も同じ。
    const v2 = qualifyCompanyPerGrantValue("1口", 1000, {
      minShares: [100],
      recordMonths: [3],
      headings: ["抽選式株主優待（参加口数）"],
    });
    expect(verdictOf(v2)).toBe("hold:lottery");
  });
});
