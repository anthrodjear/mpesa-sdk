"""Runtime verification helpers (mirrors go/helpers.go, hardening included).

* :func:`generate_password` -- STK Push/Query Password + Timestamp from
  a SINGLE instant; split clocks trigger intermittent ``500.001.1001``
  (two-clock bug, docs/apis/stk-push.md). EAT per getting-started.md.
* :func:`normalize_phone` -- Kenyan MSISDN shorthand to gateway form.
* :func:`security_credential` -- RSA PKCS#1 v1.5 of the initiator
  password with the M-Pesa cert (docs/apis/getting-started.md); validity
  dates NEVER checked (official certs ship long-expired by design).
* :func:`new_originator_id` -- idempotency key for async APIs (<20 chars).
"""

from __future__ import annotations

import base64
import re
import secrets
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509 import load_der_x509_certificate, load_pem_x509_certificate

__all__ = ["EAT", "generate_password", "normalize_phone", "security_credential",
           "new_originator_id"]

EAT = timezone(timedelta(hours=3))  # UTC+3 fixed offset -- no tzdata dep

_PHONE_RE = re.compile(r"^254[17]\d{8}$", re.ASCII)  # ASCII: \d must not
# match Unicode Nd digits ("٣") -- Go RE2 rejects them; so must we.
_MAX_MSISDN_INPUT = 32


def generate_password(shortcode: str, passkey: str, at: datetime) -> tuple[str, str]:
    """Return ``(password, timestamp)`` derived from one instant.

    Timestamp renders in EAT as ``YYYYMMDDHHmmss`` (microseconds truncated)
    and MUST travel verbatim beside the password -- split clocks cause
    intermittent ``500.001.1001`` (two-clock bug). Naive datetimes are
    rejected: unzoned clocks silently shift by three hours.

    Golden example (2021-06-28T09:24:08Z -> EAT "20210628122408")::

        generate_password("174379", "<passkey>",
                          datetime(2021, 6, 28, 9, 24, 8, tzinfo=timezone.utc))
        # -> ("MTc0Mzc5...MTIyNDA4", "20210628122408")

    Raises:
        ValueError: if *at* is naive.
    """
    if at.tzinfo is None:
        raise ValueError("mpesa: timestamp must be timezone-aware")
    timestamp = at.astimezone(EAT).strftime("%Y%m%d%H%M%S")
    password = base64.b64encode((shortcode + passkey + timestamp).encode()).decode()
    return password, timestamp


def normalize_phone(raw: str) -> str:
    """Convert Kenyan MSISDN shorthand to gateway form ``2547XXXXXXXX``.

    Accepts ``07XXXXXXXX``, ``+2547...``, ``2547...``/``2541...``. Edge
    whitespace trimmed; spaces/dashes/parentheses stripped MID-STRING too
    ("0723 456 789" normalizes). Inputs over 32 chars fail fast first.

    Example::

        normalize_phone("+254 712-345-678")  # -> "254712345678"
        normalize_phone("0723 456 789")      # mid-string spaces stripped too

    Raises:
        ValueError: overlong input or non-matching final shape (incl.
            non-ASCII digit look-alikes, rejected like Go RE2).
    """
    if len(raw) > _MAX_MSISDN_INPUT:
        raise ValueError("mpesa: input too long for a Kenyan MSISDN")
    stripped = raw.strip()
    for junk in (" ", "-", "(", ")"):
        stripped = stripped.replace(junk, "")
    if stripped.startswith("+254"):
        stripped = stripped[1:]
    elif stripped.startswith("0"):
        stripped = "254" + stripped[1:]
    if not _PHONE_RE.fullmatch(stripped):
        raise ValueError(
            f"mpesa: {raw!r} is not a valid Kenyan MSISDN "
            "(want 07XX/+2547XX/2547XX)"
        )
    return stripped


def security_credential(cert_pem_or_der: bytes, initiator_password: str) -> str:
    """RSA-encrypt *initiator_password* with the M-Pesa cert; base64 out.

    PEM or raw DER accepted; validity dates deliberately NOT verified
    (official certs ship long-expired). PEM parsing scans past
    non-CERTIFICATE blocks -- private-key-block-first input is accepted
    here where Go's first-block ``pem.Decode`` would reject it:
    intentional divergence, only the certificate reaches key handling.
    Errors never include password/cert material.

    Example::

        payload["SecurityCredential"] = security_credential(cert_bytes, pw)

    Raises:
        TypeError: cert_pem_or_der not bytes/bytearray.
        ValueError: empty password (checked before parsing), unparseable
            cert, non-RSA key, or >245-byte password (PKCS#1 block limit).
    """
    if not isinstance(cert_pem_or_der, (bytes, bytearray)):
        raise TypeError("mpesa: cert_pem_or_der must be bytes (PEM or DER)")
    if not initiator_password.strip():
        raise ValueError("mpesa: initiator_password is required")
    try:
        try:
            cert = load_pem_x509_certificate(cert_pem_or_der)
        except ValueError:
            cert = load_der_x509_certificate(cert_pem_or_der)
    except ValueError as exc:
        raise ValueError(f"mpesa: parse M-Pesa certificate ({type(exc).__name__})") from None
    public_key = cert.public_key()
    if not isinstance(public_key, rsa.RSAPublicKey):
        raise ValueError("mpesa: M-Pesa certificate carries non-RSA public key")
    try:
        ciphertext = public_key.encrypt(initiator_password.encode(), padding.PKCS1v15())
    except ValueError as exc:
        raise ValueError(f"mpesa: encrypt security credential ({type(exc).__name__})") from None
    return base64.b64encode(ciphertext).decode()


def new_originator_id() -> str:
    """Mint a 16-hex-char idempotency key (Daraja limit <20 chars).

    Uses ``secrets`` OS entropy with NO predictable fallback.

    Example::

        payload["OriginatorConversationID"] = new_originator_id()
    """
    return secrets.token_hex(8)
