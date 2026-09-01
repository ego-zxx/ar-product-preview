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

| Feature | Used for | Galaxy A33 5G |
|---|---|---|
| `hit-test` | finding surfaces | yes |
| `anchors` | keeping objects put off-camera | yes |
| `plane-detection` | occlusion + drag targets | yes |
| `light-estimation` | lighting/reflections from the real room | yes |
| `depth-sensing` | per-pixel occlusion (hands, furniture) | **no** |

Without `depth-sensing` only plane-based occlusion is possible — tables and
walls hide objects behind them; a laptop or a hand cannot.

## Deploying

**The API does not run on Vercel as-is.** `server/server.mjs` is a long-lived
Node process storing state in `server/db.json` and uploaded models in
`server/uploads/`. Serverless filesystems are ephemeral, so passes, sessions and
uploads would vanish between invocations.

Options:

1. Frontend on Vercel, API on a host with a real filesystem (Railway, Render,
   Fly). Point the frontend's `/api` and `/models` at it.
2. Port the API to serverless functions plus managed storage (Postgres/KV for
   the tables, Blob for the `.glb` files).

## Tests

```bash
node src/placement.test.mjs
```
