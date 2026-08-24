"""Regression: transport against REAL ``requests.Response`` objects.

History: ``client._send`` once assigned ``response.content`` -- a
getter-only property on ``requests.Response`` -- so EVERY live request
died with AttributeError while duck-typed fakes (which allow attribute
writes) kept the suite green. These tests build genuine
``requests.models.Response`` instances whose ``raw`` wraps a real
``urllib3.HTTPResponse`` over an in-memory stream, then drive them
through ``_send``/``_post_model`` end-to-end proving:

* no AttributeError anywhere in the pipeline (OAuth + business legs),
* the connection is closed exactly once on success paths,
* the connection is still released when the read aborts mid-stream,
* the ``(status_code, content_type, body)`` tuple feeds typed errors.
"""

import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from requests import Response  # noqa: E402
from requests.structures import CaseInsensitiveDict  # noqa: E402
from urllib3.response import HTTPResponse as Urllib3HTTPResponse  # noqa: E402

from mpesa.auth import TokenManager  # noqa: E402
from mpesa.client import MpesaClient  # noqa: E402
from mpesa.config import Config  # noqa: E402
from mpesa.exceptions import MpesaError  # noqa: E402
from mpesa.requests_sync import STKPushRequest  # noqa: E402

T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"

OAUTH_OK = b'{"access_token":"tok-real","expires_in":"3599"}'
STK_OK = (b'{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
          b'"ResponseCode":"0","ResponseDescription":"ok",'
          b'"CustomerMessage":"Success"}')
UNAUTHORIZED_401 = (b'{"requestId":"r","errorCode":"401.003.01",'
                    b'"errorMessage":"Invalid Access Token"}')


class RealResponse(Response):
    """A genuine requests.Response backed by urllib3.HTTPResponse.

    Mirrors what ``requests.Session`` hands back on a streamed request:
    ``iter_content`` pulls through ``raw.stream(...)`` and ``close()``
    releases the underlying connection -- except close() is counted so
    tests can prove the try/finally release guarantee.
    """

    def __init__(self, status_code=200, body=b"{}",
                 content_type="application/json"):
        super().__init__()
        self.status_code = status_code
        self.reason = "OK"
        self.headers = CaseInsensitiveDict({"content-type": content_type})
        self.raw = Urllib3HTTPResponse(
            body=io.BytesIO(body), status=status_code,
            headers={"content-type": content_type}, preload_content=False)
        self.url = "https://sandbox.safaricom.co.ke/test"
        self.closed_calls = 0

    def close(self):
        self.closed_calls += 1
        super().close()


class RealSession:
    """Duck-typed session whose queue holds genuine Response objects."""

    def __init__(self, responses):
        self.headers = {}
        self.adapters = {}
        self.verify = False
        self.calls = []
        self.queue = list(responses)

    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url, "json": json,
                           "params": params, "timeout": timeout,
                           "allow_redirects": allow_redirects,
                           "headers": headers, "stream": stream})
        return self.queue.pop(0)

    def get(self, url, **kwargs):
        self.calls.append({"kind": "GET", "url": url, **kwargs})
        return self.queue.pop(0)


def make(queue):
    session = RealSession(queue)
    cfg = Config(consumer_key="key", consumer_secret="secret",
                 shortcode="174379", passkey=PASSKEY,
                 now=lambda: T0, http_client=session)
    return MpesaClient(cfg), session


def valid_stk():
    return STKPushRequest(
        transaction_type="CustomerPayBillOnline", amount=1,
        party_a="0722000000", phone_number="0722000000",
        call_back_url="https://x.com/cb",
        account_reference="Order001", transaction_desc="pay")


def test_real_requests_responses_end_to_end_no_attribute_error():
    """THE regression: OAuth + business legs on genuine Responses must
    parse into models instead of dying on getter-only .content."""
    oauth_resp = RealResponse(body=OAUTH_OK)
    business_resp = RealResponse(body=STK_OK)
    client, session = make([oauth_resp, business_resp])

    resp = client.stk_push(valid_stk())   # used to raise AttributeError

    assert resp.is_accepted is True
    assert resp.checkout_request_id == "ws_CO_1"
    posts = [c for c in session.calls if c["kind"] == "POST"]
    assert len(posts) == 1
    assert posts[0]["headers"]["Authorization"] == "Bearer tok-real"
    assert oauth_resp.closed_calls == 1       # released after streaming read
    assert business_resp.closed_calls == 1    # ...on both legs


def test_real_response_401_retry_once_succeeds_and_closes_all():
    unauthorized = RealResponse(status_code=401, body=UNAUTHORIZED_401)
    token_two = RealResponse(
        body=b'{"access_token":"tok-2","expires_in":"3599"}')
    retried = RealResponse(body=STK_OK)
    client, session = make([RealResponse(body=OAUTH_OK),
                            unauthorized, token_two, retried])

    resp = client.stk_push(valid_stk())

    assert resp.is_accepted is True           # retry consumed the fresh bearer
    assert len(session.calls) == 4            # oauth, 401, tok2, retry
    assert session.calls[-1]["headers"]["Authorization"] == "Bearer tok-2"
    assert unauthorized.closed_calls == 1     # probe leg released
    assert token_two.closed_calls == 1        # refresh leg released
    assert retried.closed_calls == 1          # retry leg released


def test_real_response_midstream_abort_still_releases_connection():
    oversized = ('{"MerchantRequestID":"m","CheckoutRequestID":"c",'
                 '"ResponseCode":"0","ResponseDescription":"d",'
                 '"CustomerMessage":"' + "A" * 1_048_600 + '"}')
    doomed = RealResponse(body=oversized.encode())
    client, _ = make([RealResponse(body=OAUTH_OK), doomed])

    with pytest.raises(ValueError, match="exceeds"):
        client.stk_push(valid_stk())

    assert doomed.closed_calls == 1           # finally ran despite the abort


def test_real_response_non_2xx_typed_error_carries_content_type():
    waf_page = RealResponse(status_code=500, body=b"<html>blocked</html>",
                            content_type="text/html")
    client, _ = make([RealResponse(body=OAUTH_OK), waf_page])

    with pytest.raises(MpesaError) as excinfo:
        client.stk_push(valid_stk())

    assert excinfo.value.status_code == 500
    assert excinfo.value.error_code is None   # hostile body -> diagnostic text
    assert "text/html" in excinfo.value.error_message
    assert waf_page.closed_calls == 1


def test_oauth_refresh_with_real_response_releases_connection():
    oauth_resp = RealResponse(body=OAUTH_OK)
    session = RealSession([oauth_resp])
    tm = TokenManager(session, "https://sandbox.safaricom.co.ke",
                      "key", "secret")

    assert tm.get_token() == "tok-real"
    assert session.calls[0]["stream"] is True  # streamed read, as in prod
    assert oauth_resp.closed_calls == 1        # auth.py finally-close parity
