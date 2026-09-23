/**
 * Notion アーカイブの配置定義 (正本) と索引ページブロックの生成。
 *
 * Notion 側に「何がどこにあるか」を一発で分かる索引ページ
 * (BACKUP 直下の「アーカイブ索引」) を置く。その内容はこのモジュールが
 * 唯一の正本。配置を変えたらここを直して `pnpm notion:update-index` で
 * 再生成する (索引ページの手編集は禁止 — 再生成で消える)。
 *
 * 全記述はコードの事実のみ (実測数値・推測は書かない。ルール1)。
 * 各エントリの根拠コードを writer に残し、配置と実装の対応を追えるようにする。
 */

/** BACKUP 直下の索引ページのタイトル (固定) */
export const INDEX_PAGE_TITLE = "アーカイブ索引";

export interface IndexBullet {
  /** Notion 上のタイトル (DB 名・ページ名パターン。太字表示) */
  title: string;
  /** 一行説明 (内容・キー形式・書き手) */
  detail: string;
}

export interface IndexSection {
  heading: string;
  bullets: IndexBullet[];
}

/** 索引の全節。順序 = ページ上の表示順。 */
export const ARCHIVE_SECTIONS: IndexSection[] = [
  {
    heading: "一次データ — バックアップ直下のサービス別 DB",
    bullets: [
      {
        title: "一次データ｜yuho-quant",
        detail:
          "EDINET 有報 ZIP (XBRL type=1 / CSV type=5)。key=書類 ID (例 S100W6XE)。書き手: yuho-quant ingest / backfill-missing-docs / repair-zip-archive",
      },
      {
        title: "一次データ｜ir-catalog",
        detail:
          "TDnet 日次確定バッチ JSON (tdnet-daily-YYYY-MM-DD.json)。key=tdnet-daily-YYYY-MM-DD。書き手: src/cron/ir-catalog-tdnet.ts",
      },
      {
        title: "一次データ｜otakara-yutai",
        detail:
          "優待説明文 JSONL 確定スナップショット。key=benefit-descriptions-YYYY-MM-DD。書き手: otakara-yutai export-benefit-descriptions",
      },
      {
        title: "一次データ｜vwap-analysis",
        detail:
          "JPX 信用残高週次 PDF (実体)。key=jpx-margin-YYYY-MM-DD (週)。書き手: scripts/vwap/ingest-margin.ts",
      },
      {
        title: "一次データ｜universe",
        detail:
          "JPX 上場銘柄 XLS (実体)。key=jpx-listing-YYYY-MM (ファイル内基準月)。書き手: src/shared/jpx/sectors.ts",
      },
    ],
  },
  {
    heading: "銘柄別データ — バックアップ直下",
    bullets: [
      {
        title: "銘柄一覧｜ir-catalog (DB)",
        detail:
          "1 銘柄 = 1 ページ。配下に子 DB「適時開示｜<ticker>」(1 IR = 1 行)。書き手: dataset.ts upsertDisclosuresByStock",
      },
      {
        title: "<証券コード> (ページ)",
        detail:
          "銘柄コード名の子ページ。配下に子 DB「有報テキスト」(1 行 = 1 通、本文=抽出テキスト全文)。書き手: stock-text.ts",
      },
    ],
  },
  {
    heading: "ごみ — 不要化データの退避先 (ごみページ直下)",
    bullets: [
      {
        title: "ごみ｜<service> (DB)",
        detail:
          "moveToTrash が物理ファイルごと退避。Obsoleted At / Obsoleted Reason / Origin Page を保持し、元レコードは Notion ゴミ箱へ",
      },
    ],
  },
  {
    heading: "運用メモ",
    bullets: [
      {
        title: "区切りは全角｜(U+FF5C)",
        detail:
          "半角 | と取り違えないこと。手検索時は全角で探す",
      },
      {
        title: "発見は Search 完全一致 + 最古優先",
        detail:
          "children 全走査は約1万件で打ち切られる実測があるため、findBackupChildByTitle で正本へ収束させる。重複があっても最古 (正本) を使う",
      },
      {
        title: "このページは自動生成",
        detail:
          "正本は src/shared/notion-archive/map.ts。配置変更時は `pnpm notion:update-index` で再生成する (手編集は再生成で消える)",
      },
      {
        title: "索引ページ自体の維持",
        detail:
          "NOTION_INDEX_PAGE_ID 設定時は直接更新。未設定時は Search 発見 + 再試行 + 同名重複の整理 (最古を残す) で1ページへ収束させる",
      },
    ],
  },
];

function rich(content: string, bold = false): unknown {
  return {
    type: "text",
    text: { content },
    annotations: { bold },
  };
}

/**
 * 索引ページの本文ブロックを生成する。純粋関数 (時刻は引数で受ける)。
 * ブロック数は 100 未満・各 rich_text は 2000 文字未満に収める
 * (Notion 1 要求上限の内側。超過時は throw して気づかせる)。
 */
export function buildIndexBlocks(generatedAtISO: string): unknown[] {
  const blocks: unknown[] = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          rich(
            `kabulab 一次データ Notion アーカイブの索引 (自動生成: ${generatedAtISO})。` +
              "何がどこにあるかの一覧。正本は src/shared/notion-archive/map.ts。"
          ),
        ],
      },
    },
  ];
  for (const s of ARCHIVE_SECTIONS) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [rich(s.heading, true)] },
    });
    for (const b of s.bullets) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [rich(`${b.title} — `, true), rich(b.detail)],
        },
      });
    }
  }
  if (blocks.length >= 100) {
    throw new Error(
      `索引ブロック数が 1 要求上限に到達: ${blocks.length} (map.ts を分割すること)`
    );
  }
  for (const b of blocks) {
    const rt = (
      b as {
        paragraph?: { rich_text: Array<{ text?: { content?: string } }> };
        heading_2?: { rich_text: Array<{ text?: { content?: string } }> };
        bulleted_list_item?: {
          rich_text: Array<{ text?: { content?: string } }>;
        };
      }
    );
    const texts =
      rt.paragraph?.rich_text ??
      rt.heading_2?.rich_text ??
      rt.bulleted_list_item?.rich_text ??
      [];
    for (const t of texts) {
      const len = [...(t.text?.content ?? "")].length;
      if (len >= 2000) {
        throw new Error(`索引 rich_text が上限に到達: ${len} 文字`);
      }
    }
  }
  return blocks;
}
