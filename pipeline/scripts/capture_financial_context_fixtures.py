"""SHA検証済みTDnet原本をlocal-only fixtureへ複製する（HTTP/推計なし）。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POINTERS = ROOT / "tests/fixtures/edinet/context-unit/tdnet.source.txt"
DEST = ROOT / "tests/fixtures/tdnet/context-unit"


def capture(cache_dir: Path) -> None:
    DEST.mkdir(parents=True, exist_ok=True)
    for item in json.loads(POINTERS.read_text()):
        digest = item["raw_sha256"]
        content = (cache_dir / f"{digest}.zip").read_bytes()
        if len(content) > 64 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f"{item['code']}: 原本SHA/サイズを検証できません")
        (DEST / f"{item['code']}.zip").write_bytes(content)
        print(f"保存: {item['code']} ({len(content)} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    capture(parser.parse_args().cache_dir)
