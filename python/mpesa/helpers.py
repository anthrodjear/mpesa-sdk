"""Runtime verification helpers (mirrors go/helpers.go, hardening included).

* :func:`generate_password` -- STK Push/Query Password + Timestamp from a
  SINGLE instant; the pair must travel together or Safaricom rejects the
  request with intermittent ``500.001.1001`` (the two-clock bug,
  docs/apis/stk-push.md). EAT rendering per docs/apis/getting-started.md.
* :func:`normalize_phone` -- Kenyan MSISDN shorthand to gateway form.
* :func:`security_credential` -- RSA PKCS#1 v1.5 encryption of the
  initiator password with the M-Pesa public-key certificate
  (docs/apis/getting-started.md algorithm). Validity dates are
  deliberately NEVER checked: official certs ship long-expired by design.
* :func:`new_originator_id` -- idempotency key for async APIs (<20 chars).
"""

from __future__ import annotations

import base64
import re
import secrets
from datetime import datetime, timedelta, timezone

from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509 import load_der_x509_certificate, load_pem_x509_certificate

__all__ = [
    "EAT",
    "generate_password",
    "normalize_phone",
    "security_credential",
    "new_originator_id",
]

EAT = timezone(timedelta(hours=3))
"""East Africa Time (UTC+3), fixed offset -- no tzdata dependency."""

_PHONE_RE = re.compile(r"^254[17]\d{8}$")
_MAX_MSISDN_INPUT = 32


def generate_password(shortcode: str, passkey: str, at: datetime) -> tuple[str, str]:
    """Return ``(password, timestamp)`` derived from one instant.

    The timestamp is rendered in EAT as ``YYYYMMDDHHmmss`` and MUST be
    sent verbatim beside the password; deriving them separately causes
    intermittent ``500.001.1001`` (two-clock bug). Naive datetimes are
    rejected -- an unzoned clock silently shifts by three hours.

    Golden example::

        at = datetime(2021, 6, 28, 9, 24, 8, tzinfo=timezone.utc)
        generate_password("174379", "<sandbox passkey>", at)
        # -> ("MTc0Mzc5...MTIyNDA4", "20210628122408")   # note +3h EAT

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

    Accepts ``07XXXXXXXX``, ``+2547...``, ``2547...`` (or ``2541...``).
    Edge whitespace is trimmed; spaces/dashes/parentheses are stripped
    MID-STRING too, not only at edges ("0723 456 789" normalizes fine).
    Inputs over 32 chars fail fast before any stripping.

    Raises:
        ValueError: on overlong input or a non-matching final shape.
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

    PEM or raw DER accepted. Certificate validity dates are deliberately
    NOT verified -- official certs ship long-expired by design. Error
    messages never include password or certificate material.

    Raises:
        ValueError: empty/whitespace password (checked before parsing),
            unparseable certificate, or non-RSA public key.
    """
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
    ciphertext = public_key.encrypt(initiator_password.encode(), padding.PKCS1v15())
    return base64.b64encode(ciphertext).decode()


def new_originator_id() -> str:
    """Mint a 16-hex-char idempotency key (Daraja limit <20 chars).

    Uses ``secrets`` OS entropy with NO predictable fallback.
    """
    return secrets.token_hex(8)
