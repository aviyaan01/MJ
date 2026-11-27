#!/usr/bin/env python3
"""Check a sanitized release evidence receipt, without network or deployment."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit


def check(receipt):
    if not isinstance(receipt, dict):
        raise ValueError("receipt must be an object")
    failures = []
    for key in ("target", "expected_build", "observed_build", "observed_at", "evidence"):
        if not isinstance(receipt.get(key), str) or not receipt[key].strip():
            failures.append(f"missing {key}")
    target = receipt.get("target", "")
    url = urlsplit(target if isinstance(target, str) else "")
    if url.scheme not in ("https", "http") or not url.hostname or url.username or url.password or url.query:
        failures.append("target must be an HTTP URL without credentials/query secrets")
    if type(receipt.get("status")) is not int or receipt["status"] != 200:
        failures.append("public response is not 200")
    if receipt.get("expected_build") != receipt.get("observed_build"):
        failures.append("served fingerprint does not match candidate")
    checks = receipt.get("smoke")
    if not isinstance(checks, list) or not checks:
        failures.append("no core behavior observations")
    elif any(not isinstance(c, dict) or not isinstance(c.get("name"), str)
             or not c["name"].strip() or c.get("passed") is not True
             or not isinstance(c.get("evidence"), str) or not c["evidence"].strip()
             for c in checks):
        failures.append("smoke observations failed or lack evidence")
    return {"consistent": not failures, "failures": failures,
            "limitation": "Receipt consistency only; no URL was fetched and evidence authenticity/freshness is not proven."}


def self_test():
    good = dict(target="https://example.test/health", expected_build="r2", observed_build="r2",
                observed_at="2026-10-14T00:00:00Z", evidence="http-response.json", status=200,
                smoke=[dict(name="checkout", passed=True, evidence="smoke.json")])
    assert check(good)["consistent"]
    for patch in (dict(observed_build="r1"), dict(status=503), dict(status=True),
                  dict(smoke=[]), dict(smoke=[dict(name="checkout", passed=False)]),
                  dict(expected_build=""), dict(observed_at=""),
                  dict(target="https://user:secret@example.test/health")):
        assert not check(dict(good, **patch))["consistent"], patch
    assert not check({"cli_exit": 0})["consistent"]
    print("PASS: CLI zero, stale fingerprint, failed/missing smoke and malformed receipts rejected")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("record", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
    elif args.record:
        try:
            result = check(json.loads(args.record.read_text()))
            print(json.dumps(result))
            raise SystemExit(0 if result["consistent"] else 1)
        except (ValueError, TypeError, OSError) as error:
            parser.exit(2, f"Invalid receipt: {error}\n")
    else:
        parser.error("record or --self-test required")
