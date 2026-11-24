/**
 * MCP サーバ（Streamable HTTP・ステートレス）。
 *
 * JSON-RPC 2.0 の `initialize` / `tools/list` / `tools/call` だけを実装する。
 * ステートレスにしているのは、セッションを持つと Worker のインスタンス間で
 * 状態を共有する必要が出る（Durable Object が要る）ため。読み取り専用の
 * データ参照ツールしか出さないのでセッションは不要。
 *
 * ツール名は `jp_*` 名前空間。kabuMCP の `edinet_*` とは分ける（両方を
 * クライアントに登録できるので統合しなくてよい）。
 */
import { envelope } from "./envelope";
import { fetchAdjustedOhlcvCached } from "./ohlcv-cache";
import {
  SUPPLY_TYPES,
  fetchSupplyLatest,
  fetchSupplySeries,
  parseSupplyFilter,
  supplySourcesFromLatest,
  supplySourcesFromSeries,
} from "./supply";
import {
  MAX_BATCH_CODES,
  classifyForecastMissingCodes,
  classifyMissingCodes,
  fetchForecastLatestByCodes,
  fetchIndicatorsByCodes,
  fetchLatestJobRuns,
  fetchValuationByCodes,
  isValidCode,
  parseCodes,
  parseLimit,
} from "./routes";
import { isSupplyCode } from "./jpx-margin";
import {
  EVENT_KINDS,
  MASTER_LICENSES,
  fetchDisclosures,
  fetchFinancialsByCodes,
  fetchForecastHistory,
  fetchOhlcvR2,
  fetchUniverseEvents,
  fetchUniverseMaster,
  parseEventKind,
  parseG1Date,
  parseG1Text,
} from "./g1";
import type { PrivateEnv } from "./types";

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const TOOLS = [
  {
    name: "jp_supply_latest",
    description:
      "日本株の需給の最新断面を返す。data_type は jsf_zandaka（日証金の貸借残高）・" +
      "jsf_shina（日証金の逆日歩）・jpx_margin（JPX の信用残）。省略時は全種類。" +
      "出典は返却行から算出する (meta.attribution)。",
    inputSchema: {
      type: "object",
      properties: {
        data_type: { type: "string", enum: [...SUPPLY_TYPES] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: "jp_supply_series",
    description:
      "1銘柄の需給時系列を返す。series は jsf_zandaka（日証金の貸借残高）・" +
      "jsf_shina（日証金の逆日歩）・jpx_margin（JPX の信用残）。省略時は全系列。" +
      "出典は返却系列から算出する (meta.attribution)。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4文字の銘柄コード（JPXは原文5文字も可）" },
        series: { type: "string", enum: [...SUPPLY_TYPES] },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        cursor: { type: "string", description: "前応答meta.cursor。JPX基準日20日ずつ、nullで終端" },
      },
      required: ["code"],
    },
  },
  {
    name: "jp_ohlcv_range",
    description:
      "1銘柄の日足 OHLCV を返す。提供元の OHLCV（分割調整済み）。adj_* は配当込 total-return 調整価格（係数不明は null、adj_volume は常に null）。出来高の現株数補正はしない。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4桁の銘柄コード" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        limit: { type: "integer", minimum: 1, maximum: 3000 },
      },
      required: ["code"],
    },
  },
  {
    name: "jp_dataset_freshness",
    description: "各データセットの最新基準日・件数・格納先を返す。取り込みの鮮度確認用。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "jp_indicators_latest",
    description:
      "日本株の株価テクニカルの最新断面を銘柄コードで返す（旧 Notion『②株価テクニカル』の代替）。" +
      "終値・出来高・前日比・移動平均(5/20/25/60/75)・RSI(14)・MACD・ATR(14)・出来高比率・20日レンジを含む。" +
      "codes は最大 " + MAX_BATCH_CODES + " 件。見つからない code は data.not_found に列挙し、" +
      "理由 (unknown_code=未知コード / not_collected=実在するが未計算) を data.not_found_reasons に出す" +
      "（欠損値を埋めて返すことはしない）。",
    inputSchema: {
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BATCH_CODES,
          description: "4桁の銘柄コードの配列",
        },
      },
      required: ["codes"],
    },
  },
  {
    name: "jp_valuation",
    description:
      "日本株のバリュエーションの最新断面を銘柄コードで返す（旧 Notion『②株価テクニカル』の" +
      "バリュエーション欄の代替）。株価・PER・PBR・配当利回り・EPS・BPS・ROE・ROA・時価総額と、" +
      "その基準日(data_date)・取得時刻(fetched_at)を含む。値は Yahoo 由来の日次断面で、" +
      "PER/EPS は実績TTM (trailing。予想PERではない)。分母の basis は Yahoo 定義であり、" +
      "一次情報（財務サマリ）の代替ではない概況値として扱うこと。codes は最大 " + MAX_BATCH_CODES + " 件。" +
      "見つからない code は data.not_found に列挙し、理由 (unknown_code=未知コード / " +
      "not_collected=実在するが未取得) を data.not_found_reasons に出す。",
    inputSchema: {
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BATCH_CODES,
          description: "4桁の銘柄コードの配列",
        },
      },
      required: ["codes"],
    },
  },
  {
    name: "jp_forecast_latest",
    description:
      "日本株の会社業績予想を銘柄コードで返す（TDnet 決算短信の会社予想）。" +
      "銘柄ごとに最新開示1行だけを返し、その開示が述べた通期予想（売上・営業利益・" +
      "経常利益・純利益・EPS）と予想配当、対象期末 (target_period_end)、開示時刻 " +
      "(disclosed_at) を含む。列ごとの最新値合成はしないため、最新開示が予想未定なら" +
      "値は null のまま返る（古い開示の予想で埋めない）。対象期末は短信の文脈から" +
      "読めた場合だけ入る。codes は最大 " + MAX_BATCH_CODES + " 件。見つからない code は " +
      "data.not_found に列挙し、理由 (unknown_code=未知コード / " +
      "no_forecast_in_store=実在するが予想行が無い) を data.not_found_reasons に出す。" +
      "TDnet 由来 (factual-cite) のため内部面のみ。",
    inputSchema: {
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BATCH_CODES,
          description: "4桁の銘柄コードの配列",
        },
      },
      required: ["codes"],
    },
  },
  {
    name: "jp_job_runs",
    description:
      "収集ジョブの最新実行状況をジョブ名ごとに1件返す（旧 Notion『⑦収集ジョブログ』の代替。" +
      "鮮度ガード用途）。job_name を省略すると全ジョブの最新1件ずつを返す。" +
      "`/v1/meta/jobs` は直近N件の履歴列挙だが、こちらは「各ジョブの最新1件」に畳んで返す。",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string" },
      },
    },
  },
  {
    name: "jp_disclosures_list",
    description:
      "適時開示 (TDnet) の一覧を新しい順で返す (factual-cite、内部面のみ)。" +
      "code (4文字)・from/to (YYYY-MM-DD、開示日時の JST 暦日)・titleContains (表題部分一致)・" +
      "tag (代表タグまたは分類タグ) で絞れる。pubdate は epoch 秒。各行は tdnet_id・code・" +
      "company_code/company_name・title・document_url・xbrl_url/has_xbrl・tags・primary_tag を含み、" +
      "本文は返さない。続きは meta.cursor を cursor に渡す。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4桁の銘柄コード" },
        from: { type: "string", description: "YYYY-MM-DD (JST)" },
        to: { type: "string", description: "YYYY-MM-DD (JST)" },
        titleContains: { type: "string" },
        tag: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", description: "前応答 meta.cursor。そのまま渡す" },
      },
    },
  },
  {
    name: "jp_financials",
    description:
      "財務要約 (実績+短信予想列) を期末の新しい順で返す (jss_financials、内部面のみ)。" +
      "code (単一) か codes (最大 " + MAX_BATCH_CODES + " 件) のどちらか一方を指定する。" +
      "from/to は期末日 fiscal_period_end (YYYY-MM-DD)、limit は1銘柄あたりの上限。" +
      "売上・営業利益・経常利益・純利益・EPS/BPS・予想列・配当・CF 等を含み、行ごとの license_tag を " +
      "meta.licenses へ伝播する。この表に発行済株式数の列はない (BPS 等から逆算しないこと)。" +
      "行が無い code は data.not_found に列挙し、理由 (unknown_code / not_collected) を出す。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4桁の銘柄コード (単一指定)" },
        codes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BATCH_CODES,
          description: "4桁の銘柄コードの配列 (バッチ指定)",
        },
        from: { type: "string", description: "YYYY-MM-DD (期末日)" },
        to: { type: "string", description: "YYYY-MM-DD (期末日)" },
        limit: { type: "integer", minimum: 1, maximum: 500, description: "1銘柄あたりの上限" },
      },
    },
  },
  {
    name: "jp_forecast_history",
    description:
      "会社業績予想の開示単位の全履歴を1銘柄分、開示時刻の古い順で返す (factual-cite、内部面のみ)。" +
      "jp_forecast_latest (最新1行) と違い過去の各開示が述べた予想をそのまま並べる (合成しない)。" +
      "from/to は開示日時の JST 暦日で、開示時刻が NULL の行は範囲指定時に含まれない。" +
      "未知コード・予想行なし (範囲指定なし) はエラーにする。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4桁の銘柄コード" },
        from: { type: "string", description: "YYYY-MM-DD (JST)" },
        to: { type: "string", description: "YYYY-MM-DD (JST)" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      required: ["code"],
    },
  },
  {
    name: "jp_universe_events",
    description:
      "上場・上場廃止・市場区分変更の公式イベントを発効日の新しい順で返す (personal-only、内部面のみ)。" +
      "kind は delist/listing/transfer、from/to は発効日 effective_date (YYYY-MM-DD)。" +
      "続きは meta.cursor を cursor に渡す。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...EVENT_KINDS] },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        code: { type: "string", description: "4桁の銘柄コード" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", description: "前応答 meta.cursor。そのまま渡す" },
      },
    },
  },
  {
    name: "jp_ohlcv_r2_range",
    description:
      "R2 (vwap-data) の10年分日足 daily/{code}.json を1銘柄分返す (personal-only、内部面のみ)。" +
      "bars は保存された {date,o,h,l,c,v} (+保存されていれば adj) をそのまま返し、このツールは" +
      "分割・配当の調整を適用しない。splits ({date,ratio}) は bars と分離して全件返す。" +
      "from/to (YYYY-MM-DD) は bars の絞り込みで splits は絞らない。" +
      "jp_ohlcv_range (D1・調整価格付き) とは別経路。",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "4桁の銘柄コード" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["code"],
    },
  },
  {
    name: "jp_universe_master",
    description:
      "銘柄マスタの最小断面 (code/name/sector33/is_active) を code 順で返す (内部面のみ)。" +
      "sector33 は EDINET 提出者業種、is_active はアクティブ判定 (boolean)。" +
      "列ライセンスが混在するため meta.licenses には最も厳しい personal-only を含む。" +
      "codes (最大 " + MAX_BATCH_CODES + " 件) で集合指定、activeOnly でアクティブのみ、" +
      "一覧は meta.cursor (直前最後の code) で続ける。見つからない code は単に含まれない。",
    inputSchema: {
      type: "object",
      properties: {
        codes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_BATCH_CODES,
          description: "4桁の銘柄コードの配列",
        },
        activeOnly: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        cursor: { type: "string", description: "前応答 meta.cursor (code)。codes と併用しない" },
      },
    },
  },
  // `jp_xbrl_elements` (jss_xbrl_elements) は 2026-09-25 に削除した。
  // jss_xbrl_documents / jss_xbrl_elements は本番 0 行・writer 不在のまま
  // 退役させた (pipeline/src/jp_stock_pipeline/cloud_store/schema.py 参照)。
  {
    name: "jp_raw_file",
    description:
      "⑤原本ファイルのメタデータを SHA256 で引く。R2 のキー・サイズ・ライセンスを返す。" +
      "実体は REST の /v1/files/{sha256}/content から取得する。",
    inputSchema: {
      type: "object",
      properties: { sha256: { type: "string" } },
      required: ["sha256"],
    },
  },
] as const;

/** MCP 引数の任意銘柄コード。`undefined` だけが省略。 */
function parseMcpCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isValidCode(value)) throw new Error("銘柄コードは4桁");
  return value;
}

/** MCP 引数の cursor。形式そのものの検証は g1 fetcher が行う。 */
function parseMcpCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error("cursor が不正");
  return value;
}

function parseMcpLimit(value: unknown): number {
  return parseLimit(value === undefined ? undefined : String(value), 100);
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: PrivateEnv,
): Promise<unknown> {
  switch (name) {
    case "jp_dataset_freshness": {
      const { results } = await env.DB.prepare(
        "SELECT dataset, store, location, latest_data_date, row_or_object_count," +
          " license_tag, updated_at FROM jss_dataset_freshness ORDER BY dataset",
      ).all();
      return envelope(results);
    }
    case "jp_supply_latest": {
      const limit = parseLimit(String(args.limit ?? ""), 100);
      const dataType = parseSupplyFilter("data_type", args.data_type);
      const results = await fetchSupplyLatest(env, dataType, limit);
      return envelope(results, {
        sources: supplySourcesFromLatest(results as Array<{ data_type: unknown }>),
        licenses: ["personal-only"],
      });
    }
    case "jp_supply_series": {
      const code = String(args.code ?? "");
      if (!isSupplyCode(code)) throw new Error("銘柄コードは4文字またはJPX原文5文字");
      const wanted = parseSupplyFilter("series", args.series);
      const from = parseSupplyFilter("from", args.from);
      const to = parseSupplyFilter("to", args.to);
      const cursor = parseSupplyFilter("cursor", args.cursor);
      const result = await fetchSupplySeries(env, code, { wanted, from, to, cursor });
      if (!result) throw new Error(`需給データが無い: ${code}`);
      return envelope(result.data, { cursor: result.cursor, sources: supplySourcesFromSeries(result.data.series), licenses: ["personal-only"] });
    }

    case "jp_ohlcv_range": {
      const code = String(args.code ?? "");
      if (!isValidCode(code)) throw new Error("銘柄コードは4桁");
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const from = args.from ? String(args.from) : undefined;
      const to = args.to ? String(args.to) : undefined;
      if ((from && !dateRe.test(from)) || (to && !dateRe.test(to))) {
        throw new Error("from/to は YYYY-MM-DD");
      }
      const limit = parseLimit(
        args.limit === undefined ? undefined : String(args.limit),
        250,
        3000,
      );
      const { result } = await fetchAdjustedOhlcvCached(env.DB, code, {
        from,
        to,
        limit,
      });
      if (!result) throw new Error(`見つからない: ${code}`);
      return envelope(result, { sources: ["Yahoo"], licenses: ["personal-only"] });
    }
    case "jp_indicators_latest": {
      const codes = parseCodes(args.codes);
      const rows = await fetchIndicatorsByCodes(env.DB, codes);
      const found = new Set(rows.map((r) => String(r.code)));
      const notFound = codes.filter((c) => !found.has(c));
      const reasons = await classifyMissingCodes(env.DB, notFound);
      return envelope(
        { results: rows, not_found: notFound, not_found_reasons: reasons },
        { sources: ["Yahoo"], licenses: ["personal-only"] },
      );
    }
    case "jp_valuation": {
      const codes = parseCodes(args.codes);
      const rows = await fetchValuationByCodes(env.DB, codes);
      const found = new Set(rows.map((r) => String(r.code)));
      const notFound = codes.filter((c) => !found.has(c));
      const reasons = await classifyMissingCodes(env.DB, notFound);
      return envelope(
        { results: rows, not_found: notFound, not_found_reasons: reasons },
        { sources: ["Yahoo"], licenses: ["personal-only"] },
      );
    }
    case "jp_forecast_latest": {
      const codes = parseCodes(args.codes);
      const rows = await fetchForecastLatestByCodes(env.DB, codes);
      const found = new Set(rows.map((r) => String(r.code)));
      const notFound = codes.filter((c) => !found.has(c));
      const reasons = await classifyForecastMissingCodes(env.DB, notFound);
      return envelope(
        { results: rows, not_found: notFound, not_found_reasons: reasons },
        {
          sources: rows.map((r) => String(r.source ?? "")),
          licenses: rows.map((r) => String(r.license_tag ?? "")),
        },
      );
    }
    case "jp_job_runs": {
      const jobName = args.job_name ? String(args.job_name) : null;
      const rows = await fetchLatestJobRuns(env.DB, jobName);
      return envelope(rows);
    }
    case "jp_disclosures_list": {
      const result = await fetchDisclosures(env.DB, {
        code: parseMcpCode(args.code),
        from: parseG1Date("from", args.from),
        to: parseG1Date("to", args.to),
        titleContains: parseG1Text("titleContains", args.titleContains),
        tag: parseG1Text("tag", args.tag),
        limit: parseMcpLimit(args.limit),
        cursor: parseMcpCursor(args.cursor),
      });
      return envelope(result.rows, {
        cursor: result.cursor,
        sources: result.rows.length > 0 ? ["TDnet"] : [],
        licenses: ["factual-cite"],
      });
    }
    case "jp_financials": {
      if (args.code !== undefined && args.codes !== undefined) {
        throw new Error("code と codes はどちらか一方で指定する");
      }
      const single = parseMcpCode(args.code);
      const codes = single ? [single] : parseCodes(args.codes);
      const rows = await fetchFinancialsByCodes(env.DB, codes, {
        from: parseG1Date("from", args.from),
        to: parseG1Date("to", args.to),
        limit: parseMcpLimit(args.limit),
      });
      const found = new Set(rows.map((r) => String(r.code)));
      const notFound = codes.filter((c) => !found.has(c));
      const reasons = await classifyMissingCodes(env.DB, notFound);
      return envelope(
        { results: rows, not_found: notFound, not_found_reasons: reasons },
        {
          sources: rows.map((r) => String(r.source ?? "")),
          licenses: rows.map((r) => String(r.license_tag ?? "")),
        },
      );
    }
    case "jp_forecast_history": {
      const code = String(args.code ?? "");
      if (!isValidCode(code)) throw new Error("銘柄コードは4桁");
      const from = parseG1Date("from", args.from);
      const to = parseG1Date("to", args.to);
      const rows = await fetchForecastHistory(env.DB, code, {
        from,
        to,
        limit: parseMcpLimit(args.limit),
      });
      if (rows.length === 0) {
        const [m] = await classifyForecastMissingCodes(env.DB, [code]);
        if (m?.reason === "unknown_code") throw new Error(`見つからない (unknown_code): ${code}`);
        if (from === undefined && to === undefined) {
          throw new Error(`見つからない (no_forecast_in_store): ${code}`);
        }
        return envelope([], { licenses: [], sources: [] });
      }
      return envelope(rows, {
        sources: rows.map((r) => String(r.source ?? "")),
        licenses: rows.map((r) => String(r.license_tag ?? "")),
      });
    }
    case "jp_universe_events": {
      const result = await fetchUniverseEvents(env.DB, {
        kind: parseEventKind(args.kind),
        from: parseG1Date("from", args.from),
        to: parseG1Date("to", args.to),
        code: parseMcpCode(args.code),
        limit: parseMcpLimit(args.limit),
        cursor: parseMcpCursor(args.cursor),
      });
      return envelope(result.rows, {
        cursor: result.cursor,
        sources: result.rows.length > 0 ? ["JPX"] : [],
        licenses: ["personal-only"],
      });
    }
    case "jp_ohlcv_r2_range": {
      const code = String(args.code ?? "");
      if (!isValidCode(code)) throw new Error("銘柄コードは4桁");
      const result = await fetchOhlcvR2(env.VWAP, code, {
        from: parseG1Date("from", args.from),
        to: parseG1Date("to", args.to),
      });
      if (!result) throw new Error(`見つからない: ${code}`);
      return envelope(result, { sources: ["Yahoo"], licenses: ["personal-only"] });
    }
    case "jp_universe_master": {
      const codes = args.codes === undefined ? undefined : parseCodes(args.codes);
      const cursor = parseMcpCursor(args.cursor);
      if (codes && cursor !== undefined) throw new Error("codes と cursor は併用しない");
      if (cursor !== undefined && !isValidCode(cursor)) throw new Error("cursor が不正");
      if (args.activeOnly !== undefined && typeof args.activeOnly !== "boolean") {
        throw new Error("activeOnly は boolean で指定する");
      }
      const result = await fetchUniverseMaster(env.DB, {
        codes,
        activeOnly: args.activeOnly === true,
        limit: parseMcpLimit(args.limit),
        cursor,
      });
      return envelope(result.rows, {
        cursor: result.cursor,
        sources: result.rows.length > 0 ? ["EDINET", "JPX"] : [],
        licenses: MASTER_LICENSES,
      });
    }
    case "jp_raw_file": {
      const sha = String(args.sha256 ?? "");
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("sha256 は 64 桁の16進数");
      const row = await env.DB.prepare(
        "SELECT sha256, r2_bucket, r2_key, derived_key, source, datatype, scope," +
          " doc_id, code, data_date, ext, size_bytes, license_tag FROM jss_raw_files" +
          " WHERE sha256 = ?",
      ).bind(sha).first();
      if (!row) throw new Error("見つからない");
      return envelope(row);
    }
    default:
      throw new Error(`未知のツール: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcp(request: Request, env: PrivateEnv): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return Response.json(rpcError(null, -32700, "JSON として読めない"), { status: 400 });
  }
  const { id, method, params } = body;

  if (method === "initialize") {
    return Response.json(
      rpcResult(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "jp-stock-pipeline", version: "1.0.0" },
      }),
    );
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "tools/list") {
    return Response.json(rpcResult(id, { tools: TOOLS }));
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await callTool(name, args, env);
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        }),
      );
    } catch (exc) {
      return Response.json(
        rpcResult(id, {
          content: [{ type: "text", text: `エラー: ${(exc as Error).message}` }],
          isError: true,
        }),
      );
    }
  }
  return Response.json(rpcError(id, -32601, `未対応のメソッド: ${method}`), { status: 400 });
}
