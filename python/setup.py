"""Packaging manifest for mpesa-sdk (Python engine of the M-Pesa Daraja SDK monorepo).

Import package: ``mpesa`` (source at python/mpesa/).
Runtime dependencies:
    requests     -- HTTP transport for Daraja REST endpoints.
    cryptography -- RSA PKCS#1 v1.5 encryption for SecurityCredential
                    generation (stdlib cannot do this safely).

Go reference implementation lives in go/ ; API contracts live in docs/apis/.
"""

from setuptools import find_packages, setup

LONG_DESCRIPTION = """mpesa-sdk - Python SDK for the Safaricom M-Pesa Daraja API.

A Python engine for integrating M-Pesa payments via the Daraja platform,
mirroring the semantics of the Go reference implementation in this
monorepo. Covers OAuth token generation, STK Push (M-Pesa Express) and
STK Query, B2C v3 payouts, C2B URL registration and payment simulation,
Transaction Status queries, Reversal, Account Balance and Dynamic QR
generation against sandbox and production endpoints.

Requirements: Python >= 3.11.
"""

setup(
    name="mpesa-sdk",
    version="0.1.0",
    description=("Python SDK for the Safaricom M-Pesa Daraja API "
                 "(OAuth, STK Push/Query, B2C v3, C2B register/simulate, "
                 "Transaction Status, Reversal, Account Balance, Dynamic QR)"),
    long_description=LONG_DESCRIPTION,
    long_description_content_type="text/plain",
    author="mpesa-sdk maintainers",
    url="https://github.com/mpesa-sdk/mpesa-sdk",
    project_urls={
        "Source": "https://github.com/mpesa-sdk/mpesa-sdk",
        "Issues": "https://github.com/mpesa-sdk/mpesa-sdk/issues",
        "Changelog": "https://github.com/mpesa-sdk/mpesa-sdk/blob/main/CHANGELOG.md",
    },
    license="MIT",
    packages=find_packages(exclude=["tests", "tests.*"]),
    python_requires=">=3.11",
    install_requires=[
        # >=2.32.4 fixes CVE-2024-35195 (verify=False persistence) and
        # CVE-2024-47081 (netrc credential leak).
        "requests>=2.32.4,<3",
        # >=48.0.1 clears bundled-OpenSSL advisory lineage incl.
        # CVE-2026-34181/12797; upper-bounded before next major line.
        "cryptography>=48.0.1,<51",
    ],
    extras_require={
        "dev": [
            "pytest>=8",
        ],
    },
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Office/Business :: Financial",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
    keywords=["mpesa", "daraja", "safaricom", "stk-push", "payments", "mobile-money", "kenya"],
)
