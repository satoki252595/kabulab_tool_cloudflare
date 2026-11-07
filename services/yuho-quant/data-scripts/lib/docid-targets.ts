/**
 * backfill-missing-docs の docID 指定モード用ターゲット解析 (純粋関数)。
 *
 * 入力は JSONL (1 行 1 件): {"docID": "S100XXXX", "submit": "2017-06-29 15:30"}
 * submit の先頭 10 文字を提出日として日付ごとに束ねる。突合スクリプト等の
 * 出力をそのまま渡せる形にし、日付が読めない行は黙って落とさず throw する
 * (取りこぼし救済が目的なので、入力欠落を成功扱いにしない)。
 */

const DOC_ID_RE = /^S[0-9A-Z]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDocidTargets(text: string): Map<string, Set<string>> {
  const byDate = new Map<string, Set<string>>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new Error(`docids-file: ${i + 1} 行目が JSON ではありません`);
    }
    if (typeof obj !== "object" || obj === null) {
      throw new Error(`docids-file: ${i + 1} 行目がオブジェクトではありません`);
    }
    const rec = obj as Record<string, unknown>;
    const docID = rec["docID"];
    const submit = rec["submit"];
    if (typeof docID !== "string" || !DOC_ID_RE.test(docID)) {
      throw new Error(`docids-file: ${i + 1} 行目の docID が不正です: ${String(docID)}`);
    }
    if (typeof submit !== "string" || !DATE_RE.test(submit.slice(0, 10))) {
      throw new Error(`docids-file: ${i + 1} 行目の submit から日付を読めません: ${String(submit)}`);
    }
    const date = submit.slice(0, 10);
    let set = byDate.get(date);
    if (!set) {
      set = new Set<string>();
      byDate.set(date, set);
    }
    set.add(docID);
  }
  if (byDate.size === 0) {
    throw new Error("docids-file: 対象が 0 件です");
  }
  return new Map([...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
