"""Shared ingestion and streaming guards (single source of truth).

Every Daraja-facing reader in this package enforces the SAME 1 MiB bound
(Go ``maxResponseLen`` / TS ``MAX_RESPONSE_LEN`` parity):

* :data:`MAX_BODY_BYTES` -- the cap, measured in BYTES, not characters.
  A ``str`` body of 1M CJK characters is ~3 MiB on the wire and must not
  bypass a char-count check, so :func:`check_body_size` measures ``str``
  input as ``len(data.encode("utf-8"))`` while ``bytes``/``bytearray``
  input is measured directly.
* :func:`check_body_size` -- pre-parse gate used by the callback, result
  and sync-response models before ``json.loads``.
* :func:`read_capped` (alias :func:`_read_capped`) -- bounded streaming
  reader shared by ``auth.TokenManager._refresh_locked`` and
  ``client.MpesaClient._send`` (previously near-identical ``iter_content``
  cap loops in both places). Reads at most ``MAX_BODY_BYTES + 1`` bytes
  via ``iter_content`` -- Go ``LimitReader`` parity -- so a gzip bomb
  aborts mid-stream instead of being fully materialised by a pre-read
  ``.content`` access. The socket is released in ``finally`` so abort
  paths never leak connections.

Usage::

    from ._limits import MAX_BODY_BYTES, check_body_size, read_capped

    check_body_size(raw, "callback body")   # raises ValueError when over cap
    body = read_capped(response, "oauth/v1/generate response")
"""

from __future__ import annotations

from typing import Any

__all__ = ["MAX_BODY_BYTES", "check_body_size", "read_capped", "_read_capped"]

#: Ingestion cap in BYTES (Go maxResponseLen / TS MAX_RESPONSE_LEN parity).
MAX_BODY_BYTES = 1_048_576


def check_body_size(data: "bytes | bytearray | str",
                    label: str = "response body") -> None:
    """Reject bodies over :data:`MAX_BODY_BYTES`, measured in UTF-8 bytes.

    ``bytes``/``bytearray`` input is measured directly; ``str`` input is
    measured as ``len(data.encode("utf-8"))`` so multi-byte payloads
    (e.g. 400k CJK chars ~= 1.2 MiB) cannot smuggle up to 4x the intended
    bound past a char-count check. Anything else (already-decoded dicts)
    is unchecked -- the gate only applies to raw wire bodies.

    Args:
        data: Raw wire body (bytes, bytearray or str).
        label: Human context interpolated into the error, e.g.
            ``"callback body"`` or ``"STKPushResponse response"``.

    Raises:
        ValueError: if the byte size exceeds :data:`MAX_BODY_BYTES`.

    Example::

        check_body_size(raw, "callback body")
    """
    if isinstance(data, (bytes, bytearray)):
        size = len(data)
    elif isinstance(data, str):
        size = len(data.encode("utf-8"))
    else:  # decoded dicts carry no wire size: nothing to gate.
        return
    if size > MAX_BODY_BYTES:
        raise ValueError(
            f"mpesa: {label} exceeds {MAX_BODY_BYTES} bytes")


def read_capped(response: Any, label: str) -> bytes:
    """Stream at most ``MAX_BODY_BYTES + 1`` bytes from *response*.

    The shared bounded reader for the OAuth leg (auth.py) and the
    business leg (client.py): accumulates ``iter_content`` chunks,
    aborts with ``ValueError`` the moment the total passes the cap
    (BEFORE any ``json`` parse, so oversize bodies never reach the
    decoder), and always releases the connection via ``response.close()``
    in ``finally`` -- including the abort path.

    Plain ``bytes`` are returned instead of the ``Response`` because
    ``requests.Response.content`` is a getter-only property; callers must
    read status/headers off *response* themselves (safe after close --
    they are already materialised).

    Args:
        response: Streamed HTTP response exposing ``iter_content`` and
            ``close`` (real ``requests.Response`` or a duck-typed fake).
        label: Endpoint context for the oversize error, e.g.
            ``"oauth/v1/generate response"`` or ``"/mpesa/stkpush/..."``.

    Raises:
        ValueError: if the streamed body exceeds :data:`MAX_BODY_BYTES`.

    Example::

        body = read_capped(response, "oauth/v1/generate response")
    """
    chunks: list[bytes] = []
    total = 0
    try:
        for chunk in response.iter_content(MAX_BODY_BYTES + 1):
            chunks.append(chunk)
            total += len(chunk)
            if total > MAX_BODY_BYTES:
                raise ValueError(
                    f"mpesa: {label} exceeds {MAX_BODY_BYTES} bytes")
    finally:
        response.close()
    return b"".join(chunks)


#: Back-compat alias: the task-level name for the shared streaming reader.
_read_capped = read_capped
