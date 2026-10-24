"""Read-only qualification of the current GitHub run attempt/job/runner clock."""

import json
import os
import re
import sys
from datetime import datetime, timezone


def qualify_job_clock(payload, run_id: str, attempt: str, job: str, runner: str) -> str:
    if not re.fullmatch(r"[1-9]\d*", run_id) or not re.fullmatch(r"[1-9]\d*", attempt) or not job or not runner:
        raise ValueError("invalid job identity")
    if not isinstance(payload, dict) or type(payload.get("total_count")) is not int:
        raise ValueError("invalid job page")
    jobs, count = payload.get("jobs"), payload["total_count"]
    if not isinstance(jobs, list) or not 1 <= count <= 100 or len(jobs) != count:
        raise ValueError("incomplete job page")
    matches = [row for row in jobs if isinstance(row, dict)
               and type(row.get("run_id")) is int and type(row.get("run_attempt")) is int
               and row.get("run_id") == int(run_id) and row.get("run_attempt") == int(attempt)
               and row.get("status") == "in_progress" and row.get("runner_name") == runner
               and isinstance(row.get("name"), str)
               and (row["name"] == job or row["name"].endswith(" / " + job))]
    if len(matches) != 1:
        raise ValueError("current job is not unique")
    value = matches[0].get("started_at")
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z", value):
        raise ValueError("invalid job start")
    started = datetime.fromisoformat(value)
    if started > datetime.now(timezone.utc):
        raise ValueError("future job start")
    return started.isoformat(timespec="milliseconds").replace("+00:00", "Z")


if __name__ == "__main__":
    try:
        print(qualify_job_clock(json.load(sys.stdin), os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"],
                                os.environ["GITHUB_JOB"], os.environ["RUNNER_NAME"]))
    except (KeyError, TypeError, ValueError):
        print("Current job start could not be qualified; source execution is stopped.", file=sys.stderr)
        sys.exit(1)
