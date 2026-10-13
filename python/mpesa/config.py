"""Client configuration with credential-safe rendering (mirrors go/config.go).

``Config`` carries live Daraja credentials, so its text form can never
leak them: ``__repr__`` and ``__str__`` route through one redacted
renderer -- mirroring Go's ``Format`` hook that captures every fmt verb::

    from mpesa.config import Config

    cfg = Config(consumer_key="k", consumer_secret="s",
                 shortcode="174379", passkey="pk")
    cfg.validate_credentials()          # actionable error if incomplete
    print(f"{cfg}")                     # ... secrets=REDACTED
    client.log(json.dumps(cfg.log_safe()))   # structured-safe dict

BOUNDARY (stdlib design, documented): text redaction is not object
sanitization -- ``dataclasses.asdict``/``astuple``/``vars()`` return raw
secrets, and pickle/json of a Config embed credentials verbatim. Use
:meth:`Config.log_safe` for logging surfaces.

Environment-variable wiring belongs to the Client layer -- see the
client docs when they land; this module stays single-responsibility.
"""

from __future__ import annotations

import re
import warnings
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

import requests

from .enums import Environment
from .limits import TransactionLimits

__all__ = ["Config"]


def _mask_credential(value: str) -> str:
    """Mask a credential to first-4/last-4 (Go/TS ``maskCredential`` parity).

    Go (``go/config.go``) renders ``first4…last4`` with U+2026 for values
    of 9+ runes, a same-length ``"*"`` run for 1-7 runes, and ``""`` for
    empty (empty itself is the diagnostic). TypeScript
    (``typescript/src/config.ts``) collapses 1-8 chars to fixed ``"****"``
    and uses ASCII ``"..."`` for long values. This follows Go exactly
    except for length 8, where first-4/last-4 would reveal the whole key
    (4+4 == 8): that case collapses to ``"****"`` (TS parity, intentional
    hardening over Go) so no rendering ever carries the full key.
    """
    if not value:
        return ""
    if len(value) < 8:
        return "*" * len(value)
    if len(value) == 8:
        return "****"
    return f"{value[:4]}\u2026{value[-4:]}"


@dataclass(frozen=True)
class Config:
    """Immutable settings for a Daraja :class:`~mpesa.client.MpesaClient`.

    Attributes mirror go/config.go: ``now`` injects a clock for tests
    (clients fall back to ``datetime.now(timezone.utc)`` when None);
    ``http_client`` injects a custom ``requests.Session`` (proxies,
    tracing) -- it is cloned, never mutated, and always inherits the
    SDK's no-redirects policy; ``limits`` overrides the documented
    per-service amount ceilings (``None`` keeps
    :data:`~mpesa.limits.DEFAULT_TRANSACTION_LIMITS`) and ``track_daily``
    turns on the opt-in per-process daily accumulator.

    WARNING: a Client clones injected sessions and FORCES ``verify=True``
    before use; disabling TLS verification on the injected object only
    triggers a loud warning here, never insecure requests downstream.
    """

    consumer_key: str = ""
    consumer_secret: str = ""
    shortcode: str = ""
    passkey: str = ""
    environment: Environment = Environment.SANDBOX
    timeout_seconds: float = 30.0
    now: Optional[Callable[[], datetime]] = None
    http_client: Optional[requests.Session] = None
    #: PARTIAL per-service amount bounds. ``None`` means the documented
    #: :data:`~mpesa.limits.DEFAULT_TRANSACTION_LIMITS` baseline; a supplied
    #: :class:`~mpesa.limits.TransactionLimits` is merged per field onto
    #: that baseline, so only the services you name change.
    limits: Optional[TransactionLimits] = None
    #: Opt-in per-process daily accumulation (``max_per_day``). Off by default
    #: because one process cannot observe the other replicas sharing this
    #: shortcode, so a local counter under-counts and must never be treated
    #: as a platform-wide gate.
    track_daily: bool = False

    def __post_init__(self) -> None:
        # Fail fast on credential SHAPE (Go config.go Validate() parity):
        # a ':' in consumer_key would split the "key:secret" Basic-auth
        # pair ambiguously at the gateway or a forward proxy, and non-ASCII
        # bytes cannot round-trip the latin-1 Basic-auth encoding -- both
        # are rejected here at construction instead of surfacing late as an
        # OAuth 400. Empty credentials stay legal here (validate_credentials
        # gates them before any endpoint call) so zero-config construction
        # for offline model tests keeps working.
        if ":" in self.consumer_key:
            raise ValueError(
                "mpesa: Config.consumer_key must not contain ':' "
                "(Basic-auth separator)")
        if not (self.consumer_key + self.consumer_secret).isascii():
            raise ValueError(
                "mpesa: Config.consumer_key and Config.consumer_secret "
                "must be ASCII")
        if self.now is not None and not callable(self.now):
            raise TypeError("mpesa: Config.now must be callable or None")
        if self.limits is not None and not isinstance(self.limits,
                                                     TransactionLimits):
            raise TypeError("mpesa: Config.limits must be a TransactionLimits "
                            "or None (see mpesa.limits)")
        # Explicit bool check, not isdigit-style truthiness: ``1`` passed a
        # truthiness test once and silently enabled the daily accumulator.
        if not isinstance(self.track_daily, bool):
            raise TypeError("mpesa: Config.track_daily must be a bool")
        if getattr(self.http_client, "verify", True) is not True:
            warnings.warn(
                "TLS verification disabled on injected session -- Client will refuse",
                UserWarning,
                stacklevel=2,
            )
        # ASCII-only digit class, mirroring helpers.py's re.ASCII discipline:
        # bare \d also matches Unicode Nd digits ("١٢٣٤٥" are Nd), and a
        # shortcode is a shortcode on the wire, never an exotic-script one.
        if self.shortcode and not re.fullmatch(r"[0-9]{5,10}", self.shortcode):
            raise ValueError(
                f"mpesa: Config.shortcode must be 5-10 digits, "
                f"got {self.shortcode!r}"
            )

    @property
    def base_url(self) -> str:
        """Platform root for the configured environment."""
        return self.environment.base_url

    def log_safe(self) -> dict:
        """Secret-free dict for structured logging: shortcode/environment/timeout."""
        return {
            "shortcode": self.shortcode,
            "environment": self.environment.name,
            "timeout_seconds": self.timeout_seconds,
        }

    def _redacted(self) -> str:
        """Single renderer for repr/str -- the only safe text form.

        ``consumer_key`` renders MASKED (first-4/last-4 via
        :func:`_mask_credential`); ``consumer_secret`` and ``passkey``
        never render at all. SECURITY.md treats the key like a password:
        it authenticates every OAuth token request, so cleartext in logs,
        APM traces or crash dumps outlives the process.
        """
        return (
            f"mpesa.Config(consumer_key={_mask_credential(self.consumer_key)!r}, "
            f"shortcode={self.shortcode!r}, "
            f"environment=Environment.{self.environment.name}, "
            f"timeout_seconds={self.timeout_seconds!r}, secrets=REDACTED)"
        )

    def __repr__(self) -> str:
        return self._redacted()

    def __str__(self) -> str:
        return self._redacted()

    def validate_credentials(self) -> None:
        """Raise an actionable error unless both OAuth credentials are set."""
        if not self.consumer_key or not self.consumer_secret:
            raise ValueError(
                "mpesa: Config.consumer_key and Config.consumer_secret "
                "are required before calling any endpoint"
            )
