#!/usr/bin/env python3
"""Pinned Clef native joint-schema scorer; JSONL in/out, MPS only, no truncation."""

from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
from importlib.metadata import version
import io
import json
import math
import os
from pathlib import Path
import re
import sys

MODEL = "Cloudflare/clef-flash"
REVISION = "8b2e5fd17c09fd49bc2880b805d5323ec7ff4ff3"
SOURCE_SHA256 = "0e304cf7c6500e8bb59bef7e2afd2c6373f82596dfb3b57d1aa93c175e2dc3a3"
ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}\Z")


def verify_python_runtime() -> None:
    """Use the same Nix-backed venv and native MPS path as the calibration."""
    if (
        sys.version_info[:3] != (3, 12, 13)
        or sys.prefix == sys.base_prefix
        or not sys.base_prefix.startswith("/nix/store/")
        or Path(sys.executable) != Path(sys.prefix) / "bin/python"
    ):
        raise ValueError("nix_venv_runtime")
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") not in (None, "0"):
        raise ValueError("cpu_fallback_forbidden")
    if os.environ.get("PYTORCH_MPS_DISABLE_PREFILL_ATTENTION") not in (None, "0"):
        raise ValueError("native_prefill_required")


def verify_mps_causal(torch) -> None:
    """Reject driver/runtime causal errors before loading any model weights."""
    query = torch.zeros((1, 257, 16, 256), device="mps", dtype=torch.bfloat16).transpose(1, 2)
    key = torch.zeros((1, 257, 4, 256), device="mps", dtype=torch.bfloat16).transpose(1, 2)
    value = torch.zeros_like(key)
    value[:, :, 0] = 1
    with torch.inference_mode():
        output = torch.nn.functional.scaled_dot_product_attention(
            query, key, value, dropout_p=0.0, scale=1 / 16,
            is_causal=True, enable_gqa=True,
        )
    for position in (0, 128, 256):
        expected = 1 / (position + 1)
        if any(
            not math.isfinite(value) or abs(value - expected) > expected / 128
            for value in output[0, :, position, 0].tolist()
        ):
            raise RuntimeError("mps_causal_identity")
    torch.mps.synchronize()
    del query, key, value, output
    torch.mps.empty_cache()


def parse_request(line: str) -> object:
    def unique_fields(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate_json_field")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("nonfinite_json_value")

    return json.loads(line, object_pairs_hook=unique_fields, parse_constant=reject_constant)


def build_record(request: object) -> dict:
    if not isinstance(request, dict) or set(request) != {"id", "state", "questions"}:
        raise ValueError("request_fields")
    if not isinstance(request["id"], str) or not ID.fullmatch(request["id"]):
        raise ValueError("request_id")
    if not isinstance(request["state"], str) or not request["state"].strip():
        raise ValueError("state")
    if not isinstance(request["questions"], list) or not request["questions"]:
        raise ValueError("questions")
    questions = {}
    for question in request["questions"]:
        if not isinstance(question, dict) or set(question) != {"qid", "question", "options"}:
            raise ValueError("question_fields")
        qid = question["qid"]
        if not isinstance(qid, str) or not ID.fullmatch(qid) or qid in questions:
            raise ValueError("question_id")
        if not isinstance(question["question"], str) or not question["question"].strip():
            raise ValueError("question_instruction")
        options = question["options"]
        if (
            not isinstance(options, list)
            or len(options) != 2
            or any(not isinstance(option, str) or not option.strip() for option in options)
            or options[0] == options[1]
        ):
            raise ValueError("question_options")
        questions[qid] = {
            "type": "noul",
            "instructions": question["question"],
            "criteria": {"true": options[0], "false": options[1]},
        }
    return {"id": request["id"], "state": request["state"], "questions": questions}


def encode_batches(native, processor, max_tokens: int, record: dict):
    # Official encode_record slices state at max_length. Encode the complete input
    # first; only split the ordered question set, never shorten its shared state.
    original_tokens = None
    batches = []
    pending = [record]
    while pending:
        part = pending.pop(0)
        encoded = native.encode_record(
            processor.tokenizer, part, max_length=sys.maxsize, processor=processor
        )
        if original_tokens is None:
            original_tokens = len(encoded.input_ids)
        if not encoded.input_ids:
            raise ValueError("input_token_limit")
        if encoded.record_id != part["id"] or len(encoded.questions) != len(part["questions"]):
            raise ValueError("encoded_question_count")
        for question, qid in zip(encoded.questions, part["questions"], strict=True):
            if (question.question_id != qid or question.question_type != 0
                    or question.option_ids != ("true", "false")):
                raise ValueError("encoded_question_identity")
        if len(encoded.input_ids) <= max_tokens:
            batches.append(encoded)
            continue
        questions = list(part["questions"].items())
        if len(questions) == 1:
            raise ValueError("input_token_limit")
        middle = len(questions) // 2
        pending[0:0] = [
            {**part, "questions": dict(questions[:middle])},
            {**part, "questions": dict(questions[middle:])},
        ]
    qids = [q.question_id for batch in batches for q in batch.questions]
    if qids != list(record["questions"]):
        raise ValueError("encoded_partition_identity")
    return batches, original_tokens


def score_request(native, torch, model, processor, max_tokens: int, request: object, diagnostics=None) -> dict:
    record = build_record(request)
    # Qualify every subbatch before the first model call, including a later
    # one-question failure; model errors never trigger repartition or replay.
    batches, original_tokens = encode_batches(native, processor, max_tokens, record)
    if diagnostics is not None:
        print(json.dumps({"event": "clef_batch_layout", "request_id": record["id"],
                          "original_tokens": original_tokens, "subbatches": len(batches),
                          "layout": [{"tokens": len(b.input_ids), "questions": len(b.questions)}
                                     for b in batches]}), file=diagnostics, flush=True)
    device = next(model.parameters()).device
    if str(device) != "mps:0" and str(device) != "mps":
        raise ValueError("model_device")
    pad_id = processor.tokenizer.pad_token_id
    if not isinstance(pad_id, int) or isinstance(pad_id, bool) or pad_id < 0:
        raise ValueError("pad_token_id")
    answers = {}
    for encoded in batches:
        batch = native.collate_records([encoded], pad_id, device)
        with torch.inference_mode():
            result = model(batch)
        if (
            not isinstance(result, list) or len(result) != 1
            or not isinstance(result[0], list) or len(result[0]) != len(encoded.questions)
        ):
            raise ValueError("logit_question_count")
        for question, logits in zip(encoded.questions, result[0], strict=True):
            if tuple(logits.shape) != (2,):
                raise ValueError("logit_option_count")
            probabilities = logits.float().softmax(-1).tolist()
            if (
                not isinstance(probabilities, list) or len(probabilities) != 2
                or any(isinstance(p, bool) or not isinstance(p, (int, float))
                       or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities)
                or not math.isclose(sum(probabilities), 1, rel_tol=0, abs_tol=1e-6)
            ):
                raise ValueError("invalid_probability")
            answers[question.question_id] = probabilities[0]
    if set(answers) != set(record["questions"]):
        raise ValueError("answer_identity")
    return {"id": record["id"], "answers": answers}


def handle_request(native, torch, model, processor, max_tokens: int, request: object) -> dict:
    request_id = request.get("id") if isinstance(request, dict) else None
    if not isinstance(request_id, str) or not ID.fullmatch(request_id):
        request_id = None
    try:
        # Third-party stdout must never corrupt JSONL or expose the input.
        diagnostics = sys.stderr
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return score_request(native, torch, model, processor, max_tokens, request, diagnostics)
    except Exception as error:  # noqa: BLE001 — all-or-nothing request boundary
        print(
            f"[clef_server] request_failed class={type(error).__name__}",
            file=sys.stderr,
            flush=True,
        )
        return {"id": request_id, "error": "clef_contract_or_runtime_error"}


def load_native(path: Path):
    source = path / "joint_schema_model.py"
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
        raise ValueError("native_source_sha256")
    spec = importlib.util.spec_from_file_location("kabulab_clef_native", source)
    if spec is None or spec.loader is None:
        raise ValueError("native_source_loader")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def verify_local_model(path: Path, manifest: dict) -> None:
    if (
        manifest.get("repo") != MODEL
        or manifest.get("revision") != REVISION
        or manifest.get("source_sha256") != SOURCE_SHA256
    ):
        raise ValueError("model_manifest_identity")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("model_manifest_files")
    seen = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
            raise ValueError("model_manifest_member")
        name = item["path"]
        if (
            not isinstance(name, str)
            or not name
            or name in seen
            or Path(name).is_absolute()
            or ".." in Path(name).parts
        ):
            raise ValueError("model_manifest_path")
        if (
            not isinstance(item["size"], int)
            or isinstance(item["size"], bool)
            or item["size"] < 1
            or not isinstance(item["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])
        ):
            raise ValueError("model_manifest_hash")
        member = (path / name).resolve(strict=True)
        if (
            not member.is_relative_to(path)
            or not member.is_file()
            or member.stat().st_size != item["size"]
        ):
            raise ValueError("model_member_size")
        with member.open("rb") as body:
            if hashlib.file_digest(body, "sha256").hexdigest() != item["sha256"]:
                raise ValueError("model_member_sha256")
        if name == "joint_schema_model.py" and item["sha256"] != SOURCE_SHA256:
            raise ValueError("native_source_sha256")
        seen.add(name)
    required = {
        "joint_schema_model.py",
        "joint_head.safetensors",
        "joint_head_config.json",
        "model.safetensors.index.json",
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "processor_config.json",
    }
    if not required.issubset(seen):
        raise ValueError("model_manifest_native_members")
    index = json.loads((path / "model.safetensors.index.json").read_text())
    weight_map = index.get("weight_map")
    if (
        not isinstance(weight_map, dict)
        or not weight_map
        or any(not isinstance(name, str) for name in weight_map.values())
    ):
        raise ValueError("model_weight_index")
    if not set(weight_map.values()).issubset(seen):
        raise ValueError("model_weight_manifest_members")
    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict) or set(runtime) != {"torch", "transformers", "safetensors"}:
        raise ValueError("runtime_manifest")
    for package, expected in runtime.items():
        if not isinstance(expected, str) or not expected or version(package) != expected:
            raise ValueError("runtime_version")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=[MODEL])
    parser.add_argument("--revision", required=True, choices=[REVISION])
    parser.add_argument("--max-tokens", required=True, type=int)
    parser.add_argument("--model-path", required=True, type=Path)
    args = parser.parse_args()
    verify_python_runtime()
    if not 1 <= args.max_tokens <= 16000:
        raise ValueError("max_tokens")
    path = args.model_path.resolve(strict=True)
    if not path.is_dir() or path.name != args.revision:
        raise ValueError("local_model_path")
    manifest_path = Path(__file__).resolve().parents[3] / "src/shared/clef/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    verify_local_model(path, manifest)
    # The native loader receives an existing local directory; Hub/Transformers
    # offline flags also prevent processor lookup from fetching missing files.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    with redirect_stdout(sys.stderr):
        import torch

        if not torch.backends.mps.is_available():
            raise RuntimeError("mps_unavailable")
        verify_mps_causal(torch)
        native = load_native(path)
        model, processor = native.load_release_model(path, device="mps", local_files_only=True)
        expected_keys = set(
            json.loads((path / "model.safetensors.index.json").read_text())["weight_map"]
        )
        if set(model.language_model.state_dict()) != expected_keys:
            raise RuntimeError("loaded_backbone_key_set")
        if any(
            parameter.device.type != "mps" or parameter.dtype != torch.bfloat16
            for parameter in model.parameters()
        ):
            raise RuntimeError("model_device_or_dtype")
    print(
        json.dumps(
            {
                "ready": True,
                "model": manifest["repo"],
                "revision": manifest["revision"],
                "backend": "torch-mps",
                "max_tokens": args.max_tokens,
                "source_sha256": manifest["source_sha256"],
                "torch_version": version("torch"),
                "transformers_version": version("transformers"),
                "safetensors_version": version("safetensors"),
            }
        ),
        flush=True,
    )
    for line in sys.stdin:
        try:
            request = parse_request(line)
        except (json.JSONDecodeError, ValueError):
            response = {"id": None, "error": "invalid_json_request"}
        else:
            response = handle_request(native, torch, model, processor, args.max_tokens, request)
        print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 — never log model inputs or remote URLs
        print(
            f"[clef_server] startup_failed class={type(error).__name__}",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from None
