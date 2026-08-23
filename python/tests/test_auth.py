"""Tests for mpesa.auth -- generation-guarded token cache semantics."""

import sys
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.auth import TokenManager  # noqa: E402

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


class FakeResponse:
    def __init__(self, status_code=200, payload=None, body=b""):
        self.status_code = status_code
        self._payload = payload
        self.content = body if body else (
            __import__("json").dumps(payload).encode() if payload is not None
            else b"")
        self.headers = {"content-type": "application/json"}

    def json(self):
        import json as _json
        return _json.loads(self.content)


class FakeSession:
    """Programmable session recording every OAuth call."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def get(self, url, timeout=None, headers=None):
        self.calls.append({"url": url, "timeout": timeout,
                           "headers": headers})
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
