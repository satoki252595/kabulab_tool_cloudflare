#!/usr/bin/env python3
"""SemIf (MLX backend) 常駐スコアラー。

設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §12.9 (judge=semif)。

jev (TypeSafe System One) のクレジット枯渇時に、競合他社判定の残り銘柄を
ローカル PC (Apple Silicon / MLX) 上の SemIf (https://github.com/TheoLeeCJ/SemIf)
Qwen/Qwen3.5-4B で判定するための常駐プロセス。

起動時に SemIf の MLX バックエンドでモデルを **1 回だけ** ロードし、以降は
標準入力から JSONL リクエストを 1 行ずつ読み、標準出力へ JSONL レスポンスを
1 行ずつ書く (行区切りの JSON-RPC 的プロトコル。TS 側は
`src/shared/semif/client.ts` が 1 プロセスとして起動し続ける)。

プロトコル:
  リクエスト (1行1 JSON):
    {"id": "<バッチid>", "state": "<会社Aの状態>",
     "questions": [{"qid": "cp.<銘柄コード>", "question": "<質問文>",
                    "options": ["<yesの説明>", "<noの説明>"]}, ...]}
    同一リクエスト内の全 questions は同じ state を共有する前提
    (SemIf の shared モード = 1回の prefill を全候補で使い回す)。

  レスポンス (成功):
    {"id": "<バッチid>", "answers": {"<qid>": <p_yes 0..1>, ...}}
  レスポンス (失敗。バッチ全体を判定不能として扱う。ルール2 — 一部だけ
  既定値で埋めて返すことは絶対にしない):
    {"id": "<バッチid>", "error": "<理由。行の入力トークン数上限超過なら
     SemIf の ValueError メッセージにその行の qid と実測トークン数が入る>"}

起動時、モデルロード完了後に1行だけ準備完了通知を書く:
    {"ready": true, "model": "<HF source>", "revision": "<pin>",
     "backend": "mlx", "max_tokens": <int>}

ルール1/2 の帰結:
  - LLM に会社Bの説明文を作文させない (TS 側 summary.ts が既に機械的に
    組み立てた question/options 文字列をそのまま SemIf へ渡すだけ)。
  - 入力が長すぎて SemIf のトークン上限を超える行があっても **絶対に
    切り詰めない** (SemIf 自体が `no truncation allowed` として ValueError
    を投げる仕様。ここではそれを握りつぶさず、バッチ全体を失敗として
    理由をそのまま返す — 一部だけ判定して残りを既定値で埋めるようなことは
    しない)。
  - 応答は "yes"/"no" の2択オプションの softmax 確率 (p_yes) のみを返す。
    確率が計算できなかった行を無理に埋めない。
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def build_rows(request: dict) -> list[dict]:
    """1 リクエスト分の questions を SemIf の row (shared モード) に変換する。"""
    state = request["state"]
    questions = request["questions"]
    if not isinstance(questions, list) or len(questions) == 0:
        raise ValueError("questions が空です (呼び出し側の実装ミス)")
    rows = []
    for q in questions:
        qid = q["qid"]
        question_text = q["question"]
        options = q["options"]
        if not isinstance(options, list) or len(options) != 2:
            raise ValueError(f"{qid}: options は [yesの説明, noの説明] の2要素でなければなりません")
        rows.append(
            {
                "id": qid,
                "state": state,
                "question": question_text,
                "options": [
                    {"id": "yes", "description": options[0]},
                    {"id": "no", "description": options[1]},
                ],
            }
        )
    return rows


def handle_request(score_shared, model, tokenizer, metadata, max_tokens: int, request: dict) -> dict:
    req_id = request.get("id")
    try:
        if req_id is None:
            raise ValueError("リクエストに id がありません")
        rows = build_rows(request)
        results, _timing = score_shared(model, tokenizer, rows, metadata, max_tokens)
        answers: dict[str, float] = {}
        for result in results:
            option_ids = result["option_ids"]
            probabilities = result["probabilities"]
            if "yes" not in option_ids:
                raise ValueError(f"{result['id']}: 応答に yes オプションがありません (実装ミス)")
            p_yes = probabilities[option_ids.index("yes")]
            if not (0.0 <= p_yes <= 1.0):
                raise ValueError(f"{result['id']}: p_yes が範囲外です ({p_yes})")
            answers[result["id"]] = p_yes
        # score_shared が依頼した行数ぶん過不足なく返したことを検査する
        # (SemIf 側の実装異常を「一部だけ返って残りは既定値」にしない)。
        expected_ids = {row["id"] for row in rows}
        if set(answers.keys()) != expected_ids:
            missing = expected_ids - set(answers.keys())
            raise ValueError(f"score_shared の応答が依頼した行と一致しません (欠落: {sorted(missing)})")
        return {"id": req_id, "answers": answers}
    except Exception as error:  # noqa: BLE001 — バッチ全体を「判定不能」として返す境界
        eprint(f"[semif_server] リクエスト {req_id!r} が失敗しました: {error}")
        eprint(traceback.format_exc())
        return {"id": req_id, "error": f"{type(error).__name__}: {error}"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="Qwen/Qwen3.5-4B")
    parser.add_argument(
        "--revision",
        default="851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        help="SemIf README/docs/MLX.md が指定する固定リビジョン (40桁コミットID)",
    )
    parser.add_argument("--mlx-bits", type=int, choices=(4, 8), default=None)
    parser.add_argument("--mlx-cache-limit-mib", type=int, default=None)
    parser.add_argument(
        "--max-tokens",
        type=int,
        default=16000,
        help="1行あたりの入力トークン上限 (state 8000字 + 候補企業の説明文を安全に収める余裕値。"
        "超過時は SemIf 側が例外を投げる — 絶対に切り詰めない)",
    )
    args = parser.parse_args()

    eprint(f"[semif_server] モデルをロード中: {args.model}@{args.revision} (mlx, bits={args.mlx_bits})")
    from semif_phase1 import mlx_backend

    load_kwargs = {}
    if args.mlx_cache_limit_mib is not None:
        load_kwargs["cache_limit_mib"] = args.mlx_cache_limit_mib
    model, tokenizer, metadata = mlx_backend.load_model(
        args.model, args.revision, args.mlx_bits, **load_kwargs
    )
    eprint("[semif_server] モデルのロード完了。標準入力からのリクエスト待ち受けを開始します。")
    print(
        json.dumps(
            {
                "ready": True,
                "model": metadata.get("source"),
                "revision": metadata.get("revision"),
                "backend": "mlx",
                "max_tokens": args.max_tokens,
            }
        ),
        flush=True,
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            eprint(f"[semif_server] 標準入力の行を JSON として解釈できません: {error}")
            print(json.dumps({"id": None, "error": f"invalid JSON request line: {error}"}), flush=True)
            continue
        response = handle_request(mlx_backend.score_shared, model, tokenizer, metadata, args.max_tokens, request)
        print(json.dumps(response, ensure_ascii=False), flush=True)

    eprint("[semif_server] 標準入力が閉じられました。終了します。")


if __name__ == "__main__":
    main()
