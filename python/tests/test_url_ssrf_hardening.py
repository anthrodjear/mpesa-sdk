"""SSRF hardening tests for callback/result URL validation.

Cross-language parity: python/mpesa/requests_sync.py ``_url`` used to
perform only a shape check (absolute http(s), no control characters) and
happily accepted ``http://localhost/hook`` or ``http://169.254.169.254/``.
These tests pin the closed behaviour against go/requests.go ``requireURL``
and typescript/src/client.ts ``requireURL`` + ``isBlockedIP``/``isBlockedIPv4``.

Two layers are covered: the validator helper directly (exact reasons and
boundary pairs) and every request model that calls it, so the guard is
proven wired on both the sync and the async credential paths.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.enums import CommandID, ResponseType, TransactionType  # noqa: E402
from mpesa.requests_async import (  # noqa: E402
    AccountBalanceRequest,
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from mpesa.requests_sync import (  # noqa: E402
    C2BRegisterRequest,
    STKPushRequest,
    _url,
)

PUBLIC = "https://mydomain.com/path"


def stk(**over):
    fields = dict(
        business_short_code="174379",
        transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
        amount=1, party_a="254722000000", party_b="174379",
        phone_number="254722111111", call_back_url=PUBLIC,
        account_reference="accountref", transaction_desc="txndesc",
    )
    fields.update(over)
    return STKPushRequest(**fields)


def b2c(**over):
    fields = dict(
        initiator_name="i", security_credential="c",
        command_id=CommandID.BUSINESS_PAYMENT, amount=10,
        originator_conversation_id="oc-1", party_a="600992",
        party_b="254705912645", remarks="ok",
        queue_time_out_url=PUBLIC, result_url=PUBLIC,
    )
    fields.update(over)
    return B2CPayoutRequest(**fields)


# --------------------------------------------------------------------------
# The seven ranges named in the finding, plus the surrounding boundaries.
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url,reason",
    [
        # 127.0.0.0/8 loopback
        ("http://127.0.0.1/hook", "loopback"),
        ("https://127.0.0.1:8080/hook", "loopback"),
        ("http://127.255.255.254/hook", "loopback"),  # upper edge of /8
        # 10.0.0.0/8 private
        ("http://10.0.0.1/hook", "private"),
        ("http://10.255.255.255/hook", "private"),
        # 192.168.0.0/16 private
        ("http://192.168.1.1/hook", "private"),
        ("http://192.168.0.1/hook", "private"),
        # 172.16.0.0/12 private
        ("http://172.16.0.1/hook", "private"),
        ("http://172.31.255.254/hook", "private"),   # upper edge of /12
        # 169.254.0.0/16 link-local -- the cloud metadata address
        ("http://169.254.169.254/latest/meta-data", "link-local"),
        # unspecified
        ("http://0.0.0.0/hook", "unspecified"),
        # 224.0.0.0/4 multicast
        ("http://224.0.0.1/hook", "multicast"),
        ("http://239.255.255.255/hook", "multicast"),
    ],
)
def test_ipv4_internal_literals_rejected(url, reason):
    with pytest.raises(ValueError) as excinfo:
        _url("CallBackURL", url)
    message = str(excinfo.value)
    assert "mpesa: CallBackURL" in message
    assert "internal or private IP address" in message
    assert reason in message


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/hook",
        "https://localhost/hook",
        "http://LOCALHOST/hook",            # case-insensitive
        "http://LocalHost./hook",           # trailing-dot FQDN form
        "http://localhost:3000/hook",
    ],
)
def test_localhost_rejected(url):
    with pytest.raises(ValueError, match="must not point to localhost"):
        _url("ResultURL", url)


@pytest.mark.parametrize(
    "url,reason",
    [
        ("http://[::1]/hook", "loopback"),
        ("http://[::]/hook", "unspecified"),
        ("http://[fe80::1]/hook", "link-local"),
        ("http://[fe80::abcd:1234]/hook", "link-local"),   # upper edge /10
        ("http://[fc00::1]/hook", "unique-local"),
        ("http://[fd12:3456:789a::1]/hook", "unique-local"),
        ("http://[ff02::1]/hook", "multicast"),
    ],
)
def test_ipv6_internal_literals_rejected(url, reason):
    with pytest.raises(ValueError) as excinfo:
        _url("QueueTimeOutURL", url)
    message = str(excinfo.value)
    assert "internal or private IP address" in message
    assert reason in message


@pytest.mark.parametrize(
    "url,reason",
    [
        # IPv4-mapped IPv6 must be judged as the v4 address it embeds --
        # the IPv6 scope predicates alone would let loopback through.
        ("http://[::ffff:127.0.0.1]/hook", "loopback"),
        ("http://[::ffff:10.0.0.1]/hook", "private"),
        ("http://[::ffff:169.254.169.254]/hook", "link-local"),
        # Percent-encoded IPv6 zone id: ipaddress cannot parse the scoped form.
        ("http://[fe80::1%25eth0]/hook", "link-local"),
    ],
)
def test_mapped_and_zoned_ipv6_rejected(url, reason):
    with pytest.raises(ValueError) as excinfo:
        _url("CallBackURL", url)
    assert "internal or private IP address" in str(excinfo.value)
    assert reason in str(excinfo.value)


@pytest.mark.parametrize(
    "url",
    [
        "http://user:pass@mydomain.com/hook",
        "https://user:pass@mydomain.com/hook",
        "http://user@mydomain.com/hook",      # username only
        "http://:pass@mydomain.com/hook",      # password only
        "http://@mydomain.com/hook",           # empty userinfo is still userinfo
    ],
)
def test_embedded_credentials_rejected(url):
    with pytest.raises(ValueError, match="must not contain embedded credentials"):
        _url("CallBackURL", url)


@pytest.mark.parametrize(
    "url,fragment",
    [
        ("http:///hook", "non-empty host"),
        ("http://:8080/hook", "valid host"),
        ("https://mydomain.com:0/hook", "valid host"),
        ("https://mydomain.com:notaport/hook", "not a valid URL"),
    ],
)
def test_malformed_authority_rejected(url, fragment):
    with pytest.raises(ValueError, match=fragment):
        _url("CallBackURL", url)


# --------------------------------------------------------------------------
# Public hosts must keep working -- the guard must not become a foot-gun.
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/hook",
        "https://sandbox.safaricom.co.ke",
        "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        "https://mydomain.com/path",
        "https://mydomain.com:8443/hook",
        "https://sub.domain.example.co.ke/hook",
        "https://user-facing-brand.com/hook",       # "user" is not userinfo
        "http://8.8.8.8/hook",                     # public IPv4
        "https://[2606:4700:4700::1111]/hook",     # public IPv6
        "http://172.15.0.1/hook",                  # just below 172.16/12
        "http://172.32.0.1/hook",                  # just above 172.16/12
        "http://192.167.1.1/hook",                 # just below 192.168/16
        "http://192.169.1.1/hook",                 # just above 192.168/16
        "http://11.0.0.1/hook",                    # just above 10/8
        "http://169.253.0.1/hook",                 # just below 169.254/16
        "http://126.255.255.255/hook",             # just below 127/8
        "http://223.255.255.255/hook",             # just below 224/4
        "http://240.0.0.1/hook",                   # out of 224/4 multicast
        "http://0.0.0.1/hook",                     # not the unspecified addr
        "https://not-localhost.com/hook",          # name merely contains it
        "https://localhost.example.com/hook",
    ],
)
def test_public_urls_accepted(url):
    _url("CallBackURL", url)  # must not raise


# --------------------------------------------------------------------------
# Wiring: the guard is live on every model that carries a callback/result URL.
# --------------------------------------------------------------------------

@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/hook",
        "http://127.0.0.1/hook",
        "http://10.0.0.1/hook",
        "http://192.168.1.1/hook",
        "http://172.16.0.1/hook",
        "http://169.254.169.254/latest/meta-data",
        "http://0.0.0.0/hook",
        "http://user:pass@mydomain.com/hook",
    ],
)
def test_stk_call_back_url_rejects_internal_host(url):
    with pytest.raises(ValueError, match="mpesa: CallBackURL"):
        stk(call_back_url=url).validate()


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1/hook", "http://localhost/hook", "http://10.0.0.1/h"],
)
def test_c2b_urls_reject_internal_host(url):
    req = C2BRegisterRequest(short_code="600992",
                             response_type=ResponseType.COMPLETED,
                             confirmation_url=url, validation_url=PUBLIC)
    with pytest.raises(ValueError, match="mpesa: ConfirmationURL"):
        req.validate()
    req = C2BRegisterRequest(short_code="600992",
                             response_type=ResponseType.COMPLETED,
                             confirmation_url=PUBLIC, validation_url=url)
    with pytest.raises(ValueError, match="mpesa: ValidationURL"):
        req.validate()


@pytest.mark.parametrize("url", ["http://127.0.0.1/hook", "http://localhost/hook"])
def test_b2c_urls_reject_internal_host(url):
    with pytest.raises(ValueError, match="mpesa: QueueTimeOutURL"):
        b2c(queue_time_out_url=url).validate()
    with pytest.raises(ValueError, match="mpesa: ResultURL"):
        b2c(result_url=url).validate()


@pytest.mark.parametrize("url", ["http://127.0.0.1/hook", "http://169.254.169.254/h"])
def test_async_credential_models_reject_internal_host(url):
    with pytest.raises(ValueError, match="mpesa: ResultURL"):
        TransactionStatusRequest(initiator="i", security_credential="c",
                                 transaction_id="NLJ7RT61SV", party_a="600992",
                                 remarks="r", result_url=url,
                                 queue_time_out_url=PUBLIC).validate()
    with pytest.raises(ValueError, match="mpesa: ResultURL"):
        ReversalRequest(initiator="i", security_credential="c",
                        transaction_id="T", amount=10, receiver_party="600992",
                        remarks="ok", result_url=url,
                        queue_time_out_url=PUBLIC).validate()
    with pytest.raises(ValueError, match="mpesa: QueueTimeOutURL"):
        AccountBalanceRequest(initiator="i", security_credential="c",
                              party_a="600992", remarks="r",
                              queue_time_out_url=url, result_url=PUBLIC).validate()


def test_stk_public_callback_still_validates_and_pays_out():
    req = stk(call_back_url="https://example.com/hook")
    req.validate()
    assert req.to_payload()["CallBackURL"] == "https://example.com/hook"


def test_b2c_public_urls_still_validate():
    req = b2c(queue_time_out_url="https://example.com/hook",
              result_url="https://sandbox.safaricom.co.ke")
    req.validate()
    payload = req.to_payload()
    assert payload["QueueTimeOutURL"] == "https://example.com/hook"
    assert payload["ResultURL"] == "https://sandbox.safaricom.co.ke"
