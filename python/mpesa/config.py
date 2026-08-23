"""Client configuration with credential-safe rendering (mirrors go/config.go).

``Config`` carries live Daraja credentials, so its text form can never
leak them: both ``__repr__`` and ``__str__`` route through one redacted
renderer -- mirroring Go's ``Format`` hook that captures every fmt verb,
not just ``%#v``. Log lines, tracebacks and f-strings are safe by
construction::

    from mpesa.config import Config

    cfg = Config(consumer_key="k", consumer_secret="s",
                 shortcode="174379", passkey="pk")
    cfg.validate_credentials()          # actionable error if incomplete
    print(f"{cfg}")                     # ... secrets=REDACTED

Environment-variable wiring belongs to the Client layer -- see the
client docs when they land; this module stays single-responsibility.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

import requests

from .enums import Environment

__all__ = ["Config"]


@dataclass(frozen=True)
class Config:
    """Immutable settings for a Daraja :class:`~mpesa.client.Client`.

    Attributes map 1:1 onto go/config.go: ``now`` may inject a clock for
    tests (clients fall back to ``datetime.now(timezone.utc)`` when
    ``None``); ``http_client`` may inject a custom ``requests.Session``
    (proxies, tracing) -- it is cloned, never mutated, and always
    inherits the SDK's no-redirects policy. Frozen so a configured
    snapshot cannot drift underneath an in-flight request;
    :func:`dataclasses.replace` derives modified copies safely.
    """

    consumer_key: str = ""
    consumer_secret: str = ""
    shortcode: str = ""
    passkey: str = ""
    environment: Environment = Environment.SANDBOX
    timeout_seconds: float = 30.0
    now: Callable[[], datetime] | None = None
    http_client: requests.Session | None = None

    @property
    def base_url(self) -> str:
        """Platform root for the configured environment."""
        return self.environment.base_url

    def _redacted(self) -> str:
        """Single renderer for repr/str -- the only text form that escapes."""
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


_UTC_NOW: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
"""Default clock applied at client use when ``Config.now`` is None."""
