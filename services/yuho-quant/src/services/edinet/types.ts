/**
 * EDINET API v2 のレスポンス Zod スキーマ。
 *
 * 仕様: EDINET API 仕様書 (Version 2) — 書類一覧 API `documents.json`。
 * CLAUDE.md ルール2 に従い、想定外の構造は parse 失敗として throw させる
 * (silent な穴埋めをしない)。null になり得るフィールドは null のまま保持し、
 * `?? デフォルト` で消さない。
 */
import { z } from "zod";
import { parseStockCode } from "../../../../../src/shared/jpx/stock-code.js";

/** documents.json の results[] 1 件 (有報判定に使う項目を中心に型付け) */
export const edinetDocSchema = z.object({
  seqNumber: z.number().int(),
  docID: z.string(),
  /** 提出者 EDINET コード (例: E01234)。ファンド等で null になり得る */
  edinetCode: z.string().nullable(),
  /** 証券コード 5 桁 (4 桁ティッカー + 末尾 0)。非上場提出者は null */
  secCode: z.string().nullable(),
  JCN: z.string().nullable(),
  /** 提出者名。取下げ等で null になり得る (実 API 確認済) */
  filerName: z.string().nullable(),
  /** 府令コード — 有報は "010" (企業内容等の開示に関する内閣府令) */
  ordinanceCode: z.string().nullable(),
  /** 様式コード — 有報は "030000" */
  formCode: z.string().nullable(),
  /** 書類種別コード — 120=有価証券報告書, 130=訂正有価証券報告書 */
  docTypeCode: z.string().nullable(),
  periodStart: z.string().nullable(),
  periodEnd: z.string().nullable(),
  /** 提出日時。取下げ等で null になり得る (実 API 確認済) */
  submitDateTime: z.string().nullable(),
  docDescription: z.string().nullable(),
  /** "1"=XBRL あり */
  xbrlFlag: z.string(),
  /** "1"=CSV あり */
  csvFlag: z.string(),
  /** "1"=取下げ — 取下げ書類は無効として扱う */
  withdrawalStatus: z.string(),
});

export type EdinetDoc = z.infer<typeof edinetDocSchema>;

export const edinetListResponseSchema = z.object({
  metadata: z.object({
    /** API レベルのステータス。"200" 以外は異常 → 呼び出し側で throw */
    status: z.string(),
    message: z.string(),
    resultset: z.object({ count: z.number().int() }),
  }),
  results: z.array(edinetDocSchema),
});

export type EdinetListResponse = z.infer<typeof edinetListResponseSchema>;

/**
 * 事業会社の有価証券報告書 (訂正含む) の判定。
 *
 * docTypeCode 120(有報)/130(訂正有報) に加え、
 * ordinanceCode "010"(企業内容等の開示に関する内閣府令) かつ
 * formCode "030000"(有報)/"030001"(訂正有報) を要求する。これにより
 * 「有価証券報告書（内国投資信託受益証券）」(ord 030 / form 07A000) 等の
 * 非事業会社の開示を確実に除外する (実 EDINET で確認)。
 */
export function isAnnualSecuritiesReport(doc: EdinetDoc): boolean {
  return (
    doc.withdrawalStatus !== "1" &&
    doc.ordinanceCode === "010" &&
    (doc.docTypeCode === "120" || doc.docTypeCode === "130") &&
    (doc.formCode === "030000" || doc.formCode === "030001")
  );
}

/**
 * 当該有報の会計期末 (YYYY-MM-DD) を確定する。
 *
 * 通常の有報(120)は `periodEnd` が入る。訂正有報(130)は EDINET の一覧で
 * periodEnd が null になり、対象期間は docDescription に
 * 「…第77期(2024/04/01－2025/03/31)」の形でのみ示される。これは EDINET
 * 自身が示す対象期間であり、捏造ではなく原典記載の抽出 (ルール2整合)。
 * どちらからも確定できなければ null (呼び出し側で除外させる。埋めない)。
 */
/** 和暦元号 → 西暦元年。和暦N年 = base + N (例: 令和2年 = 2018+2 = 2020) */
const ERA_BASE: Record<string, number> = {
  令和: 2018,
  平成: 1988,
  昭和: 1925,
};

function fmtIso(y: number, mo: number, d: number): string | null {
  // 暦的に不正な値は採用しない (ルール2: 不確かなら埋めず null)
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function resolveReportPeriodEnd(doc: EdinetDoc): string | null {
  if (doc.periodEnd && /^\d{4}-\d{2}-\d{2}$/.test(doc.periodEnd.trim())) {
    return doc.periodEnd.trim();
  }
  if (!doc.docDescription) return null;
  // 全角数字を半角化してから対象期間を抽出
  const desc = doc.docDescription.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );

  // (1) 西暦表記 YYYY/MM/DD の最後 (=対象期間の至日) を採用
  const seireki = [...desc.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2})/g)];
  if (seireki.length > 0) {
    const m = seireki[seireki.length - 1];
    return fmtIso(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // (2) 和暦表記 「(令和|平成|昭和)(元|N)年M月D日」の最後を採用し西暦へ変換。
  //     EDINET 原典記載の抽出であり捏造ではない (ルール2整合)。
  const wareki = [
    ...desc.matchAll(/(令和|平成|昭和)(元|\d{1,2})年(\d{1,2})月(\d{1,2})日/g),
  ];
  if (wareki.length > 0) {
    const m = wareki[wareki.length - 1];
    const base = ERA_BASE[m[1]];
    if (base === undefined) return null;
    const eraYear = m[2] === "元" ? 1 : Number(m[2]);
    return fmtIso(base + eraYear, Number(m[3]), Number(m[4]));
  }
  return null;
}

/**
 * EDINET の 5 文字 secCode を core.stocks.code (4 文字ティッカー) に変換する。
 * secCode は「4 文字ティッカー + 末尾チェック 1 文字」。JPX 英数字コード
 * (例: 130A) も "130A0" のように下 4 文字がティッカーになる。4 文字でそのまま
 * 来る場合もある。形式判定・正規化は共有ヘルパに委ね、不確かなら null を返す
 * (ルール2: 埋めずに null を返し、呼び出し側で除外させる)。
 */
export function secCodeToTicker(secCode: string | null): string | null {
  if (!secCode) return null;
  const s = secCode.trim();
  if (s.length === 5) return parseStockCode(s.slice(0, 4));
  if (s.length === 4) return parseStockCode(s);
  return null;
}
