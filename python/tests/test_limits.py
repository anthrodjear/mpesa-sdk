"""Tests for mpesa.limits -- configurable per-merchant transaction limits.

WHY THIS MODULE EXISTS: Safaricom grades each merchant into a tier, and the
grading changes without an SDK release. A ceiling hardcoded in this package
rejected an upgraded merchant (the SDK became the outage) and forced a new
release to fix; the bounds are therefore CONFIG. The standard Safaricom
default is KES 250,000 per transaction and KES 500,000 per day
(docs/apis/b2c.md is normative); higher tiers are explicit
TransactionLimits overrides, not defaults.

Covered here: the default per-service ceilings, raising and lowering them,
the partial-config merge ("unset" inherits, an explicit "0" is unlimited),
the magnitude guard that is NOT a tier ceiling, the opt-in daily
accumulator (including the Africa/Nairobi day boundary and thread safety),
and agreement between the sync and async request paths -- which have
drifted before.
"""

import sys
import threading
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import requests  # after the sys.path insert, as in the suite

from mpesa import MpesaClient
from mpesa.config import Config
from mpesa.enums import CommandID, QRTrxCode, TransactionType
from mpesa.exceptions import MpesaError
from mpesa.limits import (
    DEFAULT_TRANSACTION_LIMITS,
    ServiceLimits,
    TransactionLimits,
    _resolved_max,
)
from mpesa.limits import (
    _resolve_transaction_limits as _resolve,
)
from mpesa.requests_async import (
    B2CPayoutRequest,
    ReversalRequest,
    TransactionStatusRequest,
)
from mpesa.requests_sync import (
    C2BSimulateRequest,
    QRCodeRequest,
    STKPushRequest,
    _service_limits,
)

PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
CB = "https://mydomain.com/path"
#: 2026-01-01 12:00 UTC == 15:00 Africa/Nairobi (UTC+3, no DST).
T0 = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)


class FakeResponse:
    """Minimal streaming fake: iter_content + close, as read_capped needs."""

    def __init__(self, status_code=200, text="{}"):
        self.status_code = status_code
        self.content = text.encode()
        self.headers = {"content-type": "application/json"}

    def iter_content(self, chunk_size):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]

    def close(self):
        pass


class FakeSession:
    """Duck-typed session replaying canned responses.

    Exhausting the queue raises instead of repeating a reply: a silent
    repeat returns the WRONG body shape for the next endpoint and the test
    then fails somewhere unrelated, which is exactly the kind of mystery
    this suite exists to prevent.
    """

    def __init__(self, queue):
        self.queue = list(queue)
        self.calls = []
        self.headers = {}           # the client snapshots these
        self.adapters = {
            "https://": requests.adapters.HTTPAdapter(),
            "http://": requests.adapters.HTTPAdapter(),
        }

    def request(self, method, url, json=None, params=None, timeout=None,
                allow_redirects=True, headers=None, stream=False):
        self.calls.append({"kind": method, "url": url, "json": json})
        if not self.queue:
            raise AssertionError(
                f"test queue exhausted at {method} {url}: add more canned "
                f"responses to make_client(...)")
        return self.queue.pop(0)

    def get(self, url, **kwargs):
        self.calls.append({"kind": "GET", "url": url, **kwargs})
        if not self.queue:
            raise AssertionError(
                f"test queue exhausted at GET {url}: add a canned OAuth "
                f"response to make_client(...)")
        return self.queue.pop(0)


class Clock:
    """Advanceable UTC clock for the day-boundary tests."""

    def __init__(self, now=T0):
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def set(self, when: datetime) -> None:
        self.now = when


def _frozen(when: datetime) -> Any:
    return lambda: when


OAUTH_OK = FakeResponse(text='{"access_token":"tok-1","expires_in":"3599"}')
STK_OK = FakeResponse(text=(
    '{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1",'
    '"ResponseCode":"0","ResponseDescription":"ok","CustomerMessage":"ok"}'))
B2C_OK = FakeResponse(text=(
    '{"OriginatorConversationID":"o-1","ConversationID":"AG_1",'
    '"ResponseCode":"0","ResponseDescription":"Accept"}'))
QR_OK = FakeResponse(text=(
    '{"ResponseCode":"AG_x","RequestID":"r",'
    '"ResponseDescription":"QR Code Successfully Generated","QRCode":"imgdata"}'))
C2B_OK = FakeResponse(text=(
    '{"OriginatorCoversationID":"x","ResponseCode":"0",'
    '"ResponseDescription":"Success"}'))


def stk(**over):
    fields = dict(business_short_code="174379",
                  transaction_type=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                  amount=1, party_a="254722000000", party_b="174379",
                  phone_number="254722000000", call_back_url=CB,
                  account_reference="a", transaction_desc="b")
    fields.update(over)
    return STKPushRequest(**fields)


def b2c(**over):
    fields = dict(initiator_name="i", security_credential="c",
                  command_id=CommandID.BUSINESS_PAYMENT, amount=10,
                  originator_conversation_id="oc-1", party_a="600992",
                  party_b="254705912645", remarks="ok",
                  queue_time_out_url=CB, result_url=CB)
    fields.update(over)
    return B2CPayoutRequest(**fields)


def reversal(**over):
    fields = dict(initiator="i", security_credential="c",
                  command_id=CommandID.REVERSAL, transaction_id="NLJ7RT61SV",
                  amount=10, receiver_party="600992", remarks="duplicate",
                  result_url=CB, queue_time_out_url=CB)
    fields.update(over)
    return ReversalRequest(**fields)


def c2b_simulate(**over):
    fields = dict(short_code="174379",
                  command_id=TransactionType.CUSTOMER_PAY_BILL_ONLINE,
                  amount=5, msisdn="0712345678", bill_ref_number="acct")
    fields.update(over)
    return C2BSimulateRequest(**fields)


def qr(**over):
    fields = dict(merchant_name="m", ref_no="r", amount=1,
                  trx_code=QRTrxCode.BUY_GOODS, cpi="174379", size="300")
    fields.update(over)
    return QRCodeRequest(**fields)


def make_client(*replies, limits=None, track_daily=False, clock=T0):
    """Client with a canned queue: OAuth first, then the endpoint replies.

    ``clock`` is either a fixed datetime or a :class:`Clock` the test
    advances; either way ``Config.now`` sees the CURRENT value.
    """
    now = clock if callable(clock) else _frozen(clock)
    session = FakeSession([OAUTH_OK, *replies])
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=now, http_client=session,
                 limits=limits, track_daily=track_daily)
    return MpesaClient(cfg), session


# ---------------------------------------------------------------------------
# Data shape: the module is the contract other languages mirror
# ---------------------------------------------------------------------------

def test_defaults_match_the_documented_baseline():
    assert DEFAULT_TRANSACTION_LIMITS == TransactionLimits(
        stk=ServiceLimits(250_000, 500_000),
        c2b=ServiceLimits(250_000, 500_000),
        b2c=ServiceLimits(250_000, 500_000),
        default=ServiceLimits(250_000, 500_000),
        reversal=ServiceLimits(250_000, 500_000),
        qr=ServiceLimits(250_000, 500_000),
    )
    # Fields start UNSET on a fresh ServiceLimits; "unlimited" is written as
    # an explicit 0 (see test_explicit_zero_disables_only_that_ceiling).
    assert ServiceLimits().max_per_transaction is None
    assert TransactionLimits().b2c.max_per_transaction is None


def test_limits_are_importable_from_the_package_root():
    import mpesa as top
    for name in ("ServiceLimits", "TransactionLimits",
                 "DEFAULT_TRANSACTION_LIMITS"):
        assert getattr(top, name) is not None


def test_config_validates_limits_and_track_daily_types():
    assert Config().limits is None            # None -> defaults
    assert Config().track_daily is False       # opt-in, off by default
    assert Config(limits=DEFAULT_TRANSACTION_LIMITS).limits is \
        DEFAULT_TRANSACTION_LIMITS
    with pytest.raises(TypeError, match="TransactionLimits"):
        Config(limits="500000")
    with pytest.raises(TypeError, match="track_daily"):
        Config(track_daily=1)


# ---------------------------------------------------------------------------
# Per-service defaults enforced
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("build,service,ceiling", [
    (lambda a: stk(amount=a), "stk", 250_000),
    (lambda a: c2b_simulate(amount=a), "c2b", 250_000),
    (lambda a: b2c(amount=a), "b2c", 250_000),
    (lambda a: reversal(amount=a), "reversal", 250_000),
    (lambda a: qr(amount=a), "qr", 250_000),
])
def test_default_ceiling_boundary_is_exact(build, service, ceiling):
    build(ceiling).validate()                          # boundary: accepted
    with pytest.raises(ValueError) as excinfo:
        build(ceiling + 1).validate()
    message = str(excinfo.value)
    assert service in message
    assert str(ceiling) in message
    assert "Config(limits=TransactionLimits(" in message   # override guidance


def test_b2c_shares_standard_ceiling_by_default():
    """Safaricom default is 250k per transaction for B2C and STK alike."""
    b2c(amount=250_000).validate()                       # standard default
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=250_001).validate()
    with pytest.raises(ValueError, match="stk service"):
        stk(amount=300_000).validate()
    # A Safaricom-approved higher tier is an explicit override.
    higher = TransactionLimits(b2c=ServiceLimits(500_000, 2_500_000))
    b2c(amount=300_000).validate(higher)


def test_b2c_minimum_is_unchanged_by_the_ceiling_change():
    b2c(amount=10).validate()
    with pytest.raises(ValueError, match="10 KES minimum"):
        b2c(amount=9).validate()
    # Other services keep their own minimum (> 0), unchanged.
    stk(amount=1).validate()
    with pytest.raises(ValueError, match="positive whole number"):
        stk(amount=0).validate()


# ---------------------------------------------------------------------------
# Overriding the tier
# ---------------------------------------------------------------------------

def test_limits_raise_and_lower_a_ceiling():
    raised = TransactionLimits(stk=ServiceLimits(1_000_000, 3_000_000))
    stk(amount=900_000).validate(raised)               # accepted
    with pytest.raises(ValueError, match="1000000"):
        stk(amount=1_000_001).validate(raised)

    lowered = TransactionLimits(b2c=ServiceLimits(100_000, 300_000))
    b2c(amount=100_000).validate(lowered)
    with pytest.raises(ValueError, match="100000"):
        b2c(amount=100_001).validate(lowered)


def test_service_falls_back_to_default_for_unknown_service_names():
    """A spelled service that does not exist inherits ``default``."""
    odd = TransactionLimits(default=ServiceLimits(1_000, 2_000))
    # Reversal and QR have their OWN buckets, so ``default`` no longer
    # serves them: they stay on their inherited 250k baseline.
    reversal(amount=1_000).validate(odd)
    with pytest.raises(ValueError, match="reversal service"):
        reversal(amount=250_001).validate(odd)
    qr(amount=1_000).validate(odd)
    with pytest.raises(ValueError, match="qr service"):
        qr(amount=250_001).validate(odd)
    # An unknown service name still inherits ``default``.
    assert _service_limits("nonesuch", odd) == odd.default
    assert _service_limits("nonesuch", odd).max_per_transaction == 1_000


def test_each_service_field_is_resolved_independently():
    """``default`` never lends its ceiling to a service with its own field."""
    only_default = TransactionLimits(default=ServiceLimits(1_000))
    # STK overrides nothing, so it INHERITS its own default (not
    # ``default``'s 1k, and not "unlimited" either).
    stk(amount=249_999).validate(only_default)
    with pytest.raises(ValueError, match="stk service"):
        stk(amount=250_001).validate(only_default)
    # QR has its own field: ``default``'s 1k never reaches it, so QR
    # stays on its inherited 250k baseline.
    qr(amount=1_000).validate(only_default)
    with pytest.raises(ValueError, match="qr service"):
        qr(amount=250_001).validate(only_default)


def test_reversal_and_qr_spend_their_own_per_transaction_bucket():
    """A raised ``reversal``/``qr`` tier must reach the PER-TRANSACTION check.

    The DAILY path already spent the dedicated buckets (``"reversal"`` and
    ``"qr"``), so a service resolving to TWO different ceilings inside one
    engine meant a merchant who raised that tier to an approved Safaricom
    level was silently ignored on the per-transaction check.
    """
    dedicated = TransactionLimits(
        reversal=ServiceLimits(max_per_transaction=700_000),
        qr=ServiceLimits(max_per_transaction=700_000),
    )
    reversal(amount=300_000).validate(dedicated)
    qr(amount=300_000).validate(dedicated)

    # A ``default``-only override must NOT reach these two services: they
    # stay on their own (250k) baseline and the amount is still rejected.
    only_default = TransactionLimits(
        default=ServiceLimits(max_per_transaction=700_000))
    with pytest.raises(ValueError, match="reversal service"):
        reversal(amount=300_000).validate(only_default)
    with pytest.raises(ValueError, match="qr service"):
        qr(amount=300_000).validate(only_default)


def test_explicit_zero_disables_only_that_ceiling():
    """An explicit 0 is the ONLY way to say "no client-side cap"."""
    unlimited = TransactionLimits(
        stk=ServiceLimits(max_per_transaction=0),        # explicit unlimited
        default=ServiceLimits(max_per_transaction=-5),   # non-positive too
        reversal=ServiceLimits(max_per_transaction=-5),  # own bucket, same
    )
    # Past the old hardcoded ceiling, but under the magnitude guard.
    stk(amount=500_000_000).validate(unlimited)
    reversal(amount=500_000_000).validate(unlimited)
    # b2c is untouched, so its standard default ceiling still applies.
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=250_001).validate(unlimited)
    # The magnitude guard is NOT a tier: it still bites.
    with pytest.raises(ValueError, match="magnitude ceiling"):
        stk(amount=10 ** 5000).validate(unlimited)


# ---------------------------------------------------------------------------
# Partial-config merge semantics (the cross-language contract)
# ---------------------------------------------------------------------------

def test_empty_transaction_limits_inherits_every_default():
    """The exact regression: an all-unset config must NOT disable guards.

    Before the merge model, ``ServiceLimits()`` (all ``None``) read as
    "no ceiling at all", so ``TransactionLimits(b2c=<...>)`` silently
    turned off stk, c2b and default -- the opposite of what overriding one
    service should do.
    """
    assert _resolve(None) == DEFAULT_TRANSACTION_LIMITS
    assert _resolve(TransactionLimits()) == DEFAULT_TRANSACTION_LIMITS
    for build in (stk, c2b_simulate, reversal, qr):
        build(amount=250_000).validate(TransactionLimits())
        with pytest.raises(ValueError, match="per-transaction ceiling"):
            build(amount=250_001).validate(TransactionLimits())
    # b2c shares the standard baseline (250k per transaction).
    b2c(amount=250_000).validate(TransactionLimits())
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=250_001).validate(TransactionLimits())


def test_overriding_one_service_leaves_the_others_at_their_defaults():
    limits = TransactionLimits(b2c=ServiceLimits(1_500_000, 4_000_000))
    b2c(amount=1_500_000).validate(limits)               # the override
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=1_500_001).validate(limits)
    # Every other service still enforces its documented baseline.
    stk(amount=250_000).validate(limits)
    with pytest.raises(ValueError, match="stk service"):
        stk(amount=250_001).validate(limits)
    qr(amount=250_000).validate(limits)
    with pytest.raises(ValueError, match="per-transaction ceiling"):
        qr(amount=250_001).validate(limits)


def test_unset_field_inherits_while_its_sibling_stays_set():
    """Per FIELD, not per service: one unset bound only loses that bound."""
    half = ServiceLimits(max_per_transaction=1_000_000)   # day unset
    assert half.max_per_day is None
    resolved = _resolve(TransactionLimits(stk=half)).stk
    assert resolved.max_per_transaction == 1_000_000     # override kept
    assert resolved.max_per_day == 500_000               # inherited default
    # Enforced end-to-end: 1M per transaction, 500k per day.
    client, _ = make_client(STK_OK, STK_OK,
                            limits=TransactionLimits(stk=half),
                            track_daily=True)
    client.stk_push(stk(amount=300_000))
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.stk_push(stk(amount=300_000))   # 600k > the inherited 500k
    assert client.daily_spend == {"stk": 300_000}


def test_config_limits_none_is_exactly_the_baseline():
    assert Config(limits=None).limits is None
    client_default = MpesaClient(Config(
        consumer_key="k", consumer_secret="s", shortcode="174379",
        passkey=PASSKEY, now=Clock()))
    client_explicit = MpesaClient(Config(
        consumer_key="k", consumer_secret="s", shortcode="174379",
        passkey=PASSKEY, now=Clock(),
        limits=DEFAULT_TRANSACTION_LIMITS))
    assert client_default._limits == DEFAULT_TRANSACTION_LIMITS
    assert client_default._limits == client_explicit._limits
    # Same behaviour, not just the same object.
    for client in (client_default, client_explicit):
        with pytest.raises(ValueError, match="stk service"):
            client.stk_push(stk(amount=250_001))


def test_dataclasses_replace_override_path():
    """replace() on the baseline is the recommended override idiom."""
    limits = replace(DEFAULT_TRANSACTION_LIMITS,
                     b2c=ServiceLimits(max_per_transaction=1_000_000))
    b2c(amount=1_000_000).validate(limits)
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=1_000_001).validate(limits)
    # replace() kept every other field at its resolved default.
    assert limits.stk == DEFAULT_TRANSACTION_LIMITS.stk
    assert limits.c2b == DEFAULT_TRANSACTION_LIMITS.c2b
    assert limits.default == DEFAULT_TRANSACTION_LIMITS.default
    stk(amount=250_000).validate(limits)
    with pytest.raises(ValueError, match="stk service"):
        stk(amount=250_001).validate(limits)


def test_merge_is_idempotent_so_the_client_can_resolve_once():
    """Re-resolving already-merged limits changes nothing."""
    partial = TransactionLimits(b2c=ServiceLimits(1_000_000, 3_000_000))
    once = _resolve(partial)
    assert _resolve(once) == once
    assert _resolve(_resolve(once)) == once


def test_absurd_magnitudes_rejected_by_the_magnitude_guard_not_the_tier():
    """Separation of concerns: 10**5000 is a magnitude bug, not a tier hit."""
    with pytest.raises(ValueError) as excinfo:
        stk(amount=10 ** 5000).validate()
    message = str(excinfo.value)
    assert "magnitude ceiling" in message
    assert "not a merchant tier" in message
    # The error never stringifies the amount (CPython's 4300-digit guard).
    assert "4300 digits" not in message
    # A magnitude guard breach beats a tier breach: no ceiling message leaks.
    assert "per-transaction ceiling configured" not in message


def test_magnitude_guard_lets_a_raised_tier_through():
    """A 900M B2C payout passes the guard and fails only if a tier caps it."""
    big = TransactionLimits(b2c=ServiceLimits(max_per_transaction=900_000_000))
    b2c(amount=900_000_000).validate(big)
    with pytest.raises(ValueError, match="b2c service"):
        b2c(amount=900_000_001).validate(big)


# ---------------------------------------------------------------------------
# Daily accumulation (opt-in)
# ---------------------------------------------------------------------------

def test_daily_tracking_is_off_by_default_and_never_accumulates():
    client, session = make_client(B2C_OK)   # default limits: 250k/500k
    client.b2c_payout(b2c(amount=250_000))   # 500k would now exceed default
    assert client.daily_spend == {}          # not tracked
    assert session.calls[1]["kind"] == "POST"


def test_daily_ceiling_rejects_before_dispatch():
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 300_000))
    client, session = make_client(B2C_OK, limits=limits, track_daily=True)
    client.b2c_payout(b2c(amount=250_000))                 # 250k today
    with pytest.raises(ValueError) as excinfo:
        client.b2c_payout(b2c(amount=100_000))             # would total 350k
    message = str(excinfo.value)
    assert "per-day ceiling" in message
    assert "300000" in message
    assert "b2c" in message
    # The rejected payout NEVER reached the transport.
    assert len(session.calls) == 2        # OAuth + the accepted payout only
    assert client.daily_spend == {"b2c": 250_000}


def test_daily_boundary_rolls_over_at_nairobi_midnight():
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 300_000))
    clock = Clock()          # 2026-01-01 12:00 UTC == 15:00 EAT
    # The ~9h jump past the 3000s TTL re-fetches the token just before the
    # third payout, so a second OAUTH reply sits between the two payouts.
    client, _ = make_client(B2C_OK, OAUTH_OK, B2C_OK, limits=limits,
                            track_daily=True, clock=clock)
    client.b2c_payout(b2c(amount=250_000))

    # 23:59 EAT: still the same Nairobi day -- still capped.
    clock.set(datetime(2026, 1, 1, 20, 59, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.b2c_payout(b2c(amount=100_000))

    # 00:00 EAT (21:00 UTC): a new Nairobi day, so the quota resets.
    clock.set(datetime(2026, 1, 1, 21, 0, tzinfo=timezone.utc))
    client.b2c_payout(b2c(amount=100_000))       # accepted: fresh day
    assert client.daily_spend == {"b2c": 100_000}


def test_daily_boundary_is_not_utc_midnight():
    """Nairobi is UTC+3: a UTC-midnight boundary would reset three hours late."""
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 300_000))
    clock = Clock()
    # OAUTH in the middle: the 14h jump past the 3000s TTL re-fetches the
    # token before the second payout.
    client, _ = make_client(B2C_OK, OAUTH_OK, B2C_OK, limits=limits,
                            track_daily=True, clock=clock)
    client.b2c_payout(b2c(amount=250_000))
    # 2026-01-02 02:00 UTC == 05:00 EAT: a NEW Nairobi day, same UTC day.
    clock.set(datetime(2026, 1, 2, 2, 0, tzinfo=timezone.utc))
    client.b2c_payout(b2c(amount=100_000))
    assert client.daily_spend == {"b2c": 100_000}

    # 2026-01-01 20:59 UTC == 23:59 EAT: the SAME Nairobi day as 12:00 UTC,
    # so a 5k QR on top of 9k trips the 10k ceiling. QR is served by the
    # dedicated ``qr`` entry (not ``default``), so this also pins that rule.
    clock2 = Clock(datetime(2026, 1, 1, 20, 59, tzinfo=timezone.utc))
    same_day = TransactionLimits(qr=ServiceLimits(1_000_000, 10_000))
    client2, _ = make_client(QR_OK, limits=same_day,
                             track_daily=True, clock=clock2)
    client2.generate_qr_code(qr(amount=9_000))
    with pytest.raises(ValueError, match="per-day ceiling"):
        client2.generate_qr_code(qr(amount=5_000))


def test_daily_totals_are_per_service():
    limits = TransactionLimits(stk=ServiceLimits(1_000_000, 150_000),
                               b2c=ServiceLimits(1_000_000, 150_000))
    client, _ = make_client(STK_OK, B2C_OK, STK_OK, B2C_OK, STK_OK,
                           limits=limits, track_daily=True)
    client.stk_push(stk(amount=100_000))
    client.b2c_payout(b2c(amount=100_000))
    assert client.daily_spend == {"stk": 100_000, "b2c": 100_000}
    # Each service is still under its own 150k, so one more of each passes.
    client.stk_push(stk(amount=49_000))
    client.b2c_payout(b2c(amount=49_000))
    assert client.daily_spend == {"stk": 149_000, "b2c": 149_000}
    # STK 1 KES more: rejected on the daily ceiling (not per-transaction).
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.stk_push(stk(amount=2_000))
    # B2C 1_001 more: same, on its own accumulator.
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.b2c_payout(b2c(amount=1_001))
    assert client.daily_spend == {"stk": 149_000, "b2c": 149_000}


def test_unlimited_daily_never_accumulates_or_rejects():
    limits = TransactionLimits(stk=ServiceLimits(max_per_day=0))
    client, _ = make_client(STK_OK, STK_OK, limits=limits, track_daily=True)
    client.stk_push(stk(amount=100_000))
    client.stk_push(stk(amount=100_000))
    assert client.daily_spend == {}          # nothing counted when unlimited


def test_daily_accumulation_is_thread_safe():
    limits = TransactionLimits(b2c=ServiceLimits(50_000_000, 80_000))
    client, session = make_client(*[B2C_OK] * 8, limits=limits,
                                  track_daily=True)
    barrier = threading.Barrier(8)
    results: list[str] = []

    def worker():
        barrier.wait()
        try:
            client.b2c_payout(b2c(amount=10_000))
            results.append("ok")
        except ValueError:
            results.append("rejected")

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 8 x 10,000 == 80,000 exactly: no lost updates, no over-count.
    assert results.count("ok") == 8
    assert client.daily_spend == {"b2c": 80_000}
    # Every accepted call reached the transport exactly once.
    assert len(session.calls) == 9          # 1 OAuth + 8 payouts


def test_daily_rejection_does_not_consume_quota():
    """A rejected payment must not reserve anything for the next one."""
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 10_000))
    client, _ = make_client(B2C_OK, limits=limits, track_daily=True)
    client.b2c_payout(b2c(amount=9_995))              # 9_995 of 10_000 spent
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.b2c_payout(b2c(amount=10))             # would total 10_005
    assert client.daily_spend == {"b2c": 9_995}


def test_transport_error_rolls_back_daily_budget():
    """Transport-level failure (requests.exceptions.RequestException)
    rolls the reservation back so a network blip does not permanently
    drain the budget. Gateway rejections keep their reservation.
    """
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 10_000))

    class TransportFailSession(FakeSession):
        """Raises ConnectionError on the first business POST."""

        def request(self, method, url, json=None, params=None, timeout=None,
                    allow_redirects=True, headers=None, stream=False):
            self.calls.append({"kind": method, "url": url, "json": json})
            if method == "POST":
                raise requests.exceptions.ConnectionError("simulated blip")
            return self.queue.pop(0)

    session = TransportFailSession([OAUTH_OK])
    cfg = Config(consumer_key="k", consumer_secret="s", shortcode="174379",
                 passkey=PASSKEY, now=lambda: T0, http_client=session,
                 limits=limits, track_daily=True)
    client = MpesaClient(cfg)

    with pytest.raises(requests.exceptions.ConnectionError):
        client.b2c_payout(b2c(amount=5_000))
    # The reservation was rolled back: budget is fully available again.
    assert client.daily_spend == {"b2c": 0}


def test_gateway_error_keeps_daily_reservation():
    """A gateway rejection (MpesaError) is NOT rolled back -- the request
    WAS sent and the gateway's verdict is authoritative.
    """
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 10_000))
    rejected = FakeResponse(status_code=500, text="{}")
    client, _ = make_client(rejected, limits=limits, track_daily=True)
    with pytest.raises(MpesaError):
        client.b2c_payout(b2c(amount=5_000))
    assert client.daily_spend == {"b2c": 5_000}       # reservation kept


def test_backward_clock_jump_keeps_daily_budget():
    """A backward clock jump (NTP correction) reuses today's budget
    instead of resetting early. Forward-only day compare: only a day key
    STRICTLY GREATER than the stored key resets the accumulator.
    """
    limits = TransactionLimits(b2c=ServiceLimits(1_000_000, 10_000))
    clock = Clock(datetime(2026, 1, 2, 10, 0, tzinfo=timezone.utc))
    client, _ = make_client(B2C_OK, B2C_OK, B2C_OK,
                            limits=limits, track_daily=True, clock=clock)
    # 2026-01-02 10:00 UTC == 13:00 EAT: Nairobi day 2026-01-02.
    client.b2c_payout(b2c(amount=8_000))
    assert client.daily_spend == {"b2c": 8_000}

    # Backward jump to 2026-01-01 22:00 UTC == 2026-01-02 01:00 EAT:
    # still Nairobi day 2026-01-02, so budget is KEPT.
    clock.set(datetime(2026, 1, 1, 22, 0, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.b2c_payout(b2c(amount=3_000))           # 8k + 3k > 10k
    assert client.daily_spend == {"b2c": 8_000}        # unchanged

    # Backward jump even further to 2026-01-01 10:00 UTC == 13:00 EAT:
    # Nairobi day 2026-01-01, which is EARLIER than the stored
    # 2026-01-02 -- forward-only compare means NO reset.
    clock.set(datetime(2026, 1, 1, 10, 0, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.b2c_payout(b2c(amount=3_000))
    assert client.daily_spend == {"b2c": 8_000}        # still unchanged


def test_reversal_and_qr_have_separate_daily_buckets():
    """Reversal accrues to "reversal", QR accrues to "qr"; neither shares
    the "default" bucket. Each bucket tracks independently.
    """
    limits = TransactionLimits(
        reversal=ServiceLimits(1_000_000, 10_000),
        qr=ServiceLimits(1_000_000, 10_000),
    )
    # Queue: OAuth, reversal-reply, qr-reply, [qr rejected pre-network],
    # reversal-reply. The second QR never reaches the network (ceiling).
    client, _ = make_client(B2C_OK, QR_OK, B2C_OK, limits=limits,
                            track_daily=True)
    # Reversal goes to "reversal" bucket.
    client.reversal(reversal(amount=9_000))
    assert client.daily_spend == {"reversal": 9_000}

    # QR goes to "qr" bucket -- independent of reversal's budget.
    client.generate_qr_code(qr(amount=5_000))
    assert client.daily_spend == {"reversal": 9_000, "qr": 5_000}

    # One more QR trips the qr bucket but not the reversal bucket.
    with pytest.raises(ValueError, match="per-day ceiling"):
        client.generate_qr_code(qr(amount=6_000))     # 5k + 6k > 10k
    assert client.daily_spend == {"reversal": 9_000, "qr": 5_000}

    # Reversal still has 1k left; 500 fits.
    client.reversal(reversal(amount=500))
    assert client.daily_spend == {"reversal": 9_500, "qr": 5_000}


def test_reversal_qr_buckets_resolve_from_their_own_fields():
    """TransactionLimits(reversal=...) and (qr=...) are merged independently
    from _DEFAULT_DEFAULT, so an override on one does not leak to the other.
    """
    resolved = _resolve(TransactionLimits(
        reversal=ServiceLimits(max_per_day=1_000)))
    assert resolved.reversal.max_per_day == 1_000      # overridden
    assert resolved.qr.max_per_day == 500_000          # default
    assert resolved.default.max_per_day == 500_000     # default

    resolved2 = _resolve(TransactionLimits(
        qr=ServiceLimits(max_per_transaction=0)))
    # Explicit 0 is kept as-is by the merge (unlimited); _resolved_max
    # converts it to None downstream.
    assert resolved2.qr.max_per_transaction == 0      # explicit unlimited
    assert _resolved_max(resolved2.qr.max_per_transaction) is None
    assert resolved2.reversal.max_per_transaction == 250_000  # default


# ---------------------------------------------------------------------------
# sync/async parity
# ---------------------------------------------------------------------------

AMOUNT_CASES = [1, 10, 250_000, 250_001, 300_000, 500_000, 500_001,
                10 ** 5000, 10 ** 12 + 1, 0, -1, True]


def test_sync_and_async_agree_on_amount_bounds():
    """STK (sync, ``stk`` tier) and Reversal (async, ``reversal`` tier)."""
    for amount in AMOUNT_CASES:
        sync_ok = True
        try:
            stk(amount=amount).validate()
        except ValueError:
            sync_ok = False
        async_ok = True
        try:
            reversal(amount=amount).validate()
        except ValueError:
            async_ok = False
        assert sync_ok is async_ok, (amount, sync_ok, async_ok)


def test_sync_and_async_agree_under_a_shared_override():
    """Both files resolve the same tier through the same helper."""
    shared = TransactionLimits(stk=ServiceLimits(700_000),
                               reversal=ServiceLimits(700_000))

    for amount in (700_000, 700_001):
        sync_ok = async_ok = True
        try:
            stk(amount=amount).validate(shared)
        except ValueError:
            sync_ok = False
        try:
            reversal(amount=amount).validate(shared)
        except ValueError:
            async_ok = False
        assert sync_ok is async_ok, amount
        assert sync_ok is (amount == 700_000)


def test_transaction_status_has_no_amount_to_limit():
    """Amount-free models accept the limits argument and bound nothing."""
    req = TransactionStatusRequest(
        initiator="i", security_credential="c", transaction_id="NLJ7RT61SV",
        party_a="600992", remarks="r", result_url=CB, queue_time_out_url=CB)
    req.validate(TransactionLimits(stk=ServiceLimits(1)))      # no crash
    assert req.validate(limits=None) is None


def test_client_passes_its_configured_limits_into_validation():
    """End-to-end: a config-limited STK ceiling fails before any request."""
    limits = TransactionLimits(stk=ServiceLimits(max_per_transaction=1_000))
    client, session = make_client(STK_OK, limits=limits)
    with pytest.raises(ValueError, match="stk service"):
        client.stk_push(stk(amount=1_001))
    assert session.calls == []          # not even the OAuth fetch happened


def test_client_daily_guard_is_bypassed_when_tracking_is_off():
    """Opt-in: the same install with track_daily=False never rejects."""
    limits = TransactionLimits(stk=ServiceLimits(1_000_000, 1_000))
    client, _ = make_client(STK_OK, STK_OK, limits=limits)
    client.stk_push(stk(amount=900))
    client.stk_push(stk(amount=900))
    assert client.daily_spend == {}
