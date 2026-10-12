# RepState — 44-week progress tracker

RepState is a browser-based hypertrophy tracker with a 44-week plan, workout logs, check-ins, milestones, and progress analytics. It can run in local-only mode or as a self-hosted app with private cross-device sync.

## Self-hosted accounts and sync

The sync-enabled app is a single Python service with a same-origin JSON API and a persistent SQLite database. Anyone can create an account using **only a username and password**; there are no email, profile, or other user-information fields. Each username has a separate private tracker dataset, which syncs across that user's browsers and devices after they sign in.

### Create an account

1. Open **Settings → Private device sync**.
2. Choose **Create an account**.
3. Enter a username (3–32 letters, numbers, dots, underscores, or hyphens) and a password of at least 10 characters.
4. Use the same username and password on each device. The first sign-in on a new device downloads that account's synced data.

Changes save locally immediately and then sync automatically. The app checks for remote changes when a device returns to the foreground and periodically while open. Concurrent edits use revision checks and per-record timestamps to merge non-conflicting workouts, check-ins, dates, milestones, and settings.

### Change your password

While signed in, open **Settings → Private device sync**, enter your current password and a new password, then choose **Change password**. The new password must be at least 10 characters. Other active sessions for that username are signed out when the password changes; the current device stays signed in.

Because accounts intentionally collect no email or recovery information, there is no self-service password reset if a password is forgotten. Keep the password in a password manager.

### Existing single-account installation

On the first upgraded start, RepState imports the previous configured account and its tracker row into the new per-user tables without deleting the original `tracker_state` row. The previous login value (formerly the account email) remains valid as that account's **username**, and its existing password continues to work. The old `SYNC_EMAIL` and `SYNC_PASSWORD_HASH` environment variables are read only to perform this one-time compatibility migration; they are optional for new installs and signups.

The SQLite file and account state must remain on persistent storage across deployments. Back up the database volume or directory before upgrades, and keep using **Export backup** for an independent JSON copy.

### Deployment requirements

- Docker Engine with Docker Compose, or a Coolify Docker Compose resource
- A hostname routed to the service with HTTPS enabled by Coolify
- The service exposed only through Coolify's HTTPS proxy; do not expose port 8000 directly to the public internet

The service listens on port `8000`. A health check is available at `/api/healthz`. The default Compose file uses a named `repstate-data` volume at `/data`; other Coolify deployments may bind-mount a persistent host directory there.

## Run directly (local development)

No account configuration is required. Start the server, open the app, and create an account from Settings when ready to test sync.

```sh
export COOKIE_SECURE=0
python3 server.py
```

Open `http://localhost:8000`. `COOKIE_SECURE=0` is only for local HTTP testing; leave secure cookies enabled behind HTTPS in production.

## Build and run with Docker Compose

```sh
docker compose up --build -d
```

The optional `SYNC_USERNAME`, `SYNC_EMAIL`, and `SYNC_PASSWORD_HASH` variables in `.env` are only for upgrading the old single-account installation. Do not remove the existing values until the migration has completed and the legacy account has been verified. New users register through the app.

## Backups and data migration

- **Export backup** downloads a JSON copy of the current browser state.
- **Settings → Import backup** imports a prior RepState JSON backup. If signed in, the imported data is then synced to that user's VPS dataset.
- The SQLite database contains account password verifiers, sessions, and per-user tracker states. Back up its persistent volume/directory before replacing app code; a JSON export is useful but does not replace the server-side database backup.
- The schema upgrade keeps the old single-row tracker table intact after copying its contents to the legacy account, allowing a rollback/inspection if required.

## Local-only Cloudflare Worker

The included `wrangler.jsonc` and `src/worker.js` still deploy the static tracker to Cloudflare Workers. That deployment remains browser-local only because it does not include the SQLite sync server. Use the Docker/Coolify deployment for cross-device accounts.

```sh
npx --yes wrangler@4.102.0 dev
npx --yes wrangler@4.102.0 deploy
```

## Source layout

- `public/index.html` — app shell and navigation
- `public/app.js` — interface, local persistence, backups, username/password account UI, and sync client
- `public/styles.css` — responsive styling
- `public/program.json` — 44-week training plan and reference data
- `public/reference.html`, `public/reference.css`, `public/reference.md` — complete program reference
- `public/assets/gym-hero.jpg` — overview hero image
- `src/worker.js`, `wrangler.jsonc` — local-only Cloudflare Worker deployment
- `server.py` — same-origin account/session/sync API with per-user SQLite state
- `Dockerfile`, `docker-compose.yml` — self-hosted deployment
- `tools/generate_sync_hash.py` — password-verifier generator retained for older setup workflows
