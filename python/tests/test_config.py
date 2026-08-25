"""Tests for mpesa.config -- redaction, immutability, validation, defaults."""

import copy
import dataclasses
import json
import pickle
import sys
import typing
from pathlib import Path

import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.config import Config  # noqa: E402
from mpesa.enums import Environment  # noqa: E402

SECRET_KEY = "live-consumer-key-abc"
SECRET_VALUE = "super-secret-value-dont-leak"
PASSKEY = "bfb-passkey-also-secret"


@pytest.fixture()
def populated() -> Config:
    return Config(
        consumer_key=SECRET_KEY,
        consumer_secret=SECRET_VALUE,
        shortcode="174379",
        passkey=PASSKEY,
    )


def test_repr_and_str_redact_all_secrets(populated):
    for rendered in (repr(populated), str(populated), f"{populated}"):
        assert SECRET_VALUE not in rendered
        assert PASSKEY not in rendered
        assert SECRET_KEY in rendered
        assert "secrets=REDACTED" in rendered
        assert "environment=Environment.SANDBOX" in rendered


def test_frozen_immutability(populated):
    with pytest.raises(dataclasses.FrozenInstanceError):
        populated.passkey = "rotated"  # type: ignore[misc]


def test_dataclasses_replace_works_and_stays_redacted(populated):
    derived = dataclasses.replace(populated, timeout_seconds=5.0)
    assert derived.timeout_seconds == 5.0
    assert derived.passkey == PASSKEY  # value preserved, just not printable
    assert "REDACTED" in repr(derived)


def test_validate_credentials_ok(populated):
    populated.validate_credentials()  # must not raise


@pytest.mark.parametrize(
    "kwargs,missing",
    [
        ({"consumer_secret": "s"}, "consumer_key"),
        ({"consumer_key": "k"}, "consumer_secret"),
        ({}, "consumer_key"),
    ],
)
def test_validate_credentials_actionable_error(kwargs, missing):
    with pytest.raises(ValueError) as excinfo:
        Config(**kwargs).validate_credentials()
    message = str(excinfo.value)
    assert message.startswith("mpesa: Config.")
    assert missing in message


def test_defaults_are_sane():
    cfg = Config()
    assert cfg.environment is Environment.SANDBOX
    assert cfg.base_url == "https://sandbox.safaricom.co.ke"
    assert cfg.timeout_seconds == 30.0
    assert cfg.now is None          # client applies UTC clock fallback
    assert cfg.http_client is None


REDACT_RENDERERS = [
    pytest.param(lambda c: repr(c), id="repr"),
    pytest.param(lambda c: str(c), id="str"),
    pytest.param(lambda c: "%s" % c, id="pct-s"),
    pytest.param(lambda c: "%r" % c, id="pct-r"),
    pytest.param(lambda c: "{}".format(c), id="format"),
]


@pytest.mark.parametrize("render", REDACT_RENDERERS)
def test_every_text_form_redacts(render):
    rendered = render(
        Config(consumer_key=SECRET_KEY, consumer_secret=SECRET_VALUE, passkey=PASSKEY)
    )
    assert SECRET_VALUE not in rendered
    assert PASSKEY not in rendered
    assert "secrets=REDACTED" in rendered


def test_validate_credentials_exact_message():
    with pytest.raises(ValueError) as excinfo:
        Config().validate_credentials()
    assert str(excinfo.value) == (
        "mpesa: Config.consumer_key and Config.consumer_secret "
        "are required before calling any endpoint"
    )


@pytest.mark.parametrize("clone", [copy.copy, deepcopy := copy.deepcopy, lambda c: pickle.loads(pickle.dumps(c))])
def test_copy_deepcopy_pickle_round_trip(clone, populated):
    twin = clone(populated)
    assert isinstance(twin, Config)
    assert (twin.consumer_key, twin.consumer_secret, twin.passkey) == (
        populated.consumer_key,
        populated.consumer_secret,
        populated.passkey,
    )
    assert "secrets=REDACTED" in repr(twin)


def test_log_safe_contains_no_secrets(populated):
    blob = json.dumps(populated.log_safe())
    assert SECRET_VALUE not in blob
    assert PASSKEY not in blob
    assert json.loads(blob) == {
        "shortcode": "174379",
        "environment": "SANDBOX",
        "timeout_seconds": 30.0,
    }


def test_asdict_boundary_is_documented_not_accidental(populated):
    # stdlib asdict() returns RAW secrets by design; log_safe() is the
    # logging surface. This pin locks that documented boundary.
    raw = dataclasses.asdict(populated)
    assert raw["consumer_secret"] == SECRET_VALUE


def test_pep604_hints_resolve_on_39():
    hints = typing.get_type_hints(Config)
    assert typing.get_origin(hints["now"]) is typing.Union
    assert typing.get_origin(hints["http_client"]) is typing.Union


def test_timeout_seconds_is_float():
    assert isinstance(Config().timeout_seconds, float)


def test_post_init_rejects_non_callable_clock():
    with pytest.raises(TypeError):
        Config(now=12345)


def test_post_init_warns_on_tls_verification_disabled():
    session = requests.Session()
    session.verify = False
    with pytest.warns(UserWarning, match="TLS verification disabled"):
        Config(http_client=session)


def test_post_init_silent_when_session_verifies():
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        Config(http_client=requests.Session())  # verify=True default: no warn


@pytest.mark.parametrize("bad_shortcode", [
    "abc", "1234", "12345678901", "17437A", "17 4379", "17.4379",
])
def test_post_init_rejects_invalid_shortcode(bad_shortcode):
    with pytest.raises(ValueError, match="must be 5-10 digits"):
        Config(shortcode=bad_shortcode)


@pytest.mark.parametrize("valid_shortcode", [
    "12345", "174379", "1234567890",
])
def test_post_init_accepts_valid_shortcode(valid_shortcode):
    cfg = Config(shortcode=valid_shortcode)
    assert cfg.shortcode == valid_shortcode


def test_post_init_allows_empty_shortcode():
    cfg = Config(shortcode="")
    assert cfg.shortcode == ""
