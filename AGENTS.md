# Base44 sandbox notes

## Run

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

Web entry point: host port **3000** → container port 5178 (`node server.js`).

## Non-obvious setup facts

- **No npm dependencies.** `server.js` uses Node's standard library only; `package.json`
  has no `dependencies`, so there is no install step and no lockfile to sync.
- **System binaries are required and live in the image**, not in the repo:
  `yt-dlp`, `ffmpeg` and `chromium` are installed by `Dockerfile.base44` (which deliberately
  does *not* copy the source — the repo is bind-mounted at `/app`).
- **The server refuses to boot on `0.0.0.0` without `DAWN_PASSWORD`** (see the `IS_REMOTE`
  guard at the bottom of `server.js`). The sandbox password placeholder lives in
  `.env.base44-defaults` (`dawn-preview`); it is loaded *before* `/run/base44/app.env`, so a
  real password from the dashboard overrides it.
- **State directory.** `DAWN_DIR`/`DAWN_STATE_DIR` both point at the `/data` volume, which
  holds downloads, `users.json` and per-user Chromium profiles. Without `DAWN_STATE_DIR`
  the state lands inside the downloads folder.
- **`config.json` is written to `/app`** when settings are saved; it is gitignored, so it
  never dirties the working tree.
- **Login sessions are in-memory** (`sessions` Map): restarting the container signs
  everyone out.
- **No dev watcher.** Plain `node server.js`, so after editing `server.js`/`sniffer.js`
  run `docker compose -f docker-compose.base44.yml restart dawn` and refresh the preview.
  Static files under `public/` are read per request (`Cache-Control: no-cache`), so
  frontend edits show on reload without a restart.

## Verify

```bash
# unauthenticated health probe (also the compose healthcheck)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/login   # 200
# tools detected inside the container
curl -s -u ":dawn-preview" http://localhost:3000/api/health
# real extraction (needs network egress)
curl -s -u ":dawn-preview" -X POST http://localhost:3000/api/info \
  -H 'Content-Type: application/json' -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

`/` returns 302 → `/login` for browsers (HTML `Accept`) and 401 JSON otherwise, so use
`/login` for probes. HTTP Basic auth (`-u ":<password>"`) works for CLI checks.

## Known environment limits

- Sites that require a logged-in session (e.g. Vimeo's web client) fail with yt-dlp's
  "works when logged-in" error unless the in-app browser-cookie / sniffer flow is used.
  Inside this sandbox the sniffer's Chromium runs headless, so the interactive
  "extract from site" login step is only partly usable.
- The preview screenshot browser does not keep cookies between captures, so the
  signed-in UI has to be checked by hand (log in once in your own preview).
