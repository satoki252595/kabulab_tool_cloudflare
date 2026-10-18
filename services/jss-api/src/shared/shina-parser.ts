/** Worker/Node共用。JSF shinaの純粋なCSV解析と単位検査。 */
import { parseCsvRows } from "../../../moneyflow/lib/sources/mof-portfolio-flows";

const HEADERS = ["貸借申込日", "決済日", "コード", "銘柄名", "取引所区分", "決算事由", "決算等", "貸借値段（円）", "貸株超過株数", "最高料率（円）", "当日品貸料率（円）", "当日品貸日数", "前日品貸料率（円）", "備考", "制限", "応札倍率ランク"];
function number(raw: string, integer = false): number | null {
  const value = raw.trim();
  if (value === "" || value === "*****") return null;
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) throw new Error("JSF shina数値不正");
  const n = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(n) || (integer && !Number.isSafeInteger(n))) throw new Error("JSF shina数値範囲外");
  return n;
}
function date(raw: string): string {
  if (!/^(?:\d{8}|\d{4}\/\d{2}\/\d{2})$/.test(raw)) throw new Error("JSF shina日付不正");
  raw = raw.replace(/\//g, "");
  const value = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
  if (new Date(value).toISOString().slice(0, 10) !== value) throw new Error("JSF shina実日付不正");
  return value;
}
export function assertShinaUnitNote(value: unknown): void {
  if (typeof value !== "string") throw new Error("JSF shina単位注記欠損");
  const note = value.normalize("NFKC").replace(/\s/g, "");
  if (!note.includes("最高料率および前日品貸料率は1日1株・口当り") || !note.includes("当日品貸料率は1日1株・口当りの品貸料率に当日品貸日数を乗じて表示")) throw new Error("JSF shina単位注記が未対応");
}

export function parseShina(bytes: ArrayBuffer): Record<string, unknown>[] {
  const rows = parseCsvRows(new TextDecoder("shift_jis", { fatal: true, ignoreBOM: false }).decode(bytes));
  if (rows.length < 5 || rows.length > 10004 || rows[0]?.[0] !== "品貸料率一覧" || rows[2]?.[1] !== "全体" || JSON.stringify(rows[3]) !== JSON.stringify(HEADERS)) throw new Error("JSF shina様式不正");
  assertShinaUnitNote(rows[1]?.[0]);
  const seen = new Set<string>(), dates = new Set<string>();
  const result = rows.slice(4).map(row => {
    if (row.length !== 16 || !/^(?:\d{4}|\d{3}[A-Z])$/.test(row[2]!) || !row[3] || !row[4]) throw new Error("JSF shina銘柄不正");
    const basis = date(row[0]!); dates.add(basis);
    const identity = `${row[2]}|${row[4]}`;
    if (seen.has(identity)) throw new Error("JSF shina重複"); seen.add(identity);
    return { code: row[2], data_type: "jsf_shina", data_date: basis, name: row[3], exchange: row[4], excess_shares: number(row[8]!, true), max_rate: number(row[9]!), today_rate: number(row[10]!), fee_days: number(row[11]!, true), prev_rate: number(row[12]!), note: row[13], restriction: row[14], bid_rank: row[15], units: { excess_shares: "shares", max_rate: "JPY_per_share_per_day", today_rate: "JPY_per_share_for_fee_days", prev_rate: "JPY_per_share_per_day", fee_days: "days" }, license_tag: "personal-only" };
  });
  if (dates.size !== 1) throw new Error("JSF shina基準日混在");
  return result;
}
