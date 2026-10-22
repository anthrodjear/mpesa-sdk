"""Cross-engine conformance harness.

Reads the shared fixtures in ``contract/fixtures`` (schema:
``contract/README.md``) and asserts the Python engine agrees with the
contract. The same files are read by ``go/contract_test.go`` and
``typescript/test/contract.test.ts``; a case that passes in one engine and
fails in another is either an engine drift bug or a wrong expectation --
decide which by checking the Daraja wire contract (``docs/apis/``), then
fix whichever is wrong.

TWO CASES ARE RED ON PURPOSE -- they pin live defects, and this phase does
not fix them:

* ``error-envelope-numeric-code`` (**D1**) -- ``MpesaError.from_response``
  keeps only the envelope members that arrive as ``str``, so a numeric
  ``errorCode`` is DROPPED: the typed error a caller receives loses the
  gateway's error code (``error_code`` is ``None`` instead of ``"401"``)
  while the envelope's other members -- the ``requestId``, the
  ``errorMessage`` -- survive. The 401 retry probe is NOT affected: it keys
  on the DOTTED code ``"401.003.01"`` (``mpesa/client.py``), which a
  numeric member would never have matched anyway, so Go and Python behave
  identically there.
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
_NUMERIC_RE = re.compile(r"^-?\d+(\.\d+)?$")

#: Leading whitespace the content-type rule skips: ASCII space, tab, CR
#: and LF -- and nothing else. Unicode whitespace (NBSP) and a UTF-8 BOM
#: are NOT whitespace here: the rule describes the ASCII framing of an
#: HTTP body, and a body that starts with a BOM is a DIFFERENT wire body.
#: All three harnesses skip exactly this set, so the three engines receive
#: the same input for the same fixture.
_ASCII_SPACE = " \t\r\n"


def _cases() -> list[dict[str, Any]]:
    """Every shared fixture, in file-name order for a stable test order.

    Fixture ids must be UNIQUE and NON-EMPTY: a duplicate would produce
    two identically named tests, and only one of them would be read as the
    case the author meant; an empty id would produce an unnamed test. A
    fixture that does not decode names ITSELF in the failure -- a bare
    JSONDecodeError would point at nothing.
    """
    if not FIXTURE_DIR.is_dir():
        pytest.fail(f"contract fixture dir missing: {FIXTURE_DIR}")
    cases: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        try:
            case = json.loads(path.read_text(encoding="utf-8"))
        except ValueError as exc:
            pytest.fail(f"decode {path.name}: {exc}")
        case_id = case.get("id", "")
        if not case_id:
            pytest.fail(f"fixture {path.name} has no id")
        prev = seen.get(case_id)
        if prev is not None:
            pytest.fail(
                f"duplicate fixture id {case_id!r} in {prev} and {path.name}")
        seen[case_id] = path.name
        cases.append(case)
    if not cases:
        pytest.fail(f"no contract fixtures found in {FIXTURE_DIR}")
    return cases


def _require(expect: dict[str, Any], key: str, case_id: str) -> Any:
    """A required expectation, or a loud failure naming the fixture.

    A fixture that forgets an expectation is a BROKEN fixture: reading it
    as a default would let the case pass while asserting nothing.
    """
    if key not in expect:
        pytest.fail(f"fixture {case_id!r} has no expect.{key}")
    return expect[key]


def _require_body(case: dict[str, Any]) -> Any:
    """The fixture body, or a loud failure naming the fixture.

    EVERY kind goes through this check, so a fixture with no body fails
    with the same message in all three engines -- and never feeds an
    engine an empty body, an input no gateway ever sent.
    """
    if "body" not in case:
        pytest.fail(f"fixture {case.get('id', '?')!r} has no body")
    return case["body"]


def _balance_text(case: dict[str, Any]) -> str:
    """The balance blob of a ``balance_segment`` fixture.

    Routed through the same body check as the other kinds, so a fixture
    with no body fails with the same message everywhere.
    """
    body = _require_body(case)
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str):
        pytest.fail(f"fixture {case.get('id', '?')!r} has no body.text")
    return text


def _raw_body(case: dict[str, Any]) -> bytes:
    """The bytes the engine must SEE for a fixture body.

    A JSON string body IS the raw body text (a WAF page, an HTML error
    page); an object body is the raw JSON document. Go and TypeScript
    apply the same rule, so one corpus can express both a JSON envelope
    and a non-JSON gateway response.
    """
    body = _require_body(case)
    if isinstance(body, str):
        return body.encode("utf-8")
    return json.dumps(body).encode("utf-8")


def _content_type(raw: bytes) -> str:
    """The content type the transport would have reported for the raw body.

    Derived from the RAW TEXT, exactly as the Go and TypeScript harnesses
    derive it: skip the leading ASCII whitespace, then look at the first
    byte. A body that opens with a JSON object or array is
    ``application/json``; anything else (a WAF page, an HTML error page, a
    bare scalar) is ``text/html``.

    The fixture's JSON TYPE must not decide this: a fixture ``body`` that
    is the string ``"42"`` IS the raw wire text ``42``, which is not JSON.
    Deriving from the type instead would have the Python engine receive a
    different input than the other two for the same fixture.
    """
    text = raw.decode("utf-8", errors="replace").lstrip(_ASCII_SPACE)
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
        result = StkCallbackResult.from_json(_raw_body(case))
        assert result.classify().value == _require(expect, "class", case["id"])
        assert result.result_code == _require(expect, "resultCode", case["id"])
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
        segments, skipped = parse_balance_segments(_balance_text(case))
        assert len(segments) == _require(expect, "segments", case["id"])
        assert skipped == _require(expect, "skipped", case["id"])

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
        raw = _raw_body(case)
        err = MpesaError.from_response(status, raw, _content_type(raw))
        want_code = _require(expect, "errorCode", case["id"])
        if want_code is None:
            assert err.error_code is None
        else:
            assert err.error_code == want_code
        want_message = _require(expect, "errorMessage", case["id"])
        if want_message is None:
            assert err.error_message is None
        else:
            assert err.error_message == want_message

    else:
        pytest.fail(f"unknown fixture kind {kind!r}")


def test_numeric_grammar_rejects_non_plain_decimals():
    """The plain-decimal grammar is a LOCAL helper, so it needs its own
    test: a future swap for ``float()`` -- which accepts ``"inf"``,
    ``"nan"`` and ``"1_000"``-style spellings of other numbers -- would
    silently re-open the cross-engine divergence the grammar exists to
    close, with Python calling ``"1e3"`` a number while Go and
    TypeScript do not.
    """
    for text in ("1e3", "0x10", "Inf", "NaN", "1_000"):
        assert _number(text) is None, f"{text!r} must not be numeric"
    assert _number("100") == 100.0
    assert _number("-100") == -100.0
    assert _number("100.50") == 100.5
    # A JSON number is numeric by construction, whatever its magnitude.
    assert _number(100) == 100.0
    # Booleans are not numbers: True must never compare equal to 1.
    assert _number(True) is None
