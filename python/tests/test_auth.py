"""Tests for mpesa.auth -- generation-guarded token cache semantics."""

import json
import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.auth import TokenManager
from mpesa.exceptions import MpesaError, RefreshRateLimitedError

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


class FakeResponse:
    def __init__(self, status_code=200, payload=None, body=b""):
        self.status_code = status_code
        self._payload = payload
        self.content = body if body else (
            __import__("json").dumps(payload).encode() if payload is not None
            else b"")
        self.headers = {"content-type": "application/json"}
        self.closed_calls = 0

    def json(self):
        import json as _json
        return _json.loads(self.content)

    def iter_content(self, chunk_size):
        blob = self.content
        for i in range(0, len(blob), chunk_size):
            yield blob[i:i + chunk_size]

    def close(self):
        self.closed_calls += 1


class FakeSession:
    """Programmable session recording every OAuth call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        return self.responses.pop(0)


def ok(expires="3599"):
    return FakeResponse(payload={"access_token": f"tok-{len('x')}",
                                 "expires_in": expires})


class Clock:
    def __init__(self, start=T0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


def make(responses=None, clock=None):
    clock = clock or Clock()
    session = FakeSession(responses if responses is not None else [ok()])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "key", "secret", now=clock)
    return tm, session, clock


def test_cache_hit_single_fetch():
    tm, session, _ = make()
    assert tm.get_token() == "tok-1"
    assert tm.get_token() == "tok-1"
    assert len(session.calls) == 1


def test_basic_auth_header_and_url_and_timeout():
    tm, session, _ = make()
    assert tm.get_token()
    call = session.calls[0]
    assert call["url"].endswith("/oauth/v1/generate"
                                "?grant_type=client_credentials")
    assert call["timeout"] == 30.0
    import base64
    expected = base64.b64encode(b"key:secret").decode()
    assert call["headers"]["Authorization"] == f"Basic {expected}"


def test_concurrent_threads_exactly_one_fetch():
    tm, session, _ = make([ok() for _ in range(5)])
    results: list[str] = []
    barrier = threading.Barrier(8)

    def worker():
        barrier.wait()
        results.append(tm.get_token())

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 8 and all(results)
    assert len(session.calls) == 1


def test_injectable_clock_expiry_triggers_refetch():
    clock = Clock()
    tm, session, clock = make([ok(), ok()], clock)
    tm.get_token()
    # Cadence for expires_in=3599 is min(3599-60, 3000) = 3000s.
    clock.advance(3001)
    tm.get_token()
    assert len(session.calls) == 2


def test_short_ttl_refresh_after_advance():
    clock = Clock()
    tm, session, clock = make([ok("120"), ok("120")], clock)
    first = tm.get_token()            # cadence max(1, 120-60)=60s
    clock.advance(59)
    assert tm.get_token() == first    # still cached at t+59
    clock.advance(2)                  # t+61 > 60s window
    tm.get_token()
    assert len(session.calls) == 2


def test_unknown_ttl_defaults_to_3000s_cadence():
    clock = Clock()
    tm, session, clock = make([ok(None), ok(None)], clock)
    tm.get_token()
    clock.advance(2999)
    tm.get_token()
    assert len(session.calls) == 1
    clock.advance(2)
    tm.get_token()
    assert len(session.calls) == 2


def test_invalid_token_same_gen_forces_refetch_different_gen_adopts():
    clock = Clock()
    tm, session, clock = make([ok(), ok()], clock)
    tm.get_token()
    my_gen = tm.generation            # caller's view after its fetch (gen=1)
    fresh = tm.refresh_after_invalid_token(my_gen)   # same gen -> lead refresh
    assert len(session.calls) == 2
    assert fresh.startswith("tok-")
    # A peer still holding the PRE-refresh view (gen=1) now finds gen=2:
    # it must adopt the current token without another OAuth round-trip.
    adopted = tm.refresh_after_invalid_token(my_gen)
    assert adopted == fresh
    assert len(session.calls) == 2


def test_empty_credentials_raise_before_network():
    session = FakeSession([ok()])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "", "secret")
    with pytest.raises(ValueError, match="required before calling any endpoint"):
        tm.get_token()
    assert len(session.calls) == 0


def test_non_200_surfaces_mpesa_error():
    session = FakeSession([FakeResponse(
        status_code=401,
        body=b'{"requestId":"r","errorCode":"401.003.01",'
             b'"errorMessage":"Invalid Access Token"}')])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(Exception) as excinfo:
        tm.get_token()
    assert "401.003.01" in str(excinfo.value)


def test_missing_access_token_rejected():
    session = FakeSession([FakeResponse(payload={"expires_in": "3599"})])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(ValueError, match="missing access_token"):
        tm.get_token()


def test_repr_redacts_token():
    tm, _, _ = make()
    tm.get_token()
    rendered = repr(tm)
    assert "tok-" not in rendered
    assert "cached=True" in rendered and "gen=" in rendered


# ---- hardening round ---------------------------------------------------------

class BadJsonResponse(FakeResponse):
    def json(self):
        raise ValueError("body is not json")


def make_multi(responses, clock=None, **kwargs):
    clock = clock or Clock()
    session = FakeSession(responses)
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "key", "secret", now=clock, **kwargs)
    return tm, session, clock


def test_get_token_with_gen_pairs_snapshot():
    tm, _, _ = make_multi([ok(), ok()])
    tok, gen = tm.get_token_with_gen()
    assert tok.startswith("tok-") and gen >= 1
    assert tm.get_token_with_gen() == (tok, gen)     # cached pairing stable


def test_failed_lead_refresh_untrusts_clock_fresh_token():
    tm, session, _ = make_multi([ok(), FakeResponse(status_code=500, body=b"x"), ok()])
    tm.get_token()
    stale_gen = tm.generation
    with pytest.raises(MpesaError) as excinfo:
        tm.refresh_after_invalid_token(stale_gen)
    # Narrower than a blind `Exception`: a 500 from the token endpoint must
    # surface as the typed Daraja error, carrying the gateway status.
    assert excinfo.value.status_code == 500
    # The invalidated-but-clock-fresh token must NOT be servable now:
    next_token = tm.get_token()
    assert next_token.startswith("tok-")
    assert len(session.calls) == 3                   # hard refetch happened


def test_oauth_fetch_refuses_redirects_and_huge_body():
    session = FakeSession([FakeResponse(status_code=302,
                                        body=b"redirect target")])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(Exception) as excinfo:
        tm.get_token()
    assert session.calls[0].get("allow_redirects") is False
    assert isinstance(excinfo.value, Exception)

    huge = FakeSession([FakeResponse(payload={"access_token": "t",
                                              "expires_in": "3599"},
                                     body=b'{"x":"' + b"A" * (1 << 20) + b'"}')])
    tm2 = TokenManager(huge, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(ValueError, match="exceeds 1048576"):
        tm2.get_token()


class StreamOnlyResponse:
    """Mirrors test_client.StreamOnlyResponse: exposes ONLY iter_content
    -- no .content attribute exists, so any pre-read .content access
    inside _refresh would blow up as AttributeError."""

    def __init__(self, status_code=200, text="{}", chunks=None):
        self.status_code = status_code
        self._text = text
        self._chunks = chunks
        self.headers = {"content-type": "application/json"}
        self.parse_attempts = 0
        self.closed_calls = 0

    def json(self):
        self.parse_attempts += 1
        return json.loads(self._text)

    def iter_content(self, chunk_size):
        if self._chunks is not None:
            yield from self._chunks   # pre-chunked wire stream, verbatim
            return
        blob = self._text.encode()
        for i in range(0, len(blob), chunk_size):
            yield blob[i:i + chunk_size]

    def close(self):
        self.closed_calls += 1


def test_oauth_refresh_streams_bounded_read_without_dot_content():
    resp = StreamOnlyResponse(
        text='{"access_token":"tok-stream","expires_in":"3599"}')
    session = FakeSession([resp])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    assert tm.get_token() == "tok-stream"
    assert session.calls[0]["stream"] is True
    assert session.calls[0]["allow_redirects"] is False
    assert not hasattr(resp, "content")   # fake itself never had one
    assert resp.closed_calls == 1         # connection released after read


def test_oauth_oversize_aborts_midstream_before_parse():
    over = b'{"access_token":"' + b"A" * (1 << 20) + b'"}'
    resp = StreamOnlyResponse(chunks=[over[:700_000], over[700_000:]])
    session = FakeSession([resp])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(ValueError, match=r"exceeds 1048576"):
        tm.get_token()
    assert resp.parse_attempts == 0       # cap fired mid-stream; no parse
    assert resp.closed_calls == 1         # finally released the socket


def test_decode_error_wrapped_as_value_error():
    session = FakeSession([BadJsonResponse(body=b"not-json-at-all")])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(ValueError, match="decode oauth response"):
        tm.get_token()


def test_timeout_kwarg_passthrough():
    tm, session, _ = make_multi([ok()], timeout=12.5)
    tm.get_token()
    assert session.calls[0]["timeout"] == 12.5


def test_adopt_path_rejects_expired_peer_token():
    clock = Clock()
    tm, session, clock = make_multi([ok("120"), ok("120")], clock)
    tm.get_token()
    stale_view = tm.generation
    clock.advance(120)                # peer token now past even raw TTL
    fresh = tm.refresh_after_invalid_token(stale_view + 5)  # would adopt
    assert len(session.calls) == 2    # fell through to real refresh instead
    assert fresh.startswith("tok-")


def test_credential_hygiene():
    for key, secret in (("with:colon", "s"), ("k\u00e9y", "s\u00e9")):
        with pytest.raises(ValueError):
            # Sandbox host: fakes never hit the network, so the allowlist
            # passes and the failure pins the credential check itself.
            TokenManager(FakeSession([]),
                         "https://sandbox.safaricom.co.ke", key, secret)


def test_cadence_clamp_edges():
    # Inputs are post-coercion ints (OAuthToken.expires_in_seconds domain).
    # Floor is 60.0s (TS parity): TTLs below 120s all clamp to the floor.
    cases = {30: 60.0, 61: 60.0, 62: 60.0, 120: 60.0, 3060: 3000.0, None: 3000.0}
    for expires, want in cases.items():
        assert TokenManager._cadence(expires) == want


def test_cadence_floor_is_sixty_seconds():
    """TS parity: sub-120s TTLs all collapse to the 60s floor."""
    # expires=30 -> min(30-60, 3000) = -30 -> max(60.0, -30) = 60.0
    assert TokenManager._cadence(30) == 60.0
    # expires=119 -> min(59, 3000) = 59 -> max(60.0, 59) = 60.0
    assert TokenManager._cadence(119) == 60.0
    # expires=120 -> min(60, 3000) = 60 -> max(60.0, 60) = 60.0
    assert TokenManager._cadence(120) == 60.0
    # expires=121 -> min(61, 3000) = 61 -> max(60.0, 61) = 61.0
    assert TokenManager._cadence(121) == 61.0


def test_refresh_failure_restamps_attempt_clock():
    """Failure re-stamp (Go recordRefreshFailure parity): the except block
    re-stamps _last_attempt to the CURRENT instant, so the 3-in-5s window
    measures from when the failure LANDED, not from when it started.

    Simulates a long OAuth round-trip: the session advances the clock by
    4s while "in flight", so the attempt starts at T0 but the failure
    arrives at T0+4. Without the re-stamp, _last_attempt would stay at T0
    and a later non-forced refresh at T0+5 would pass the gate
    (elapsed=5s >= 5.0s) even though the third failure just landed.
    """
    clock = Clock()

    class SlowFailSession:
        """Fails after advancing the clock 4s (simulated timeout)."""

        def __init__(self):
            self.calls = []

        def get(self, url, **kwargs):
            self.calls.append({"url": url, **kwargs})
            clock.advance(4)  # round-trip takes 4s
            return FakeResponse(status_code=500, body=b"{}")

    session = SlowFailSession()
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "k", "s", now=clock)

    from mpesa.exceptions import MpesaError

    # First failure: attempt starts at T0, lands at T0+4.
    # The gate stamps _last_attempt=T0; the except re-stamps to T0+4.
    with pytest.raises(MpesaError):
        tm.get_token()
    assert clock.now == T0 + timedelta(seconds=4)
    # _last_attempt is T0+4 (re-stamped), NOT T0 (attempt-start).
    assert tm._last_attempt == T0 + timedelta(seconds=4)

    # Second failure: starts at T0+4, lands at T0+8.
    # Gate stamps T0+4; except re-stamps T0+8.
    with pytest.raises(MpesaError):
        tm.get_token()
    assert tm._last_attempt == T0 + timedelta(seconds=8)

    # Third failure: starts at T0+8, lands at T0+12.
    # Gate stamps T0+8; except re-stamps T0+12. failures=3.
    with pytest.raises(MpesaError):
        tm.get_token()
    assert tm._last_attempt == T0 + timedelta(seconds=12)

    # Fourth attempt 1s later (T0+13): gate sees failures=3 and
    # elapsed = 13 - 12 = 1s < 5.0s -> rate-limited.
    # WITHOUT the re-stamp, _last_attempt would be T0+8 (attempt-start
    # of 3rd), elapsed = 13-8 = 5s >= 5.0s, and the gate would NOT fire.
    clock.advance(1)
    from mpesa.exceptions import RefreshRateLimitedError
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()


def test_typed_mpesa_error_with_status_code():
    from mpesa.exceptions import MpesaError
    session = FakeSession([FakeResponse(
        status_code=401,
        body=b'{"requestId":"r","errorCode":"401.003.01",'
             b'"errorMessage":"Invalid Access Token"}')])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    with pytest.raises(MpesaError) as excinfo:
        tm.get_token()
    assert excinfo.value.status_code == 401


def test_concurrent_stress_no_stampede():
    import itertools
    counter = itertools.count(1)

    def ok_unique():
        return FakeResponse(payload={"access_token": f"tok-{next(counter)}",
                                     "expires_in": "3599"})

    tm, session, _ = make_multi([ok_unique() for _ in range(20)])
    results: list[str] = []
    barrier = threading.Barrier(8)

    def worker(i):
        barrier.wait()
        if i % 2:
            results.append(tm.get_token())
        else:
            results.append(tm.refresh_after_invalid_token(0))  # always stale

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert all(results)
    assert len(set(results)) == len(session.calls)      # tokens map 1:1 to fetches
    assert len(session.calls) <= 9                      # no 8-thread stampede


def test_adopted_token_identity_differs_from_pre_refresh():
    import itertools
    counter = itertools.count(1)

    def ok_unique():
        return FakeResponse(payload={"access_token": f"tok-{next(counter)}",
                                     "expires_in": "3599"})

    tm, session, _ = make_multi([ok_unique(), ok_unique()])
    pre = tm.get_token()
    post = tm.refresh_after_invalid_token(tm.generation)
    assert post != pre
    adopted = tm.refresh_after_invalid_token(tm.generation - 1)
    assert adopted == post and adopted != pre


# ---- D10: the OAuth round-trip must not hold the token lock ---------------
#
# The refresh used to run the whole OAuth GET inside self._lock, so every
# thread that needed a token (and every other user of that mutex) was
# frozen for up to the full 30s OAuth timeout -- roughly once an hour, and
# for the whole process if the OAuth endpoint hung. Go elects a leader and
# refreshes OUTSIDE the mutex (go/client.go leadRefresh); the tests below
# pin the same contract for Python.


class BlockingSession(FakeSession):
    """FakeSession whose OAuth GET can be held open on demand.

    The hold is what makes the D10 defect OBSERVABLE: the OAuth leg stays
    in flight while the test inspects the manager's lock, so a
    lock-held-across-the-network implementation is caught in the act
    rather than by timing.
    """

    def __init__(self, responses):
        super().__init__(responses)
        self.hold = False
        self.entered = threading.Event()
        self.release = threading.Event()

    def get(self, url, **kwargs):
        self.calls.append({"url": url, **kwargs})
        if self.hold:
            self.entered.set()
            # Bounded so a failed assertion can never wedge the suite.
            self.release.wait(timeout=10.0)
        return self.responses.pop(0)


class CountingCondition(threading.Condition):
    """Condition that counts how many callers parked on it.

    WHY: a test that wants to prove "one OAuth request, every waiter
    woken with the same error" must KNOW that the waiters are parked
    before the leader fails -- otherwise a caller that arrives late would
    legitimately become the next leader and the assertion would be a
    race, not a test.
    """

    def __init__(self, lock):
        super().__init__(lock)
        self.expected = 0
        self.parked = threading.Event()
        self.count = 0
        # The counter is guarded by its own lock: a plain `count += 1` can
        # lose an update when two threads interleave between the read and
        # the write, and the lost update would leave the count below
        # `expected` -- the parked event would never fire and the test would
        # TIME OUT instead of failing cleanly.
        self._count_lock = threading.Lock()

    def wait(self, timeout=None):
        with self._count_lock:
            self.count += 1
            seen = self.count
        if seen >= self.expected:
            self.parked.set()
        return super().wait(timeout)


def test_d10_oauth_leg_runs_without_the_token_lock_held():
    """D10: the OAuth round-trip must NOT hold the token lock.

    Before the fix the leader held self._lock across the whole OAuth
    GET, so every other thread that needed the lock -- a cached-token
    read, a generation read, the next refresh -- was frozen for up to
    the full 30s OAuth timeout.
    """
    clock = Clock()
    session = BlockingSession([ok(), ok()])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s",
                      now=clock)
    tm.get_token()                     # prime the cache (one OAuth call)
    clock.advance(3001)                # the cached token is stale now
    session.hold = True

    workers = 8
    barrier = threading.Barrier(workers)
    tokens: list[str] = []

    def worker():
        barrier.wait()
        tokens.append(tm.get_token())

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    assert session.entered.wait(timeout=5.0), "the OAuth leg never started"

    # THE PROBE: the token lock must be free while the OAuth leg is in
    # flight. With the lock held across the network call this acquire
    # times out -- which is the defect, observed directly.
    acquired = tm._lock.acquire(timeout=0.5)
    if acquired:
        tm._lock.release()
    assert acquired, "the OAuth round-trip held the token lock (D10)"

    session.release.set()
    for t in threads:
        t.join(timeout=10.0)
    assert not [t for t in threads if t.is_alive()], "a caller hung"
    assert len(session.calls) == 2      # the prime + exactly ONE refresh
    assert len(tokens) == workers
    assert len(set(tokens)) == 1        # every caller got the SAME token


def test_d10_failed_refresh_wakes_every_waiter_with_the_same_error():
    """D10: a failed refresh wakes every waiter with the SAME error.

    Before the fix each waiter woke up, found the token still stale and
    ran its OWN OAuth round-trip: a failure stampede (one request and
    one error object per waiter). Now the leader publishes its error and
    the waiters re-raise it.
    """
    workers = 6
    session = BlockingSession([
        FakeResponse(status_code=500, body=b"boom") for _ in range(workers)])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    cond = getattr(tm, "_cond", None)
    assert cond is not None, (
        "D10: the manager exposes no refresh condition -- the OAuth leg "
        "still runs under the token mutex, so waiters cannot park (nor be "
        "woken with the leader's error)")
    counting = CountingCondition(tm._lock)
    counting.expected = workers - 1
    tm._cond = counting

    session.hold = True
    errors: list[BaseException] = []
    barrier = threading.Barrier(workers)

    def worker():
        barrier.wait()
        try:
            tm.get_token()
        except Exception as exc:           # the point of the test
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    assert session.entered.wait(timeout=5.0), "the OAuth leg never started"
    # Every caller but the leader is parked on the condition.
    assert counting.parked.wait(timeout=5.0), "the waiters never parked"
    session.release.set()                 # the leader now fails

    for t in threads:
        t.join(timeout=10.0)
    assert not [t for t in threads if t.is_alive()], "a waiter hung"
    assert len(errors) == workers
    assert len(session.calls) == 1, "the waiters each ran their own request"
    first = errors[0]
    # The waiters see the SAME error -- same type and message. Not the same
    # OBJECT: the manager hands every waiter a fresh copy, because one
    # shared instance would carry another thread's traceback (the reason
    # the copy exists at all).
    assert all(type(exc) is type(first) for exc in errors)
    assert all(str(exc) == str(first) for exc in errors)
    assert isinstance(first, MpesaError)


def test_d10_rate_limiter_still_trips_after_three_failures():
    """D10: the rate-limit gate is unchanged by the leader/waiter split --
    three consecutive failures refuse the fourth NON-forced refresh, and
    the refused attempt never reaches the wire."""
    session = FakeSession([FakeResponse(status_code=500, body=b"x")
                           for _ in range(4)])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()
    assert len(session.calls) == 3


def test_d10_forced_refresh_bypasses_the_rate_limit_gate():
    """D10: a 401-triggered (forced) refresh bypasses the gate -- but it
    still advances the attempt clock, so the next non-forced refresh
    stays refused."""
    session = FakeSession([FakeResponse(status_code=500, body=b"x")
                           for _ in range(5)])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()                    # the gate refuses the 4th attempt
    # The FORCED refresh bypasses the gate and reaches the wire.
    with pytest.raises(MpesaError):
        tm.refresh_after_invalid_token(tm.generation)
    assert len(session.calls) == 4
    # The forced failure still advanced the attempt clock: the gate keeps
    # refusing non-forced refreshes.
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()
    assert len(session.calls) == 4


def test_d10_invalid_token_path_yields_a_fresh_token():
    """D10: the 401.003.01 path still produces a NEW token and bumps the
    generation exactly once."""
    session = FakeSession([
        FakeResponse(payload={"access_token": "tok-first",
                              "expires_in": "3599"}),
        FakeResponse(payload={"access_token": "tok-second",
                              "expires_in": "3599"}),
    ])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke", "k", "s")
    first, gen = tm.get_token_with_gen()
    assert first == "tok-first" and gen == 1
    fresh = tm.refresh_after_invalid_token(gen)
    assert fresh == "tok-second"
    assert tm.generation == gen + 1
    assert len(session.calls) == 2


# ---- B1: a forced refresh must reach the wire, gate or no gate --------------
#
# The single-flight round publishes its failure to every waiter. That is
# right for a round's OWN waiters, but a FORCED refresh (401-triggered) must
# not inherit a NON-forced round's refusal: the rate-limit gate refuses
# NON-forced refreshes ONLY, so inheriting that refusal denies the forced
# refresh the very thing it exists to do -- put a request on the wire.


class GatedRefreshManager(TokenManager):
    """A TokenManager whose refresh can be parked at a chosen point.

    WHY: the single-flight protocol is only observable when one refresh is
    provably IN FLIGHT while another caller arrives. A sleep-based
    approximation is a race (and a flaky one); an EVENT makes the
    interleaving exact and reproducible.
    """

    def __init__(self, session, base_url, consumer_key, consumer_secret,
                 now=None):
        super().__init__(session, base_url, consumer_key, consumer_secret,
                         now=now)
        # Which mode parks: "non-forced", "forced" or both.
        self.park_non_forced = False
        self.park_forced = False
        self.parked = threading.Event()
        self.resume = threading.Event()

    def _refresh(self, force: bool = False) -> str:
        if (self.park_forced if force else self.park_non_forced):
            # The round is already claimed (so a peer sees _refreshing ==
            # True) but the OAuth leg has not started: park HERE.
            self.parked.set()
            self.resume.wait(timeout=10.0)
        return super()._refresh(force=force)


def test_forced_refresh_does_not_inherit_a_peers_rate_limit_refusal():
    """B1: a FORCED refresh must not inherit a NON-forced round's refusal.

    The rate-limit gate refuses NON-forced refreshes only -- a forced
    (401-triggered) refresh always reaches the wire. When a forced refresher
    parked on a peer's NON-forced round and that round was refused by the
    closed gate, it inherited the refusal and never touched the wire: the
    exact denial it was meant to bypass.
    """
    # Arm the gate: three consecutive NON-forced failures.
    session = FakeSession([FakeResponse(status_code=500, body=b"boom")
                           for _ in range(4)])
    tm = GatedRefreshManager(session, "https://sandbox.safaricom.co.ke",
                             "k", "s")
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
    assert len(session.calls) == 3

    # The peer: a NON-forced refresh that parks mid-round (its round is
    # claimed, so a concurrent caller sees a refresh in flight). The gate is
    # closed, so the peer will be REFUSED once it resumes.
    counting = CountingCondition(tm._lock)
    counting.expected = 1
    tm._cond = counting
    tm.park_non_forced = True

    peer_errors: list[BaseException] = []

    def peer():
        try:
            tm.get_token()
        except Exception as exc:          # the point of the test
            peer_errors.append(exc)

    peer_thread = threading.Thread(target=peer)
    peer_thread.start()
    assert tm.parked.wait(timeout=5.0), "the peer's refresh never started"

    # The forced refresher arrives while the peer's NON-forced round is in
    # flight: it must park on that round -- and must not be woken by the
    # round's failure with the rate-limit refusal.
    forced_errors: list[BaseException] = []

    def forced():
        try:
            tm.refresh_after_invalid_token(tm.generation)
        except Exception as exc:          # the point of the test
            forced_errors.append(exc)

    forced_thread = threading.Thread(target=forced)
    forced_thread.start()
    assert counting.parked.wait(timeout=5.0), "the forced refresher never parked"

    # The peer resumes and is refused by the closed gate.
    tm.resume.set()
    peer_thread.join(timeout=10.0)
    assert not peer_thread.is_alive(), "the peer hung"
    assert len(peer_errors) == 1
    assert isinstance(peer_errors[0], RefreshRateLimitedError)

    forced_thread.join(timeout=10.0)
    assert not forced_thread.is_alive(), "the forced refresher hung"

    # The forced refresh reached the wire: ONE more OAuth call, and the
    # error it raised is the gateway's -- NOT the rate-limit refusal.
    assert len(session.calls) == 4, "the forced refresh never reached the wire"
    assert len(forced_errors) == 1
    assert not isinstance(forced_errors[0], RefreshRateLimitedError)
    assert isinstance(forced_errors[0], MpesaError)


def test_forced_round_failure_is_shared_with_its_own_waiters():
    """B1: a FORCED round's failure IS shared with its own waiters.

    The anti-stampede property must survive the B1 fix: one failed forced
    refresh, ONE wire call, and every waiter woken with the same error.
    """
    workers = 5
    session = FakeSession([FakeResponse(status_code=500, body=b"boom")
                           for _ in range(workers + 1)])
    tm = GatedRefreshManager(session, "https://sandbox.safaricom.co.ke",
                             "k", "s")
    counting = CountingCondition(tm._lock)
    counting.expected = workers - 1
    tm._cond = counting
    tm.park_forced = True

    errors: list[BaseException] = []
    barrier = threading.Barrier(workers)

    def worker():
        barrier.wait()
        try:
            tm.refresh_after_invalid_token(tm.generation)
        except Exception as exc:          # the point of the test
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    # The leader is parked inside its OAuth leg; every other caller is
    # parked on the condition.
    assert tm.parked.wait(timeout=5.0), "the forced refresh never started"
    assert counting.parked.wait(timeout=5.0), "the waiters never parked"
    tm.resume.set()

    for t in threads:
        t.join(timeout=10.0)
    assert not [t for t in threads if t.is_alive()], "a waiter hung"
    assert len(errors) == workers
    # ONE wire call: the waiters did not each run their own request.
    assert len(session.calls) == 1, "the waiters each ran their own request"
    # Every waiter was woken with the SAME error.
    first = errors[0]
    assert all(type(exc) is type(first) for exc in errors)
    assert all(str(exc) == str(first) for exc in errors)
    assert isinstance(first, MpesaError)
