import { describe, it, expect } from "vitest";
import { classify, HIGH_SIGNAL_TAGS } from "../services/classify.js";
import {
  companyCodeToTicker,
  normalizeTdnetItem,
  type TdnetItemRaw,
} from "../services/tdnet/types.js";
import { prepareRows } from "../services/ingest.js";

describe("classify — 決定論的・捏造なし", () => {
  it("上方修正を方向付きで判定", () => {
    const c = classify("2026年3月期 業績予想及び配当予想の修正（上方修正）に関するお知らせ");
    expect(c.tags).toContain("上方修正");
    expect(c.tags).not.toContain("下方修正");
    expect(c.primaryTag).toBe("上方修正");
  });

  it("下方修正と上方修正は排他", () => {
    expect(classify("通期業績予想の下方修正に関するお知らせ").tags).toEqual(
      expect.arrayContaining(["下方修正"])
    );
    expect(classify("通期業績予想の下方修正に関するお知らせ").tags).not.toContain(
      "上方修正"
    );
  });

  it("増配", () => {
    const c = classify("配当予想の修正（増配）に関するお知らせ");
    expect(c.tags).toContain("増配");
    expect(c.primaryTag).toBe("増配");
  });

  it("配当政策の変更は増配と別概念", () => {
    const c = classify("株主還元方針の変更に関するお知らせ");
    expect(c.tags).toContain("配当政策の変更");
    expect(c.tags).not.toContain("増配");
  });

  it("自社株買い / 自己株式の消却", () => {
    expect(classify("自己株式の取得に係る事項の決定に関するお知らせ").tags).toContain(
      "自社株買い"
    );
    expect(classify("自己株式の消却に関するお知らせ").tags).toContain(
      "自己株式の消却"
    );
  });

  it("決算短信", () => {
    expect(classify("2026年3月期 第1四半期決算短信〔IFRS〕（連結）").tags).toContain(
      "決算短信"
    );
  });

  it("方向不明の業績予想修正は中立タグに留める (方向を捏造しない)", () => {
    const c = classify("業績予想の修正に関するお知らせ");
    expect(c.tags).toContain("業績予想の修正");
    expect(c.tags).not.toContain("上方修正");
    expect(c.tags).not.toContain("下方修正");
  });

  it("どの規則にも当たらない開示は未分類 (タグを捏造しない)", () => {
    const c = classify("本社移転に関するお知らせ");
    expect(c.tags).toEqual([]);
    expect(c.primaryTag).toBeNull();
  });

  it("highSignal 集合に主要 6 種が含まれる", () => {
    for (const t of [
      "上方修正",
      "下方修正",
      "増配",
      "減配・無配",
      "配当政策の変更",
      "自社株買い",
    ]) {
      expect(HIGH_SIGNAL_TAGS.has(t)).toBe(true);
    }
    expect(HIGH_SIGNAL_TAGS.has("決算短信")).toBe(false);
  });
});

describe("companyCodeToTicker — 推測で補正しない", () => {
  it("5 桁→先頭4桁", () => {
    expect(companyCodeToTicker("72030")).toBe("7203");
    expect(companyCodeToTicker("65490")).toBe("6549");
  });
  it("4 桁はそのまま", () => {
    expect(companyCodeToTicker("7203")).toBe("7203");
  });
  it("英数字混在の新コード (例 135A0→135A)", () => {
    expect(companyCodeToTicker("135A0")).toBe("135A");
    expect(companyCodeToTicker("131a0")).toBe("131A");
  });
  it("想定外は null (フォールバックしない)", () => {
    expect(companyCodeToTicker("")).toBeNull();
    expect(companyCodeToTicker(null)).toBeNull();
    expect(companyCodeToTicker("12")).toBeNull();
    expect(companyCodeToTicker("12-34")).toBeNull();
  });

  // 元はこの行が「想定外は null」の一部として `７２０３` → null を要求していた。
  // 全角→半角は「推測による補正」ではなく「同じ値の表現揺れを揃える処理」で、
  // 共有ヘルパ normalizeStockCode が仕様として明記している挙動 (ルール2 の明示的な
  // 例外)。EDINET 側の secCodeToTicker は以前から半角化して受理しており、
  // TDnet 側だけが弾いていたのが割れの実体だったので、削除せず反転して残す。
  // 実データへの影響は無い: 本番 ir_disclosures 37,641 行の company_code は
  // 全件 ASCII (小文字 0 件・全角 0 件。TDnet WebAPI 由来なので当然)。
  it("全角は表現揺れとして半角化して受理する", () => {
    expect(companyCodeToTicker("７２０３")).toBe("7203");
    expect(companyCodeToTicker("１３０ａ")).toBe("130A");
  });

  // 5 文字を無条件に先頭 4 文字で切ると別の証券に取り違える。
  // 検査文字が "0" のものだけを 4 文字化する。
  it("末尾検査文字が 0 でない 5 文字は null (取り違えより取りこぼし)", () => {
    // 伊藤園第1種優先株式。旧実装は "2593" (同社 普通株) を返しており、
    // 優先株の開示を普通株のページへ付け替えていた。両方が本番 core_stocks に実在。
    expect(companyCodeToTicker("25935")).toBeNull();
    // 実在しないコード "0720" を捏造していた (本番に先頭 0 のコードは 0 件)。
    expect(companyCodeToTicker("07203")).toBeNull();
    // 末尾の検査文字が 0 でない 5 文字。先頭 4 文字の 1202 (合成コード) は core_stocks に無いため、
    // 旧実装でも次行の codeToId 突合で落ちていた。取りこぼしは増えない。
    expect(companyCodeToTicker("12024")).toBeNull();
  });

  it("1 桁目英字は JPX 付番体系に無いので null", () => {
    // 旧実装は /^[0-9A-Z]{4,5}$/ だったため "A130" をそのまま通していた。
    expect(companyCodeToTicker("A130")).toBeNull();
  });
});

describe("normalizeTdnetItem — 符号化揺れ吸収・異常は null (ルール2)", () => {
  const flat = {
    id: "9",
    pubdate: "2026-05-14 22:30:00",
    company_code: "19110",
    company_name: "住友林",
    title: "(開示事項の経過)子会社化完了に関するお知らせ",
    document_url: "https://x/d.pdf",
    url_xbrl: null,
    markets_string: "東",
    update_history: null,
  };
  it("ラッパ有無どちらも同じ結果に正規化", () => {
    const a = normalizeTdnetItem({ Tdnet: flat }, "t");
    const b = normalizeTdnetItem(flat, "t");
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.id).toBe("9");
  });
  it("markets_string 欠落は null 許容 (捏造しない)", () => {
    const { markets_string: _omit, ...noMkt } = flat;
    const r = normalizeTdnetItem(noMkt, "t");
    expect(r).not.toBeNull();
    expect(r!.markets_string).toBeNull();
  });
  it("本質フィールド欠落は null を返す (バッチ全体を落とさない)", () => {
    const { title: _t, ...noTitle } = flat;
    expect(normalizeTdnetItem(noTitle, "t")).toBeNull();
    expect(normalizeTdnetItem(null, "t")).toBeNull();
    expect(normalizeTdnetItem("x", "t")).toBeNull();
  });
});

function item(over: Partial<TdnetItemRaw> & { id: string }): TdnetItemRaw {
  return {
    id: over.id,
    pubdate: over.pubdate ?? "2026-05-18 15:00:00",
    company_code: over.company_code ?? "72030",
    company_name: over.company_name ?? "トヨタ自",
    title: over.title ?? "決算短信",
    document_url: over.document_url ?? "https://x/doc.pdf",
    url_xbrl: over.url_xbrl ?? null,
    markets_string: over.markets_string ?? "東",
    update_history: over.update_history ?? null,
  };
}

describe("prepareRows — 冪等な前処理 (ルール1/2)", () => {
  const codeToId = new Map<string, number>([["7203", 1]]);

  it("同一 tdnet_id は後勝ちで 1 行に畳む (バッチ全体落下を防ぐ)", () => {
    const rows = prepareRows(
      [
        item({ id: "100", title: "決算短信" }),
        item({ id: "100", title: "（訂正）決算短信" }),
      ],
      codeToId
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("（訂正）決算短信");
  });

  it("ユニバース外コード/不正コードは正直に除外 (捏造しない)", () => {
    const rows = prepareRows(
      [
        item({ id: "1", company_code: "99990" }), // core.stocks に無い
        item({ id: "2", company_code: "ABCDE" }), // 不正
        item({ id: "3", company_code: "72030" }), // ユニバース内
      ],
      codeToId
    );
    expect(rows.map((r) => r.tdnetId)).toEqual(["3"]);
    expect(rows[0].ticker).toBe("7203");
  });

  it("pubdate を JST(+09:00) として解釈する", () => {
    const rows = prepareRows(
      [item({ id: "5", pubdate: "2026-05-18 15:00:00" })],
      codeToId
    );
    // 15:00 JST = 06:00 UTC
    expect(rows[0].pubdate.toISOString()).toBe("2026-05-18T06:00:00.000Z");
  });

  it("不正な pubdate は throw (捏造しない)", () => {
    expect(() =>
      prepareRows([item({ id: "9", pubdate: "2026/05/18" })], codeToId)
    ).toThrow();
  });
});
