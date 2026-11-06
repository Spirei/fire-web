"""Deterministically balance complete pytest files across isolated CI jobs."""

import argparse
import collections
import json
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", type=int, required=True)
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--plan-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.count <= 16 or not 0 <= args.index < args.count:
        parser.error("index must select one of 1..16 shards")
    root = Path(__file__).resolve().parents[1]
    collected = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q"],
        cwd=root, text=True, capture_output=True, check=False,
    )
    if collected.returncode:
        sys.stdout.write(collected.stdout)
        sys.stderr.write(collected.stderr)
        return collected.returncode
    counts = collections.Counter(
        line.split("::", 1)[0] for line in collected.stdout.splitlines()
        if line.startswith("tests/") and "::" in line
    )
    if not counts:
        raise RuntimeError("No test files collected; refusing an empty successful shard")
    groups = [[] for _ in range(args.count)]
    loads = [0] * args.count
    for file, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        index = loads.index(min(loads))
        groups[index].append(file)
        loads[index] += count
    assigned = [file for group in groups for file in group]
    assert len(assigned) == len(set(assigned)) and set(assigned) == set(counts)
    assert sum(loads) == sum(counts.values())
    if not groups[args.index]:
        raise RuntimeError("Selected shard is empty; reduce shard count")
    print(json.dumps({"shard": args.index, "tests": loads[args.index],
                      "files": len(groups[args.index]), "allTests": sum(loads),
                      "allFiles": len(counts), "partition": loads}), flush=True)
    if args.plan_only:
        return 0
    return subprocess.run(
        [sys.executable, "-m", "pytest", "-q", "--maxfail=1", "--durations=25", "--tb=short", *sorted(groups[args.index])],
        cwd=root, check=False,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
