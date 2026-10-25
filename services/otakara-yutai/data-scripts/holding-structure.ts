import { createHash } from "node:crypto";
import type { BenefitHoldingStructure } from "../src/public-facts.js";
import { splitHeadedDescription } from "./estimated-value-guard.js";

/** 保存全文だけ。現在tierと名簿・移転前株数・参考画像・観劇枠・買物限度を区別する。 */
export function compileRegistryTierLiteral(description: string) {
  const hash = createHash("sha256").update(description).digest("hex");
  const card = [
    { hash: "edd78c862677b3f3e90d1a9b1643e78b0b2ffabd040229f8f8ae98cff368a64e", minShares: 100, limitManYen: 15 },
    { hash: "bc3adf5d878b2aad14fa9a895325d68c42b96a396f88e429618571196bb36941", minShares: 200, limitManYen: 30 },
    { hash: "e8c4d3e70b73c3526b294253a9f0d4e751c9a4ea4b9e8caf65107afd957ad43a", minShares: 600, limitManYen: 40 },
    { hash: "84298613c565451f34e8e15d29166cb2ffd027a1033a36836282f4f90b2da63c", minShares: 1000, limitManYen: 50 },
    { hash: "bc9b3d38bc6165b5ffca37a42eaa9d1f9228af454fe3efc122eda376b48acf8e", minShares: 2000, limitManYen: 100 },
    { hash: "38318830370e45bb8305c42161ea92c0fd15c256950cf7b3bc42410891796863", minShares: 6000, limitManYen: 150 },
    { hash: "0ae574eab606bb4c4d11424a3e86f74ebea1b048f5cbc4c8112827a0d41cbd11", minShares: 10000, limitManYen: 200 },
    { hash: "dac9db84764ead7da07b7b9ff1253623d430aabe914ca54550a34eaffb28e9b0", minShares: 20000, limitManYen: 300 },
  ].find(source => source.hash === hash);
  if (card !== undefined) return { ...card, stockCode: "3099", recordMonths: [3, 9], listedYen: null, valueReason: "discount",
    shortSummary: `三越伊勢丹カード:百貨店・グループ店買物/飲食10%引、限度${card.limitManYen}万円(9月末新規のみ・限度半額)。長期:初回発行後同一株主番号で継続保有し3月末を2年連続600株以上で迎えると当年発行分から限度2倍。限度なし10%引:三越劇場(日本橋本店)/美容室/写真室/エステ等、通販カタログ、ローマ三越。5%引:伊勢丹会館(飲食/美容室)、クィーンズ伊勢丹。買物駐車無料1時間延長、三越伊勢丹有料文化展/美術展無料。三井記念美術館、三越伊勢丹旅行/ニッコトラベル指定ツアー(通常除外)、ホテル指定食事/宿泊は優待価格` };
  const source = [
    { hash: "2c1e36318109370db8a035354a2abab9bd395df18bd5f58a96ebd0b39bef4ecb", stockCode: "3139", minShares: 100, recordMonths: [11], listedYen: null, valueReason: "choice",
      shortSummary: "カタログ1点選択:2年以上保有で3,000円相当(三祐チーズセット/LicoLico自家製ジェラート/町村農場特製新鮮純良バター/ホテルオークラバームクーヘン/夢一喜フーズ熟成ハム・ウインナー、2026年参考)または寄付。画像はAコース3,000円相当の例。継続条件:11月30日/5月31日の全基準日に100株以上または300株以上、同一株主番号5回以上連続記載。各株数の保有開始時点から回数を数える。毎年2月末目処に順次発送" },
    { hash: "63f6a544ee461523e5572d0860df9f5791ab6b89cc446a399a8f38095fd05567", stockCode: "3139", minShares: 300, recordMonths: [11], listedYen: null, valueReason: "ambiguous_condition_tiers",
      shortSummary: "カタログ1点選択:2年以上保有で5,000円相当(三祐チーズセット/銀座千疋屋アイス＆ソルベ/町村農場3種のバター/ゴディバパティスリーアソートメント/伊豆沼ハム宮城県産豚ロース味噌漬け)または寄付。画像はAコース3,000円相当の例。継続条件:11月30日/5月31日の全基準日に100株以上または300株以上、同一株主番号5回以上連続記載。各株数の保有開始時点から回数を数える。毎年2月末目処に順次発送" },
    { hash: "56b2deee9fbe571e0cf641884efae2ec77d18c30a99490bcf6655580631359c5", stockCode: "4814", minShares: 500, recordMonths: [3, 9], listedYen: null, valueReason: "no_source_yen_amount",
      shortSummary: "OSK先着観劇券:ブルックリンパーラー劇場は顔認証登録あり全公演観劇可、なし30枚。対象はOSK自主公演および同劇場の全公演(同劇場約250ステージ/OSK約50ステージ)。対象公演と申込可能枠数は保有株数・顔認証登録の有無で異なる。案内10月下旬発送、日程2027年1月1日～2027年6月30日" },
    { hash: "fb4d3db60d78ec10fe6e8bae6b17ef7dd61a5a1f9c521d470da975b9ac920a76", stockCode: "4814", minShares: 3000, recordMonths: [3, 9], listedYen: null, valueReason: "no_source_yen_amount",
      shortSummary: "OSK先着観劇券:ブルックリンパーラー劇場は顔認証登録あり全公演観劇可(チケットレス入場)、なし30枚。OSK自主公演30枚。対象は両者の全公演(同劇場約250ステージ/OSK約50ステージ)。対象公演と申込可能枠数は保有株数・顔認証登録の有無で異なる。案内10月下旬発送、日程2027年1月1日～2027年6月30日" },
    { hash: "dfce867bbaeb4b6b1aa50f0d376400774a6d331da60c06f7290659c14e85b605", stockCode: "640A", minShares: 1000, recordMonths: [3], listedYen: 5000, valueReason: "qualified_company_per_grant",
      shortSummary: "ASNOVA×monotomoiギフト:1年以上保有で5,000円相当の商品。継続条件:基準日を含む3月末/9月末の直近3回名簿に同一株主番号・各1,000株以上を確認予定。初回の1年以上要件の経過措置:2026年9月30日に旧ASNOVAを500株以上保有・名簿記載または記録、株式移転後も継続し2027年3月31日に当社1,000株以上保有なら要件を満たす扱い" },
    { hash: "bd1a934ded15f1c305e6f575eb0a41c42472a60cb28c1c6d456b8e347885e827", stockCode: "640A", minShares: 5000, recordMonths: [3], listedYen: 10000, valueReason: "qualified_company_per_grant",
      shortSummary: "ASNOVA×monotomoiギフト:1年以上保有で10,000円相当の商品。継続条件:基準日を含む3月末/9月末の直近3回名簿に同一株主番号・各1,000株以上を確認予定。初回の1年以上要件の経過措置:2026年9月30日に旧ASNOVAを500株以上保有・名簿記載または記録、株式移転後も継続し2027年3月31日に当社1,000株以上保有なら要件を満たす扱い" },
  ].find(source => source.hash === hash);
  return source === undefined ? null : source;
}

/** 保存全文1件だけ。全商品・寄付先・選択条件と翌年の保有要件を保持する。 */
export function compileHoldingGiftChoiceLiteral(description: string): string | null {
  if (createHash("sha256").update(description).digest("hex") !== "f8bbc945eff462d9429e0fa49d2fed5fa6ba4d7d184498292a2ff68a0e0656d7") return null;
  return "2026年10月末の優待:保有3年未満は1,000円相当(mtマスキングテープ/HABRIC comfyシート/QUOカード)、3年以上は2,000円相当(岡山県産桃のフルーツプリン詰合せ/大原美術館ミュージアムショップグッズ/スパイス香る牛スジカレー/北海道ラーメン詰合せ)より各1点(枠内複数可)または日本赤十字社/AMDA/大原美術館へ寄付。2027年10月31日提供から1年以上保有。毎年10月31日/4月30日名簿に同一株主番号で各最低株数以上を維持、1年以上3回/3年以上7回以上連続記載または記録";
}

/** 保存全文1件だけ。基本・初回・長期の別枠と各上限・実加算額の倍率を保持する。 */
export function compileEqualAllocationHoldingLiteral(description: string): string | null {
  if (createHash("sha256").update(description).digest("hex") !== "d35926fa1ca5aac28e95da7bef2ea2684d4e54aa8fa0a81c956b24002265bb04") return null;
  return "QUOカードPay:基本枠総額上限1,000万円を対象株主で均等割(1円未満切捨・上限5,000円相当)。初回2027年1月31日のみ記念枠1,000万円を全対象株主へ均等加算(1名上限なし)。2028年1月31日から長期枠総額上限1,000万円を対象株主で分配加算:保有1年以上2年未満は上限5,000円相当、2年以上は1年以上2年未満の加算額の2倍。継続条件:1月31日/7月31日名簿に同一株主番号・毎回1,000株以上、1年以上3回/2年以上5回以上連続記載または記録。基準日から3か月以内贈呈";
}

/** 保存全文3件だけ。分割前株数・予定分割・両掲載額と歴史100株条件を保持する。 */
export function compileMealTicketSplitLiteral(description: string): { shortSummary: string; minShares: number } | null {
  const hash = createHash("sha256").update(description).digest("hex");
  const minShares = hash === "161211b9c5dae6eef820682d944e2c43ed16521f49656b9dfbf7d8866fb2c02c" ? 100
    : hash === "ca6451a00c51f8cbe814dddcd759f6328fee33afd2a66916158d27d8ad8a190d" ? 300
    : hash === "4c416b5e4abe9fd1447f9701ab840d2b1e6826a8793b882f96e04e6659a1efe5" ? 500 : null;
  if (minShares === null) return null;
  const amounts = [...splitHeadedDescription(description).body.normalize("NFKC").matchAll(/^([0-9,]+)円相当\(年間 ([0-9,]+)円相当\)$/gm)];
  if (amounts.length !== (minShares === 100 ? 2 : 1)) return null;
  const benefit = minShares === 100
    ? `食事券:1年未満保有${amounts[0][1]}円相当(年${amounts[0][2]}円相当)、1年以上保有${amounts[1][1]}円相当(年${amounts[1][2]}円相当)。`
    : `食事券${amounts[0][1]}円相当(年${amounts[0][2]}円相当)。`;
  return { minShares, shortSummary: benefit + "居酒屋事業で利用可・電子チケット1枚5,000円相当。株数は2026年12月1日を効力発生日とする予定1:2分割前表示。継続保有の定義:基準日を含む同年5月末/前年11月末の名簿に同一株主番号100株以上3回以上連続して記載または記録。5月末確定分8月、11月末確定分翌年2月贈呈" };
}

/** 保存全文3件だけ。預金・特産品の選択、取扱日、除外と名簿条件を全て保持する。 */
export function compileBankDepositChoiceLiteral(description: string): { shortSummary: string; minShares: number } | null {
  const hash = createHash("sha256").update(description).digest("hex");
  const minShares = hash === "d3387c4d55ca00d52f24d7bf264e5c895845a9b2901de17ca18d489ab658b859" ? 300
    : hash === "7138c36a8be45b7c36e94a8f7f453a01ec9fc811a7edeb5ec5f9db4e9a22fb0b" ? 1500
    : hash === "a3ee4dbfb4e621cfbd26c5377d20c23d446eac69b304f77df377d7decc5534c2" ? 3000 : null;
  if (minShares === null) return null;
  const amounts = /^①([0-9]+)枚\(0\.2%上乗せ\)※([0-9]+)万円まで\n②([0-9,]+)円相当$/mu.exec(splitHeadedDescription(description).body);
  if (amounts === null) return null;
  return { minShares, shortSummary: `1年以上保有:定期預金優待券${amounts[1]}枚(0.2%上乗せ・${amounts[2]}万円まで)または地域特産品${amounts[3]}円相当を選択。カタログは東日本大震災復興応援の地場産品中心、寄付も選択可。定期は証書式スーパー定期・期間1年、取扱2026年7月1日から1年間、ひまわりポイントサービス3ステップ以上の定期預金金利優遇サービス対象外。継続条件:3月31日/9月30日株主名簿に同一株主番号3回以上連続記載` };
}

/** 保存全文1件の9券種だけ。枚数・各利用人数・季節・割引対象を全て保持する。 */
export function compileSkiTicketBundleLiteral(description: string): string | null {
  // ponytail: 保存全文1型のみ。別形式は全条件を確認した文法を追加するまでHOLD。
  if (createHash("sha256").update(description).digest("hex") !== "46692d4d1b2d2fde1726d52c92b2e2b59a25982940add4f8d398573e0113cabc") return null;
  return "割引券:日本スキー場開発グループ・アライアンスパートナーリゾートの通年ゴンドラ・アクティビティ5枚/冬期リフト7枚、スパイシーレンタル・白馬EXアドベンチャーのレンタル5枚、白馬岩岳マウンテンリゾート特別券2枚、白馬姫川温泉岩岳の湯2枚(以上各1枚5名利用可)、日本駐車場開発運営の時間貸駐車場1日料金30%引5枚、那須ハイランドパーク2枚・那須高原りんどう湖ファミリー牧場2枚(各1枚4名まで)、那須高原TOWAピュアコテージ朝食付きプラン50%引2枚";
}

/** 保存全文2件だけ。期間別額・株数毎加算・倍率と歴史保有条件を現在tierから分離する。 */
export function compileHotelHoldingLiteral(description: string): { shortSummary: string; minShares: number } | null {
  const hash = createHash("sha256").update(description).digest("hex");
  const minShares = hash === "d5ff2d37414fce803d49b749c5aeaaa02c74fb293fc11643963528b148514914" ? 200
    : hash === "7ebe977949d4bebdedab8563275eda0a38476a4c300a2b783609711d1ba83ea8" ? 4000 : null;
  if (minShares === null) return null;
  const body = splitHeadedDescription(description).body;
  const tiers = [...body.matchAll(/^【([1-4]年(?:未満|以上))保有】\n([^\n]+)/gm)];
  if (tiers.length !== 5) return null;
  // 末尾の4桁を「万」へ表記正規化するだけ。加算・倍率から金額を生成しない。
  const yen = (text: string) => text.replaceAll(",", "").replace(/0{4}$/u, "万");
  let benefit: string;
  if (minShares === 200) {
    const base = /^([0-9,]+)円相当分$/u.exec(tiers[0][2]);
    const step = /^以降([0-9]+)株ごとに([0-9,]+)円相当を追加進呈$/mu.exec(body);
    const multiples = tiers.slice(1).map(tier => /^初年度の ([0-9.]+) 倍$/u.exec(tier[2]));
    if (base === null || step === null || multiples.some(value => value === null)) return null;
    benefit = `${tiers[0][1]}${yen(base[1])}円相当、以降${step[1]}株毎${yen(step[2])}円相当追加。初年度比${tiers.slice(1).map((tier, i) => `${tier[1]}${multiples[i]![1]}倍`).join("/")}`;
  } else {
    const amounts = tiers.map(tier => /^([0-9,]+)円相当分$/u.exec(tier[2]));
    if (amounts.some(value => value === null)) return null;
    benefit = `保有${tiers.map((tier, i) => `${tier[1]}${yen(amounts[i]![1])}`).join("/")}円相当`;
  }
  return { minShares, shortSummary: `指定ホテル宿泊割引券:${benefit}。継続条件:毎年8月末まで同一株主番号100株以上継続保有。詳細はがき2026年11月上旬送付` };
}

/** 保存全文1件だけ。通常・特例の保有期間と歴史的名簿条件を現在tierへ転用しない。 */
export function compileBankHoldingHistoryLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  if (createHash("sha256").update(description).digest("hex") !== "4482e903938f82100c0e98e972f9da38c00858e4ff2544b3456de6d5970c67d4") return null;
  const amount = /^【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\n/u.exec(splitHeadedDescription(description).body);
  if (amount === null) return null;
  const listedYen = Number(amount[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
  return { listedYen, shortSummary: `カタログ${listedYen}円相当(継続条件:通常1年以上保有:3月31日基準、9月30日/3月31日同一株主番号1000株以上3回以上連続記録。2027年3月31日基準は半年以上保有)` };
}

/** 掲載全文が一致する2施設の優待券だけ。施設・各枚数・利用制限を省略しない。 */
export function compileVenueAdmissionLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "温浴施設「テルマー湯」優待券") return null;
  const match = /^新宿店 ([1-9][0-9]*)枚\n六本木・西麻布店 ([1-9][0-9]*)枚\n※1枚につき1名が入場できる。\n※土日、祝日および特定日は\n[ \t]*利用できない。$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null) return null;
  const counts = [Number(match[1]), Number(match[2])];
  if (!counts.every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `テルマー湯優待券:新宿店${counts[0]}枚、六本木・西麻布店${counts[1]}枚(1枚1名、土日祝・特定日利用不可)`;
}

/** 掲載全文が一致する電子ギフトだけ。掲載額・換算・交換先・贈呈期限を保持する。 */
export function compilePointExchangeLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "電子ギフト") return null;
  const match = /^([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円相当\n※電子ギフトは1ポイント1円相当の各種電子マネーやポイントと交換することが可能です。\n■贈呈時期\n基準日から3カ月以内$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null) return null;
  const listedYen = Number(match[1].replaceAll(",", ""));
  if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
  return { shortSummary: `電子ギフト ${listedYen.toLocaleString("en-US")}円相当(1ポイント1円相当、電子マネー・ポイント交換、基準日から3か月以内贈呈)`, listedYen };
}

/** 既知の残全文に束縛した各回ポイントと繰越両条件だけ。約換算は金額にしない。 */
export function compilePremiumClubCarryLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "プレミアム優待倶楽部ポイント") return null;
  const match = /^([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\(年間([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\)\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "6b92867c4e0cbff43b79fefe5faba333a26a353727b739f78a5ea3938686ac8c") return null;
  const count = Number(match[1].replaceAll(",", "")), annual = Number(match[2].replaceAll(",", ""));
  // 掲載された2数量の整合確認だけ。年額や換算額を生成しない。
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(annual) || annual !== count * 2) return null;
  return `${count}ポイント(商品選択/WILLsCoin交換、繰越:同株主番号2回以上連続記載・1000株以上継続保有)`;
}

/** 保有期間別の両数量と、継続保有・記載・繰越・開始時期の既知全文だけを定型化する。 */
export function compileHoldingPointCarryLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "プレミアム優待倶楽部ポイント") return null;
  const match = /^【1年未満保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\n【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)ポイント\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "72495c8f4116e4a58389f02b24409d01561fffec516534b3333a1dd43d49781a") return null;
  const below = Number(match[1].replaceAll(",", "")), above = Number(match[2].replaceAll(",", ""));
  if (![below, above].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `保有1年未満${below}/1年以上${above}ポイント(WEB商品選択/WILLsCoin交換)、1年以上/繰越条件:毎年12月末同一株主番号600株以上継続保有・記載、繰越次回1回、翌3月上旬開始`;
}

/** 買物利用枠の両期間と歴史的保有定義を、その他の条件全文へ束縛する。 */
export function compileDepartmentHoldingLiteral(description: string): string | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "大丸・松坂屋 買物優待カード 10%割引") return null;
  const match = /^【3年未満保有株主】\n利用限度額 ([1-9][0-9]*)万円\n【3年以上保有株主】\n利用限度額 ([1-9][0-9]*)万円\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "2f6025c9442eee30a8a56d84752967c165f5b92dce7d9ac16a82084a7018079b") return null;
  const below = Number(match[1]), above = Number(match[2]);
  if (![below, above].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return `大丸松坂屋10%引(一部除外/現金・指定カード等)、上限3年未満${below}万/3年以上${above}万円。3年判定:毎年2月末、2・8月末同一株主番号100株以上7回以上連続記載、8月末新規半額、大丸松坂屋等有料文化催事/パルコアートスペース入場無料`;
}

/** 掲載各回額・年額と終了時期を持つ既知全文だけ。歴史的保有定義を現在tierへ転用しない。 */
export function compileAnnualGiftHistoryLiteral(description: string): { shortSummary: string; listedYen: number } | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading?.normalize("NFKC").trim() !== "デジタルギフト(長期保有者向け)※2027年8末限り") return null;
  const match = /^【1年以上保有】\n([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\(年間 ([1-9][0-9]{0,2}(?:,[0-9]{3})+|[1-9][0-9]*)円相当\)\n([\s\S]+)$/u.exec(source.body.normalize("NFKC").trim());
  if (match === null || createHash("sha256").update(match[3]).digest("hex") !== "8ce124842d80b5bebefe95e9827396a93fa3cdbab2f314f425393a19354f5fe5") return null;
  const listedYen = Number(match[1].replaceAll(",", "")), annual = Number(match[2].replaceAll(",", ""));
  if (![listedYen, annual].every(value => Number.isSafeInteger(value) && value > 0) || annual !== listedYen * 2) return null;
  return { listedYen, shortSummary: `デジタルギフト${listedYen}円相当(年${annual}円相当)、継続条件:1年以上・2月末/8月末同一株主番号100株以上3回以上連続記載、交換先選択、各基準日から3か月以内贈呈、現制度2027年8月末限り` };
}

/** 保存全文にある単一期間と掲載額・枚数の対応だけを読む。本人の適用条件は未確認。 */
export function parseBenefitHoldingStructure(description: string): BenefitHoldingStructure | null {
  const source = splitHeadedDescription(description);
  if (source.malformed || source.heading === null) return null;
  const heading = source.heading.normalize("NFKC");
  const body = source.body.normalize("NFKC").trim();
  const sourceSha256 = createHash("sha256").update(description).digest("hex");
  const common = { status: "literal_parsed", rule: "single-holding-period-v1", sourceSha256, applicability: "unverified" } as const;
  if (heading === "オンラインショップ・クーポン(長期保有者向け)") {
    const match = /^【半年以上保有】\n([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)円相当$/u.exec(body);
    if (match === null) return null;
    const listedYen = Number(match[1].replaceAll(",", ""));
    if (!Number.isSafeInteger(listedYen) || listedYen <= 0) return null;
    return { ...common, ast: { holdingPeriod: "半年以上", benefit: { kind: "coupon", listedYen, notation: "相当" } } };
  }
  if (heading === "株主優待券※以下の優待券を贈呈(長期保有者向け)") {
    const match = /^【1年以上保有】\n「リトルワールド」、「日本モンキーパーク」\(遊園地部分のみ\)、「南知多ビーチランド&南知多おもちゃ王国」 共通 入場招待券 ([0-9]+)枚$/u.exec(body);
    if (match === null) return null;
    const quantity = Number(match[1]);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    return { ...common, ast: { holdingPeriod: "1年以上", benefit: { kind: "admission_tickets", quantity, unit: "枚" } } };
  }
  return null;
}
