from pathlib import Path

CA = (Path(__file__).parent / "fixtures" / "certs" / "test-ca.crt").read_bytes()


def upload(c, data, name="homeCA.crt"):
    return c.post("/api/admin/ca", files={"file": (name, data)})


def test_upload_and_download(admin):
    c = admin
    assert c.get("/api/ca").json()["available"] is False
    assert c.get("/ca.crt").status_code == 404
    r = upload(c, CA)
    assert r.status_code == 200, r.text
    info = r.json()
    assert info["name"] == "Test Home CA" and info["self_signed"]
    assert len(info["fingerprint"].split(":")) == 32
    # phones need this content type to offer installing it
    d = c.get("/ca.crt")
    assert d.headers["content-type"] == "application/x-x509-ca-cert"
    assert d.content.startswith(b"-----BEGIN CERTIFICATE-----")
    pub = c.get("/api/ca").json()
    assert pub["available"] and pub["fingerprint"] == info["fingerprint"]
    assert c.get("/setup/").status_code == 200 and "Set up this phone" in c.get("/setup/").text
    assert c.delete("/api/admin/ca").status_code == 200
    assert c.get("/api/ca").json()["available"] is False


def test_rejects_keys_and_junk(admin):
    c = admin
    key = b"-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n"
    r = upload(c, CA + key)
    assert r.status_code == 400 and "PRIVATE KEY" in r.json()["detail"]
    assert upload(c, CA + CA).status_code == 400  # exactly one certificate
    assert upload(c, b"hello").status_code == 400
    assert c.get("/api/ca").json()["available"] is False


def test_only_admin_uploads(client):
    assert client.post("/api/admin/ca", files={"file": ("x.crt", CA)}).status_code == 401


def test_addresses(admin):
    c = admin
    r = c.put(
        "/api/admin/settings",
        json={"app_url": "https://games.grzv.local/", "setup_url": "http://192.168.1.10:8080"},
    )
    assert r.status_code == 200 and r.json()["app_url"] == "https://games.grzv.local"
    assert c.get("/api/ca").json()["setup_url"] == "http://192.168.1.10:8080"
    assert c.put("/api/admin/settings", json={"setup_url": "https://x.local"}).status_code == 400
    assert c.put("/api/admin/settings", json={"app_url": "games.grzv.local"}).status_code == 400
