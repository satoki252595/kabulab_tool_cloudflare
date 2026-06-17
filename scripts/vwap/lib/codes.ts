import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// public/vwap-analysis/data/stocks.json から全銘柄コードを得る（Worker の loadCodes と同じ）。
export async function loadCodes(): Promise<string[]> {
  const j = JSON.parse(await fs.readFile(path.join(ROOT, "public/vwap-analysis/data/stocks.json"), "utf8"));
  return j.stocks.map((s: any[]) => s[0]);
}

// 引数 --key=value を読む簡易パーサ
export function arg(key: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${key}=`));
  return a ? a.slice(key.length + 3) : undefined;
}
