"""Concurrency-safe Daraja transport (mirrors go/client.go).

Create one :class:`MpesaClient` per environment and share it -- the
OAuth cache inside :class:`mpesa.auth.TokenManager` is synchronized and
generation-aware; share the Session per requests norms and do not
mutate config or session after first use.

Environment wiring from process env vars fulfils config.py's deferred
pointer::

    import os
    from mpesa.config import Config
    from mpesa.enums import Environment

    cfg = Config(
        consumer_key=os.environ["MPESA_CONSUMER_KEY"],
        consumer_secret=os.environ["MPESA_CONSUMER_SECRET"],
        shortcode=os.environ["MPESA_SHORTCODE"],
        passkey=os.environ["MPESA_PASSKEY"],
        environment=Environment.from_config(os.environ.get("MPESA_ENVIRONMENT")),
    )
    client = MpesaClient(cfg)

Requests are treated as VALUES: endpoint methods apply injected
defaults (shortcode/password/originator/identifiers) to an internal
``dataclasses.replace`` copy -- the caller's object is never mutated.
"""

from __future__ import annotations

import copy
import dataclasses
import threading
from datetime import datetime, timezone
from types import TracebackType
from typing import Any, TypeVar

import requests
from requests.adapters import DEFAULT_POOLSIZE, HTTPAdapter

# Back-compat re-export from mpesa._limits (the single source of truth),
# pinned by tests/test_hardening_regressions.py::
#   test_limits_single_source_and_back_compat_reexports
# The cap is enforced by read_capped below, not by reading this alias, so the
# F401 suppression on the next line is scoped to it deliberately.
from ._limits import MAX_BODY_BYTES as _MAX_RESPONSE_BYTES  # noqa: F401
from ._limits import read_capped
from .auth import TokenManager
from .config import Config
from .enums import CommandID
from .exceptions import MpesaError
from .helpers import EAT, generate_password, new_originator_id
from .limits import (
    ServiceLimits,
    TransactionLimits,
    _resolve_transaction_limits,
    _resolved_max,
)
from .requests_async import (
    AccountBalanceRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from .requests_sync import (
    C2BRegisterRequest,
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    STKQueryRequest,
)
from .responses import (
    B2CResponse,
    C2BAckResponse,
    ConversationResponse,
    QRCodeResponse,
    STKPushResponse,
    STKQueryResponse,
)

__all__ = ["MpesaClient"]

STK_PUSH_PATH = "/mpesa/stkpush/v1/processrequest"
STK_QUERY_PATH = "/mpesa/stkpushquery/v1/query"
B2C_PATH = "/mpesa/b2c/v3/paymentrequest"
C2B_REGISTER_PATH = "/mpesa/c2b/v2/registerurl"
C2B_SIMULATE_PATH = "/mpesa/c2b/v2/simulate"
TX_STATUS_PATH = "/mpesa/transactionstatus/v1/query"
REVERSAL_PATH = "/mpesa/reversal/v1/request"
ACCOUNT_BALANCE_PATH = "/mpesa/accountbalance/v1/query"
QR_CODE_PATH = "/mpesa/qrcode/v1/generate"

_ERR_INVALID_TOKEN = "401.003.01"  # nosec B105  # M-Pesa error code, not a token

_ModelT = TypeVar("_ModelT")


def _utc_now() -> datetime:
    """Module-level UTC clock fallback (hoisted out of the hot path)."""
    return datetime.now(timezone.utc)


def _clone_adapter(adapter: Any) -> Any:
    """Pool-isolated twin of one mounted adapter (see :func:`_clone_adapters`).

    Only a STANDARD ``HTTPAdapter`` is rebuilt with its own connection
    pool. A subclass or exotic adapter is passed through BY REFERENCE: the
    caller mounted it deliberately, and silently downgrading it to a plain
    ``HTTPAdapter`` would drop its behaviour (telemetry, custom retry,
    auth) -- a far worse surprise than sharing its pool, which is exactly
    what mounting it on a session means anyway.
    """
    if type(adapter) is not HTTPAdapter:
        return adapter
    # requests keeps pool tuning in PRIVATE fields with no public getter
    # (``_pool_connections``/``_pool_maxsize``/``_pool_block``), so read
    # them defensively and fall back to the library defaults for any
    # adapter that does not expose them.
    retries = getattr(adapter, "max_retries", None)
    if retries is not None and hasattr(retries, "copy"):
        retries = retries.copy()  # own copy: caller edits cannot reach us
    return HTTPAdapter(
        pool_connections=getattr(adapter, "_pool_connections",
                                 DEFAULT_POOLSIZE),
        pool_maxsize=getattr(adapter, "_pool_maxsize", DEFAULT_POOLSIZE),
        pool_block=getattr(adapter, "_pool_block", False),
        max_retries=retries)


def _clone_adapters(source: Any) -> "dict[str, Any]":
    """Fresh adapter mapping with FRESH pool objects for one session.

    ``copy.copy(session)`` shared the caller's ``adapters`` OrderedDict BY
    REFERENCE, so mounting on the clone mutated the caller's session, and
    the ``HTTPAdapter`` objects were shared too -- so ``Session.close()``
    tore down the caller's connection pools while they were still in use.
    Both break the isolation the docstring promises: the clone gets its own
    mapping AND its own pool-backed adapters that copy the caller's tuning
    (pool sizes, retries, blocking), and nothing the caller does afterwards
    can reach our traffic (or vice versa).
    """
    return {
        prefix: _clone_adapter(adapter)
        for prefix, adapter in dict(
            getattr(source, "adapters", {}) or {}).items()
    }


class _OAuthOnlySession:
    """Thin read-only view over the client session that injects
    ``allow_redirects=False`` into TokenManager's OAuth GETs."""

    def __init__(self, session: Any) -> None:
        self._session = session

    def get(self, url: str, **kwargs: Any) -> Any:
        kwargs["allow_redirects"] = False
        return self._session.get(url, **kwargs)


def _daily_boundary(now: datetime) -> str:
    """Africa/Nairobi day key (fixed UTC+3, no DST -> no tzdata dependency).

    Kenya has no daylight saving, so the Nairobi day is a plain fixed-offset
    conversion of the EAT instant -- exactly what ``datetime.astimezone(EAT)``
    computes, with no ``zoneinfo`` lookup that could raise on a stripped
    container (and no Windows-only tzdata hazard). The key is a date string,
    so two instants in the same Nairobi day share it regardless of how many
    times the clock jumps.

    Raises:
        ValueError: if *now* is naive (same guard style as
            :func:`mpesa.helpers.generate_password`): an unzoned clock
            would silently shift the Nairobi day by three hours.
    """
    if now.tzinfo is None:
        raise ValueError("mpesa: timestamp must be timezone-aware")
    return now.astimezone(EAT).date().isoformat()


class MpesaClient:
    """Daraja API engine bound to one :class:`~mpesa.config.Config`.

    TRUST BOUNDARY: an injected ``http_client`` is shallow-cloned and then
    HARDENED -- headers are snapshot-copied, adapters remounted, cookies
    deep-copied (``requests.Session.prepare_request`` merges live session
    cookies into every request, so a shared jar would leak cross-request
    state both ways), ``auth`` reset to ``None`` (no ambient credential
    pickup from the caller's session), ``proxies`` snapshotted into a new
    dict, and ``trust_env`` forced to ``False`` (per the requests docs this
    stops netrc/env credential and proxy pickup -- the clone only ever
    talks where the SDK points it). Later mutations of the caller's
    objects stay invisible here; do not mutate them after first use
    either. The clone is forced ``verify=True`` per the config.py
    contract. Concurrency: TokenManager is fully synchronized; share one
    Session per requests norms.

    LIMITS: ``config.limits`` (or
    :data:`~mpesa.limits.DEFAULT_TRANSACTION_LIMITS`) bounds every amount
    per service, enforced per-transaction by the request models. When
    ``config.track_daily`` is on, this client also accumulates
    ``max_per_day`` per service, reset at each Africa/Nairobi midnight --
    under :attr:`_daily_lock` so concurrent callers cannot both pass a
    check on the same quota. See :mod:`mpesa.limits` for why the daily
    accumulator is opt-in (one process cannot see its peers' traffic).
    """

    def __init__(self, config: Config) -> None:
        # Fail-fast credential validation (Go NewClient() cfg.Validate() parity):
        # reject empty consumer_key/consumer_secret at construction time so
        # misconfiguration surfaces immediately, not at first API call.
        if not config.consumer_key or not config.consumer_secret:
            raise ValueError(
                "mpesa: Config.consumer_key and Config.consumer_secret "
                "are required")
        self._cfg = config
        self._base_url = config.environment.base_url.rstrip("/")
        self._clock = config.now or _utc_now   # hoisted: no lambda per call
        source = config.http_client
        self._session = (copy.copy(source) if source is not None
                         else requests.Session())
        self._session.headers = dict(source.headers) if source is not None \
            else {}
        if source is not None:
            # ISOLATION: copy.copy(source) shared the caller's ``adapters``
            # mapping AND its adapter objects, so mounting on the clone
            # mutated the caller's session and close() tore down the
            # caller's connection pools. The clone now owns a separate
            # mapping of pool-isolated adapters (see _clone_adapters).
            self._session.adapters = _clone_adapters(source)
            # Deep-copy the cookie jar: copy.copy above shares it, and
            # prepare_request would otherwise merge the caller's live
            # cookies into our requests (and ours back on real Sessions
            # via response cookie extraction).
            cookies = getattr(source, "cookies", None)
            if cookies is not None:
                self._session.cookies = copy.deepcopy(cookies)
            # Drop ambient auth (Basic/Digest tuple or callable) so the
            # caller's credential is never sent to Daraja hosts; the SDK
            # injects its own per-request Authorization header instead.
            if hasattr(self._session, "auth"):
                self._session.auth = None
            # Snapshot proxies: later caller edits must not reroute the
            # clone's traffic (or vice versa).
            proxies = getattr(source, "proxies", None)
            if proxies is not None:
                try:
                    self._session.proxies = dict(proxies)
                except (TypeError, ValueError):
                    self._session.proxies = {}
        # Refuse netrc/env pickup on OUR clone only (caller object untouched
        # except where noted above); TLS stays forced on below.
        self._session.trust_env = False
        self._session.verify = True  # forced on OUR clone only
        # Timeout clamp: non-positive values fall back to Go's 30s default.
        # Non-numeric values (e.g. "fast") raise ValueError, not the bare
        # TypeError that `> 0` would produce on a str/None.
        try:
            timeout = float(config.timeout_seconds)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "mpesa: Config.timeout_seconds must be a number of seconds, "
                f"got {config.timeout_seconds!r}") from exc
        self._timeout = timeout if timeout > 0 else 30.0
        self._tokens = TokenManager(
            _OAuthOnlySession(self._session), base_url=self._base_url,
            consumer_key=config.consumer_key,
            consumer_secret=config.consumer_secret,
            now=config.now, timeout=self._timeout)
        #: Per-merchant tier ceilings for the amount-bearing endpoints,
        #: resolved ONCE here: per-service overrides merged onto the
        #: Safaricom defaults, so an unset field can never read as
        #: "no ceiling" and nothing re-merges per call.
        self._limits: TransactionLimits = _resolve_transaction_limits(
            config.limits)
        #: Opt-in daily accumulator state (see :mod:`mpesa.limits` for why
        #: it is off by default). Guards ``_daily_used``/``_daily_day``.
        self._daily_lock = threading.Lock()
        self._daily_used: dict[str, int] = {}
        self._daily_day: str | None = None

    def __repr__(self) -> str:
        """Credential-safe rendering (never secrets/token)."""
        return (f"MpesaClient(environment={self._cfg.environment.name}, "
                f"timeout_seconds={self._timeout!r})")

    def close(self) -> None:
        """Release the underlying session's connection pool."""
        closer = getattr(self._session, "close", None)
        if callable(closer):
            closer()

    def __enter__(self) -> "MpesaClient":
        return self

    def __exit__(self, exc_type: type[BaseException] | None,
                 exc: BaseException | None,
                 tb: TracebackType | None) -> None:
        self.close()

    # ---- transport --------------------------------------------------------

    # ---- transaction limits ---------------------------------------------------

    def _accrue_daily(self, service: str, amount: int) -> None:
        """Check then consume *amount* against the service's daily ceiling.

        No-op unless ``Config.track_daily`` is on. The whole
        read-check-increment sequence runs under one lock so two threads
        cannot both observe the pre-check total and each pass: the
        accumulator stays exact under concurrency, and the Nairobi-day key
        is re-evaluated inside the same lock, so a rollover observed by one
        thread resets for everyone.

        ACCOUNTING (consumed-on-attempt): the quota is consumed BEFORE
        dispatch (every ``stk_push``/``b2c_payout``/``c2b_simulate``/
        ``reversal``/``generate_qr_code`` accrues, then calls
        :meth:`_post_model`). A failed send AFTER accrue does NOT roll
        back -- gateway rejections and 401-retry failures all keep their
        reservation. Transport-level failures
        (``requests.exceptions.RequestException``) DO roll back via
        :meth:`_rollback_daily`, so a network blip does not permanently
        drain the budget for a payment that never reached Daraja.
        Only a pre-dispatch rejection (validation or daily-ceiling
        ``ValueError``) costs nothing, because it never accrues.

        BUCKETS: ``reversal`` and ``generate_qr_code`` each get their own
        daily bucket (``"reversal"`` and ``"qr"`` respectively; see
        :mod:`mpesa.limits`); every other amount-bearing endpoint has its
        own bucket. ``Transaction Status`` has no amount, so it never
        accrues.

        Raises:
            ValueError: the running total for this Nairobi day would pass
                ``max_per_day``. The caller never dispatches in that case,
                so a rejected payment costs no OAuth token and no request.
        """
        if not self._cfg.track_daily:
            return
        ceiling = self._daily_ceiling(service)
        if ceiling is None or amount <= 0:
            return
        with self._daily_lock:
            day = _daily_boundary(self._now())
            if self._daily_day is None or day > self._daily_day:
                # New Nairobi day: a fresh quota for every service.
                # Forward-only compare (ISO strings sort lexicographically):
                # a backward clock jump (NTP correction) reuses today's
                # budget instead of resetting early and letting a
                # double-spend through a fresh quota.
                self._daily_day, self._daily_used = day, {}
            used = self._daily_used.get(service, 0)
            if used + amount > ceiling:
                raise ValueError(
                    f"mpesa: {service} amount {amount} would take the running "
                    f"total to {used + amount} KES, over the {ceiling} KES "
                    f"per-day ceiling configured for this service "
                    f"({used} KES already moved on {day} Nairobi time); "
                    f"override it with Config(limits=TransactionLimits("
                    f"{service}=ServiceLimits(max_per_day=<KES>))) -- leave "
                    f"the field unset (None) to keep the Safaricom default, "
                    f"or set it to 0 to disable the daily ceiling")
            self._daily_used[service] = used + amount

    def _rollback_daily(self, service: str, amount: int) -> None:
        """Return *amount* to *service*'s daily quota after a transport error.

        Called only on ``requests.exceptions.RequestException`` (Go
        ``recordTransportRollback`` parity): the payment never reached
        Daraja, so the reservation must not persist. Gateway
        rejections and validation errors keep their reservation -- the
        request WAS sent and the gateway's verdict is authoritative.
        Clamped at zero: concurrent accruals and clock skew can make the
        running total smaller than *amount*; we never drive it negative.
        """
        if not self._cfg.track_daily:
            return
        with self._daily_lock:
            current = self._daily_used.get(service, 0)
            self._daily_used[service] = max(0, current - amount)

    def _daily_ceiling(self, service: str) -> int | None:
        """Resolved ``max_per_day`` for *service* (None = unlimited).

        Reads the ALREADY-MERGED limits resolved in ``__init__``, so an
        unset ``max_per_day`` has inherited its Safaricom default here and
        an explicit ``0`` is the only thing that means unlimited.
        """
        bounds = getattr(self._limits, service, None)
        if not isinstance(bounds, ServiceLimits):
            bounds = self._limits.default
        return _resolved_max(bounds.max_per_day)

    @property
    def daily_spend(self) -> dict[str, int]:
        """Amount already charged today, per service (this PROCESS only).

        Deliberately NOT a platform figure: other replicas sharing this
        shortcode also move money, which is exactly why daily tracking is
        opt-in. Useful for tests and for logging.
        """
        with self._daily_lock:
            return dict(self._daily_used)

    def _now(self) -> datetime:
        return self._clock()

    def _send(self, token: str, method: str, path: str,
              json_body: Any, params: Any) -> tuple[int, str, bytes]:
        """Authenticated round-trip returning ``(status_code,
        content_type, body)``.

        True streaming cap via the shared mpesa._limits.read_capped
        (Go LimitReader parity): reads at most _MAX_RESPONSE_BYTES+1 via
        iter_content, aborting mid-stream on oversize bodies. Plain values
        are returned instead of the Response because ``Response.content``
        is a getter-only property -- writing it raises AttributeError on
        every real request (duck-typed fakes allowed attribute writes
        and masked the crash historically). The connection is released
        inside read_capped's ``finally``, so aborts mid-read never leak
        sockets.
        """
        response = self._session.request(
            method, self._base_url + path, json=json_body, params=params,
            timeout=self._timeout, allow_redirects=False, stream=True,
            headers={"Authorization": f"Bearer {token}",
                     "Content-Type": "application/json"})
        try:
            body = read_capped(response, f"{path} response")
        except ValueError as exc:
            # Oversize body: the response arrived but exceeds the
            # accumulation bound. Typed MpesaError(413) matches Go/TS
            # parity -- the SDK surfaces HTTP-level failures as
            # MpesaError, not as a bare ValueError that callers cannot
            # distinguish from a validation failure.
            raise MpesaError(
                413, error_message=f"mpesa: {path} response {exc}") from exc
        content_type = response.headers.get("content-type", "")
        return response.status_code, content_type, body

    def _post_model(self, path: str, payload: dict[str, Any],
                    model: type[_ModelT]) -> _ModelT:
        """Authenticated POST -> parsed sync-response model, consuming the
        ``(status_code, content_type, body)`` tuple from :meth:`_send`,
        with the documented retry-once on 401.003.01. Every size cap is
        enforced inside :meth:`_send` (the tuple body can never exceed
        the accumulation bound), so the 401 probe and final parse are
        size-capped by construction.

        ACCOUNTING: callers accrue the daily quota BEFORE this dispatch
        (see :meth:`_accrue_daily`); failures raised here -- gateway
        non-2xx, transport errors -- do NOT roll the reservation back
        (consumed-on-attempt). Callers that need rollback on transport
        errors catch ``requests.exceptions.RequestException`` at the
        endpoint level and call :meth:`_rollback_daily`.
        """
        token, gen = self._tokens.get_token_with_gen()
        status_code, content_type, body = self._send(
            token, "POST", path, payload, None)
        if status_code == 401:
            probe = MpesaError.from_response(401, body, content_type)
            if probe.error_code == _ERR_INVALID_TOKEN:
                fresh = self._tokens.refresh_after_invalid_token(gen)
                status_code, content_type, body = self._send(
                    fresh, "POST", path, payload, None)
        if not 200 <= status_code <= 299:
            raise MpesaError.from_response(status_code, body, content_type)
        return model.from_json(body)

    # ---- endpoints --------------------------------------------------------

    def stk_push(self, req: STKPushRequest) -> STKPushResponse:
        """Send a payment prompt (docs/apis/stk-push.md); Password and
        Timestamp derive from ONE shared EAT instant bound to the
        shortcode ACTUALLY sent.

        Example::

            resp = client.stk_push(STKPushRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.business_short_code:
            req.business_short_code = self._cfg.shortcode
        if not req.party_b:
            req.party_b = req.business_short_code
        req.validate(self._limits)
        self._accrue_daily("stk", req.amount)
        password, timestamp = generate_password(
            req.business_short_code, self._cfg.passkey, self._now())
        payload = {**req.to_payload(), "Password": password,
                   "Timestamp": timestamp}
        try:
            return self._post_model(STK_PUSH_PATH, payload, STKPushResponse)
        except requests.exceptions.RequestException:
            self._rollback_daily("stk", req.amount)
            raise

    def stk_query(self, req: STKQueryRequest) -> STKQueryResponse:
        """Check a push outcome when callbacks are late
        (docs/apis/stk-query.md); Password binds to the EFFECTIVE
        shortcode either way.

        The config shortcode fills an empty request shortcode BEFORE
        validation, so ``validate()`` always sees the normalized value
        that is actually sent (garbage fails here with ``ValueError``,
        never as a gateway 500).

        Example::

            resp = client.stk_query(STKQueryRequest(
                checkout_request_id="ws_CO_191220191020363925"))
        """
        req = dataclasses.replace(req)
        if not req.business_short_code:
            req.business_short_code = self._cfg.shortcode
        req.validate(self._limits)
        effective = req.business_short_code
        # Hand-built flat payload mirrors go/client.go stkQueryPayload:
        # BusinessShortCode participates in password derivation.
        password, timestamp = generate_password(
            effective, self._cfg.passkey, self._now())
        payload = {"BusinessShortCode": effective, "Password": password,
                   "Timestamp": timestamp,
                   "CheckoutRequestID": req.checkout_request_id}
        return self._post_model(STK_QUERY_PATH, payload, STKQueryResponse)

    def b2c_payout(self, req: B2CPayoutRequest) -> B2CResponse:
        """Async payout (docs/apis/b2c.md); OriginatorConversationID <-
        new_originator_id() and PartyA <- cfg.shortcode when empty.

        Example::

            ack = client.b2c_payout(B2CPayoutRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.originator_conversation_id:
            req.originator_conversation_id = new_originator_id()
        if not req.party_a:
            req.party_a = self._cfg.shortcode
        req.validate(self._limits)
        self._accrue_daily("b2c", req.amount)
        try:
            return self._post_model(B2C_PATH, req.to_payload(), B2CResponse)
        except requests.exceptions.RequestException:
            self._rollback_daily("b2c", req.amount)
            raise

    def transaction_status(
            self, req: TransactionStatusRequest) -> ConversationResponse:
        """Query by receipt XOR conversation ID
        (docs/apis/transaction-status.md); CommandID <- TX_STATUS_QUERY,
        IdentifierType <- "4" when unset.

        Example::

            ack = client.transaction_status(TransactionStatusRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.TX_STATUS_QUERY
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate(self._limits)
        return self._post_model(TX_STATUS_PATH, req.to_payload(),
                                ConversationResponse)

    def reversal(self, req: ReversalRequest) -> ConversationResponse:
        """Reverse a recent C2B transaction -- C2B ONLY
        (docs/apis/reversal.md); CommandID <- REVERSAL when unset.

        Daily quota accrues against the dedicated ``"reversal"`` bucket
        (see :meth:`_accrue_daily`), consumed-on-attempt with transport-
        error rollback only.

        Example::

            ack = client.reversal(ReversalRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.REVERSAL
        req.validate(self._limits)
        self._accrue_daily("reversal", req.amount)
        try:
            return self._post_model(REVERSAL_PATH, req.to_payload(),
                                    ConversationResponse)
        except requests.exceptions.RequestException:
            self._rollback_daily("reversal", req.amount)
            raise

    def account_balance(
            self, req: AccountBalanceRequest) -> ConversationResponse:
        """Query organization balances (docs/apis/account-balance.md);
        CommandID <- ACCOUNT_BALANCE, IdentifierType <- "4" when unset.

        Example::

            ack = client.account_balance(AccountBalanceRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.command_id:
            req.command_id = CommandID.ACCOUNT_BALANCE
        if not req.identifier_type:
            req.identifier_type = "4"
        req.validate(self._limits)
        return self._post_model(ACCOUNT_BALANCE_PATH, req.to_payload(),
                                ConversationResponse)

    def c2b_register_url(self, req: C2BRegisterRequest) -> C2BAckResponse:
        """Register validation/confirmation URLs, v2 -- effectively
        one-shot in production (docs/apis/c2b.md); ShortCode <- cfg.

        Example::

            ack = client.c2b_register_url(C2BRegisterRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate(self._limits)
        return self._post_model(C2B_REGISTER_PATH, req.to_payload(),
                                C2BAckResponse)

    def c2b_simulate(self, req: C2BSimulateRequest) -> C2BAckResponse:
        """Fake an inbound payment -- SANDBOX ONLY (docs/apis/c2b.md);
        ShortCode <- cfg.shortcode when empty.

        Example::

            ack = client.c2b_simulate(C2BSimulateRequest(...))
        """
        req = dataclasses.replace(req)
        if not req.short_code:
            req.short_code = self._cfg.shortcode
        req.validate(self._limits)
        self._accrue_daily("c2b", req.amount)
        try:
            return self._post_model(C2B_SIMULATE_PATH, req.to_payload(),
                                    C2BAckResponse)
        except requests.exceptions.RequestException:
            self._rollback_daily("c2b", req.amount)
            raise

    def generate_qr_code(self, req: QRCodeRequest) -> QRCodeResponse:
        """Create a dynamic QR payload, fully synchronous
        (docs/apis/dynamic-qr.md).

        The caller's request is treated as a VALUE: it is copied via
        ``dataclasses.replace`` before ``validate()`` (which normalizes
        trx_code/cpi/size in place), so the caller's object is never
        mutated -- parity with the other 8 endpoints.

        Daily quota accrues against the dedicated ``"qr"`` bucket
        (see :meth:`_accrue_daily`), consumed-on-attempt with transport-
        error rollback only.

        Example::

            qr = client.generate_qr_code(QRCodeRequest(...))
        """
        req = dataclasses.replace(req)
        req.validate(self._limits)
        self._accrue_daily("qr", req.amount)
        try:
            return self._post_model(QR_CODE_PATH, req.to_payload(),
                                    QRCodeResponse)
        except requests.exceptions.RequestException:
            self._rollback_daily("qr", req.amount)
            raise
