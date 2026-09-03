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

One product at a time, rendered by the platform:

| | Android | iOS |
|---|---|---|
| "View in your space" | Google Scene Viewer | Apple AR Quick Look |

Both are native ARCore/ARKit system viewers, which is why they are used rather
than drawing AR in the page: they bring real depth occlusion, live light
estimation and proper contact shadows that an in-page WebXR scene cannot match
on mid-range hardware. The trade is that they show one model at a time, full
screen, with no control returned to the page — which suits a product preview.

**Stored models must be at real-world scale.** Both viewers read glTF as
1 unit = 1 metre and accept no scale parameter — they receive only a file URL.
`src/bake.ts` bakes scale and grounding into the GLB at upload, so records
carry `scale: 1`. A model stored at author scale looks fine in the turntable
preview and arrives absurdly sized in AR: one of these bottles was 47 metres.

iOS gets its USDZ generated in the browser from the same GLB (`src/usdz.ts`),
so there is one asset per product. Output verified with `usdchecker --arkit`.

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

**Commit author must be the Vercel-connected GitHub user.** On the Hobby plan
with a private repo, Vercel blocks any deployment whose commit author is a
different GitHub identity (`readyState: BLOCKED`; the CLI shows it as
`UNKNOWN`). This repo's local git config authors commits as `ego-zxx` via
GitHub's noreply address for that reason. If you clone elsewhere, set the same
`user.name`/`user.email` or pushes will silently not deploy.

The CLI path also works: `npx vercel deploy --prod`. `.vercelignore` keeps the
upload small — without it the CLI ships `node_modules`.

## Interaction and realism

Placement mechanics follow what Google's `<model-viewer>` does in AR, after
reading its source rather than guessing:

- **Motion** is a critically damped spring (`src/damper.ts`, `DECAY_MS`), not a
  lerp. It carries velocity, so the object tracks a moving finger without lag
  piling up and settles with no overshoot.
- **Dragging** hit-tests ARCore on the touch's own ray (transient-input hit
  testing, profile `generic-touchscreen`), so the object follows real surfaces
  under the finger. Off any surface it holds height and settles on release.
- **Lighting** comes from the room: `XREstimatedLight` (`EstimatedLighting` in
  `src/ARScene.tsx`) supplies the main directional light, spherical-harmonic
  ambient and an HDR reflection cube map, which is the split ARCore's own
  guidance prescribes. `KeyLight` is the fallback while no estimate exists.
- **Shadows** are the object's real silhouette from that light, caught by a
  transparent `ShadowMaterial` plane under the object. The estimate reports a
  light *direction*, so three parks the light near the session's origin and its
  frustum covered four metres for a twelve-centimetre product — a shadow too
  faint and too smeared to ground anything. `fitShadow` re-anchors the light on
  the object and fits the frustum to it each frame, so the whole map is spent
  on the caster. Map size is the quality/performance knob.
- **Camera matching** (`src/grain.ts`, AR only): sensor grain, a lens
  vignette and a plate response (lifted blacks, rolled-off whites, saturation
  falling away at both ends) so the object carries the feed's character, not
  just its light. This is the compositor's black-point/white-point match; a
  render's pure blacks and clean whites are a tell even under matched light.
- **Shadow colour** follows the room's ambient (SH band 0 → `shadowTint`), as
  a photographed shadow is the surface lit by ambient alone, never black.
- **Exposure** is matched to the feed, not left at 1. The room's ambient is
  counted once (the estimated cube map supplies it, so the SH probe is hidden
  while that map is in use — counting both made objects roughly twice as bright
  as the room), the synthetic `RoomEnvironment` fallback is dimmed to
  `ENV_FALLBACK_INTENSITY` so it cannot out-light a dim room, and a damped trim
  from the measured room level darkens the render toward the auto-exposed feed.
  `?debug=1` prints the room level and the trim; `EXPOSURE_REFERENCE` is the knob.
  Klein & Murray (ISMAR 2008) found the camera's artefacts, not the lighting,
  are the biggest remaining tell once lighting is right.
- **Occluders never cut the object.** A detected plane is a convex hull that
  overshoots the real surface, and it renders depth-only, so a plane crossing
  the product sliced it along a straight line. A real surface cannot pass
  through a solid object, so a plane intersecting the object's bounding sphere
  is a bad hull and stops occluding; planes genuinely in front still occlude.
- **Light wrap and edge softness** are done by the XR compositor rather than
  by us. The camera feed is never ours to sample, but the session composites it
  behind our layer in alpha-blend mode, so feathering alpha across the outermost
  pixels of the silhouette makes the compositor mix the *real* background into
  the object's edge. That is a true light wrap against the actual room, plus a
  soft matte, for the cost of one line. The width is measured in screen pixels
  via `fwidth`, so a tight bevel and a flat panel feather identically.
- **Halation** (`src/halation.tsx`) is the one effect that cannot be per
  material: light bleeding out of a highlight is a screen-space operation. In a
  session three renders into a framebuffer the compositor owns, so the pass
  notes that binding, renders a quarter-resolution bright pass into its own
  target, restores the binding, and adds the glow back through a full-screen
  quad in the scene. The session's render path is never taken over. The glow
  adds alpha as well as colour, so it spills onto the real room rather than
  stopping at the object's edge. It disables itself below `MIN_FPS`;
  `?nohalation=1` turns it off outright and `?debug=1` reports whether it ran.
- **Placement** turns the product's front toward the camera.
- **iOS renders none of the above.** Quick Look draws the USDZ with its own
  renderer, so the camera matching, exposure and shadow work apply to Android
  only. What the export can carry, it now does: the same metalness correction
  the WebXR path makes (the export loads its own copy of the glTF, so a model
  shipping metalness 0.12 was losing that much diffuse on iOS and nothing
  else), full-size normal and roughness maps (the exporter halves anything
  above 1K by default), and a gentle mid-tone lift on the base colour to
  answer Quick Look's darker tone curve, shaped as a gamma so neither black nor
  white moves and nothing clips. `IOS_MIDTONE_LIFT` is the knob.
- Material corrections in `src/materials.ts` are compensations for weak assets
  and disable themselves on well-authored ones: metalness is only snapped when
  there is no metalnessMap, roughness only varied when there is no
  roughnessMap. A model with a full PBR set is rendered as authored.
- Deliberately not adopted: pinch-to-scale (products are real size).

## Tests

```bash
node src/placement.test.mjs
```
