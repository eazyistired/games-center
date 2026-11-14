# Deploying on TrueNAS SCALE

Target: `https://games.grzv.local` → Pi-hole → Nginx Proxy Manager → TrueNAS app.

## 1. Image (GitHub Actions → GHCR)
Every push to `main` runs the tests and publishes `ghcr.io/eazyistired/games-center:latest`
(plus a `sha-xxxxxxx` tag; git tags `v1.2.3` also publish `1.2.3`).

**Visibility:** if the repository is private, the package will be too, and TrueNAS can't pull
it anonymously. Pick one:
- GitHub → your profile → Packages → `games-center` → Package settings → **Change visibility →
  Public** (the code stays private, only the image is public), or
- keep it private and give TrueNAS registry credentials for `ghcr.io` (username + a classic PAT
  with `read:packages`), if your TrueNAS version offers registry credentials for apps.

## 2. Dataset
Storage → create dataset `tank/apps/games-center` (any pool/path), **Dataset Preset: Apps**.
Make sure user/group **apps (568)** can write to it (the preset does this).

## 3. Install the app
Apps → Discover Apps → ⋮ → **Install via YAML**. Name it `games-center` and paste
[`compose.yaml`](../compose.yaml), after editing:
- the host path in `volumes` (`/mnt/<pool>/apps/games-center:/data`)
- `ADMIN_PASSWORD`
- `TZ` (e.g. `Europe/Bucharest`)
- the host port if 8080 is already used (`"8095:8080"`)

Check: `http://<NAS-IP>:8080/api/health` → `{"status":"ok"}`.

## 4. Nginx Proxy Manager
Hosts → Proxy Hosts → Add:
- Domain: `games.grzv.local`
- Scheme `http`, Forward host `<NAS-IP>`, port `8080`
- ✅ Block common exploits, ✅ **Websockets Support** (required: live updates, lobbies and
  multi-phone games use WebSockets on `/ws`)
- SSL tab: your existing certificate, ✅ Force SSL, ✅ HTTP/2

## 5. Pi-hole
Local DNS → DNS Records: `games.grzv.local` → IP of Nginx Proxy Manager.

## 5b. HTTPS that phones trust (home CA)
What worked on this network:
- **Ports:** the TrueNAS web interface runs on **81 / 444** (System → General → GUI), so Nginx
  Proxy Manager can own **80 / 443**. The NPM app's default host ports (**30021 / 30022**) must be
  changed to 80 / 443 in Apps → Nginx Proxy Manager → Edit, otherwise `https://games.grzv.local`
  doesn't load (it only works as `https://games.grzv.local:30022`).
- **Certificate:** a home root CA ("Home Lab Root CA", `homeCA.crt` + `homeCA.key`, 10 years) signs
  a wildcard certificate for `*.grzv.local` (825 days, SAN + serverAuth). Files are backed up in
  `/mnt/storage2/storage_main/certs`. Recreating the CA means re-installing it on every phone,
  so don't; just re-sign the site certificate every ~2 years:
  ```bash
  openssl x509 -req -in grzv.local.csr -CA homeCA.crt -CAkey homeCA.key -CAcreateserial -out grzv.local.crt -days 825 -sha256 -extfile grzv.local.ext
  ```
  then upload the new `grzv.local.crt` as the custom certificate in NPM.
- **Phones trust the CA** (once per device): upload `homeCA.crt` in **Admin → Settings → Home
  certificate**, fill in the two addresses, and let people scan the QR there (or 📲 Invite →
  "First time on this phone"). It opens `/setup` over plain HTTP on `http://<NAS-IP>:8080`, which
  shows the steps for iPhone / Android / computers (incl. the easy-to-miss iPhone switch:
  Settings → General → About → Certificate Trust Settings).
- **Check what NPM serves** (TrueNAS shell, which doesn't use Pi-hole, so connect to 127.0.0.1):
  ```bash
  openssl s_client -connect 127.0.0.1:443 -servername games.grzv.local </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName
  ```

## 6. Phones
Open `https://games.grzv.local`, then **Share → Add to Home Screen** (iOS) or
**⋮ → Add to Home screen** (Android) for a fullscreen app icon.

Two things to know:
- **Tilt controls and keep-screen-awake only work over HTTPS that the phone trusts.** If the
  certificate is self-signed or from a local CA, install/trust that CA on each phone (iOS:
  install profile, then Settings → General → About → Certificate Trust Settings). Without it,
  Heads Up still works with tap controls.
- **`.local` names on Apple devices:** iOS/macOS resolve `*.local` with multicast DNS (Bonjour)
  and may not ask Pi-hole. If iPhones can't open the site while Android can, the fix is to use a
  different suffix such as `games.grzv.lan` or `games.home.arpa` (Pi-hole record + NPM host +
  certificate).

## 7. Updating
Push to `main` → wait for the GitHub Action (green ✓) → TrueNAS Apps → games-center →
**Update** if offered, or **Edit → Save** to redeploy (the compose file uses `pull_policy: always`).
Database migrations run automatically at startup.

Pin a version instead of `latest` by using a tag (e.g. `ghcr.io/eazyistired/games-center:1.0.0`)
if you want updates only when you choose.

## Which version is running?
Admin → Dashboard shows **Running version** (the git commit, with a link) and
`https://games.grzv.local/api/health` returns it too. Compare it with the latest commit on `main`.

## 8. Backups
- The app writes a SQLite backup to `/data/backups` every 24h (14 kept) and on demand
  (Admin → Backup). Admin → Backup also has a full JSON export/import.
- Add a periodic ZFS snapshot task for the dataset for point-in-time recovery.

## Troubleshooting
| Symptom | Fix |
|---|---|
| App won't start, `unable to open database file` / permission denied | Dataset not writable by 568:568: fix the dataset permissions (Apps preset) |
| Admin says "Admin disabled" | Set `ADMIN_PASSWORD` in the app's YAML and redeploy |
| Lobby / Live now / watch screens don't update by themselves | Turn on **Websockets Support** on the NPM proxy host |
| Tilt does nothing | Not HTTPS / cert not trusted / motion permission denied. Use **Test tilt** on the Heads Up start screen (and **Flip tilt direction** if up/down are swapped), or turn **Tilt controls** off and use taps |
| Old UI after update | Pull to refresh; assets revalidate on every load |
| Logs | Apps → games-center → Logs |
