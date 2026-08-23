"""OAuth token caching with generation-guarded refresh
(mirrors go/client.go token-cache semantics; rules in docs/apis/oauth.md).

Daraja invalidates ALL outstanding tokens whenever any app mints a new
one, and the TTL is ~3600s. A single process therefore caches one bearer,
refreshes eagerly before expiry, and resolves 401.003.01 through a
generation counter so concurrent callers never stampede the OAuth
endpoint across replicas.

Usage::

    tm = TokenManager(session, base_url=cfg.base_url,
                      consumer_key=cfg.consumer_key,
                      consumer_secret=cfg.consumer_secret)
    tok = tm.get_token()                       # cached or single-flight
    ...
    tok = tm.refresh_after_invalid_token(my_gen)   # on 401.003.01
"""

from __future__ import annotations

import base64
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import requests

from .exceptions import MpesaError
from .responses import OAuthToken

__all__ = ["TokenManager"]

_OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials"
_CREDENTIALS_MSG = ("mpesa: Config.consumer_key and Config.consumer_secret "
                    "are required before calling any endpoint")


class TokenManager:
    """Concurrency-safe bearer cache for one Daraja environment.

    The caller owns ``session`` (the Client passes its hardened session);
    ``now`` injects a UTC clock for tests. State is guarded by a plain
    :class:`threading.Lock`.
    """

    def __init__(self, session: requests.Session, base_url: str,
                 consumer_key: str, consumer_secret: str,
                 now: Callable[[], datetime] | None = None) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._consumer_key = consumer_key
        self._consumer_secret = consumer_secret
        self._now: Callable[[], datetime] = now or (
            lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at: datetime | None = None
        self._gen = 0

    def get_token(self) -> str:
        """Return a valid cached bearer, refreshing single-flight if stale."""
        with self._lock:
            now = self._now()
            if self._token and self._expires_at and now < self._expires_at:
                return self._token
            return self._refresh_locked()

    def refresh_after_invalid_token(self, my_gen: int) -> str:
        """Resolve a 401.003.01 under the generation guard.

        If OUR view was current when it failed (``_gen`` unchanged), we
        lead the hard refresh; otherwise a peer already refreshed and we
        adopt its token -- this invalidate-on-new-token design (oauth.md)
        would otherwise thrash every replica into an OAuth round-trip.
        """
        with self._lock:
            if self._gen == my_gen:
                return self._refresh_locked()
            assert self._token is not None
            return self._token

    @staticmethod
    def _cadence(expires_in_seconds: int | None) -> float:
        """Eager window: TTL minus 60s safety, clamped to [1s, 3000s];
        unknown/zero TTL falls back to the legacy 3000s cadence."""
        seconds = expires_in_seconds or 0
        if seconds <= 0:
            return 3000.0
        return max(1.0, min(seconds - 60, 3000))

    def _refresh_locked(self) -> str:
        """Hard OAuth round-trip; caller must hold the lock. Credentials
        are validated BEFORE any network I/O."""
        if not self._consumer_key or not self._consumer_secret:
            raise ValueError(_CREDENTIALS_MSG)
        auth = base64.b64encode(
            f"{self._consumer_key}:{self._consumer_secret}".encode()).decode()
        response = self._session.get(
            f"{self._base_url}{_OAUTH_PATH}", timeout=30.0,
            headers={"Authorization": f"Basic {auth}"})
        if not 200 <= response.status_code <= 299:
            raise MpesaError.from_response(
                response.status_code, response.content,
                getattr(response.headers, "get", lambda *_: "")(
                    "content-type"))
        token_response = OAuthToken.from_json(response.json())
        if not token_response.access_token:
            raise ValueError("mpesa: oauth response missing access_token")
        now = self._now()
        self._token = token_response.access_token
        self._expires_at = now + timedelta(
            seconds=self._cadence(token_response.expires_in_seconds))
        self._gen += 1
        return self._token

    @property
    def generation(self) -> int:
        """Current generation counter (test/introspection seam)."""
        return self._gen

    def __repr__(self) -> str:
        """Credential-safe: never renders the bearer value."""
        return (f"TokenManager(gen={self._gen}, "
                f"cached={self._token is not None})")
