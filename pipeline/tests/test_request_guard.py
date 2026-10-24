"""Declared protocol controls only: no source fixtures, model, or network writes."""

import argparse
import threading
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import requests

from jp_stock_pipeline import http
from jp_stock_pipeline.cloud_store import r2
from jp_stock_pipeline.config import CloudStoreSettings, load_settings
from jp_stock_pipeline.jobs import runner, supply_daily
from jp_stock_pipeline.jobs.scheduled import ScheduledWindowError
from jp_stock_pipeline.notion import client as notion
from jp_stock_pipeline.request_guard import RequestNotStartedError, assert_request_allowed, request_guard


def deny():
    raise ScheduledWindowError("deadline")


def test_notion_throttle_wait_is_followed_by_send_admission(monkeypatch):
    client = notion.NotionClient("unit-control", rps=1000)
    active = True

    def guard():
        if not active:
            deny()

    def wait():
        nonlocal active
        active = False

    monkeypatch.setattr(client._throttle, "wait", wait)
    send = Mock()
    with request_guard(guard), pytest.raises(RequestNotStartedError):
        client._call(send, _retry_safe=False)
    send.assert_not_called()
    assert_request_allowed()  # context reset; the final ops receipt may close.


def test_explicit_429_retry_cannot_send_after_hard_deadline(monkeypatch):
    client = notion.NotionClient("unit-control", rps=1000)
    active = True

    def guard():
        if not active:
            deny()

    def wait(_seconds):
        nonlocal active
        active = False

    monkeypatch.setattr(client._throttle, "wait", lambda: None)
    monkeypatch.setattr(notion.time, "sleep", wait)
    send = Mock(side_effect=notion._RetryableRawError(429, {"Retry-After": "2"}))
    with request_guard(guard), pytest.raises(RequestNotStartedError) as stopped:
        client._call(send, _retry_safe=False)
    assert not isinstance(stopped.value, notion.NotionUnknownResultError)
    assert send.call_count == 1


def test_attachment_readback_checks_hard_without_exposing_its_signed_url(monkeypatch):
    send = Mock(side_effect=AssertionError("network forbidden"))
    monkeypatch.setattr(notion.requests, "get", send)
    client = notion.NotionClient("unit-control", rps=1000)
    with request_guard(deny), pytest.raises(RequestNotStartedError, match="^scheduled_request_not_started$"):
        client.download_file("https://example.invalid/protocol-control?signature=unit-control")
    send.assert_not_called()


@pytest.mark.parametrize("soft", [False, True])
def test_source_backoff_checks_soft_and_hard_before_the_next_attempt(monkeypatch, soft):
    active = True

    def guard():
        if not active:
            deny()

    def wait(_seconds):
        nonlocal active
        active = False

    response = requests.Response()
    response.status_code = 503
    session = SimpleNamespace(get=Mock(return_value=response))
    monkeypatch.setattr(http._get.retry, "sleep", wait)
    with request_guard(lambda: None if soft else guard()):
        with pytest.raises(http.FetchError if soft else RequestNotStartedError):
            http.fetch("https://example.invalid/protocol-control", session=session,
                       before_request=guard if soft else None)
    assert session.get.call_count == 1


def native_store(monkeypatch, guard):
    """Use the installed botocore before-send path, with its actual HTTP boundary disabled."""
    settings = CloudStoreSettings(cf_account_id="unit-control", r2_access_key_id="unit-control",
                                  r2_secret_access_key="unit-control")
    store = r2.R2Store(settings, "unit-control", writer="unit-control")
    store._s3 = r2._client(settings)
    send = Mock(side_effect=AssertionError("network forbidden"))
    monkeypatch.setattr(store.s3._endpoint.http_session, "send", send)
    return store, send, request_guard(guard)


def test_native_s3_first_send_guard_is_known_not_started(monkeypatch):
    checked = 0

    def guard():
        nonlocal checked
        checked += 1
        if checked == 2:  # after public admission, at the installed SDK before-send hook
            deny()

    store, send, scope = native_store(monkeypatch, guard)
    with scope, pytest.raises(RequestNotStartedError):
        store.put_json_conditional("control.json", {"version": 1})
    assert checked == 2
    send.assert_not_called()


def test_native_s3_retry_deadline_retains_the_prior_unknown_attempt(monkeypatch):
    from botocore.awsrequest import AWSResponse
    import botocore.endpoint

    active = True

    def guard():
        if not active:
            deny()

    store, send, scope = native_store(monkeypatch, guard)

    def failed_response(request):
        nonlocal active
        active = False
        raw = SimpleNamespace(stream=lambda: iter([b"<Error><Code>InternalError</Code></Error>"]))
        return AWSResponse(request.url, 500, {"content-type": "application/xml"}, raw)

    send.side_effect = failed_response
    monkeypatch.setattr(botocore.endpoint.time, "sleep", lambda _seconds: None)
    with scope, pytest.raises(r2.R2Error, match="retain claim") as stopped:
        store.put_json_conditional("control.json", {"version": 1})
    assert not isinstance(stopped.value, RequestNotStartedError)
    assert send.call_count == 1


def test_supply_executor_inherits_the_same_request_guard(monkeypatch):
    # Parser boundary controls; these rows never reach any persistence layer.
    rows = [supply_daily.jsf.ZandakaRow(date(2026, 10, 23), code, "unit-control", "unit-control", "unit-control")
            for code in ["9001", "9002"]]
    monkeypatch.setattr(supply_daily, "_fetch_and_store", lambda *args: (None, b"protocol-control"))
    monkeypatch.setattr(supply_daily.jsf, "parse_zandaka", lambda _bytes: rows)
    monkeypatch.setattr(supply_daily.jsf, "parse_shina", lambda _bytes: [])
    monkeypatch.setattr(supply_daily, "R2Store", lambda *args, **kwargs: None)
    parent_thread = threading.get_ident()
    checked_threads = []

    def guard():
        checked_threads.append(threading.get_ident())
        deny()

    def write(*args, **kwargs):
        assert_request_allowed()
        raise AssertionError("write forbidden")

    monkeypatch.setattr(supply_daily, "upsert_supply_series", write)
    cloud = SimpleNamespace(settings=SimpleNamespace(r2_enabled=lambda: True, d1_enabled=lambda: False,
                                                     bucket_supply="unit-control"))
    ctx = runner.JobContext(settings=load_settings(env={}, dry_run=True), client=None,
                            args=argparse.Namespace(limit=None), cloud=cloud)
    with request_guard(guard):
        supply_daily.execute(ctx)
    assert ctx.processed == 0 and ctx.failed == 2
    assert len(checked_threads) == 2 and all(t != parent_thread for t in checked_threads)


def test_runner_restores_send_context_before_the_final_ops_receipt(monkeypatch, tmp_path):
    from jp_stock_pipeline.cloud_store import d1, ops

    receipt = Mock(side_effect=lambda *args, **kwargs: assert_request_allowed() is None)
    monkeypatch.setattr(ops, "safe_record_job_run", receipt)
    monkeypatch.setattr(d1, "D1Store", lambda *args, **kwargs: None)

    def execute(ctx):
        ctx.cloud = SimpleNamespace(settings=SimpleNamespace(d1_enabled=lambda: True))
        now = datetime.now(timezone.utc)
        ctx.args._scheduled_window = (now - timedelta(minutes=2), now - timedelta(minutes=1))
        assert_request_allowed()

    assert runner.run_job("unit-control", execute, ["--dry-run"], env={"RAW_DATA_DIR": str(tmp_path)}) == 1
    receipt.assert_called_once()
