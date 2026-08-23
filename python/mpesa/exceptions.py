"""Typed errors for Daraja's standard error envelope (mirrors go/errors.go).

Every non-2xx response becomes one :class:`MpesaError`, whether the body
carried the wire envelope ``{requestId, errorCode, errorMessage}`` or was
hostile entirely (HTML WAF pages, truncated JSON, binary junk). Envelope
members are always sanitized -- Unicode Cc/Cf control runes stripped, each
field capped at 512 characters -- so corrupted gateway output can never
inject newlines or ANSI escapes into logs.

Raise/catch::

    if resp.status_code >= 300:
        raise MpesaError.from_response(resp.status_code, resp.content,
                                       resp.headers.get("content-type", ""))
    try:
        push()
    except MpesaError as exc:
        log.warning("%s", exc)   # mpesa: HTTP 500 msg [code] requestId=...
"""

from __future__ import annotations

import json
import unicodedata

__all__ = ["MpesaError"]

_MAX_FIELD_CHARS = 512
_MAX_SNIPPET_CHARS = 200


def _sanitize(value: str, limit: int = _MAX_FIELD_CHARS) -> str:
    """Strip ``Cc``/``Cf`` control runes, then cap at *limit* characters."""
    cleaned = "".join(c for c in value if unicodedata.category(c) not in ("Cc", "Cf"))
    return cleaned[:limit]


def _ascii_snippet(text: str, limit: int = _MAX_SNIPPET_CHARS) -> str:
    """Return up to *limit* printable-ASCII characters of *text*, for diagnostics."""
    out: list[str] = []
    for ch in text:
        if len(out) < limit and " " <= ch <= "~":
            out.append(ch)
    return "".join(out)


class MpesaError(Exception):
    """The typed surface for non-2xx Daraja responses.

    Attributes:
        status_code: HTTP status of the failed response (always set).
        request_id: Daraja ``requestId`` trace handle, or None.
        error_code: dotted gateway code such as ``500.001.1001``, or None.
        error_message: gateway text, an unparseable-body diagnostic, or None.

    Example::

        try:
            client.stk_push(amount=1, phone="2547XXXXXXXX")
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
                      content_type: str = "") -> "MpesaError":
        """Build an :class:`MpesaError` from raw non-2xx *body* bytes.

        Never raises: malformed JSON, wrong shapes and binary garbage all fall
        through to an instance whose ``error_message`` carries a diagnostic
        with content type, byte length and a printable-ASCII body snippet.
        Non-string envelope members are treated as absent.
        """
        raw = {"requestId": "", "errorCode": "", "errorMessage": ""}
        try:
            parsed = json.loads(body.decode("utf-8", errors="replace"))
        except Exception:  # noqa: BLE001 - deliberate fail-safe parse
            parsed = None
        if isinstance(parsed, dict):
            for key in raw:
                if isinstance(parsed.get(key), str):
                    raw[key] = parsed[key]
        err = cls(
            status_code=status_code,
            request_id=_sanitize(raw["requestId"]) or None,
            error_code=_sanitize(raw["errorCode"]) or None,
            error_message=_sanitize(raw["errorMessage"]) or None,
        )
        if not any(raw.values()):
            err.error_message = (
                f"unparseable error body ({len(body)} bytes, "
                f"content-type {content_type!r}): "
                f"{_ascii_snippet(body.decode('utf-8', errors='replace'))!r}"
            )
        return err
