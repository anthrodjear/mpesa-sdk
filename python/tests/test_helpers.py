"""Tests for mpesa.helpers -- mirrors go/helpers_test.go incl. golden vectors."""

import base64
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mpesa.helpers import (  # noqa: E402
    generate_password,
    new_originator_id,
    normalize_phone,
    security_credential,
)

SHORTCODE = "174379"
PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
CERT = Path(__file__).parent / "fixtures" / "SandboxCertificate.cer"


def test_generate_password_golden_vector():
    at = datetime(2021, 6, 28, 9, 24, 8, tzinfo=timezone.utc)
    password, timestamp = generate_password(SHORTCODE, PASSKEY, at)
    assert timestamp == "20210628122408"
    want = (
        "MTc0Mzc5YmZiMjc5ZjlhYTliZGJjZjE1OGU5N2RkNzFhNDY3Y2QyZTBjODkzMDU5YjEw"
        "Zjc4ZTZiNzJhZGExZWQyYzkxOTIwMjEwNjI4MTIyNDA4"
    )
    assert password == want
    decoded = base64.b64decode(password)
    assert decoded == (SHORTCODE + PASSKEY + "20210628122408").encode()


def test_generate_password_rejects_naive_datetime():
    with pytest.raises(ValueError, match="timezone-aware"):
        generate_password(SHORTCODE, PASSKEY, datetime(2021, 6, 28, 9, 24, 8))


@pytest.mark.parametrize(
    "utc,want_ts",
    [
        ((2021, 6, 28, 20, 59, 59), "20210628235959"),   # just before EAT midnight
        ((2021, 6, 28, 21, 0, 0), "20210629000000"),     # EAT day rollover
        ((2021, 12, 31, 21, 30, 0), "20220101003000"),   # EAT year rollover
    ],
)
def test_generate_password_eat_boundaries(utc, want_ts):
    _, ts = generate_password(SHORTCODE, PASSKEY, datetime(*utc, tzinfo=timezone.utc))
    assert ts == want_ts


@pytest.mark.parametrize(
    "raw,want",
    [
        ("0712345678", "254712345678"),
        ("+254712345678", "254712345678"),
        ("254712345678", "254712345678"),
        ("0110123456", "254110123456"),
        ("+254110123456", "254110123456"),
        ("0723 456 789", "254723456789"),
        (" 0712345678 ", "254712345678"),
        ("\t0712345678\n", "254712345678"),
        ("0723-456-789", "254723456789"),     # mid-string dashes
        ("(0723)456789", "254723456789"),     # mid-string parens
    ],
)
def test_normalize_phone_table(raw, want):
    assert normalize_phone(raw) == want


@pytest.mark.parametrize(
    "raw", ["", "+", "071234567", "07123456789", "254612345678", "abcdefghijk",
            "+441234567890"]
)
def test_normalize_phone_invalid_shapes(raw):
    with pytest.raises(ValueError):
        normalize_phone(raw)


def test_normalize_phone_overlong_boundary():
    with pytest.raises(ValueError, match="too long"):
        normalize_phone("0" * 33)   # over the cap: rejected before stripping
    with pytest.raises(ValueError):  # at cap: still must fail shape check
        normalize_phone("0" * 32)


def test_security_credential_sandbox_cert_round_trip():
    cred = security_credential(CERT.read_bytes(), "initiator-password")
    assert len(cred) == 344            # 2048-bit RSA -> 256B ct -> 344 b64 chars
    raw = base64.b64decode(cred)
    assert len(raw) == 256             # decrypts to a 256-byte PKCS#1 block


def test_security_credential_accepts_raw_der():
    from cryptography.hazmat.primitives.serialization import Encoding
    from cryptography.x509 import load_pem_x509_certificate

    blob = CERT.read_bytes()
    if b"-----BEGIN" not in blob:
        pytest.skip("fixture is already DER")
    der = load_pem_x509_certificate(blob).public_bytes(Encoding.DER)
    assert len(security_credential(der, "pw")) == 344


def test_security_credential_password_checked_before_cert_parse():
    for pw in ("", "   "):
        with pytest.raises(ValueError, match="initiator_password is required"):
            security_credential(b"definitely not a certificate", pw)


def test_security_credential_rejects_garbage_cert():
    with pytest.raises(ValueError, match="parse M-Pesa certificate"):
        security_credential(b"definitely not a certificate", "pw")


def test_new_originator_id_shape():
    pattern = re.compile(r"^[0-9a-f]{16}$")
    ids = {new_originator_id() for _ in range(16)}
    assert all(pattern.fullmatch(i) and len(i) <= 19 for i in ids)
    assert len(ids) == 16  # uniqueness across the loop


def test_generate_password_converts_non_utc_aware_zone():
    eat5 = timezone(timedelta(hours=5))  # same instant as 09:24:08Z
    _, ts = generate_password(
        SHORTCODE, PASSKEY, datetime(2021, 6, 28, 14, 24, 8, tzinfo=eat5)
    )
    assert ts == "20210628122408"


def test_generate_password_truncates_microseconds():
    at = datetime(2021, 6, 28, 9, 24, 8, 999999, tzinfo=timezone.utc)
    _, ts = generate_password(SHORTCODE, PASSKEY, at)
    assert ts == "20210628122408"  # sub-second precision dropped by format
    assert len(ts) == 14


def test_normalize_phone_rejects_unicode_digits():
    # Python \d matches Unicode Nd; Go RE2 does not. Must never accept.
    with pytest.raises(ValueError):
        normalize_phone("2547\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0660")


def test_normalize_phone_mixed_separators_positive():
    assert normalize_phone("+254 712-345-678") == "254712345678"


def test_security_credential_requires_bytes_input():
    with pytest.raises(TypeError, match="must be bytes"):
        security_credential("-----BEGIN CERTIFICATE-----", "pw")


def test_security_credential_wraps_oversize_password_error():
    with pytest.raises(ValueError, match="encrypt security credential"):
        security_credential(CERT.read_bytes(), "x" * 246)  # >245B PKCS#1 limit


def test_security_credential_rejects_ec_key_cert():
    from datetime import datetime as dt

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ec-test")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(dt(2020, 1, 1, tzinfo=timezone.utc))
        .not_valid_after(dt(2030, 1, 1, tzinfo=timezone.utc))
        .sign(key, hashes.SHA256())
    )
    der = cert.public_bytes(
        __import__("cryptography.hazmat.primitives.serialization", fromlist=["Encoding"]).Encoding.DER
    )
    with pytest.raises(ValueError, match="non-RSA public key"):
        security_credential(der, "pw")
