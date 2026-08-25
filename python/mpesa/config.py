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
from datetime import datetime, timezone
from typing import Callable, Optional

import requests

from .enums import Environment

__all__ = ["Config"]


@dataclass(frozen=True)
class Config:
    """Immutable settings for a Daraja :class:`~mpesa.client.MpesaClient`.

    Attributes mirror go/config.go: ``now`` injects a clock for tests
    (clients fall back to ``datetime.now(timezone.utc)`` when None);
    ``http_client`` injects a custom ``requests.Session`` (proxies,
    tracing) -- it is cloned, never mutated, and always inherits the
    SDK's no-redirects policy.

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

    def __post_init__(self) -> None:
        if self.now is not None and not callable(self.now):
            raise TypeError("mpesa: Config.now must be callable or None")
        if getattr(self.http_client, "verify", True) is not True:
            warnings.warn(
                "TLS verification disabled on injected session -- Client will refuse",
                UserWarning,
                stacklevel=2,
            )
        if self.shortcode and not re.fullmatch(r"\d{5,10}", self.shortcode):
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
        """Single renderer for repr/str -- the only safe text form."""
        return (
            f"mpesa.Config(consumer_key={self.consumer_key!r}, "
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
