"""Lenient coercion of Safaricom's inconsistent JSON value types.

Daraja sends the same logical field with different JSON types depending
on endpoint and capture: ``ResponseCode`` arrives as the STRING "0" in
synchronous STK responses but as INTEGER 0 inside callbacks;
``expires_in`` is the STRING "3599" in official OAuth captures and a
bare number elsewhere; callback metadata ``TransactionDate`` is
numeric-typed (see docs/apis/stk-push.md, docs/apis/oauth.md). Parsing
such payloads with rigid types breaks on real traffic, so these helpers
accept every observed shape and canonicalize.

Divergence from go/coercion.go (intentional, documented):
* ``null`` -> ``None`` (Python Optional idiom) instead of Go's zero
  values; ``coerce_int``'s ``None`` means "absent/unknown", which is the
  same TTL-unknown signal Go expresses as ``expires_in <= 0``.
* Inputs are already-decoded Python values, so ``coerce_str`` trims
  surrounding whitespace itself and unknown shapes are re-serialized
  with :func:`json.dumps`, mirroring Go's raw-token fallback.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["coerce_str", "coerce_int"]


def coerce_str(raw: Any) -> str | None:
    """Canonical string form of any decoded JSON value, or ``None``.

    | Input            | Output      |
    |------------------|-------------|
    | ``"  x  "``      | ``"x"``     |
    | ``True/False``   | "true"/"false" |
    | ``3599``         | ``"3599"``  |
    | ``3599.0``       | ``"3599"``  |
    | ``1.5``          | ``"1.5"``   |
    | ``None``         | ``None``    |
    | other (dict...)  | compact JSON text |

    Example::

        code = coerce_str(payload.get("ResponseCode"))  # "0" or 0 both fine

    Empty strings are preserved (a present-but-empty value differs from
    an absent key mapped to ``None``).
    """
    if raw is None:
        return None
    if isinstance(raw, bool):
        return "true" if raw else "false"
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        return str(int(raw)) if raw.is_integer() else repr(raw)
    if isinstance(raw, str):
        return raw.strip()
    return json.dumps(raw, separators=(",", ":"))


def coerce_int(raw: Any) -> int | None:
    """Strict integer extracted from lenient wire shapes, else ``None``.

    | Input              | Output | Notes                          |
    |--------------------|--------|--------------------------------|
    | ``"3599"``         | 3599   |                                |
    | ``'"3599"'``       | 3599   | one quote-pair stripped        |
    | ``" 3599 "``       | 3599   | whitespace trimmed             |
    | ``3599`` / ``3599.0`` | 3599 | bare number / integral float   |
    | ``1.5``, ``"12x"`` | None   | non-integral / alphabetic      |
    | `'""3599""'``      | None   | doubled quoting is malformed   |
    | ``""``/``None``    | None   | absent/unknown (Go uses 0)     |

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
        return int(raw) if raw.is_integer() else None
    if isinstance(raw, str):
        text = raw.strip()
        if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
            text = text[1:-1].strip()
        if not text:
            return None
        try:
            return int(text)
        except ValueError:
            return None
    return None
