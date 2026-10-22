"""Regression tests for the Y-hardening round (rate-limit clock, masking,
STKQuery shortcode, accounting docs, small hardening, robustness).

Each test pins one Y-item so a future change must argue with the test
that named it.
"""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.auth import TokenManager
from mpesa.callback_token import callback_token_equal
from mpesa.client import MpesaClient, _daily_boundary
from mpesa.config import Config
from mpesa.exceptions import MpesaError, RefreshRateLimitedError
from mpesa.requests_sync import STKQueryRequest, _ip_literals, _url

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
CB = "https://mydomain.com/path"


class FakeOAuthFail:
    """OAuth leg that always fails with a typed gateway error."""

    def __init__(self):
        self.calls = 0
        self.verify = True

    def get(self, url, **kwargs):
        self.calls += 1

        class _Resp:
            status_code = 500
            headers = {"content-type": "application/json"}

            def iter_content(self, _size):
                yield b'{"requestId":"r","errorCode":"500.001.1001"}'

            def close(self):
                pass

        return _Resp()


class Clock:
    def __init__(self, start=T0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += timedelta(seconds=seconds)


# ---- Y1: forced failures advance the rate-limit clock -----------------------


def test_forced_failures_advance_rate_limit_clock():
    """3 forced (401-triggered) failures must arm the 4th non-forced guard.

    Before the fix, forced refreshes skipped the ``_last_attempt`` update,
    so a crash loop of forced failures left the clock stale (None) and the
    next non-forced refresh escaped the 3-in-5s gate.
    """
    clock = Clock()
    session = FakeOAuthFail()
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "k", "s", now=clock)
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.refresh_after_invalid_token(tm.generation)
    assert tm._failures == 3
    assert tm._last_attempt == T0
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()
    assert session.calls == 3


def test_forced_refresh_still_bypasses_guard_after_fix():
    """Documented behavior: forced refreshes bypass the guard itself."""
    clock = Clock()
    session = FakeOAuthFail()
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "k", "s", now=clock)
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()
    # Forced bypasses the guard (fails with the gateway error, not limited).
    with pytest.raises(MpesaError):
        tm.refresh_after_invalid_token(tm.generation)
    assert session.calls == 4


def test_refused_refresh_does_not_advance_rate_limit_clock():
    """A REFUSED (rate-limited) refresh is not an attempt: it must leave
    both the failure counter and the ``_last_attempt`` clock untouched.

    The guard in ``_refresh`` raises BEFORE the ``_last_attempt``
    assignment, so a refusal cannot push the 3-in-5s window forward. If
    it did, the window would be measured from the refusal time instead
    of the last real attempt and a later attempt would stay refused.
    """
    clock = Clock()
    session = FakeOAuthFail()
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "k", "s", now=clock)
    # Arm the guard: three consecutive failures at T0, T0+1s, T0+2s.
    for _ in range(3):
        with pytest.raises(MpesaError):
            tm.get_token()
        clock.advance(1)
    assert tm._failures == 3
    assert tm._last_attempt == T0 + timedelta(seconds=2)
    # 4th non-forced attempt inside the 5s window: refused.
    with pytest.raises(RefreshRateLimitedError):
        tm.get_token()
    # The refusal is not an attempt: no network call, no clock advance,
    # no counter bump.
    assert session.calls == 3
    assert tm._last_attempt == T0 + timedelta(seconds=2)
    assert tm._failures == 3
    # At T0+7.5s the attempt is "within window" of a refusal that happened
    # at T0+3s (4.5s < 5s), but 5.5s after the last REAL attempt. Only if
    # the refusal had advanced the clock would this still be refused.
    clock.advance(4.5)
    with pytest.raises(MpesaError):
        tm.get_token()
    assert session.calls == 4
    assert tm._failures == 4


# ---- Y3: STKQuery shortcode validation --------------------------------------


@pytest.mark.parametrize("bad", ["abc", "1234", "12345678901", "17437A",
                                 "17 4379", "   ", ""])
def test_stkquery_model_rejects_bad_shortcode(bad):
    with pytest.raises(ValueError, match="BusinessShortCode"):
        STKQueryRequest(business_short_code=bad,
                        checkout_request_id="ws_CO_1").validate()


def test_stkquery_model_accepts_good_shortcode():
    req = STKQueryRequest(business_short_code="174379",
                          checkout_request_id="ws_CO_1")
    req.validate()
    assert req.to_payload()["BusinessShortCode"] == "174379"


def test_stkquery_client_rejects_garbage_before_network():
    class FakeSession:
        def __init__(self):
            self.headers = {}
            self.adapters = {}
            self.verify = True
            self.calls = []

        def request(self, *a, **k):
            self.calls.append(k)
            raise AssertionError("must not reach network")

        def get(self, *a, **k):
            self.calls.append(k)
            raise AssertionError("must not reach network")

    session = FakeSession()
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=session)
    client = MpesaClient(cfg)
    with pytest.raises(ValueError, match="BusinessShortCode"):
        client.stk_query(STKQueryRequest(business_short_code="garbage!",
                                         checkout_request_id="ws_CO_1"))
    assert session.calls == []


# ---- Y5a: naive daily boundary ----------------------------------------------


def test_daily_boundary_rejects_naive_datetime():
    with pytest.raises(ValueError, match="timezone-aware"):
        _daily_boundary(datetime(2026, 1, 1, 12, 0, 0))
    # Aware still works (2026-01-01 12:00 UTC == 15:00 EAT).
    assert _daily_boundary(T0) == "2026-01-01"


# ---- Y5b: TokenManager TLS warning -------------------------------------------


def test_token_manager_warns_on_disabled_verify():
    class NoTLS:
        verify = False

        def get(self, *a, **k):
            raise AssertionError("must not reach network")

    with pytest.warns(UserWarning, match="TLS verification disabled"):
        TokenManager(NoTLS(), "https://sandbox.safaricom.co.ke", "k", "s")


def test_token_manager_silent_when_verifying():
    import warnings

    class TLS:
        verify = True

        def get(self, *a, **k):
            raise AssertionError("must not reach network")

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        TokenManager(TLS(), "https://sandbox.safaricom.co.ke", "k", "s")


def test_token_manager_warns_on_falsy_verify_zero():
    class ZeroVerify:
        verify = 0

        def get(self, *a, **k):
            raise AssertionError("must not reach network")

    with pytest.warns(UserWarning, match="TLS verification disabled"):
        TokenManager(ZeroVerify(), "https://sandbox.safaricom.co.ke",
                     "k", "s")


# ---- Y6: robustness ----------------------------------------------------------


@pytest.mark.parametrize("expected,provided", [
    (None, "tok"),
    ("tok", None),
    (None, None),
    (123, "tok"),
    ("tok", 123),
    (b"tok", "tok"),
    ("tok", b"tok"),
    (["tok"], "tok"),
])
def test_callback_token_equal_non_string_is_false(expected, provided):
    assert callback_token_equal(expected, provided) is False


def test_client_rejects_non_numeric_timeout():
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, timeout_seconds="fast")
    with pytest.raises(ValueError, match="timeout_seconds"):
        MpesaClient(cfg)


@pytest.mark.parametrize("url", [
    "HTTP://mydomain.com/path",
    "HTTPS://mydomain.com/path",
    "Http://mydomain.com/path",
    "hTTp://mydomain.com/path",
])
def test_url_accepts_case_insensitive_scheme(url):
    _url("CallBackURL", url)


def test_zone_strip_is_ipv6_only():
    # IPv4 with a "%" suffix must NOT be silently normalized to the bare IP.
    assert _ip_literals("8.8.8.8%09") == []
    # IPv6 scoped literals still strip the zone and judge the address.
    assert _ip_literals("fe80::1%eth0") != []
    _url("CallBackURL", "http://8.8.8.8%09/hook")
