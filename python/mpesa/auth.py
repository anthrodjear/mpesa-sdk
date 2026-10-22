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
import warnings
from datetime import datetime, timedelta, timezone
from typing import Callable

import requests

from ._limits import MAX_BODY_BYTES as _MAX_BODY_BYTES
from ._limits import read_capped
from .exceptions import MpesaError, RefreshRateLimitedError
from .responses import OAuthToken

__all__ = ["TokenManager"]

_OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials"
_CREDENTIALS_MSG = ("mpesa: Config.consumer_key and Config.consumer_secret "
                    "are required before calling any endpoint")
# Back-compat alias: the historic name for the ingestion cap. New code uses
# _MAX_BODY_BYTES (imported from mpesa._limits, the single source of truth).
_MAX_BODY_CHARS = _MAX_BODY_BYTES
#: OAuth refresh rate-limit parity with go/client.go (`refreshRateLimit` +
#: `refreshFailures` guard): after this many consecutive failures, non-forced
#: refreshes are throttled for ``_REFRESH_RATE_LIMIT_SECONDS``.
_REFRESH_FAILURE_THRESHOLD = 3
_REFRESH_RATE_LIMIT_SECONDS = 5.0
#: Daraja hosts this manager is willing to mint tokens against. The
#: base_url MUST arrive from trusted config (Config.environment.base_url)
#: -- never from user input -- so an attacker host can neither harvest the
#: Basic-auth credential nor receive it via redirect (redirects are refused
#: on every OAuth GET anyway). Trailing slashes are stripped before the
#: membership test.
_TRUSTED_BASE_URLS = frozenset({
    "https://sandbox.safaricom.co.ke",
    "https://api.safaricom.co.ke",
})
#: How long a waiter parks on the refresh condition before it re-checks
#: the cache. The wait is BOUNDED so that a lost notification -- or a
#: leader that never returns -- cannot park a caller forever: the waiter
#: simply re-evaluates and becomes the next leader if the cache is still
#: stale. The leader's own completion wakes every waiter immediately, so
#: this slice is a safety net, not the normal latency.
_REFRESH_WAIT_SECONDS = 5.0


def _fresh_error(exc: BaseException) -> BaseException:
    """A FRESH exception instance carrying the same type and message.

    WHY: the leader's exception was raised verbatim by every waiter, so N
    threads raised ONE instance and each raise overwrote its
    ``__traceback__`` -- a caller logging the traceback could see another
    thread's stack. A copy keeps the two things callers branch on (the type
    and the message) while giving every waiter its own object.

    ``MpesaError`` survives the copy: its ``args`` are exactly the four
    envelope members its constructor takes, so ``status_code``,
    ``request_id``, ``error_code`` and ``error_message`` are all preserved.
    The instance attributes are carried over as well, because
    ``MpesaError.from_response`` substitutes the generic message AFTER
    construction (an unparseable body): a copy built from ``args`` alone
    would report a DIFFERENT message than the leader raised.
    """
    try:
        fresh = type(exc)(*exc.args)
    except Exception:  # an exotic exception type: keep the original
        return exc
    fresh.__dict__.update(exc.__dict__)
    return fresh


class _RefreshRound:
    """The outcome of ONE refresh attempt, shared with its waiters.

    WHY: when the leader's OAuth round-trip fails, every waiter must be
    woken with THAT error. Without it each waiter would wake up, find
    the cache still stale and start its OWN OAuth round-trip -- turning
    one failure into N requests against an already-sick endpoint, and
    handing the caller N different error objects to triage. The leader
    publishes the error here; the waiters re-raise it.

    ``forced`` records the MODE the round ran in: a FORCED round (a
    401-triggered refresh, which bypasses the rate-limit gate) or a
    NON-FORCED one (an ordinary staleness refresh, which the gate CAN
    refuse). The two modes have different failure semantics: a forced
    refresher must not inherit a NON-forced round's refusal -- the
    rate-limit refusal is the very denial a forced refresh exists to
    bypass -- while a FORCED round's own failure IS shared with its own
    waiters (the anti-stampede property).
    """

    __slots__ = ("error", "forced")

    def __init__(self, forced: bool = False) -> None:
        self.error: BaseException | None = None
        self.forced = forced


class TokenManager:
    """Concurrency-safe bearer cache for one Daraja environment.

    The caller owns ``session`` (the Client passes its hardened
    session); ``timeout`` feeds every OAuth GET; ``now`` injects a UTC
    clock for tests.

    TRUSTED-CONFIG BOUNDARY: ``base_url`` must come from trusted config
    (``Config.environment.base_url`` -- sandbox or production) and is
    validated against an allowlist at construction, because the OAuth leg
    ships the Basic-auth credential (``consumer_key:consumer_secret``) to
    it. A non-allowlisted host raises ``ValueError`` immediately -- before
    any network use -- so a confused-deputy base URL can never harvest
    credentials. Fakes in tests never hit the network, so they use the
    sandbox host too.

    TLS NOTE (client-only guarantee): this manager never mutates
    ``session.verify`` -- it only warns (``UserWarning``) when handed a
    session with falsy ``verify``, mirroring the ``Config`` TLS-verify
    warning. The TLS guarantee lives in :class:`mpesa.client.MpesaClient`,
    which clones the injected session and forces ``verify=True`` on its
    own clone before any OAuth or business traffic.

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
        normalized = base_url.rstrip("/")
        if normalized not in _TRUSTED_BASE_URLS:
            raise ValueError(
                f"mpesa: refusing untrusted OAuth base_url {base_url!r} "
                "(want https://sandbox.safaricom.co.ke or "
                "https://api.safaricom.co.ke from Config.environment)")
        if not getattr(session, "verify", True):
            warnings.warn(
                "TLS verification disabled on TokenManager session -- "
                "OAuth would ship Basic-auth credentials without "
                "peer verification; pass a verifying session (MpesaClient "
                "forces verify=True on its clone)",
                UserWarning,
                stacklevel=2,
            )
        self._session = session
        self._base_url = normalized
        self._consumer_key = consumer_key
        self._consumer_secret = consumer_secret
        self._timeout = float(timeout)
        self._now: Callable[[], datetime] = now or (
            lambda: datetime.now(timezone.utc))
        self._lock = threading.Lock()
        # The condition is built ON the mutex: waiters park on it (which
        # RELEASES the mutex while they wait) while the elected leader
        # refreshes with NO lock held. Holding the mutex across the OAuth
        # round-trip -- the old behaviour -- froze every thread that
        # needed a token, and every other user of that mutex, for up to
        # the full 30s timeout.
        self._cond = threading.Condition(self._lock)
        self._refreshing = False
        self._round: _RefreshRound | None = None
        self._token: str | None = None
        self._expires_at: datetime | None = None
        self._gen = 0
        self._failures = 0
        self._last_attempt: datetime | None = None

    def get_token(self) -> str:
        """Valid cached bearer, refreshing single-flight when stale."""
        return self.get_token_with_gen()[0]

    def get_token_with_gen(self) -> "tuple[str, int]":
        """Return ``(token, gen)`` from ONE coherent snapshot.

        Single-flight WITHOUT holding the lock across the network: the
        first caller that finds the cache stale becomes the LEADER and
        performs the OAuth round-trip with NO lock held; every other
        caller parks on the condition and re-checks once the leader
        publishes its result (Go ``leadRefresh`` parity).

        WHY the split: the refresh used to run the whole OAuth GET
        inside ``self._lock``, so a slow or hung OAuth endpoint froze
        every thread that needed a token -- and every other user of that
        mutex -- for up to the full 30s timeout, roughly once an hour.

        Example::

            token, gen = tm.get_token_with_gen()
        """
        def recheck() -> "tuple[str, int] | None":
            # Fast path. INVARIANT: refresh_after_invalid_token nulls
            # _token under this same lock BEFORE it claims its round, so
            # the token the gateway just rejected can never be served
            # here while the forced refresh is in flight.
            now = self._now()
            if self._token and self._expires_at and now < self._expires_at:
                return self._token, self._gen
            return None

        return self._single_flight(forced=False, recheck=recheck)

    def refresh_after_invalid_token(self, my_gen: int) -> str:
        """Resolve a 401.003.01 under the generation guard.

        If OUR view was current when it failed (``_gen`` unchanged), we
        clear the token and lead the hard refresh -- a Daraja-invalidated
        but clock-fresh token must never stay servable. Otherwise a peer
        already refreshed and we adopt its token, but ONLY while it is
        still wall-clock fresh (parity with go/client.go
        ``refreshAfterInvalidToken``: Go freshness-gates the peer token
        via ``tokenFresh()`` and force-refreshes when it is stale -- an
        expired adopt would hand back a dead bearer).

        The forced refresh runs OUTSIDE the lock, on the same
        leader/waiter scheme as :meth:`get_token_with_gen`: the leader
        performs the OAuth round-trip with no lock held, and a caller
        that arrives while it is in flight parks on the condition instead
        of issuing a second round-trip.

        FAILURE-SHARING RULE (the two modes are NOT symmetric): a
        FORCED round's failure is shared with its own waiters (one wire
        call, one error -- the anti-stampede property), but a NON-forced
        round's failure is NEVER inherited here. The rate-limit gate
        refuses non-forced refreshes only, so a forced refresher that
        inherited such a refusal would never reach the wire at all: the
        exact denial a forced refresh exists to bypass. When that
        happens the forced caller falls through and leads its OWN forced
        attempt (``force=True`` skips the gate).

        Example::

            token = tm.refresh_after_invalid_token(gen)
        """
        def recheck() -> "tuple[str, int] | None":
            if self._gen != my_gen:
                now = self._now()
                if self._token and self._expires_at and now < self._expires_at:
                    return self._token, self._gen
            else:
                # OUR view is current, so the cached token is the one
                # the gateway rejected: it must not stay servable.
                self._token = None
            return None

        token, _gen = self._single_flight(forced=True, recheck=recheck)
        return token

    def _single_flight(
            self, forced: bool,
            recheck: Callable[[], "tuple[str, int] | None"]) -> "tuple[str, int]":
        """The ONE leader/waiter protocol both refresh entry points share.

        Returns ``(token, gen)``. The caller supplies *recheck*, the
        per-mode fast path: it is called UNDER THE LOCK before every
        attempt and returns the ``(token, gen)`` to hand back, or None to
        continue with the protocol. It may mutate the cache -- the forced
        path drops the rejected token there, BEFORE any round is claimed,
        which is what keeps the rejected-but-fresh token unservable.

        The protocol (identical for both modes):

        1. *recheck* -- adopt a usable token if there is one.
        2. A refresh is in flight: park on the condition (which RELEASES
           the lock while waiting) instead of queueing behind the mutex
           for the whole round-trip. The wait is BOUNDED, so a lost
           notification or a leader that never returns parks nobody
           forever: the waiter re-checks and becomes the next leader.
        3. Otherwise claim the round and leave the lock. The OAuth
           round-trip runs with NO lock held.

        FAILURE-SHARING RULE (the two modes are NOT symmetric): a round's
        failure is shared with the waiters of THAT round -- one wire call,
        one error, no stampede. A FORCED round's failure is therefore
        inherited by a forced waiter, but a NON-forced round's failure is
        NOT: the rate-limit gate refuses non-forced refreshes only, so a
        forced refresher that inherited such a refusal would never reach
        the wire at all -- the exact denial a forced refresh exists to
        bypass. A forced waiter that observed a failed non-forced round
        falls through and leads its OWN forced attempt (``force=True``
        skips the gate).
        """
        while True:
            with self._lock:
                adopted = recheck()
                if adopted is not None:
                    return adopted
                if self._refreshing:
                    # A leader is already refreshing: park on the
                    # condition (which releases the lock while waiting)
                    # instead of queueing behind the mutex for the whole
                    # round-trip.
                    refresh_round = self._round
                    self._cond.wait(timeout=_REFRESH_WAIT_SECONDS)
                    if refresh_round is not None and refresh_round.error is not None:
                        if refresh_round.forced or not forced:
                            # The leader failed: every waiter sees the
                            # SAME error instead of stampeding the OAuth
                            # endpoint. A forced waiter inherits ONLY a
                            # forced round's failure (see the rule above).
                            raise _fresh_error(refresh_round.error)
                    continue
                # Leader: claim the round, then leave the lock. The round
                # records the mode it runs in, because the failure-sharing
                # rule above is mode-dependent.
                self._refreshing = True
                refresh_round = _RefreshRound(forced=forced)
                self._round = refresh_round
            break

        try:
            token = self._refresh(force=forced)
        except BaseException as exc:
            with self._lock:
                refresh_round.error = exc
                self._refreshing = False
                self._cond.notify_all()
            raise
        with self._lock:
            self._refreshing = False
            gen = self._gen
            self._cond.notify_all()
        return token, gen

    @staticmethod
    def _cadence(expires_in_seconds: int | None) -> float:
        """Eager window: TTL minus 60s safety, clamped to [60s, 3000s];
        unknown/zero TTL falls back to the legacy 3000s cadence.

        Parity with TypeScript ``client.ts refreshCadence``: the floor is
        60 seconds, not 1. A token whose TTL is barely above the 60s
        safety margin still gets a full 60s cadence rather than being
        re-requested on nearly every call (the old 1s floor produced
        sub-second refresh storms on short-lived tokens).
        """
        seconds = expires_in_seconds or 0
        if seconds <= 0:
            return 3000.0
        return max(60.0, min(seconds - 60, 3000))

    def _refresh(self, force: bool = False) -> str:
        """Hard OAuth round-trip against
        ``{base}/oauth/v1/generate?grant_type=client_credentials``
        (docs/apis/oauth.md).

        NO lock is held across the network call. The caller (the leader
        elected by :meth:`get_token_with_gen` or
        :meth:`refresh_after_invalid_token`) runs the whole HTTP leg
        here, and every state mutation below is guarded by its own SHORT
        critical section. Holding the mutex across the round-trip --
        the old behaviour -- froze every thread that needed a token for
        up to the full 30s timeout.

        Rate-limit parity with ``go/client.go refreshLocked``: non-forced
        refreshes are throttled after ``_REFRESH_FAILURE_THRESHOLD``
        consecutive failures inside ``_REFRESH_RATE_LIMIT_SECONDS``;
        401-triggered refreshes (``force=True``) bypass the GUARD entirely
        but still advance the attempt clock, so a crash loop of forced
        failures cannot leave ``_last_attempt`` stale and let a later
        non-forced refresh escape the 3-in-5s gate.
        The throttle raises :class:`~mpesa.exceptions.RefreshRateLimitedError`
        -- a typed SDK exception (RuntimeError subclass) instead of a bare
        ``RuntimeError``, so callers can distinguish "Daraja/we are
        throttling YOU" from a programming error without string matching.

        On failure the attempt clock is RE-STAMPED to the current instant
        (Go ``recordRefreshFailure`` parity): the gate above stamps at
        attempt start, but a long OAuth round-trip (timeout, DNS stall)
        means the stamp taken on entry can be seconds old by the time the
        exception arrives. Re-stamping in the ``except`` block keeps the
        3-in-5s window honest against wall-clock drift.
        """
        if not self._consumer_key or not self._consumer_secret:
            raise ValueError(_CREDENTIALS_MSG)
        # Rate limit: only the GUARD is gated on non-forced refreshes
        # (Go `if !force` verbatim); the CLOCK advances on EVERY attempt
        # including forced. A refused (rate-limited) call is not an
        # attempt and leaves the clock untouched. The gate check and the
        # stamp share one short critical section so the decision and the
        # stamp cannot be split by another thread.
        with self._lock:
            now_gate = self._now()
            if not force:
                if (self._failures >= _REFRESH_FAILURE_THRESHOLD
                        and self._last_attempt is not None
                        and (now_gate - self._last_attempt).total_seconds()
                        < _REFRESH_RATE_LIMIT_SECONDS):
                    elapsed = (now_gate - self._last_attempt).total_seconds()
                    raise RefreshRateLimitedError(
                        f"mpesa: refresh rate limited after {self._failures} "
                        f"consecutive failures (last attempt {elapsed:.3f}s "
                        f"ago, need {_REFRESH_RATE_LIMIT_SECONDS:.1f}s)")
            self._last_attempt = now_gate
        try:
            auth = base64.b64encode(
                f"{self._consumer_key}:{self._consumer_secret}".encode("latin-1"))
            # The OAuth leg runs with NO lock held: a hung endpoint must
            # not freeze the token cache for every other thread.
            response = self._session.get(
                f"{self._base_url}{_OAUTH_PATH}", timeout=self._timeout,
                headers={"Authorization": f"Basic {auth.decode('ascii')}"},
                allow_redirects=False, stream=True)
            # Bounded streaming read via the shared mpesa._limits.read_capped
            # (Go LimitReader parity): caps the DECOMPRESSED byte count during
            # transfer via iter_content(MAX+1) so a gzip bomb aborts mid-stream
            # instead of being fully materialised by a pre-read .content. The
            # socket is released in ``finally`` inside read_capped so abort
            # paths never leak it.
            body = read_capped(response, "oauth/v1/generate response")
            if not 200 <= response.status_code <= 299:
                content_type = response.headers.get("content-type", "")
                raise MpesaError.from_response(
                    response.status_code, body, content_type)
            try:
                payload = json.loads(body)
            except Exception as exc:  # deliberate: wrap any decoder blow-up
                raise ValueError(f"mpesa: decode oauth response: {exc}") from exc
            token_response = OAuthToken.from_json(payload)
            if not token_response.access_token:
                raise ValueError("mpesa: oauth response missing access_token")
        except Exception:
            with self._lock:
                self._failures += 1
                # Re-stamp on failure so the 3-in-5s gate measures from the
                # moment the failed attempt LANDED, not from when it started.
                # Mirrors Go recordRefreshFailure.
                self._last_attempt = self._now()
            raise
        with self._lock:
            now = self._now()
            self._token = token_response.access_token
            self._expires_at = now + timedelta(
                seconds=self._cadence(token_response.expires_in_seconds))
            self._gen += 1
            self._failures = 0
            return self._token

    @property
    def generation(self) -> int:
        """Current generation counter (test/introspection seam)."""
        return self._gen

    def __repr__(self) -> str:
        """Credential-safe: never renders the bearer value."""
        return (f"TokenManager(gen={self._gen}, "
                f"cached={self._token is not None})")
