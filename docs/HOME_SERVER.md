# grzv home server: setup & conventions for custom apps

> Drop this file into a new project as `CLAUDE.md` (or `docs/HOME_SERVER.md`) so Claude Code knows
> how apps are built, shipped and hosted here. Learned while building `eazyistired/games-center`
> (the reference implementation for everything below). Items marked **(verify)** weren't
> confirmed: check them before relying on them.

## 1. The setup at a glance
```
phone / laptop (LAN)
   │  https://<app>.grzv.local
   ▼
Pi-hole  ── local DNS record: <app>.grzv.local → IP of Nginx Proxy Manager
   ▼
Nginx Proxy Manager (HTTPS already set up)  ── proxy host → http://<NAS-IP>:<port>
   ▼
TrueNAS SCALE  ── Apps → custom app "Install via YAML" (docker compose)
   │  image: ghcr.io/eazyistired/<app>:latest
   │  data:  /mnt/<pool>/apps/<app>  → /data in the container
   ▼
GitHub (eazyistired/<app>) ── Actions build & push the image to GHCR on every push to main
```

| Piece | What we know |
|---|---|
| NAS | TrueNAS SCALE, Docker-based apps; custom apps are installed via **Apps → Discover Apps → ⋮ → Install via YAML** (compose). Built-in apps user/group **apps = 568:568**. A pool called **`storage2`** exists (`/mnt/storage2/storage_main/...`); app datasets' exact path **(verify)**, examples use `tank`. |
| Reverse proxy | **Nginx Proxy Manager** (TrueNAS app) on host ports **80 / 443** (the app's defaults 30021 / 30022 were changed). The TrueNAS web UI itself is on **81 / 444**. |
| HTTPS | Home root CA **"Home Lab Root CA"** (`homeCA.crt` / `homeCA.key`) signs a wildcard cert for **`*.grzv.local`** (825 days), uploaded to NPM as a custom certificate. Backups: `/mnt/storage2/storage_main/certs`. Every new `<app>.grzv.local` is covered automatically. Phones install `homeCA.crt` once (Games Center: Admin → Settings → Home certificate → QR → `/setup`). |
| DNS | **Pi-hole** local DNS records, one per app, pointing at NPM. |
| Domain pattern | `<app>.grzv.local` (e.g. `games.grzv.local`). |
| Code & images | GitHub user **eazyistired**; images on **GHCR** `ghcr.io/eazyistired/<app>`. Public repo → anonymous pulls work. Private repo → make the *package* public or give TrueNAS registry credentials. |
| Clients | Mostly **phones on the home Wi-Fi**, often added to the home screen as a web app. |

## 2. Deploying a new app (checklist)
1. **Repo** on GitHub (`eazyistired/<app>`), with `Dockerfile`, `compose.yaml` and
   `.github/workflows/build.yml` (templates below).
2. **Push to `main`**: GitHub Actions runs the tests and pushes `ghcr.io/eazyistired/<app>:latest`
   (plus `sha-xxxxxxx` and semver tags).
3. **Dataset** in TrueNAS: `<pool>/apps/<app>`, Dataset Preset **Apps** (so 568 can write).
4. **Install via YAML**: paste `compose.yaml`; set the host path, secrets (env vars) and a
   free host port. Check `http://<NAS-IP>:<port>/api/health`.
5. **Nginx Proxy Manager**: Proxy Host `<app>.grzv.local` → `http` · `<NAS-IP>` · `<port>`;
   Block common exploits ✅; **Websockets Support ✅** if the app uses WebSockets (live
   updates); SSL tab → existing certificate, Force SSL ✅, HTTP/2 ✅.
6. **Pi-hole**: Local DNS → `<app>.grzv.local` → IP of NPM.
7. Open `https://<app>.grzv.local` on a phone, Share → Add to Home Screen.

### Updating
TrueNAS **does not auto-update custom apps** (the "v1.0.0 / vcustom" version shown is just the
wrapper, it never changes). After CI is green:
- Apps → `<app>` → **Edit → Save** (with `pull_policy: always` it pulls the new `:latest`), or
- TrueNAS shell: `sudo docker pull ghcr.io/eazyistired/<app>:latest`, then Stop/Start the app.
- Verify: bake the git commit into the image (`BUILD_SHA` build arg) and show it in the app
  (`/api/health`, admin page), then compare with the latest commit on `main`.

## 3. Gotchas we hit
- **HTTPS "doesn't load" but HTTP works** → NPM's HTTPS is on a non-standard host port
  (TrueNAS app default 30022). Give NPM 443 (TrueNAS UI already moved to 444).
- **"Not secure"** → the phone doesn't trust the CA: install `homeCA.crt` and (iPhone) switch it on
  under Certificate Trust Settings. Don't regenerate the CA; only re-sign site certificates.
- **The TrueNAS shell doesn't resolve `*.grzv.local`** (it doesn't use Pi-hole): test against
  `127.0.0.1` with `-servername`.
- **HTTPS matters on phones**: motion sensors, screen wake lock, clipboard etc. only work in a
  secure context **with a certificate the phone trusts**. With a self-signed/local-CA cert,
  install and trust the CA on each phone, or design a fallback (e.g. tap controls).
- **`.local` and Apple devices**: iOS/macOS resolve `*.local` via multicast DNS (Bonjour) and may
  not ask Pi-hole. If iPhones can't open a site that Android can, switch to `.lan` or `.home.arpa`.
- **WebSockets through NPM** need the "Websockets Support" toggle on the proxy host.
- **File permissions**: run containers as `568:568` and create datasets with the Apps preset,
  or the app can't write to `/data`.
- **Private GHCR images** can't be pulled anonymously by TrueNAS.
- **SQLite on the dataset** is fine for these apps (WAL mode); ZFS snapshots of the dataset are
  the outer backup layer.

## 4. App conventions (what games-center does, reuse by default)
- **Stack**: Python 3.12 + FastAPI + SQLAlchemy 2 + SQLite + **Alembic migrations run on
  startup** (existing data upgrades in place). Frontend: plain HTML/ES modules, **no build
  step**, served by FastAPI `StaticFiles` with `Cache-Control: no-cache` so redeploys show up.
- **Data** lives in `/data` (`DATA_DIR`): `app.db`, `backups/`, auto-generated secret key.
- **Config via env vars** in `compose.yaml` (`TZ`, `ADMIN_PASSWORD`, ...); settings the owner
  tunes later go in an **admin page** (DB overrides env).
- **No user logins** for friends-and-family apps: people pick their name; a phone remembers it
  (anonymous device id in `localStorage`, sent as `X-Device-Id`). Admin is one password
  (`ADMIN_PASSWORD`) → signed cookie.
- **Admin page**: CRUD, settings, audit log, backups (daily SQLite backup into `/data/backups`,
  JSON export/import), running version.
- **`/api/health`** returns status + build commit; the Docker `HEALTHCHECK` uses it.
- **Live updates**: one WebSocket endpoint (`/ws`) with per-resource rooms, auto-reconnect,
  heartbeats; "quiet after N seconds" timings configurable in admin.
- **Mobile first**: 44 px+ touch targets, safe-area insets, add-to-home-screen manifest + icons.
- **Design**: warm dark palette as CSS tokens:
  `--bg #14110f · --surface #221d19 · --surface-2 #2b2520 · --border #3a322b ·
  --text #f5efe6 · --muted #9a8f82 · --accent #f5c518 (gold, black text on it) ·
  --good #1fa35b · --bad #d9452b`; bold 800–900 headings; flat cards; 14 px button radius.
- **Testing**: pytest for the API/rules + Playwright click-through of real flows (phone viewport,
  several browser contexts for multi-device features) before merging.

## 5. Working agreements with Claude Code
- Discuss and plan first; ask clarifying questions before big features.
- **Branches**: only `main` and `dev` are long-lived. Feature branch off `dev` → merge into
  `dev` (`--no-ff`) → delete it. `dev` → `main` **only when the owner says "merge to main"**
  (main = what gets deployed).
- Claude Code cloud sessions can push branches but **cannot delete remote branches**: keep feature
  branches local or tell the owner which ones to delete.
- English UI and docs. Commit messages describe the why.

## 5b. A "setup this phone" page in every app (optional)
New apps can reuse Games Center's approach: serve the CA at `/ca.crt` with content type
`application/x-x509-ca-cert`, plus a `/setup` page reachable over plain HTTP on
`http://<NAS-IP>:<port>` (Force SSL in NPM would redirect the domain to https). Or just point
people at the Games Center setup QR: the CA is the same for every app.

## 6. Templates

### Dockerfile
```dockerfile
FROM python:3.12-slim
ARG BUILD_SHA=dev
ARG BUILD_DATE=
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data PORT=8080 BUILD_SHA=${BUILD_SHA} BUILD_DATE=${BUILD_DATE}
WORKDIR /app
RUN groupadd --gid 568 apps && useradd --uid 568 --gid 568 --no-create-home --shell /usr/sbin/nologin apps
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app
COPY web ./web
RUN mkdir -p /data && chown 568:568 /data
VOLUME ["/data"]
USER 568:568
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/api/health', timeout=4)" || exit 1
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
```

### compose.yaml (TrueNAS → Install via YAML)
```yaml
services:
  myapp:
    image: ghcr.io/eazyistired/myapp:latest
    container_name: myapp
    restart: unless-stopped
    pull_policy: always
    ports:
      - "8090:8080"              # pick a free host port per app
    environment:
      TZ: "Europe/Bucharest"
      ADMIN_PASSWORD: "change-me"
      SECURE_COOKIES: "true"     # served over HTTPS via NPM
    volumes:
      - /mnt/tank/apps/myapp:/data   # (verify) pool name
    user: "568:568"
```

### .github/workflows/build.yml
```yaml
name: test & build
on:
  push: { branches: [main], tags: ["v*"] }
  pull_request:
  workflow_dispatch:
permissions: { contents: read, packages: write }
env: { IMAGE: "ghcr.io/${{ github.repository }}" }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12", cache: pip, cache-dependency-path: "requirements*.txt" }
      - run: pip install -r requirements-dev.txt
      - run: ruff check . && pytest -q
  image:
    needs: test
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=short
            type=semver,pattern={{version}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          build-args: |
            BUILD_SHA=${{ github.sha }}
            BUILD_DATE=${{ github.event.head_commit.timestamp }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

## 7. Existing apps
| App | URL | Repo / image | Host port |
|---|---|---|---|
| Games Center | `https://games.grzv.local` | `eazyistired/games-center` | 8080 (default in its compose) **(verify)** |
