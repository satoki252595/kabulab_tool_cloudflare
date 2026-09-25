/**
 * validate.ts / diff.ts / proposal.ts のテスト用フィクスチャ。
 *
 * 実在する単語帳ドラフト (2026-09 時点の検討成果物、
 * scratchpad/vocab-draft.json) から、2 列 (upstream/downstream) に
 * またがる business 語 7 件 (6 系統) と、その語だけで構成語が完結する
 * theme 2 件を抜粋している。ラベル・定義・keywords・excludeKeywords・
 * 出典 (`sources`) は実データをそのまま使い、捏造した値は含めない
 * (ルール1)。ドラフトの `family` 表記ゆれ (防衛→DEF)・`addedIn`/
 * `deprecated` 欠落・`file`/`notes` フィールドのみ、この単語帳の型
 * (`schema.ts`) に合わせて補正・除去した。
 *
 * ドラフトには theme と唯一の構成語が labelJa まで完全一致する組
 * (例: T.CRITICAL_MINERALS と B.MAT.CRITICAL_MINERAL_RARE_EARTH は
 * どちらも「重要鉱物・レアアース」) が実在し、採用すると
 * `validateVocabulary` の一意性ルールに引っかかるため、ここではラベルが
 * 重複しない組み合わせを選んでいる。
 *
 * 個々のテストは複製 (`structuredClone` 等) してから 1 箇所だけ壊し、
 * `validateVocabulary` の該当ルールを確認する
 * (このモジュール自体は変更しない — 複数テストが同じ配列を参照するため)。
 */
import type { BusinessTerm, ThemeTerm, Vocabulary } from "../schema.js";

/** business 語 7 件 (upstream 4・downstream 3、6 系統: SEMI/ENERGY/MACH/MOBI/MED/DEF) */
export const MINI_BUSINESS_TERMS: BusinessTerm[] = [
  {
    "id": "B.SEMI.SILICON_WAFER",
    "layer": "business",
    "family": "SEMI",
    "subfamily": "front_end_materials",
    "notionColumn": "upstream",
    "labelJa": "シリコンウエハ",
    "definitionJa": "半導体デバイスの基板となる単結晶シリコンウエハ、およびその原料となる多結晶シリコン・金属シリコンを製造する事業。ウエハという中間素材の供給が対象で、完成した半導体デバイス(ロジック・メモリ等)自体の設計・製造は該当しない。",
    "definitionEn": "Manufacture of single-crystal silicon wafers used as substrates for semiconductor devices, and of the upstream polysilicon/metallurgical-grade silicon feedstock. Does not include designing or fabricating the finished chip itself.",
    "keywords": [
      "シリコンウエハ",
      "シリコンウェハ",
      "ウエハ",
      "単結晶シリコン",
      "多結晶シリコン",
      "金属シリコン",
      "ポリシリコン",
      "エピタキシャルウエハ",
      "エピウエハ",
      "半導体用シリコン",
      "シリコンインゴット"
    ],
    "excludeKeywords": [
      "太陽電池用ウエハ",
      "太陽光パネル"
    ],
    "sources": [
      {
        "title": "経済安全保障推進法に基づく重要物資の安定的な供給の確保に向けた各特定重要物資に関するサプライチェーンの分析と取組内容",
        "url": "https://www.cao.go.jp/keizai_anzen_hosho/suishinhou/supply_chain/doc/sc_gaiyou2.pdf",
        "date": "2026-04",
        "section": "半導体（サプライチェーン上の課題）ウエハ・部素材図（p.12）",
        "quote": "ウエハシリコンウエハ 化合物ウエハ"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.ENERGY.HYDROGEN_FUEL_CELL",
    "layer": "business",
    "family": "ENERGY",
    "subfamily": "水素",
    "notionColumn": "upstream",
    "labelJa": "水素製造装置・燃料電池",
    "definitionJa": "再生可能エネルギー等由来の水素を製造する水電解装置、および水素と酸素の化学反応で発電する燃料電池(セパレータ等の構成部品を含む)を製造する事業を指す。燃料電池を搭載した完成車両(FCV)そのものの製造や、水素ステーションの小売運営単体は含めない。",
    "definitionEn": "Manufacture of water-electrolysis equipment used to produce hydrogen, and of fuel cells (including component parts such as separators) that generate electricity from hydrogen. Excludes finished fuel-cell vehicles (FCVs) themselves and standalone retail operation of hydrogen refueling stations.",
    "keywords": [
      "水電解装置",
      "水電解槽",
      "燃料電池",
      "水素製造装置",
      "燃料電池セパレータ",
      "燃料電池スタック",
      "PEM水電解",
      "アルカリ水電解",
      "固体酸化物形燃料電池"
    ],
    "excludeKeywords": [
      "燃料電池自動車",
      "FCV完成車"
    ],
    "sources": [
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "細分類2999 その他の電気機械器具製造業（燃料電池セパレータ製造業）",
        "quote": "太陽電池製造業；燃料電池セパレータ製造業"
      },
      {
        "title": "分野別投資戦略(ver.3)",
        "url": "https://www.meti.go.jp/files/900018780.pdf",
        "date": "2025-12-26",
        "section": "重点16分野「水素等」投資促進策",
        "quote": "◆ 産業競争力のある水電解装置や燃料電池の製造設備の投資に対する支援"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.MACH.MACHINE_TOOL",
    "layer": "business",
    "family": "MACH",
    "subfamily": "工作機械",
    "notionColumn": "upstream",
    "labelJa": "工作機械",
    "definitionJa": "金属を切削・研削して部品や製品の形に加工する工作機械(旋盤・フライス盤・マシニングセンタ・研削盤・歯切盤など)を製造する事業。対象は金属を削る・切る工作機械そのものであり、金属を曲げる・打ち抜く金属加工機械(プレス機等)や、工作機械を使って部品加工を受託するだけの企業(単なる金属加工業)は含まない。",
    "definitionEn": "Machine tools that cut or grind metal into finished parts or shapes (lathes, milling machines, machining centers, grinders, gear-cutting machines). Covers makers of the cutting/grinding machine itself; excludes press/forming machinery makers and firms that merely provide contract metal-cutting services using such tools.",
    "keywords": [
      "工作機械",
      "NC工作機械",
      "旋盤",
      "フライス盤",
      "マシニングセンタ",
      "研削盤",
      "歯切盤",
      "放電加工機",
      "中ぐり盤",
      "ボール盤",
      "工作機械事業",
      "精密工作機械",
      "複合加工機"
    ],
    "excludeKeywords": [
      "工作機械賃貸",
      "工作機械修理"
    ],
    "sources": [
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "細分類2661 金属工作機械製造業（小分類266 金属加工機械製造業）p.268",
        "quote": "主として金属塊から切削加工製品を製造する工作機械類を製造する事"
      },
      {
        "title": "経済安全保障推進法に基づく重要物資の安定的な供給の確保（サプライチェーン強靱化）に向けた各特定重要物資に関するサプライチェーンの分析と取組内容",
        "url": "https://www.cao.go.jp/keizai_anzen_hosho/suishinhou/supply_chain/doc/sc_gaiyou2.pdf",
        "date": "2026-04",
        "section": "工作機械・産業用ロボット（「取組方針」）安定供給確保に関する目標 p.9",
        "quote": "工作機械は約11万台／年、産業⽤ロボットは約35万台／年とする。）。"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.MACH.INDUSTRIAL_ROBOT",
    "layer": "business",
    "family": "MACH",
    "subfamily": "産業用ロボット",
    "notionColumn": "upstream",
    "labelJa": "産業用ロボット",
    "definitionJa": "工場の生産ラインで溶接・組立・搬送などの作業を自動で行う産業用ロボット(マニピュレータ、固定/可変シーケンスロボット、数値制御ロボット等)を製造する事業。人と同じ空間で協調して動く協働ロボットや、介護・清掃・災害対応など工場ライン以外で使うサービスロボットはB.MACH.SERVICE_ROBOTで扱う。",
    "definitionEn": "Industrial robots (manipulators, sequence-controlled and numerically-controlled robots) used on factory production lines for welding, assembly, and material transfer. Collaborative robots and non-factory-line service robots (nursing, cleaning, disaster response) are covered by a separate term (B.MACH.SERVICE_ROBOT).",
    "keywords": [
      "産業用ロボット",
      "産業用ロボット事業",
      "マニピュレータ",
      "多関節ロボット",
      "溶接ロボット",
      "組立ロボット",
      "垂直多関節ロボット",
      "ロボットアーム",
      "数値制御ロボット",
      "6軸ロボット"
    ],
    "excludeKeywords": [
      "サービス用ロボット"
    ],
    "sources": [
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "細分類2694 ロボット製造業（小分類269 その他の生産用機械・同部分品製造業）p.271",
        "quote": "ロボット、プレイバックロボット、数値制御ロボットなどの産業用ロボ"
      },
      {
        "title": "経済安全保障推進法に基づく重要物資の安定的な供給の確保（サプライチェーン強靱化）に向けた各特定重要物資に関するサプライチェーンの分析と取組内容",
        "url": "https://www.cao.go.jp/keizai_anzen_hosho/suishinhou/supply_chain/doc/sc_gaiyou2.pdf",
        "date": "2026-04",
        "section": "工作機械・産業用ロボット（「取組方針」）安定供給確保に関する目標 p.9",
        "quote": "工作機械は約11万台／年、産業⽤ロボットは約35万台／年とする。）。"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.MOBI.AUTO_OEM",
    "layer": "business",
    "family": "MOBI",
    "subfamily": "自動車",
    "notionColumn": "downstream",
    "labelJa": "自動車完成車",
    "definitionJa": "乗用車・バス・トラック等の四輪自動車を完成品として製造・組立てし、自社ブランドの完成車として市場に供給する事業。自動車部品のみの製造や、他社完成車の販売・整備・リース・レンタルのみを行う事業は含まない。",
    "definitionEn": "Manufacture and assembly of complete four-wheel motor vehicles (passenger cars, buses, trucks) sold as finished vehicles under the maker's own brand; excludes parts-only manufacturing and dealership/maintenance/leasing/rental-only businesses that do not build the vehicle itself.",
    "keywords": [
      "自動車製造業",
      "完成車製造",
      "乗用車",
      "商用車",
      "バス完成車製造業",
      "ダンプトラック製造業",
      "電気自動車製造業",
      "自動車シャシー製造業",
      "自動車製造組立業",
      "四輪自動車"
    ],
    "excludeKeywords": [
      "自動車部分品製造",
      "中古車販売",
      "自動車リース",
      "レンタカー"
    ],
    "sources": [
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "中分類31/小分類311/細分類3111 自動車製造業（二輪自動車を含む）(p.296)",
        "quote": "3111 自動車製造業（二輪自動車を含む）"
      },
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "細分類3111 定義文(p.296)",
        "quote": "主として各種自動車（二輪自動車を含む）の完成品及び自動車シャシ"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.MED.INNOVATOR_DRUG",
    "layer": "business",
    "family": "MED",
    "subfamily": "医薬品(新薬・先発品)",
    "notionColumn": "downstream",
    "labelJa": "医療用医薬品(新薬・先発品)",
    "definitionJa": "特許期間中の新規有効成分を自社で創製・保有し、医師の処方箋を必要とする先発医薬品(新薬)として製造販売する事業。「ファーストインクラス」(全く新しい作用機序で世界初承認)や「ベストインクラス」(同一作用の中で最も有用性が高い)と呼ばれる新薬開発を含み、後発医薬品(ジェネリック)専業や他社創製品のみの受託製造は含めない。",
    "definitionEn": "A business that discovers/owns and markets prescription pharmaceuticals containing a novel, patent-protected active ingredient (branded/innovator drugs), including \"first-in-class\" (first approved with a wholly new mechanism) and \"best-in-class\" (most effective among drugs sharing a mechanism) candidates. Excludes generic-only businesses and pure contract manufacturing of another company's drug.",
    "keywords": [
      "新薬",
      "先発医薬品",
      "創薬",
      "ファーストインクラス",
      "ベストインクラス",
      "新薬候補",
      "治験",
      "第Ⅲ相試験",
      "承認申請",
      "特許医薬品",
      "希少疾病用医薬品",
      "オーファンドラッグ",
      "創薬ベンチャー",
      "自社創製",
      "医薬品パイプライン"
    ],
    "excludeKeywords": [
      "後発医薬品",
      "ジェネリック医薬品"
    ],
    "sources": [
      {
        "title": "戦略17分野における「主要な製品・技術等」の官民投資ロードマップ",
        "url": "https://www.cas.go.jp/jp/seisaku/nipponseichosenryaku/pdf/rm2026.pdf",
        "date": "2026-07-21",
        "section": "創薬・先端医療 ①ファーストインクラス製品・ベストインクラス製品（医薬品、再生医療等製品）",
        "quote": "米国等では、ファーストインクラス※1製品・ベストインクラス※2製品の開発に当たり、開"
      },
      {
        "title": "戦略17分野における「主要な製品・技術等」の官民投資ロードマップ",
        "url": "https://www.cas.go.jp/jp/seisaku/nipponseichosenryaku/pdf/rm2026.pdf",
        "date": "2026-07-21",
        "section": "創薬・先端医療 ①ファーストインクラス製品・ベストインクラス製品（脚注）",
        "quote": "※1 全く新しい作用で世界で初めて承認されるもの ／ ※2 同じ作用の製品の中で有用性が最も優れるもの"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "B.DEF.SMALL_ARMS",
    "layer": "business",
    "family": "DEF",
    "subfamily": "火器",
    "notionColumn": "downstream",
    "labelJa": "小火器・火砲",
    "definitionJa": "拳銃・小銃・機関銃・機関砲・高射砲・迫撃砲など、軍用の銃器・火砲そのものを製造する事業。狩猟用の猟銃や産業用銃(建設・解体用等)の製造は対象外。",
    "definitionEn": "Manufacture of military firearms and artillery pieces themselves — pistols, rifles, machine guns, autocannons, anti-aircraft guns, mortars. Excludes hunting shotguns/rifles and industrial-use guns (e.g. for construction/demolition).",
    "keywords": [
      "けん銃製造業",
      "小銃製造業",
      "機関銃製造業",
      "機関砲製造業",
      "高射砲製造業",
      "迫撃砲製造業",
      "バズーカ砲製造業",
      "銃剣製造業",
      "火えん発射機製造業",
      "小火器",
      "火砲",
      "火器事業"
    ],
    "excludeKeywords": [
      "猟銃",
      "産業用銃",
      "狩猟用"
    ],
    "sources": [
      {
        "title": "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
        "url": "https://www.soumu.go.jp/main_content/000941216.pdf",
        "date": "2023-07",
        "section": "細分類2761 武器製造業（p.278）",
        "quote": "けん銃製造業；小銃製造業；機関銃製造業；機関砲製造業；高射砲製造業"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  }
];

/** theme 2 件 (構成語はどちらも上の 7 件に含まれる) */
export const MINI_THEME_TERMS: ThemeTerm[] = [
  {
    "id": "T.HYDROGEN",
    "layer": "theme",
    "labelJa": "水素・燃料電池",
    "definitionJa": "水電解装置・燃料電池など水素の製造・利用機器を手掛ける企業群。GX分野別投資戦略「水素等」分野で製造設備投資支援の対象とされている。",
    "definitionEn": "Makers of water-electrolysis equipment and fuel cells for hydrogen production and use, supported under the \"hydrogen etc.\" field of Japan's GX sector investment strategy.",
    "members": [
      "B.ENERGY.HYDROGEN_FUEL_CELL"
    ],
    "sources": [
      {
        "title": "分野別投資戦略(Ver.3)",
        "url": "https://www.meti.go.jp/files/900018780.pdf",
        "date": "2025-12-26",
        "section": "水素等分野 投資促進策(p.54-56)",
        "quote": "◆ 産業競争力のある水電解装置や燃料電池の製造設備の投資に対する支援"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  },
  {
    "id": "T.MACHINE_TOOL_ROBOT",
    "layer": "theme",
    "labelJa": "工作機械・産業用ロボット",
    "definitionJa": "工作機械および産業用ロボットの製造企業群。経済安全保障推進法で単一の特定重要物資として指定され、制御関連機器や専用部素材を含む国内生産基盤強化の対象となっている。",
    "definitionEn": "Makers of machine tools and industrial robots, jointly designated as a single specified critical material under Japan's economic security law, with a focus on strengthening domestic production of control equipment and dedicated parts.",
    "members": [
      "B.MACH.MACHINE_TOOL",
      "B.MACH.INDUSTRIAL_ROBOT"
    ],
    "sources": [
      {
        "title": "経済施策を一体的に講ずることによる安全保障の確保の推進に関する法律施行令",
        "url": "https://laws.e-gov.go.jp/law/504CO0000000394",
        "date": "2022-12-23",
        "section": "第1条(特定重要物資の指定)第四号",
        "quote": "四　工作機械及び産業用ロボット"
      }
    ],
    "addedIn": "v1",
    "deprecated": false
  }
];

/** 検査を通る最小の単語帳 (version v1) */
export const MINI_VOCAB: Vocabulary = {
  version: "v1",
  business: MINI_BUSINESS_TERMS,
  themes: MINI_THEME_TERMS,
};
