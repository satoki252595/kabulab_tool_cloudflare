"""Read-only qualification of the current GitHub run attempt/job/runner clock."""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone


class JobClockError(ValueError):
    """Only fixed, non-sensitive reason codes may be raised here."""


class JobClockNotReady(JobClockError):
    """A complete Jobs page has not published the current job's clock yet."""


def qualify_job_clock(payload, run_id: str, attempt: str, job: str, runner: str) -> str:
    if not re.fullmatch(r"[1-9]\d*", run_id) or not re.fullmatch(r"[1-9]\d*", attempt) or not job or not runner:
        raise JobClockError("invalid_identity")
    if not isinstance(payload, dict) or type(payload.get("total_count")) is not int:
        raise JobClockError("invalid_page")
    jobs, count = payload.get("jobs"), payload["total_count"]
    if not isinstance(jobs, list) or not 0 <= count <= 100 or len(jobs) != count:
        raise JobClockError("incomplete_page")
    if any(not isinstance(row, dict) or type(row.get("run_id")) is not int
           or type(row.get("run_attempt")) is not int or row["run_id"] != int(run_id)
           or row["run_attempt"] != int(attempt) or not isinstance(row.get("name"), str)
           for row in jobs):
        raise JobClockError("job_identity_mismatch")
    candidates = [row for row in jobs if row["name"] == job or row["name"].endswith(" / " + job)]
    if not candidates:
        raise JobClockNotReady("job_not_visible")
    if len(candidates) == 1 and candidates[0].get("status") not in ("queued", "waiting", "pending", "in_progress"):
        raise JobClockError("job_not_active")
    matches = [row for row in candidates if row.get("runner_name") == runner]
    if not matches and len(candidates) == 1 and candidates[0].get("runner_name") in (None, ""):
        raise JobClockNotReady("runner_unassigned")
    if len(matches) != 1:
        raise JobClockError("job_ambiguous" if len(candidates) > 1 else "runner_mismatch")
    if matches[0].get("status") in ("queued", "waiting", "pending"):
        raise JobClockNotReady("job_not_started")
    if matches[0].get("status") != "in_progress":
        raise JobClockError("job_not_active")
    value = matches[0].get("started_at")
    if value in (None, ""):
        raise JobClockNotReady("start_unpublished")
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", value):
        raise JobClockError("invalid_start")
    try:
        started = datetime.fromisoformat(value)
    except ValueError as exc:
        raise JobClockError("invalid_start") from exc
    if started > datetime.now(timezone.utc):
        raise JobClockError("future_start")
    return started.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def observe_job_clock(read_page, run_id, attempt, job, runner, *, monotonic=time.monotonic,
                      sleep=time.sleep) -> str:
    """Observe metadata only, at most three GETs within the existing 30-second budget."""
    deadline = monotonic() + 30
    for observation in range(1, 4):
        if observation > 1:
            if deadline - monotonic() <= 2:
                raise JobClockError("observation_timeout")
            sleep(2)
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise JobClockError("observation_timeout")
        payload = read_page(remaining)
        if monotonic() >= deadline:
            raise JobClockError("observation_timeout")
        try:
            return qualify_job_clock(payload, run_id, attempt, job, runner)
        except JobClockNotReady as exc:
            print(f"native_job_clock observation={observation} reason={exc}", file=sys.stderr)
            if observation == 3:
                raise
    raise AssertionError("unreachable")


def read_github_job_page(repository, run_id, attempt, timeout):
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
            or not re.fullmatch(r"[1-9]\d*", run_id) or not re.fullmatch(r"[1-9]\d*", attempt)):
        raise JobClockError("invalid_identity")
    endpoint = f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100"
    try:
        response = subprocess.run(["gh", "api", "--method", "GET", endpoint],
                                  capture_output=True, text=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired as exc:
        raise JobClockError("observation_timeout") from exc
    except (OSError, subprocess.CalledProcessError) as exc:
        raise JobClockError("api_read_failed") from exc
    try:
        return json.loads(response.stdout)
    except ValueError as exc:
        raise JobClockError("invalid_page") from exc


if __name__ == "__main__":
    try:
        identity = tuple(os.environ[key] for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_JOB", "RUNNER_NAME"))
        if sys.argv[1:] == ["--github"]:
            repository = os.environ["GITHUB_REPOSITORY"]
            print(observe_job_clock(lambda timeout: read_github_job_page(repository, *identity[:2], timeout), *identity))
        elif not sys.argv[1:]:
            print(qualify_job_clock(json.load(sys.stdin), *identity))
        else:
            raise JobClockError("invalid_invocation")
    except (KeyError, TypeError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, JobClockError) else "invalid_input"
        print(f"Current job start could not be qualified; source execution is stopped. reason={reason}", file=sys.stderr)
        sys.exit(1)
