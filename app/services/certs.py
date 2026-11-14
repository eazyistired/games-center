"""The home CA certificate friends install on their phones (public part only - never a key)."""

from __future__ import annotations

import hashlib
import re
import ssl
import tempfile
from pathlib import Path
from typing import Any

from ..config import get_settings

_PEM_RE = re.compile(r"-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----")


def ca_path() -> Path:
    return get_settings().data_dir / "home-ca.crt"


def _decode(pem: str) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile("w", suffix=".crt", delete=True) as tmp:
        tmp.write(pem)
        tmp.flush()
        return ssl._ssl._test_decode_cert(tmp.name)  # type: ignore[attr-defined]


def _name(rdns) -> str:
    for rdn in rdns or ():
        for key, value in rdn:
            if key == "commonName":
                return value
    return "?"


def validate(data: bytes) -> str:
    """Return a single clean PEM certificate, or raise ValueError."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:  # DER (binary) certificate -> PEM
            text = ssl.DER_cert_to_PEM_cert(data)
        except Exception as exc:
            raise ValueError("That isn't a certificate file") from exc
    if "PRIVATE KEY" in text:
        raise ValueError(
            "That file contains a PRIVATE KEY - upload only the .crt (public) file, and keep the key secret"
        )
    certs = _PEM_RE.findall(text)
    if len(certs) != 1:
        raise ValueError("Upload exactly one certificate (your home CA, e.g. homeCA.crt)")
    pem = certs[0].strip() + "\n"
    try:
        _decode(pem)
    except Exception as exc:
        raise ValueError("Couldn't read that certificate") from exc
    return pem


def save(data: bytes) -> dict[str, Any]:
    pem = validate(data)
    path = ca_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(pem)
    return info()


def remove() -> None:
    ca_path().unlink(missing_ok=True)


def info() -> dict[str, Any]:
    path = ca_path()
    if not path.exists():
        return {"available": False}
    pem = path.read_text()
    d = _decode(pem)
    fp = hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem)).hexdigest().upper()
    return {
        "available": True,
        "name": _name(d.get("subject")),
        "self_signed": d.get("subject") == d.get("issuer"),
        "valid_until": d.get("notAfter"),
        "fingerprint": ":".join(fp[i : i + 2] for i in range(0, len(fp), 2)),
    }
