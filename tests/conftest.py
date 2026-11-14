import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp(prefix="gc-test-")
    monkeypatch.setenv("DATA_DIR", tmp)
    monkeypatch.setenv("ADMIN_PASSWORD", "secret")
    monkeypatch.setenv("AUTO_BACKUP", "false")
    monkeypatch.setenv("TZ", "Europe/Bucharest")
    from app.config import get_settings

    get_settings.cache_clear()
    from app.main import create_app

    app = create_app(get_settings())
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


@pytest.fixture()
def admin(client):
    r = client.post("/api/admin/login", json={"password": "secret"})
    assert r.status_code == 200, r.text
    return client


@pytest.fixture()
def players(admin):
    names = ["Ana", "Bogdan", "Cata", "Dana", "Emil", "Flori"]
    ids = []
    for n in names:
        r = admin.post("/api/admin/players", json={"name": n, "emoji": "🦊"})
        assert r.status_code == 200, r.text
        ids.append(r.json()["id"])
    return ids
