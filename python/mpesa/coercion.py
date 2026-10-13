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
* Floats beyond +/-2**53 are rejected by ``coerce_int`` (and by
  ``coerce_str``'s integral branch): their integer conversion silently
  corrupts precision (e.g. ``1e30`` carries ~19 spurious digits);
  ``float('inf')`` stringifies as ``'inf'`` here.
* Money is :class:`~decimal.Decimal` quantized to 2dp (see
  :func:`coerce_amount`): Daraja money on the wire always carries two
  decimal places, so a float would silently re-introduce binary cent loss
  on the way INTO settlement. Every numeric path applies the SAME
  +/-2**53 magnitude cap -- the old float path checked finiteness only,
  which accepted ``1e300``.
* Returned strings are hard-capped at 4096 chars -- silent truncation
  bounds memory/log amplification from hostile gateway bodies.
"""

from __future__ import annotations

import json
import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any

from .exceptions import InvalidTokenError

__all__ = ["coerce_str", "coerce_int", "safe_json_int", "coerce_amount",
           "coerce_token", "first_wins"]

_MAX_STR_LEN = 4096
#: Magnitude bound shared by EVERY money path (int/float/Decimal/str):
#: beyond +/-2**53 the difference between adjacent representable values
#: exceeds one cent, so a converted value could no longer round-trip.
_MONEY_MAGNITUDE = 2 ** 53
#: Daraja money is always 2dp on the wire (b2c.md/c2b.md/stk-push.md).
_MONEY_QUANTUM = Decimal("0.01")

# ASCII digits only, max 19 (int64 range): kills Unicode-Nd digits,
# PEP 515 underscores, and overlong CPU-DoS digit runs on py<3.11.
_INT_RE = re.compile(r"[+-]?[0-9]{1,19}", re.ASCII)

# Shared amount shape: up to 12 int digits + optional 2dp fraction.
# THREE changes from the old 6dp shape, all deliberate:
#   * 2dp, because Daraja money carries exactly two decimals -- anything
#     finer (0.30000000000000004, 1.123456) is hostile noise that would be
#     silently rounded away = silent cent loss;
#   * strings keep the tighter 12-int-digit wire shape while every NUMERIC
#     path is bounded by _MONEY_MAGNITUDE, so one bound (2**53) governs the
#     magnitude and the regex only narrows the documented wire shape;
#   * ASCII gate still rejects "1_000", "0x10", Unicode digits.
# Single source for callbacks.amount() and results.amount() — previously
# duplicated verbatim (38 lines) and already at risk of drift.
_AMOUNT_RE = re.compile(r"[+-]?[0-9]{1,12}(\.[0-9]{1,2})?", re.ASCII)


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
        # Aligned with coerce_int's +/-2**53 gate: str(int(1e30)) prints
        # ~19 spurious binary digits ("1000000000000000019884624838656"),
        # so an integral float beyond the cap falls back to repr() -- the
        # honest "this magnitude is not an exact integer" rendering.
        if raw.is_integer() and abs(raw) <= _MONEY_MAGNITUDE:
            out = str(int(raw))
        else:
            out = repr(raw)
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

    The bare-``int`` path is unbounded BY DESIGN (a Python int has no
    width): huge ints pass through here and fail closed downstream --
    request amounts hit ``_MAGNITUDE_GUARD``/tier ceilings, oversized
    ``str(int)`` conversions trip CPython's 4300-digit guard, and
    ``safe_json_int`` caps decoded digit runs at 19. Money paths pre-gate
    at +/-2**53 (see :func:`coerce_amount`) so precision-corrupting
    magnitudes never reach settlement.

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


def _quantize_money(value: Decimal) -> Decimal | None:
    """Bound- and finite-check *value*, then quantize to 2 decimal places.

    One helper so the magnitude cap is IDENTICAL on every path: the old
    float branch checked finiteness only, so ``1e300`` sailed through while
    the int branch rejected it at 2**53. A sub-cent input (e.g. ``1.005``)
    is refused rather than rounded: rounding is silent cent loss, and the
    wire shape is 2dp by contract.
    """
    if not value.is_finite() or abs(value) > _MONEY_MAGNITUDE:
        return None
    try:
        return value.quantize(_MONEY_QUANTUM)
    except (InvalidOperation, ValueError):  # 28dp default context overflow
        return None


def coerce_amount(value: Any) -> Decimal | None:
    """Canonical Daraja amount as a 2dp :class:`~decimal.Decimal`, or None.

    Shared by :meth:`callbacks.StkCallbackResult.amount` and
    :meth:`results.AsyncResult.amount` (previously duplicated verbatim).
    Guards, in order: bool -> None (bool is int subclass); magnitude cap
    +/-2**53 on EVERY numeric path; non-finite -> None; strings must fully
    match ``[+-]?digits{1,12}(.digits{1,2})?`` (ASCII gate rejects "1_000",
    "0x10", Unicode digits, exponent notation "1e30"); other types -> None.

    Decimal is the type, not a float, because binary floats cannot hold
    ``10.10``: ``float("10.10") == 10.1`` and a value passed straight into
    ``settle(order, amount=result.amount())`` loses the trailing cent of
    display. ``Decimal("10.10").quantize(0.01)`` is exact, and
    ``Decimal`` compares/arithmetic with ``int``/``float`` normally.

    Example::

        coerce_amount("10.50")   # -> Decimal('10.50')  (10.10 round-trips)
        coerce_amount(10.1)      # -> Decimal('10.10')  (2dp canonical form)
        coerce_amount(1e300)     # -> None  (magnitude cap)
        coerce_amount("1.123456")  # -> None  (sub-cent precision refused)
        coerce_amount(True)      # -> None
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return _quantize_money(value)
    if isinstance(value, int):
        try:
            return _quantize_money(Decimal(value))
        except (InvalidOperation, ValueError, OverflowError):
            return None
    if isinstance(value, float):
        # repr() is the shortest round-trip form, so a value written with
        # <=2dp on the wire re-appears as exactly that decimal text
        # ("10.1" -> "10.1"), and noisy binary tails ("0.30000000000000004")
        # fail the shape gate instead of being silently rounded.
        if not math.isfinite(value) or abs(value) > _MONEY_MAGNITUDE:
            return None
        return _coerce_amount_text(repr(value))
    if isinstance(value, str):
        return _coerce_amount_text(value.strip())
    return None


def _coerce_amount_text(text: str) -> Decimal | None:
    """Shape-gate *text*, then parse it as bounded 2dp money."""
    if not _AMOUNT_RE.fullmatch(text):
        return None
    try:
        return _quantize_money(Decimal(text))
    except (InvalidOperation, ValueError):
        return None


def coerce_token(raw: Any) -> str | None:
    """OAuth bearer from the wire: a JSON string, else explicit absence.

    | Input             | Output  | Notes                            |
    |-------------------|---------|----------------------------------|
    | ``"tok"``/``" t "``| ``"tok"``/``"t"`` | whitespace trimmed    |
    | ``None``          | ``None`` | JSON null = explicit absence     |
    | ``""``/``"   "``  | ``""``   | empty -> auth raises "missing"   |
    | bool/int/float/dict/list | raises | never stringified into a cache |

    Why a dedicated helper instead of ``coerce_str``: the generic coercion
    turns unknown shapes into compact JSON, so ``{"access_token": null}``
    became the literal string ``"None"`` -- truthy, so it passed the
    ``if not token_response.access_token`` gate and poisoned the process
    cache (FIX 1). A bearer is a CREDENTIAL, so it is the one field where
    "lenient re-serialization" is the wrong default: a non-string value
    raises instead of being cached, and only ``None`` is reported as
    absence.

    Example::

        token = coerce_token(body.get("access_token"))
        if not token:
            raise ValueError("mpesa: oauth response missing access_token")
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw.strip()
    raise InvalidTokenError(
        "mpesa: access_token must be a JSON string, got "
        f"{type(raw).__name__} -- refusing to cache a non-string bearer")


def first_wins(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Flatten ``(key, value)`` pairs first-wins (Go Parameters parity).

    Used by callback metadata and async-result parameters: on duplicate
    keys the FIRST value wins; later values are shadowed (count them with
    ``duplicate_keys()`` where available). O(n) single pass.

    Example::

        first_wins([("a", 1), ("a", 2)])  # -> {"a": 1}
    """
    out: dict[str, Any] = {}
    for key, value in pairs:
        out.setdefault(key, value)
    return out
