# AR Product Preview

Web AR for placing hardware products (faucets, shower heads, tiles) in a real
room. QR-gated time-limited access, admin panel for passes and the model
catalogue.

## Running locally

```bash
npm install
npm run server   # API on :8788 — prints the admin key on startup
npm run dev      # app on :5173
```

Admin panel is at `/admin`; sign in with the key the API printed.

### Testing on a phone

WebXR needs a **secure context**. `localhost` gets that for free; a LAN IP does
not, so it needs HTTPS.

- **Over USB (best):** `adb reverse tcp:5173 tcp:5173`, then open
  `http://localhost:5173` on the phone. No certificate, no warnings.
- **Over Wi-Fi:** serve HTTPS with a cert whose `subjectAltName` matches the
  LAN IP — Chrome on Android rejects a cert without one outright.

  ```bash
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout certs/key.pem -out certs/cert.pem \
    -subj "/CN=192.168.1.83" \
    -addext "subjectAltName=IP:192.168.1.83,IP:127.0.0.1,DNS:localhost"
  ```

  `vite.config.ts` picks `certs/` up automatically. Set `NO_SSL=1` for plain
  HTTP (the USB route).

## Platform support

| | Android Chrome | iOS Safari |
|---|---|---|
| WebXR AR | yes | **no** — Apple ships no `immersive-ar` on iPhone |

There is no browser workaround on iOS: every iOS browser is required to use
WebKit. `public/ios-spike.html` is a free marker-tracking fallback (MindAR).

### Per-device AR features

Requested as optional, so a session still starts when a device declines one:

Measured on real hardware:

| Feature | Used for | A33 5G | S20 FE 5G |
|---|---|---|---|
| `hit-test` | finding surfaces | yes | yes |
| `anchors` | keeping objects put off-camera | yes | yes |
| `plane-detection` | occlusion + drag targets | yes | yes |
| `light-estimation` | lighting/reflections from the real room | yes | yes |
| `mesh-detection` | scene geometry | no | no |
| `depth-sensing` | per-pixel occlusion (hands, furniture) | **no** | yes, `cpu-optimized` only |

Two traps here:

- Without `depth-sensing` only plane-based occlusion is possible — tables and
  walls hide objects behind them; a laptop or a hand cannot.
- three.js renders a depth occluder automatically, but **only** when the runtime
  grants `gpu-optimized` usage. The S20 FE offers `cpu-optimized` only, so
  `src/occlusion.ts` uploads the depth buffer itself and injects the test into
  each material's shader. Requesting `gpu-optimized` alone gets the feature
  refused outright, so both are listed in `usagePreference`.

## Deploying (split hosting)

The API keeps state on disk (`server/db.json`, `server/uploads/`), so it needs a
host with a real filesystem. Vercel is serverless and would lose passes,
sessions and uploads between invocations — the frontend goes there, the API
does not.

### API — Railway / Render / Fly

Deploy this repo; the start command is `node server/server.mjs`. It reads:

| Env | Purpose |
|---|---|
| `PORT` | assigned by the platform |
| `ALLOWED_ORIGIN` | your Vercel URL, e.g. `https://your-app.vercel.app` |

The admin key is printed to the logs on first boot — grab it from there.

Attach a **persistent volume** mounted at `server/` or the JSON store and
uploaded models are wiped on every redeploy.

### Frontend — Vercel

Import the repo; `vercel.json` sets the build. Add one env var:

```
VITE_API_URL=https://your-api.up.railway.app
```

Everything client-side routes through `src/api.ts`, so that single variable
points the app at the API. Leave it unset locally — Vite proxies `/api` and
`/models` to `localhost:8788`.

**HTTPS is mandatory** for WebXR; Vercel gives you a real certificate, which
also means QR codes scan with no warning (unlike the self-signed LAN setup).
Set the admin panel's "Link the QR points to" field to your Vercel URL.

## Tests

```bash
node src/placement.test.mjs
```
