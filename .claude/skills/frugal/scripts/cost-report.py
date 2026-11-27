#!/usr/bin/env python3
"""Summarize one unit of observed attempt cost; never estimate missing usage."""
import argparse
import json
import math
from pathlib import Path


def summarize(attempts):
    if not isinstance(attempts, list) or not attempts:
        raise ValueError("a nonempty attempt list is required")
    units, completed, tasks = set(), set(), set()
    total, unknown = 0, False
    for attempt in attempts:
        task = attempt["task"]
        unit = attempt["unit"]
        correct = attempt["correct"]
        cost = attempt["cost"]
        if not isinstance(task, str) or not task or type(correct) is not bool:
            raise ValueError("task must be named; correct must be an independent boolean result")
        if unit not in ("tokens", "USD", "bytes", "seconds"):
            raise ValueError("unsupported unit; keep currencies and proxies separate")
        units.add(unit)
        tasks.add(task)
        if correct:
            if task in completed:
                raise ValueError("duplicate correct completion for one task")
            completed.add(task)
        if cost is None:
            unknown = True
        elif type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0:
            raise ValueError("cost must be finite nonnegative observed usage or null")
        else:
            total += cost
    if len(units) != 1:
        raise ValueError("mixed units cannot be added")
    return {
        "unit": units.pop(), "attempts": len(attempts), "tasks": len(tasks),
        "correct_tasks": len(completed), "known_cost": total,
        "total_cost": None if unknown else total,
        "cost_per_correct_task": None if unknown or not completed else total / len(completed),
        "limitation": "Acceptance and usage are supplied evidence; this script does not establish their truth.",
    }


def self_test():
    def row(task, cost, correct=False, unit="tokens"):
        return dict(task=task, cost=cost, correct=correct, unit=unit)
    result = summarize([row("a", 30), row("a", 20, True), row("b", 50)])
    assert result["cost_per_correct_task"] == 100 and result["correct_tasks"] == 1
    assert summarize([row("a", 10)])["cost_per_correct_task"] is None
    assert summarize([row("a", None, True)])["total_cost"] is None
    for bad in ([], [row("a", -1)], [row("a", float("nan"))],
                [row("a", 1, unit="bytes"), row("b", 2)],
                [row("a", 1, True), row("a", 2, True)], [row("a", True)]):
        try:
            summarize(bad)
        except ValueError:
            continue
        raise AssertionError("invalid observation accepted")
    print("PASS: failed attempts counted; zero success/missing usage undefined; invalid costs rejected")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.record:
        try:
            print(json.dumps(summarize(json.loads(args.record.read_text())), allow_nan=False))
        except (ValueError, KeyError, TypeError, OSError) as error:
            parser.exit(2, f"Invalid cost record: {error}\n")
    else:
        parser.error("record or --self-test required")
