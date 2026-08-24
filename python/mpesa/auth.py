"""OAuth token caching with generation-guarded refresh
(mirrors go/client.go token-cache semantics; rules in docs/apis/oauth.md).

Daraja invalidates ALL outstanding tokens whenever any app mints a new
one (TTL ~3600s). This manager caches one bearer per process, refreshes
eagerly before expiry, and resolves 401.003.01 through a generation
counter so concurrent callers never stampede the OAuth endpoint across
replicas. The documented pairing primitive for 401 recovery is
:meth:`TokenManager.get_token_with_gen`.

Example::

    tm = TokenManager(session, base_url=cfg.base_url,
                      consumer_key=cfg.consumer_key,
                      consumer_secret=cfg.consumer_secret)
    token, gen = tm.get_token_with_gen()          # paired snapshot
    ...
    token = tm.refresh_after_invalid_token(gen)   # on 401.003.01
"""

from __future__ import annotations

import base64
import json
import threading
from datetime import datetime, timedelta, timezone
from typing import Callable

import requests

from .exceptions import MpesaError
from .responses import OAuthToken

__all__ = ["TokenManager"]

_OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials"
_CREDENTIALS_MSG = ("mpesa: Config.consumer_key and Config.consumer_secret "
                    "are required before calling any endpoint")
# Local mirror of client._MAX_RESPONSE_BYTES: importing it would create a
# circular import (client.py already imports TokenManager from this module).
_MAX_BODY_CHARS = 1_048_576


class TokenManager:
    """Concurrency-safe bearer cache for one Daraja environment.

    The caller owns ``session`` (the Client passes its hardened
    session); ``timeout`` feeds every OAuth GET; ``now`` injects a UTC
    clock for tests.

    Example::

        tm = TokenManager(session, base_url, key, secret)
        tok, gen = tm.get_token_with_gen()
    """

    def __init__(self, session: requests.Session, base_url: str,
                 consumer_key: str, consumer_secret: str,
                 now: Callable[[], datetime] | None = None,
                 timeout: float = 30.0) -> None:
        if ":" in consumer_key:
            raise ValueError("mpesa: consumer_key must not contain ':'")
        if not (consumer_key + consumer_secret).isascii():
            raise ValueError("mpesa: credentials must be ASCII")
        self._session = session
        self._base_url = base_url.rstrip("/")
        self._consumer_key = consumer_key
        self._consumer_secret = consumer_secret
        self._timeout = float(timeout)
        self._now: Callable[[], datetime] = now or (
            lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at: datetime | None = None
        self._gen = 0

    def get_token(self) -> str:
        """Valid cached bearer, refreshing single-flight when stale."""
        return self.get_token_with_gen()[0]

    def get_token_with_gen(self) -> "tuple[str, int]":
        """Return ``(token, gen)`` from ONE coherent snapshot.

        Fast path snapshots under the lock and returns immediately when
        fresh WITHOUT performing any state mutation (double-checked
        pattern); stale callers re-acquire for the single-flight refresh,
        whose recheck keeps concurrent refetches at exactly one.

        Example::

            token, gen = tm.get_token_with_gen()
        """
        now = self._now()
        with self._lock:
            if self._token and self._expires_at and now < self._expires_at:
                return self._token, self._gen
            return self._refresh_locked(), self._gen

    def refresh_after_invalid_token(self, my_gen: int) -> str:
        """Resolve a 401.003.01 under the generation guard.

        If OUR view was current when it failed (``_gen`` unchanged), we
        clear the token and lead the hard refresh -- a Daraja-invalidated
        but clock-fresh token must never stay servable. Otherwise a peer
        already refreshed and we adopt its token, but ONLY while it is
        still wall-clock fresh (intentional deviation from go/client.go:
        Go trusts the peer unconditionally; an expired adopt would hand
        back a dead bearer).

        Example::

            token = tm.refresh_after_invalid_token(gen)
        """
        with self._lock:
            if self._gen == my_gen:
                self._token = None          # forceRefreshLocked parity
                return self._refresh_locked()
            now = self._now()
            if self._token and self._expires_at and now < self._expires_at:
                return self._token
            return self._refresh_locked()

    @staticmethod
    def _cadence(expires_in_seconds: int | None) -> float:
        """Eager window: TTL minus 60s safety, clamped to [1s, 3000s];
        unknown/zero TTL falls back to the legacy 3000s cadence."""
        seconds = expires_in_seconds or 0
        if seconds <= 0:
            return 3000.0
        return max(1.0, min(seconds - 60, 3000))

    def _refresh_locked(self) -> str:
        """Hard OAuth round-trip against
        ``{base}/oauth/v1/generate?grant_type=client_credentials``
        (docs/apis/oauth.md). Holds the write lock across the network
        call -- callers stall ~once per refresh window; that is the
        deliberate single-flight tradeoff (see go/client.go).
        """
        if not self._consumer_key or not self._consumer_secret:
            raise ValueError(_CREDENTIALS_MSG)
        auth = base64.b64encode(
            f"{self._consumer_key}:{self._consumer_secret}".encode("latin-1"))
        response = self._session.get(
            f"{self._base_url}{_OAUTH_PATH}", timeout=self._timeout,
            headers={"Authorization": f"Basic {auth.decode('ascii')}"},
            allow_redirects=False, stream=True)
        # Bounded streaming read (Go LimitReader parity with
        # client._send): cap the DECOMPRESSED byte count during transfer
        # via iter_content(MAX+1) so a gzip bomb aborts mid-stream instead
        # of being fully materialised by a pre-read .content.
        chunks: list[bytes] = []
        total = 0
        for chunk in response.iter_content(_MAX_BODY_CHARS + 1):
            chunks.append(chunk)
            total += len(chunk)
            if total > _MAX_BODY_CHARS:
                raise ValueError(
                    f"mpesa: oauth/v1/generate response exceeds "
                    f"{_MAX_BODY_CHARS} bytes")
        body = b"".join(chunks)
        if not 200 <= response.status_code <= 299:
            content_type = response.headers.get("content-type", "")
            raise MpesaError.from_response(
                response.status_code, body, content_type)
        try:
            payload = json.loads(body)
        except Exception as exc:  # noqa: BLE001 - wrap any decoder blow-up
            raise ValueError(f"mpesa: decode oauth response: {exc}") from exc
        token_response = OAuthToken.from_json(payload)
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
