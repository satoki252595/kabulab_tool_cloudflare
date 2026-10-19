"""Run with Nix Python: python -m unittest discover -s services/yuho-quant/scripts -p test_clef_server.py."""

from contextlib import nullcontext, redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import hashlib
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import clef_server as server


class Logits:
    def __init__(self, probabilities):
        self.probabilities = probabilities
        self.shape = (len(probabilities),)

    def float(self):
        return self

    def softmax(self, _dimension):
        return self

    def tolist(self):
        return self.probabilities


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.request = {
            "id": "batch.9533",
            "state": "東邦ガス株式会社の有価証券報告書。",
            "questions": [
                {
                    "qid": "bt.gas",
                    "question": "都市ガス事業を営んでいるか。",
                    "options": ["都市ガス事業を営む。", "都市ガス事業を営まない。"],
                },
                {
                    "qid": "bt.electric",
                    "question": "電気事業を営んでいるか。",
                    "options": ["電気事業を営む。", "電気事業を営まない。"],
                },
            ],
        }
        self.forwards = 0
        self.encoded_tokens = 100
        self.results = [[Logits([0.75, 0.25]), Logits([0.5, 0.5])]]
        self.encode_kwargs = None

        def encode(_tokenizer, record, **kwargs):
            self.encode_kwargs = kwargs
            self.record = record
            return SimpleNamespace(
                record_id=record["id"],
                input_ids=tuple(range(self.encoded_tokens)),
                questions=tuple(
                    SimpleNamespace(question_id=qid, question_type=0, option_ids=("true", "false"))
                    for qid in record["questions"]
                ),
            )

        self.native = SimpleNamespace(encode_record=encode, collate_records=lambda *_args: {})
        self.torch = SimpleNamespace(inference_mode=nullcontext)
        self.processor = SimpleNamespace(tokenizer=SimpleNamespace(pad_token_id=248044))

        class Model:
            def parameters(_self):
                yield SimpleNamespace(device="mps:0")

            def __call__(_self, _batch):
                self.forwards += 1
                return self.results

        self.model = Model()

    def score(self, request=None, max_tokens=16000):
        return server.score_request(
            self.native,
            self.torch,
            self.model,
            self.processor,
            max_tokens,
            self.request if request is None else request,
        )

    def test_native_noul_schema_complete_state_and_option_binding(self):
        result = self.score()
        self.assertEqual(
            result, {"id": "batch.9533", "answers": {"bt.gas": 0.75, "bt.electric": 0.5}}
        )
        self.assertEqual(self.record["state"], self.request["state"])
        self.assertEqual(
            self.record["questions"]["bt.gas"],
            {
                "type": "noul",
                "instructions": self.request["questions"][0]["question"],
                "criteria": {
                    "true": self.request["questions"][0]["options"][0],
                    "false": self.request["questions"][0]["options"][1],
                },
            },
        )
        self.assertEqual(self.encode_kwargs["max_length"], sys.maxsize)
        self.assertNotIn("max_state_tokens", self.encode_kwargs)
        self.assertEqual(self.forwards, 1)

    def test_overlong_full_encoding_stops_before_forward(self):
        self.encoded_tokens = 16001
        with self.assertRaisesRegex(server.ClefInputTokenLimitError, "input_token_limit"):
            self.score()
        self.assertEqual(self.forwards, 0)

    def test_input_limit_has_dedicated_response_only_for_pre_forward_rejection(self):
        self.encoded_tokens = 16001
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = server.handle_request(self.native, self.torch, self.model,
                                           self.processor, 16000, self.request)
        self.assertEqual(result, {"id": self.request["id"], "error": "clef_input_token_limit"})
        self.assertEqual(self.forwards, 0)
        self.assertNotIn(self.request["state"], stderr.getvalue())

        # Third-party error messages do not qualify the dedicated rejection.
        def failed(*_args, **_kwargs):
            raise ValueError("input_token_limit")
        self.native.encode_record = failed
        with redirect_stderr(stderr):
            result = server.handle_request(self.native, self.torch, self.model,
                                           self.processor, 16000, self.request)
        self.assertEqual(result, {"id": self.request["id"], "error": "clef_contract_or_runtime_error"})
        self.assertEqual(self.forwards, 0)

    def test_question_partition_keeps_full_state_and_preencodes_every_batch(self):
        original_encode = self.native.encode_record
        seen = []
        def encode(tokenizer, record, **kwargs):
            seen.append(record)
            self.encoded_tokens = 16001 if len(record["questions"]) == 2 else 500
            return original_encode(tokenizer, record, **kwargs)
        def collate(*_args):
            self.assertEqual(len(seen), 3, "all batches must be encoded before first forward")
            return {}
        self.native.encode_record = encode
        self.native.collate_records = collate
        self.results = [[Logits([0.75, 0.25])]]
        diagnostics = io.StringIO()
        result = server.score_request(self.native, self.torch, self.model, self.processor,
                                      16000, self.request, diagnostics)
        self.assertEqual(result["answers"], {"bt.gas": 0.75, "bt.electric": 0.75})
        self.assertEqual(self.forwards, 2)
        self.assertTrue(all(x["state"] == self.request["state"] for x in seen))
        self.assertEqual([list(x["questions"]) for x in seen],
                         [["bt.gas", "bt.electric"], ["bt.gas"], ["bt.electric"]])
        layout = json.loads(diagnostics.getvalue())
        self.assertEqual(layout["original_tokens"], 16001)
        self.assertEqual(layout["subbatches"], 2)
        self.assertEqual(layout["layout"], [{"tokens": 500, "questions": 1}] * 2)
        self.assertNotIn(self.request["state"], diagnostics.getvalue())

    def test_later_one_question_over_limit_stops_all_forward_calls(self):
        original_encode = self.native.encode_record
        def encode(tokenizer, record, **kwargs):
            self.encoded_tokens = 500 if list(record["questions"]) == ["bt.gas"] else 16001
            return original_encode(tokenizer, record, **kwargs)
        self.native.encode_record = encode
        with self.assertRaisesRegex(server.ClefInputTokenLimitError, "input_token_limit"):
            self.score()
        self.assertEqual(self.forwards, 0)

    def test_partition_runtime_failure_has_no_partial_answer_or_retry(self):
        original_encode = self.native.encode_record
        def encode(tokenizer, record, **kwargs):
            self.encoded_tokens = 16001 if len(record["questions"]) == 2 else 500
            return original_encode(tokenizer, record, **kwargs)
        self.native.encode_record = encode
        class Model:
            def parameters(_self):
                yield SimpleNamespace(device="mps:0")
            def __call__(_self, _batch):
                self.forwards += 1
                if self.forwards == 2:
                    raise RuntimeError("second_batch_runtime_failure")
                return [[Logits([0.75, 0.25])]]
        self.model = Model()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            result = server.handle_request(self.native, self.torch, self.model,
                                           self.processor, 16000, self.request)
        self.assertEqual(result, {"id": self.request["id"], "error": "clef_contract_or_runtime_error"})
        self.assertEqual(self.forwards, 2)
        self.assertNotIn("answers", result)

    def test_missing_extra_duplicate_ids_and_options_stop_before_forward(self):
        bad = []
        extra = deepcopy(self.request)
        extra["images"] = []
        bad.append(extra)
        missing = deepcopy(self.request)
        del missing["state"]
        bad.append(missing)
        duplicate = deepcopy(self.request)
        duplicate["questions"][1]["qid"] = "bt.gas"
        bad.append(duplicate)
        bad_id = deepcopy(self.request)
        bad_id["questions"][0]["qid"] = "line\nbreak"
        bad.append(bad_id)
        options = deepcopy(self.request)
        options["questions"][0]["options"].append("third")
        bad.append(options)
        same_options = deepcopy(self.request)
        same_options["questions"][0]["options"][1] = same_options["questions"][0]["options"][0]
        bad.append(same_options)
        for request in bad:
            with self.subTest(request=request), self.assertRaises(ValueError):
                self.score(request)
        self.assertEqual(self.forwards, 0)

    def test_missing_extra_and_nonfinite_logits_do_not_return_partial_answers(self):
        for result in [
            [],
            [[]],
            [[Logits([0.75, 0.25])]],
            self.results + self.results,
            [[Logits([math.nan, math.nan]), Logits([0.5, 0.5])]],
            [[Logits([0.5, 0.4]), Logits([0.5, 0.5])]],
            [[Logits([True, False]), Logits([0.5, 0.5])]],
        ]:
            self.results = result
            with self.subTest(result=result), self.assertRaises(ValueError):
                self.score()

    def test_encoded_id_reordering_is_rejected(self):
        encode = self.native.encode_record

        def reordered(*args, **kwargs):
            encoded = encode(*args, **kwargs)
            encoded.questions = tuple(reversed(encoded.questions))
            return encoded

        self.native.encode_record = reordered
        with self.assertRaisesRegex(ValueError, "encoded_question_identity"):
            self.score()
        self.assertEqual(self.forwards, 0)

    def test_cpu_device_is_rejected(self):
        self.model.parameters = lambda: iter([SimpleNamespace(device="cpu")])
        with self.assertRaisesRegex(ValueError, "model_device"):
            self.score()
        self.assertEqual(self.forwards, 0)

    def test_startup_checks_mps_math_before_any_model_load_and_stops_on_failure(self):
        torch = SimpleNamespace(backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: True)))
        with TemporaryDirectory() as directory:
            path = Path(directory) / server.REVISION
            path.mkdir()
            argv = ["clef_server.py", "--model", server.MODEL, "--revision", server.REVISION,
                    "--max-tokens", "16000", "--model-path", str(path)]
            for failed in (True, False):
                events = []
                def check(_torch):
                    events.append("mps_math")
                    if failed:
                        raise RuntimeError("mps_causal_identity")
                def load(_path):
                    events.append("model_load")
                    raise RuntimeError("test_load_boundary")
                with (
                    self.subTest(failed=failed),
                    patch.object(sys, "argv", argv),
                    patch.dict(sys.modules, {"torch": torch}),
                    patch.dict(server.os.environ, {"PYTORCH_ENABLE_MPS_FALLBACK": "0"}),
                    patch.object(server, "verify_python_runtime"),
                    patch.object(server, "verify_local_model"),
                    patch.object(server, "verify_mps_causal", side_effect=check),
                    patch.object(server, "load_native", side_effect=load),
                    self.assertRaises(RuntimeError),
                ):
                    server.main()
                self.assertEqual(events, ["mps_math"] if failed else ["mps_math", "model_load"])

    def test_calibrated_nix_venv_and_native_prefill_are_required_before_model_import(self):
        valid = dict(version_info=(3, 12, 13), prefix="/project/.venv",
                     base_prefix="/nix/store/python3-3.12.13", executable="/project/.venv/bin/python")
        with patch.multiple(server.sys, **valid), patch.dict(server.os.environ, {}, clear=True):
            server.verify_python_runtime()
            for field, value in (
                ("version_info", (3, 12, 12)), ("base_prefix", "/uv/python3"),
                ("prefix", valid["base_prefix"]),
                ("executable", valid["base_prefix"] + "/bin/python"),
            ):
                with self.subTest(field=field), patch.object(server.sys, field, value):
                    with self.assertRaisesRegex(ValueError, "nix_venv_runtime"):
                        server.verify_python_runtime()
            for key, reason in (("PYTORCH_ENABLE_MPS_FALLBACK", "cpu_fallback_forbidden"),
                                ("PYTORCH_MPS_DISABLE_PREFILL_ATTENTION", "native_prefill_required")):
                with self.subTest(key=key), patch.dict(server.os.environ, {key: "1"}):
                    with self.assertRaisesRegex(ValueError, reason):
                        server.verify_python_runtime()

    def test_duplicate_json_fields_and_nan_are_rejected(self):
        for line in [
            '{"id":"a","id":"b"}',
            '{"state":NaN}',
            '{"questions":[{"qid":"a","qid":"b"}]}',
        ]:
            with self.subTest(line=line), self.assertRaises(ValueError):
                server.parse_request(line)

    def test_full_manifest_shard_binding_and_tampered_weight_fail_closed(self):
        with TemporaryDirectory() as directory:
            path = Path(directory).resolve()
            files = {
                name: name.encode()
                for name in [
                    "joint_schema_model.py",
                    "joint_head.safetensors",
                    "joint_head_config.json",
                    "config.json",
                    "tokenizer.json",
                    "tokenizer_config.json",
                    "processor_config.json",
                    "model-1.safetensors",
                ]
            }
            files["model.safetensors.index.json"] = json.dumps(
                {"weight_map": {"weight": "model-1.safetensors"}}
            ).encode()
            for name, content in files.items():
                (path / name).write_bytes(content)
            source_sha = hashlib.sha256(files["joint_schema_model.py"]).hexdigest()
            manifest = {
                "repo": server.MODEL,
                "revision": server.REVISION,
                "source_sha256": source_sha,
                "files": [
                    {
                        "path": name,
                        "size": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    for name, content in files.items()
                ],
                "runtime": dict.fromkeys(["torch", "transformers", "safetensors"], "pinned"),
            }
            with (
                patch.object(server, "SOURCE_SHA256", source_sha),
                patch.object(server, "version", return_value="pinned"),
            ):
                server.verify_local_model(path, manifest)
                missing = deepcopy(manifest)
                missing["files"] = [
                    item for item in missing["files"] if item["path"] != "model-1.safetensors"
                ]
                with self.assertRaisesRegex(ValueError, "model_weight_manifest_members"):
                    server.verify_local_model(path, missing)
                (path / "joint_head.safetensors").write_bytes(
                    b"x" * len(files["joint_head.safetensors"])
                )
                with self.assertRaisesRegex(ValueError, "model_member_sha256"):
                    server.verify_local_model(path, manifest)

    def test_exception_never_echoes_state_or_partial_answer(self):
        def failed(*_args, **_kwargs):
            print(self.request["state"])
            print(self.request["state"], file=sys.stderr)
            raise RuntimeError(self.request["state"])

        self.native.encode_record = failed
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = server.handle_request(
                self.native, self.torch, self.model, self.processor, 16000, self.request
            )
        self.assertEqual(result, {"id": "batch.9533", "error": "clef_contract_or_runtime_error"})
        self.assertEqual(stdout.getvalue(), "")
        self.assertNotIn(self.request["state"], stderr.getvalue())
        self.assertIn("class=RuntimeError", stderr.getvalue())
        self.assertNotIn("answers", result)

    def test_exception_type_is_bounded_and_cannot_inject_diagnostic_lines(self):
        error = type("Bad\nType " + "x" * 100, (RuntimeError,), {})(self.request["state"])
        self.assertEqual(server.safe_exception_type(error), ("Bad_Type_" + "x" * 100)[:64])


if __name__ == "__main__":
    unittest.main()
