"""Tests for callback URL token primitives: shape, entropy uniqueness,
and the exact truth table of the constant-time comparison (mirrors
go/callbacktoken_test.go)."""

import inspect
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.callback_token import (  # noqa: E402
    callback_token_equal,
    new_callback_token,
)

# Unpadded base64url alphabet: A-Z a-z 0-9 '-' '_', exactly 22
# characters for a 16-byte draw.
_TOKEN_ALPHABET = re.compile(r"^[A-Za-z0-9_-]{22}$")

ON_FILE = "dQw4w9WgXcQ_ab12CD34ef"   # token stored beside the request record


def test_new_callback_token_shape_and_uniqueness():
    # 1000 draws must all be 22 chars, strictly inside the base64url
    # alphabet, and pairwise unique -- any collision across 2^14+
    # sampled bits implies broken randomness, not bad luck.
    draws = 1000
    seen = set()
    for i in range(draws):
        tok = new_callback_token()
        assert len(tok) == 22, f"draw {i}: length {len(tok)}, want 22"
        assert _TOKEN_ALPHABET.match(tok), \
            f"draw {i}: {tok!r} outside base64url alphabet"
        assert tok not in seen, f"draw {i}: duplicate {tok!r} across {draws}"
        seen.add(tok)


def test_entropy_failure_propagates_never_falls_back(monkeypatch):
    # A secrets failure must surface verbatim -- a silent fallback to
    # random/time-derived values would convert every registered endpoint
    # into a forgery target.
    def no_entropy(nbytes):
        raise OSError("mpesa test: entropy source unavailable")

    monkeypatch.setattr("secrets.token_urlsafe", no_entropy)
    with pytest.raises(OSError):
        new_callback_token()


@pytest.mark.parametrize("name,expected,provided,want", [
    ("exact match", ON_FILE, "dQw4w9WgXcQ_ab12CD34ef", True),
    ("same-length mismatch", ON_FILE, "dQw4w9WgXcQ_ab12CD34eg", False),
    ("both empty", "", "", False),
    ("expected empty, provided set", "", ON_FILE, False),
    ("provided empty, expected set", ON_FILE, "", False),
    ("case sensitivity", "DQW4W9WGXCQ_AB12CD34EF",
     "dqw4w9wgxcq_ab12cd34ef", False),
    ("lengths differ", "short", ON_FILE, False),
    ("provided truncates expected", ON_FILE, "dQw4w9WgXcQ_ab12CD34e", False),
])
def test_callback_token_equal_truth_table(name, expected, provided, want):
    # Both-empty MUST be False even though hmac.compare_digest("", "")
    # is True -- the empty guard exists precisely to override that
    # stdlib edge case (an unconfigured expectation must never bless a
    # request).
    assert callback_token_equal(expected, provided) is want, name


def test_generated_tokens_roundtrip_through_comparison():
    # The two primitives compose: a genuine hit matches its own record,
    # a fresh unrelated token never does.
    mine = new_callback_token()
    other = new_callback_token()
    assert callback_token_equal(mine, mine) is True
    assert callback_token_equal(mine, other) is False


def test_type_annotations_smoke():
    sig = inspect.signature(new_callback_token)
    assert sig.return_annotation is str
    assert not sig.parameters

    cmp_sig = inspect.signature(callback_token_equal)
    assert cmp_sig.return_annotation is bool
    annotations = [p.annotation for p in cmp_sig.parameters.values()]
    assert annotations == [str, str]
