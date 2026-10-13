"""Per-merchant transaction limits (mirrors go/limits.go, same API surface).

Safaricom's published default is KES 250,000 per B2C transaction and
KES 500,000 per day (docs/apis/b2c.md is normative). Higher tiers exist
only for Safaricom-approved paybills and are expressed as an explicit
``TransactionLimits`` override in config (``0`` disables a ceiling). The
bounds therefore live in CONFIG as data, and the SDK defaults to the
documented standard baseline.

THE MERGE MODEL (identical in the Go and TypeScript bindings): configuration
is PARTIAL. A developer overrides SPECIFIC values on top of the Safaricom
defaults; every other value stays at its default. Per field:

* ``None`` -- the field is UNSET, so it INHERITS the Safaricom default.
* ``0`` or negative -- an EXPLICIT opt-out, meaning UNLIMITED. A merchant on
  a private unlimited tier must be able to say that, and ``0`` is the only
  value that reads unambiguously as "no ceiling here" rather than "the
  unknown default I did not look up".

Only those two states exist, and the distinction is resolved in ONE place,
:func:`_resolve_transaction_limits`, so no binding can drift on what a
half-configured ``TransactionLimits`` means. Note the trap this closes:
``ServiceLimits()`` (all ``None``) used to read as "no ceiling at all",
which silently disabled every guard the developer did not think to set --
the opposite of what overriding one service should do.

Two independent bounds per service:

``max_per_transaction``
    Applied by the request model's ``validate()`` BEFORE any network call,
    so a bad amount fails in-process instead of burning an OAuth token and
    a round-trip.
``max_per_day``
    Applied by :class:`~mpesa.client.MpesaClient` for the process that
    owns the accumulator, and OPT-IN via ``Config(track_daily=True)``.

WHY DAILY TRACKING IS OPT-IN: several replicas commonly share one Daraja
shortcode. A per-process accumulator sees only its own traffic, so it
UNDER-counts (it never sees a peer's payouts) and can therefore never be
the authoritative gate on a platform-wide cap -- it is a local circuit
breaker for the one process worst case, not a control. Left off by default,
it is a consistency-notice you must opt into knowingly.

Examples::

    cfg = Config(...)                                  # baseline everywhere
    cfg = Config(..., limits=TransactionLimits(
        b2c=ServiceLimits(500_000, 2_500_000)))  # explicit higher-tier override

    from dataclasses import replace
    replaces_one_service = replace(DEFAULT_TRANSACTION_LIMITS,
                                   stk=ServiceLimits(max_per_transaction=0))
    # ... is the recommended idiom when the starting point is the baseline,
    # because replace() keeps every other field at its resolved default.
"""

from __future__ import annotations

from dataclasses import dataclass

__all__ = ["ServiceLimits", "TransactionLimits", "DEFAULT_TRANSACTION_LIMITS"]


def _resolved_max(value: int | None) -> int | None:
    """Ceiling as ENFORCED: a non-positive value means UNLIMITED.

    Runs AFTER :func:`_resolve_transaction_limits`, so ``value`` is already
    a concrete number -- the default, or the developer's override. ``None``
    is still tolerated for a caller that bypasses the merge, and still
    means "no client-side cap"; the gateway stays the authority, so a bad
    tier surfaces as a gateway error the operator already knows rather than
    as a silently blocked payment.

    Example::

        _resolved_max(250_000)   # -> 250_000
        _resolved_max(0)         # -> None   (explicit unlimited)
        _resolved_max(None)      # -> None   (unmerged: no cap)
    """
    if value is None or value <= 0:
        return None
    return value


def _merge_field(override: int | None, default: int) -> int:
    """Per-field merge: UNSET inherits, ``0``/negative stays explicit.

    The single point where "unset" and "unlimited" stop being confused --
    everything downstream reads a concrete number and never has to guess
    which of the two a ``None`` used to be.
    """
    return default if override is None else override


def _merge_service(service: ServiceLimits,
                   defaults: "tuple[int, int]") -> ServiceLimits:
    """Overlay one service's overrides on its Safaricom defaults."""
    return ServiceLimits(
        max_per_transaction=_merge_field(service.max_per_transaction,
                                         defaults[0]),
        max_per_day=_merge_field(service.max_per_day, defaults[1]),
    )


def _resolve_transaction_limits(
        limits: "TransactionLimits | None") -> TransactionLimits:
    """Merge ``limits`` onto the defaults, PER FIELD, in one place.

    ``None`` yields the baseline unchanged; a partially-filled
    ``TransactionLimits`` keeps the defaults for every field the caller
    left UNSET and overrides the rest. This function is the single source
    of truth for the nil-vs-0 distinction, so the Go and TypeScript
    bindings can be checked against it line by line.
    """
    chosen = limits if limits is not None else TransactionLimits()
    return TransactionLimits(
        stk=_merge_service(chosen.stk, _DEFAULT_STK),
        c2b=_merge_service(chosen.c2b, _DEFAULT_C2B),
        b2c=_merge_service(chosen.b2c, _DEFAULT_B2C),
        default=_merge_service(chosen.default, _DEFAULT_DEFAULT),
    )


#: Baseline ceilings, in whole KES. Every service carries the standard
#: Safaricom default of 250k per transaction and 500k per day
#: (docs/apis/b2c.md is normative); a Safaricom-approved higher tier is
#: expressed as an explicit ``TransactionLimits`` override, not a default.
_DEFAULT_STK = (250_000, 500_000)
_DEFAULT_C2B = (250_000, 500_000)
_DEFAULT_B2C = (250_000, 500_000)
_DEFAULT_DEFAULT = (250_000, 500_000)


@dataclass(frozen=True)
class ServiceLimits:
    """Overrides for ONE service's bounds -- partial by design.

    ``None`` means UNSET: the field inherits its Safaricom default when the
    limits are resolved (see :func:`_resolve_transaction_limits`), so a
    service bounds only what the developer actually overrode. An explicit
    ``0`` (or negative) means UNLIMITED -- the only value that unambiguously
    says "no ceiling here" rather than "the default I did not look up".

    ``max_per_transaction`` is the largest single amount the SDK will
    build for this service (whole KES); ``max_per_day`` the largest this
    process may move in one Africa/Nairobi day when
    ``Config.track_daily`` is on. Both are ceilings checked client-side;
    the gateway remains the final authority.

    Example::

        ServiceLimits(500_000, 2_500_000)  # explicit higher-tier override
        ServiceLimits(max_per_transaction=0)          # unlimited, day kept

    The standard Safaricom default is 250k per transaction and 500k per
    day; higher tiers are set via an explicit ``TransactionLimits``
    override.
    """

    max_per_transaction: int | None = None
    max_per_day: int | None = None


@dataclass(frozen=True)
class TransactionLimits:
    """PARTIAL per-service overrides for one :class:`~mpesa.config.Config`.

    Service selection is per ENDPOINT (see ``MpesaClient``): ``stk`` covers
    STK Push, ``c2b`` covers C2B simulate, ``b2c`` covers B2C payout, and
    ``default`` covers everything else that carries an amount (Reversal,
    Transaction Status, dynamic QR). Reversal and dynamic QR therefore
    share ONE ``default`` daily bucket when ``Config.track_daily`` is on
    (``MpesaClient._accrue_daily("default", ...)`` for both), and the
    daily quota is consumed-on-attempt: accrued before dispatch, never
    rolled back on post-accrue gateway/transport failures.

    Each field is merged INDEPENDENTLY against its own default pair, so
    ``TransactionLimits(b2c=ServiceLimits(500_000, 2_500_000))`` is an
    explicit higher-tier override: it raises the b2c bounds above the
    standard Safaricom default (250k per transaction, 500k per day) and
    leaves stk/c2b/default exactly where they were. A
    service that is not named here is NOT unlimited -- it is unconfigured,
    which means "keep the default". That distinction is the whole reason
    this class is resolved through :func:`_resolve_transaction_limits`
    rather than read directly.

    Two equivalent ways to express the same explicit higher-tier override:

    * ``TransactionLimits(b2c=ServiceLimits(500_000, 2_500_000))``
    * ``replace(DEFAULT_TRANSACTION_LIMITS,
      b2c=ServiceLimits(500_000, 2_500_000))`` -- the recommended idiom
      when the baseline is the starting point, because ``replace`` keeps
      every other field at its resolved default.

    Example::

        limits = TransactionLimits(stk=ServiceLimits(max_per_transaction=0))
        Config(consumer_key="k", consumer_secret="s", limits=limits)
    """

    stk: ServiceLimits = ServiceLimits()
    c2b: ServiceLimits = ServiceLimits()
    b2c: ServiceLimits = ServiceLimits()
    default: ServiceLimits = ServiceLimits()


#: The documented baseline, resolved and ready to enforce (see the private
#: tuples above). Every field is a real ceiling, because a merchant who
#: needs more raises it in config with an explicit value -- or writes ``0``.
DEFAULT_TRANSACTION_LIMITS = _resolve_transaction_limits(None)
