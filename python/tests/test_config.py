"""Tests for mpesa.config -- redaction, immutability, validation, defaults."""

import dataclasses
import sys
from pathlib import Path

import pytest

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
