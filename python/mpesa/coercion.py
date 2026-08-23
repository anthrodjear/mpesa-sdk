"""Lenient coercion of Safaricom's inconsistent JSON value types.

Daraja sends the same logical field with different JSON types depending
on endpoint and capture: ``ResponseCode`` arrives as the STRING "0" in
synchronous STK responses but as INTEGER 0 inside callbacks;
``expires_in`` is the STRING "3599" in official OAuth captures and a
bare number elsewhere; callback metadata ``TransactionDate`` is
numeric-typed (see docs/apis/stk-push.md, docs/apis/oauth.md). Parsing
such payloads with rigid types breaks on real traffic, so these helpers
accept every observed shape and canonicalize.

Divergences from go/coercion.go (intentional, documented):
* ``null`` -> ``None`` instead of Go zero values; ``coerce_int``'s
  ``None`` means "absent/unknown" -- Go's TTL-unknown signal.
* Inputs are decoded Python values, so ``coerce_str`` trims surrounding
  whitespace itself; unknown shapes are re-serialized via :func:`json.dumps`
  (Go's raw-token fallback).
* Floats beyond +/-2**53 are rejected by ``coerce_int``: their integer
  conversion silently corrupts precision (e.g. ``1e30`` carries ~19
  spurious digits); ``float('inf')`` stringifies as ``'inf'`` here.
* Returned strings are hard-capped at 4096 chars -- silent truncation
  bounds memory/log amplification from hostile gateway bodies.
"""

from __future__ import annotations

import json
import re
from typing import Any

__all__ = ["coerce_str", "coerce_int", "safe_json_int"]

_MAX_STR_LEN = 4096

# ASCII digits only, max 19 (int64 range): kills Unicode-Nd digits,
# PEP 515 underscores, and overlong CPU-DoS digit runs on py<3.11.
_INT_RE = re.compile(r"[+-]?[0-9]{1,19}", re.ASCII)


def safe_json_int(digits: str) -> int | None:
    """``json.loads(parse_int=...)`` hook shared by callback/result models.

    Integers up to 19 digits decode normally; anything longer becomes
    explicit absence (None) so one hostile magnitude can neither trip
    CPython's 4300-digit conversion guard nor survive as an unbounded
    precision-corrupted value.

    Example::

        json.loads(body, parse_int=safe_json_int)
    """
    return int(digits) if len(digits) <= 19 else None


def coerce_str(raw: Any) -> str | None:
    """Canonical string form of any decoded JSON value, or ``None``.

    | Input             | Output        | Notes                       |
    |-------------------|---------------|-----------------------------|
    | ``"  x  "``       | ``"x"``       | whitespace trimmed          |
    | ``True/False``    | "true"/"false"|                             |
    | ``3599``/``3599.0``| ``"3599"``   | integral float de-junked    |
    | ``1.5``           | ``"1.5"``     |                             |
    | dict/list/other   | compact JSON  | JSON-serializable others    |
    | unserializable    | ``None``      | e.g. Decimal/bytes/cycles   |
    | ``None``          | ``None``      |                             |

    Output longer than 4096 chars is silently truncated (rationale in
    module docstring). Example::

        code = coerce_str(payload.get("ResponseCode"))  # "0" or 0 both fine
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        out = "true" if raw else "false"
    elif isinstance(raw, str):
        out = raw.strip()
    elif isinstance(raw, int):
        try:
            out = str(raw)
        except ValueError:
            return None  # py3.11+ int_max_str_digits guard (>4300 digits)
    elif isinstance(raw, float):
        out = str(int(raw)) if raw.is_integer() else repr(raw)
    else:
        try:
            out = json.dumps(raw, separators=(",", ":"))
        except (TypeError, ValueError, RecursionError):
            return None
    return out[:_MAX_STR_LEN]


def coerce_int(raw: Any) -> int | None:
    """Strict integer extracted from lenient wire shapes, else ``None``.

    | Input               | Output | Notes                            |
    |---------------------|--------|----------------------------------|
    | ``"3599"``/``'+3599'``/``"-7"`` | value | ASCII digits, sign ok |
    | ``'"3599"'``        | 3599   | one quote-pair stripped          |
    | ``" 3599 "``        | 3599   | whitespace trimmed               |
    | ``3599``            | 3599   | bare int                         |
    | ``3599.0``          | 3599   | integral float within +/-2**53   |
    | ``1e30``, >2**53    | None   | precision-corrupting floats      |
    | ``"1_000"``, Nd digits, >19 digits | None | ASCII gate        |
    | ``1.5``, ``"12x"``  | None   | non-integral / alphabetic        |
    | `'""3599""'`        | None   | doubled quoting is malformed     |
    | ``""``/``None``     | None   | absent/unknown (Go uses 0)       |

    Example::

        ttl = coerce_int(body.get("expires_in"))
        if ttl is None or ttl <= 0:
            refresh_token_now()
    """
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    if isinstance(raw, float):
        if raw.is_integer() and -(2 ** 53) <= raw <= 2 ** 53:
            return int(raw)
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
            text = text[1:-1].strip()
        return int(text) if _INT_RE.fullmatch(text) else None
    return None
