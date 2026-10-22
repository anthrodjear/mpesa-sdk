"""Cross-engine conformance harness.

Reads the shared fixtures in ``contract/fixtures`` (schema:
``contract/README.md``) and asserts the Python engine agrees with the
contract. The same files are read by ``go/contract_test.go`` and
``typescript/test/contract.test.ts``; a case that passes in one engine and
fails in another is a DRIFT BUG in the failing engine, not a bad fixture.

TWO CASES ARE RED ON PURPOSE -- they pin live defects, and this phase does
not fix them:

* ``error-envelope-numeric-code`` (**D1**) -- ``MpesaError.from_response``
  keeps only the envelope members that arrive as ``str``, so a numeric
  ``errorCode`` is DROPPED (the envelope's other members -- the
  ``requestId``, the ``errorMessage`` -- still survive): the error code the
  401 retry probe in ``client.py`` keys on never arrives.
* ``balance-over-2p53`` (**D3**) -- ``parse_balance_segments`` has no
  2**53 gate, so a balance that cannot survive a float64 round-trip is
  returned with a silently rounded amount instead of being skipped and
  counted (Go ``exceedsSafeBalance`` and the TypeScript parity already
  skip it).

The assertions stay in place when the defects are fixed: Phase 1 turns
these cases green by changing the ENGINE, never by weakening this file.
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import pytest

from mpesa.callbacks import StkCallbackResult
from mpesa.exceptions import MpesaError
from mpesa.results import parse_balance_segments

# The package directory is <repo>/python, so two parents up is the repo root
# where the shared corpus lives.
FIXTURE_DIR = Path(__file__).resolve().parents[2] / "contract" / "fixtures"

#: Plain-decimal grammar: optional sign, digits, optional fractional part.
#:
#: Deliberately plain-decimal-only. ``float()`` also accepts ``"inf"`` and
#: ``"nan"``, Go's ``strconv.ParseFloat`` also accepts ``"Inf"``, ``"NaN"``
#: and ``"0x1p-2"``, and TypeScript's ``Number()`` also accepts ``"0x10"``
#: and ``"1e3"`` -- three permissive parsers would classify the same
#: metadata text three different ways. One grammar, applied identically in
#: all three harnesses, removes that class of drift by construction.
_NUMERIC_RE = re.compile(r"-?\d+(\.\d+)?")


def _cases() -> list[dict[str, Any]]:
    """Every shared fixture, in file-name order for a stable test order."""
    if not FIXTURE_DIR.is_dir():
        pytest.fail(f"contract fixture dir missing: {FIXTURE_DIR}")
    cases: list[dict[str, Any]] = []
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        cases.append(json.loads(path.read_text(encoding="utf-8")))
    if not cases:
        pytest.fail(f"no contract fixtures found in {FIXTURE_DIR}")
    return cases


def _raw_body(body: Any) -> bytes:
    """The bytes the engine must SEE for a fixture body.

    A JSON string body IS the raw body text (a WAF page, an HTML error
    page); an object body is the raw JSON document. Go and TypeScript
    apply the same rule, so one corpus can express both a JSON envelope
    and a non-JSON gateway response.
    """
    if isinstance(body, str):
        return body.encode("utf-8")
    return json.dumps(body).encode("utf-8")


def _content_type(raw: bytes) -> str:
    """The content type the transport would have reported for the raw body.

    Derived from the RAW TEXT, exactly as the Go and TypeScript harnesses
    derive it: a body that opens with a JSON object or array is
    ``application/json``, anything else (a WAF page, an HTML error page, a
    bare scalar) is ``text/html``.

    The fixture's JSON TYPE must not decide this: a fixture ``body`` that
    is the string ``"42"`` IS the raw wire text ``42``, which is not JSON.
    Deriving from the type instead would have the Python engine receive a
    different input than the other two for the same fixture.
    """
    text = raw.decode("utf-8", errors="replace").lstrip()
    if text.startswith("{") or text.startswith("["):
        return "application/json"
    return "text/html"


def _number(value: Any) -> float | None:
    """A metadata value as a comparable number, or None when it is not one.

    A JSON number is numeric. A STRING is numeric only when its trimmed
    text matches the plain-decimal grammar (``_NUMERIC_RE``). Everything
    else compares as a string.

    Booleans are NOT numbers here: ``True`` must never compare equal to 1,
    and a boolean metadata value is compared as a string instead.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        try:
            return float(value)
        except OverflowError:  # a JSON integer beyond the float64 range
            return None
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip()
        if not _NUMERIC_RE.fullmatch(text):
            return None
        parsed = float(text)
        return parsed if math.isfinite(parsed) else None
    return None


@pytest.mark.parametrize("case", _cases(), ids=lambda c: c["id"])
def test_contract_fixture(case: dict[str, Any]) -> None:
    """Assert this engine agrees with the shared wire contract."""
    kind = case["kind"]
    expect = case["expect"]

    if kind == "stk_callback":
        result = StkCallbackResult.from_json(_raw_body(case["body"]))
        assert result.classify().value == expect["class"]
        assert result.result_code == expect["resultCode"]
        meta = result.metadata()
        for key, want in expect.get("metadata", {}).items():
            assert key in meta, f"metadata[{key!r}] missing"
            got = meta[key]
            want_num, got_num = _number(want), _number(got)
            if want_num is not None and got_num is not None:
                # The gateway sends Amount as 100 in one capture and as
                # "100" in another; both mean the same money.
                assert got_num == want_num, (
                    f"metadata[{key!r}] = {got!r}, want {want!r}")
            else:
                assert str(got).strip() == str(want).strip(), (
                    f"metadata[{key!r}] = {got!r}, want {want!r}")

    elif kind == "balance_segment":
        segments, skipped = parse_balance_segments(case["body"]["text"])
        assert len(segments) == expect["segments"]
        assert skipped == expect["skipped"]

    elif kind == "error_envelope":
        # statusCode is an INPUT -- the HTTP status the harness feeds the
        # engine -- not an expectation, so it is never asserted on. 0 is not
        # a real HTTP status, so an absent AND a zero value are both
        # rejected: the three harnesses must agree on what a valid input is.
        status = case.get("statusCode")
        if status is None or status == 0:
            pytest.fail(
                f"fixture {case['id']!r} has no valid top-level statusCode: "
                f"{status!r}")
        raw = _raw_body(case["body"])
        err = MpesaError.from_response(status, raw, _content_type(raw))
        if expect.get("errorCode") is None:
            assert err.error_code is None
        else:
            assert err.error_code == expect["errorCode"]
        if expect.get("errorMessage") is None:
            assert err.error_message is None
        else:
            assert err.error_message == expect["errorMessage"]

    else:
        pytest.fail(f"unknown fixture kind {kind!r}")
