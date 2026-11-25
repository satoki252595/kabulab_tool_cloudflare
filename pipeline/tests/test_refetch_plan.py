"""欠測の自動再取得計画（refetch_plan）と ops_check からの接続のテスト。

ops_check は検知できても対処は Issue のみで、欠測が翌日以降も残っていた
（2026-11-24 実測: VWAP 日足 4 銘柄が 2 取引日以上遅れ、IR PDF 未保管
3 件）。計画は「対象を絞れる冪等な手動入口がある欠測だけ」を対象とし、
上限超過・系統障害は自動で叩かないことを固定する。
"""

from __future__ import annotations

import json
from datetime import datetime

from jp_stock_pipeline.jobs import ops_check
from jp_stock_pipeline.jobs.refetch_plan import (
    MAX_IR_PDF_GAPS,
    MAX_VWAP_DAILY_CODES,
    RefetchRequest,
    ir_pdf_request,
    vwap_daily_request,
    write_plan,
)
from jp_stock_pipeline.models import JST
from test_ops_slo import _FakeDailyR2, _FakeStore


class TestVwapDailyRequest:
    def test_欠測銘柄だけを日足再取得する(self) -> None:
        request = vwap_daily_request(["8139", "1788", "1788"], expected_date="2026-11-24")
        assert request == RefetchRequest(
            kind="vwap_daily",
            workflow="vwap-ingest.yml",
            inputs={"target": "daily", "daily_codes": "1788,8139"},
            reason="VWAP保存日足: 期待取引日 2026-11-24 に対し2取引日以上遅れ・欠落 2 銘柄",
        )

    def test_空と上限超過は計画しない(self) -> None:
        assert vwap_daily_request([], expected_date="2026-11-24") is None
        codes = [f"{1000 + i}" for i in range(MAX_VWAP_DAILY_CODES + 1)]
        assert vwap_daily_request(codes, expected_date="2026-11-24") is None

    def test_不正コードは計画しない(self) -> None:
        assert vwap_daily_request(["17 88"], expected_date="2026-11-24") is None
        assert vwap_daily_request(["1788,7203"], expected_date="2026-11-24") is None


class TestIrPdfRequest:
    # 2026-11-10 / 2026-11-20 の正午 JST
    OLD = int(datetime(2026, 11, 10, 12, tzinfo=JST).timestamp())
    NEW = int(datetime(2026, 11, 20, 12, tzinfo=JST).timestamp())

    def test_未保管の月範囲でbackfillする(self) -> None:
        request = ir_pdf_request(gap_count=3, oldest_epoch=self.OLD, newest_epoch=self.NEW)
        assert request is not None
        assert request.workflow == "backfill.yml"
        assert request.inputs == {"job": "ir", "from": "2026-11", "to": "2026-11"}

    def test_月を跨ぐ範囲もそのまま渡す(self) -> None:
        october = int(datetime(2026, 10, 31, 12, tzinfo=JST).timestamp())
        request = ir_pdf_request(gap_count=2, oldest_epoch=october, newest_epoch=self.NEW)
        assert request is not None
        assert request.inputs["from"] == "2026-10"
        assert request.inputs["to"] == "2026-11"

    def test_上限超過と不正な範囲は計画しない(self) -> None:
        assert ir_pdf_request(gap_count=0, oldest_epoch=self.OLD, newest_epoch=self.NEW) is None
        assert (
            ir_pdf_request(
                gap_count=MAX_IR_PDF_GAPS + 1, oldest_epoch=self.OLD, newest_epoch=self.NEW
            )
            is None
        )
        assert ir_pdf_request(gap_count=1, oldest_epoch=self.NEW, newest_epoch=self.OLD) is None
        assert ir_pdf_request(gap_count=1, oldest_epoch=0, newest_epoch=self.NEW) is None


class TestWritePlan:
    def test_計画JSONはworkflowとinputsを持つ(self, tmp_path) -> None:
        path = tmp_path / "plan.json"
        request = vwap_daily_request(["1788"], expected_date="2026-11-24")
        assert request is not None
        write_plan(str(path), [request])
        payload = json.loads(path.read_text(encoding="utf-8"))
        assert payload["requests"][0]["workflow"] == "vwap-ingest.yml"
        assert payload["requests"][0]["inputs"]["daily_codes"] == "1788"

    def test_計画なしは空リストを書く(self, tmp_path) -> None:
        path = tmp_path / "plan.json"
        write_plan(str(path), [])
        assert json.loads(path.read_text(encoding="utf-8")) == {"requests": []}


class TestOpsCheckWiring:
    NOW = datetime(2026, 11, 6, 23, 35, tzinfo=JST)

    def _store(self, codes=("7203", "7204", "7205")):
        store = _FakeStore()
        for i, code in enumerate(codes, start=1):
            store.query(
                "INSERT INTO core_stocks (id,code,is_active,instrument_type) VALUES (?,?,1,'equity')",
                [i, code],
            )
        return store

    def test_vwap欠測は再取得計画にも入る(self) -> None:
        problems: list[str] = []
        refetch: list[RefetchRequest] = []
        r2 = _FakeDailyR2({"7203": datetime(2026, 11, 6, 18, 30, tzinfo=JST),
                           "7204": datetime(2026, 11, 4, 18, 30, tzinfo=JST)})
        ops_check._check_vwap_daily_coverage(
            self._store(), r2, problems, now=self.NOW, refetch=refetch
        )
        assert len(problems) == 1
        assert len(refetch) == 1
        assert refetch[0].inputs == {"target": "daily", "daily_codes": "7204,7205"}

    def test_当日書込0の系統障害は再取得しない(self) -> None:
        problems: list[str] = []
        refetch: list[RefetchRequest] = []
        stamp = datetime(2026, 11, 5, 18, 30, tzinfo=JST)
        r2 = _FakeDailyR2({"7203": stamp, "7204": stamp, "7205": stamp})
        ops_check._check_vwap_daily_coverage(
            self._store(), r2, problems, now=self.NOW, refetch=refetch
        )
        assert len(problems) == 1
        assert refetch == []

    def test_ir未保管は再取得計画にも入る(self) -> None:
        store = _FakeStore()
        now = 1_800_000_000
        day = 86_400
        store.query(
            "INSERT INTO ir_disclosures (tdnet_id, pubdate, notion_page_id)"
            " VALUES ('gap-1', ?, NULL)",
            [now - 20 * day],
        )
        problems: list[str] = []
        refetch: list[RefetchRequest] = []
        ops_check._check_ir_pdf_archive(store, problems, now_epoch=now, refetch=refetch)
        assert len(problems) == 1
        assert len(refetch) == 1
        assert refetch[0].workflow == "backfill.yml"
        assert refetch[0].inputs["job"] == "ir"

    def test_refetch未指定なら従来どおり判定だけする(self) -> None:
        problems: list[str] = []
        r2 = _FakeDailyR2({"7203": datetime(2026, 11, 6, 18, 30, tzinfo=JST)})
        ops_check._check_vwap_daily_coverage(self._store(), r2, problems, now=self.NOW)
        assert len(problems) == 1
