"""Callback URL tokens: bearer capabilities hardening callback endpoints
against forged POSTs (mirrors go/callbacktoken.go).
Threat model: Safaricom sends NO signature on callback traffic -- anyone
who learns/guesses your CallBackURL can forge a body that parses
cleanly, so treat the registered URL path as a bearer capability: embed
an unguessable token (https://api.example.com/mpesa/callback/<token>)
proving the caller KNOWS the URL. It gates the ENDPOINT, NOT payload
content; a hit never replaces settlement -- always settle by query
bound to YOUR CheckoutRequestID record (forged callbacks parse fine)::
    resp = client.stk_query(STKQueryRequest(checkout_request_id=crid))
    if resp.result_code == "0":
        mark_paid(order)   # settled by query, never by the bare hit
Scrub access logs/APM traces (the token rides in URLs); rotate
long-lived C2B registrations via an overlap window, retiring the old
token once traffic migrates."""

import hmac
import secrets

__all__ = ["callback_token_equal", "new_callback_token"]

#: 128 bits -- the floor for unguessable URL capabilities -- encoding to
#: exactly 22 unpadded base64url characters.
_CALLBACK_TOKEN_ENTROPY_BYTES = 16


def new_callback_token() -> str:
    """Return a fresh URL-safe callback token: 22 characters carrying
    128 bits of entropy, encoded unpadded base64url.

    The source is :mod:`secrets` -- Python's crypto-grade CSPRNG
    (``os.urandom`` under the hood), mirroring Go's ``crypto/rand``
    choice. Generate one per registered CallBackURL (or per order),
    embed it in the URL path and store it beside the request record for
    later comparison. Entropy failures propagate verbatim: there is
    deliberately NO fallback to random/time-derived values, because a
    guessable token silently converts every registered endpoint into a
    forgery target. See the threat-model notes atop this module for
    logging, rotation and settlement rules.
    """
    return secrets.token_urlsafe(_CALLBACK_TOKEN_ENTROPY_BYTES)


def callback_token_equal(expected: str, provided: str) -> bool:
    """Compare the token on file against the token on a request hit in
    constant time; True only on exact equality.

    Either side empty returns False immediately -- including BOTH empty
    -- because an unconfigured expectation must never bless a request:
    :func:`hmac.compare_digest` alone returns True for two empty inputs,
    which is exactly backwards here. Differing lengths return False per
    stdlib semantics; comparison cost stays flat in byte equality,
    leaking length only, and length is public anyway (the token rides
    in the URL).
    """
    if not expected or not provided:
        return False
    return hmac.compare_digest(expected.encode(), provided.encode())
