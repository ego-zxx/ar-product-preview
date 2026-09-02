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
  ./tools/make-cert.sh
  ```

  Re-run it whenever DHCP changes the machine's IP — the certificate must name
  the exact address being visited or Chrome refuses it with no way through.

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

## Deploying to cPanel

cPanel suits this better than a serverless host: it has a real filesystem, so
`server/db.json` and uploaded models persist, and AutoSSL issues a **real
certificate** — which is what finally makes QR codes scan without a warning.

### Which of the two setups you need

Look for **Setup Node.js App** in cPanel (Software section).

**If it is there — full app.** Frontend and API both run.

1. Upload the repo (minus `node_modules`) to something like `~/ar-api`.
2. Setup Node.js App → Node 20+, application root `~/ar-api`, startup file
   `server/server.mjs`. Add environment variables:
   `ALLOWED_ORIGIN=https://yourdomain.com`. cPanel supplies `PORT`.
3. Run NPM Install, then Start. The admin key prints to the app log on first
   boot — take it from there.
4. Build the frontend against it and upload:
   ```bash
   VITE_API_URL=https://yourdomain.com npm run package
   ```
   Unzip `ar-preview-cpanel.zip` into `public_html`.

**If it is not there — demo without the backend.** No QR passes, no admin, no
uploads; the catalogue and AR still work, using the built-in products.

```bash
VITE_OPEN_ACCESS=1 npm run package
```

`VITE_OPEN_ACCESS=1` removes the pass gate, since with no API there is nothing
to issue or check passes against.

### Either way

- Unzip into `public_html` (or a subfolder — then build with
  `VITE_BASE=/ar/` so asset paths resolve).
- `public/.htaccess` ships with the build and handles the three things Apache
  gets wrong here: forcing HTTPS (WebXR will not start without it), serving
  `.glb` as `model/gltf-binary` (a wrong Content-Type makes the loader reject
  the model), and routing `/admin` to `index.html`.
- Admin is reachable at `/admin` or `/#/admin` — the hash route needs no
  rewrite at all, so use it if the rewrite gives trouble.
- In admin, set **Link the QR points to** to your real domain.

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
| `DATA_DIR` | where `db.json` and uploads live — point it at the volume, e.g. `/data` |

The admin key is printed to the logs on first boot — grab it from there.

Attach a **persistent volume** and set `DATA_DIR` to its mount path. Without
it the JSON store and uploaded models are wiped on every redeploy. Do not
mount the volume over `server/` — it would hide `server.mjs`.

### Frontend — Vercel

Import the repo; `vercel.json` sets the build. Add one env var:

```
VITE_API_URL=https://your-api.up.railway.app
```

Everything client-side routes through `src/api.ts`, so that single variable
points the app at the API. It is the API's **origin only** — the client adds
`/api/...` and `/models/...` itself. Leave it unset locally — Vite proxies `/api` and
`/models` to `localhost:8788`.

**HTTPS is mandatory** for WebXR; Vercel gives you a real certificate, which
also means QR codes scan with no warning (unlike the self-signed LAN setup).
Set the admin panel's "Link the QR points to" field to your Vercel URL.

## Interaction and realism

Placement mechanics follow what Google's `<model-viewer>` does in AR, after
reading its source rather than guessing:

- **Motion** is a critically damped spring (`src/damper.ts`, `DECAY_MS`), not a
  lerp. It carries velocity, so the object tracks a moving finger without lag
  piling up and settles with no overshoot.
- **Dragging** hit-tests ARCore on the touch's own ray (transient-input hit
  testing, profile `generic-touchscreen`), so the object follows real surfaces
  under the finger. Off any surface it holds height and settles on release.
- **Shadows** are the object's real silhouette from an overhead key light
  (`KeyLight` in `src/ARScene.tsx`), caught by a transparent `ShadowMaterial`
  plane under each object. Map size is the quality/performance knob.
- **Placement** turns the product's front toward the camera.
- Deliberately not adopted: pinch-to-scale (products are real size) and
  `XREstimatedLight` (removed by request; it is the right way to bring room
  lighting back if wanted).

## Tests

```bash
node src/placement.test.mjs
```
