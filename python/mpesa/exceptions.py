"""Typed errors for Daraja's standard error envelope (mirrors go/errors.go).

Every non-2xx response becomes one :class:`MpesaError`, whether the body
carried the wire envelope ``{requestId, errorCode, errorMessage}`` or was
hostile entirely (HTML WAF pages, truncated JSON, binary junk). Envelope
members are always sanitized -- Unicode Cc/Cf control runes stripped, each
field capped at 512 characters -- so corrupted gateway output can never
inject newlines or ANSI escapes into logs.

ERROR-BODY ISOLATION (go/errors.go ``parseError`` parity): a body that is
not the envelope at all yields a GENERIC ``error_message``. The upstream
bytes -- content type, length and a printable-ASCII snippet -- are handed
to the optional ``error_logger`` and DISCARDED otherwise. Rationale: an
exception object is logged by every ``logger.exception`` on the call
path, so embedding upstream body text here would ship raw gateway payloads
off-box (customer MSISDNs, WAF internals) to whatever log sink happens to
be configured. Diagnostics are opt-in, never ambient.

Raise/catch::

    if resp.status_code >= 300:
        raise MpesaError.from_response(resp.status_code, resp.content,
                                       resp.headers.get("content-type", ""))
    try:
        push()
    except MpesaError as exc:
        log.warning("%s", exc)   # mpesa: HTTP 500 msg [code] requestId=...

    # Opt-in diagnostics (the only place upstream bytes surface):
    MpesaError.from_response(500, body, ctype, my_sink)
"""

from __future__ import annotations

import json
import math
import unicodedata
from typing import Any, Callable

__all__ = ["MpesaError", "InvalidTokenError", "RefreshRateLimitedError"]

_MAX_FIELD_CHARS = 512
_MAX_SNIPPET_CHARS = 200
#: Magnitude bound for the integral-float branch, mirroring
#: ``mpesa.coercion._MONEY_MAGNITUDE`` -- the SAME +/-2**53 rule
#: ``coerce_str``/``coerce_int`` apply (see the coercion module's
#: docstring). Kept as a local constant because ``mpesa.coercion`` imports
#: this module: importing it back would be an import cycle.
_MONEY_MAGNITUDE = 2 ** 53
#: Caller-facing text for a non-envelope body (go/errors.go verbatim).
_UNPARSEABLE_MESSAGE = "unexpected error response from gateway"
#: Opt-in diagnostic sink: (status_code, content_type, raw body).
ErrorLogger = Callable[[int, str, bytes], None]


def _sanitize(value: str, limit: int = _MAX_FIELD_CHARS) -> str:
    """Strip ``Cc``/``Cf`` control runes, then cap at *limit* characters."""
    cleaned = "".join(c for c in value if unicodedata.category(c) not in ("Cc", "Cf"))
    return cleaned[:limit]


def _ascii_snippet(text: str, limit: int = _MAX_SNIPPET_CHARS) -> str:
    """Return up to *limit* printable-ASCII characters of *text*, for diagnostics.

    Lives here for OPT-IN error loggers only: an ``error_logger`` handed a
    raw upstream body may render it through this helper before persisting
    anything. The SDK itself never interpolates the result into an
    exception, because exception text travels off-box by default.
    """
    out: list[str] = []
    for ch in text:
        if len(out) < limit and " " <= ch <= "~":
            out.append(ch)
    return "".join(out)


def _envelope_value(raw: Any) -> str:
    """Coerce one error-envelope member to its wire string form.

    Go ``FlexString`` (go/coercion.go:23-47) accepts strings, numbers,
    booleans and null; arrays and objects are a hard error there, which
    drops the whole envelope onto the generic-message path. This mirrors
    the member-level half of that: strings pass through, numbers and
    booleans are rendered as their JSON text, and null/arrays/objects
    count as absent.

    Floats follow ``coercion.coerce_str``'s policy EXACTLY: an integral
    float within +/-2**53 is de-junked to its integer text, and one
    beyond that bound is rendered with ``repr`` instead -- ``str(int(1e30))``
    would print ~19 spurious binary digits. A NON-FINITE float counts as
    ABSENT: Python's ``json`` decoder accepts the bare ``NaN``/``Infinity``
    literals, so the member must be refused here rather than reach the
    caller as the text "nan"/"inf" (the same defence in depth
    ``mpesa.results`` applies to balance floats).

    Kept local rather than reusing ``coercion.coerce_str`` because
    ``mpesa.coercion`` imports from this module -- a shared helper here
    would be an import cycle.
    """
    if isinstance(raw, str):
        return raw
    if isinstance(raw, bool):
        # bool BEFORE int: in Python a bool IS an int subclass, so the
        # int branch would render True as "1".
        return "true" if raw else "false"
    if isinstance(raw, int):
        return str(raw)
    if isinstance(raw, float):
        # Defence in depth: a non-finite member is ABSENCE, never text.
        if not math.isfinite(raw):
            return ""
        # Mirrors coerce_str's integral-float branch: str(int(1e30)) prints
        # ~19 spurious binary digits ("1000000000000000019884624838656"),
        # so an integral float beyond the magnitude cap falls back to
        # repr() -- the honest "this magnitude is not an exact integer"
        # rendering.
        if raw.is_integer() and abs(raw) <= _MONEY_MAGNITUDE:
            return str(int(raw))
        return repr(raw)
    return ""


class MpesaError(Exception):
    """The typed surface for non-2xx Daraja responses.

    Attributes:
        status_code: HTTP status of the failed response (always set).
        request_id: Daraja ``requestId`` trace handle, or None.
        error_code: dotted gateway code such as ``500.001.1001``, or None.
        error_message: gateway text, an unparseable-body diagnostic, or None.

    Example::

        try:
            client.stk_push(STKPushRequest(
                transaction_type="CustomerPayBillOnline", amount=100,
                party_a="2547XXXXXXXX", phone_number="2547XXXXXXXX",
                call_back_url="https://example.com/callback",
                account_reference="Order42", transaction_desc="pay"))
        except MpesaError as exc:
            if exc.error_code == "401.003.01":
                refresh_token()
            else:
                raise
    """

    def __init__(self, status_code: int, request_id: str | None = None,
                 error_code: str | None = None,
                 error_message: str | None = None) -> None:
        """Store the four attributes; hand-raised inputs must already be sanitized."""
        self.status_code = status_code
        self.request_id = request_id
        self.error_code = error_code
        self.error_message = error_message
        super().__init__(status_code, request_id, error_code, error_message)

    def __str__(self) -> str:
        """Render Go-style: ``mpesa: HTTP 500 <msg> [<code>] requestId=<id>``."""
        parts = [f"HTTP {self.status_code}"]
        if self.error_message:
            parts.append(self.error_message)
        if self.error_code:
            parts.append(f"[{self.error_code}]")
        if self.request_id:
            parts.append(f"requestId={self.request_id}")
        return "mpesa: " + " ".join(parts)

    @classmethod
    def from_response(cls, status_code: int, body: bytes,
                      content_type: str = "",
                      error_logger: "ErrorLogger | None" = None) -> "MpesaError":
        """Build an :class:`MpesaError` from raw non-2xx *body* bytes.

        Never raises: malformed JSON, wrong shapes and binary garbage all fall
        through to an instance whose ``error_message`` is the generic
        :data:`_UNPARSEABLE_MESSAGE`. Diagnostics (status, content type, byte
        length, printable-ASCII snippet) go to the OPT-IN *error_logger*
        only -- ``(status_code, content_type, body)`` -- and are discarded
        when it is omitted, so a hostile upstream body can never travel off-box
        inside the exception text. A member that arrives as a STRING or a
        SCALAR (number, boolean) is coerced to its wire string form; a
        member that arrives as null, an array or an object counts as absent.

        Args:
            status_code: HTTP status of the failed response.
            body: Raw response bytes (never interpolated into the error).
            content_type: Response ``Content-Type`` (diagnostics only).
            error_logger: Optional sink for upstream diagnostics; a logger
                that itself raises is swallowed and never masks this error.
        """
        raw = {"requestId": "", "errorCode": "", "errorMessage": ""}
        try:
            parsed = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:  # deliberate: a hostile body must still yield typed error
            parsed = None
        if isinstance(parsed, dict):
            for key in raw:
                raw[key] = _envelope_value(parsed.get(key))
        err = cls(
            status_code=status_code,
            request_id=_sanitize(raw["requestId"]) or None,
            error_code=_sanitize(raw["errorCode"]) or None,
            error_message=_sanitize(raw["errorMessage"]) or None,
        )
        if not any(raw.values()):
            err.error_message = _UNPARSEABLE_MESSAGE
            if error_logger is not None:
                try:
                    error_logger(status_code, content_type, body)
                except Exception:  # a broken sink must never mask the error
                    pass
        return err


class InvalidTokenError(ValueError):
    """The OAuth ``access_token`` arrived as a NON-STRING JSON value.

    The old coercion was ``str`` -- so a gateway hiccup sending
    ``{"access_token": null, ...}`` produced the literal string ``"None"``,
    which is truthy, passed the ``if not token_response.access_token``
    gate, and poisoned the process token cache: every subsequent call 401s,
    the retry re-fires, and the failure counter trips the refresh rate
    limiter. Numeric/dict/list tokens are equally meaningless as bearers.

    Subclasses :class:`ValueError` (not a bare ``RuntimeError``/``Exception``)
    so the documented decoder contract -- ``from_json`` raises ``ValueError``
    for a malformed payload -- stays truthful while still being catchable as
    its own type. It is NEVER swallowed into a cached token.
    """


class RefreshRateLimitedError(RuntimeError):
    """OAuth refresh was throttled after too many consecutive failures.

    Raised by :meth:`mpesa.auth.TokenManager` after
    ``_REFRESH_FAILURE_THRESHOLD`` failed refreshes inside
    ``_REFRESH_RATE_LIMIT_SECONDS`` (parity with go/client.go
    ``refreshRateLimit``): a crash-looping gateway must not turn the OAuth
    endpoint into a hammer. Subclasses :class:`RuntimeError` so existing
    ``except RuntimeError`` handlers keep working unchanged.
    """
