"""Tests for mpesa.auth -- generation-guarded token cache semantics."""

import json
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
    with pytest.raises(Exception):
        tm.refresh_after_invalid_token(stale_gen)
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
    inside _refresh_locked would blow up as AttributeError."""

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
            TokenManager(FakeSession([]), "https://x", key, secret)


def test_cadence_clamp_edges():
    # Inputs are post-coercion ints (OAuthToken.expires_in_seconds domain).
    cases = {30: 1.0, 61: 1.0, 62: 2.0, 3060: 3000.0, None: 3000.0}
    for expires, want in cases.items():
        assert TokenManager._cadence(expires) == want


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
