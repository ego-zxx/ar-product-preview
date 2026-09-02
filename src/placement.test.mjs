// Run: node src/placement.test.mjs
// Guards the maths that has no other safety net, now that AR rendering is
// handled by the platform (Scene Viewer / Quick Look) rather than in-page.
import assert from 'node:assert/strict'

// --- grounding models (mirrors groundingOffset in src/Model.tsx) ---
// Models are authored around arbitrary origins, but every downstream consumer —
// the turntable, the baked GLB, the generated USDZ — assumes base-at-y=0.
const groundingOffset = (min, max) => ({
  x: -(min.x + max.x) / 2 + 0,
  y: -min.y + 0,
  z: -(min.z + max.z) / 2 + 0,
})
assert.deepEqual(
  groundingOffset({ x: -1, y: -0.5, z: -1 }, { x: 1, y: 0.5, z: 1 }),
  { x: 0, y: 0.5, z: 0 },
  'a centre-origin model is lifted onto the ground',
)
assert.equal(groundingOffset({ x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }).y, 0, 'already grounded, left alone')
assert.deepEqual(
  groundingOffset({ x: 0, y: 0, z: 0 }, { x: 4, y: 1, z: 2 }),
  { x: -2, y: 0, z: -1 },
  'a corner-origin model is centred',
)
assert.equal(groundingOffset({ x: 0, y: 3, z: 0 }, { x: 1, y: 4, z: 1 }).y, -3, 'a floating model is brought down')

// --- real-world scale ---
// The system AR viewers read glTF as 1 unit = 1 metre and take no scale
// parameter, so the stored file must already be true size. Getting this wrong
// is not subtle: a beer bottle shipped at author scale is 47 metres tall.
const bakedSize = (authorSize, scale) => authorSize * scale
assert.ok(Math.abs(bakedSize(47.377, 0.005277) - 0.25) < 0.001, 'bottle bakes to 25cm')
assert.ok(Math.abs(bakedSize(0.603, 0.530680) - 0.32) < 0.001, 'pizza bakes to 32cm across')
assert.equal(bakedSize(0.094, 1), 0.094, 'a model already in metres is unchanged by scale 1')

// --- turntable orbit clamp (src/ProductPage.tsx) ---
const PITCH_MIN = -0.45, PITCH_MAX = 1.25
const clampPitch = (p) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, p))
assert.equal(clampPitch(0.5), 0.5, 'a normal tilt passes through')
assert.equal(clampPitch(99), PITCH_MAX, 'dragging far up stops at the limit')
assert.equal(clampPitch(-99), PITCH_MIN, 'dragging far down stops at the limit')
assert.ok(PITCH_MAX < Math.PI / 2 && PITCH_MIN > -Math.PI / 2, 'never reaches vertical, where the view flips')
assert.ok(PITCH_MAX > 1.0, 'tilts far enough to see into an open vessel')

// --- damping used by the turntable ---
const damp = (from, to, dt) => from + (to - from) * (1 - Math.exp(-14 * dt))
assert.ok(damp(0, 1, 1 / 60) > 0 && damp(0, 1, 1 / 60) < 1, 'eases rather than snapping')
const two60 = damp(damp(0, 1, 1 / 60), 1, 1 / 60)
assert.ok(Math.abs(two60 - damp(0, 1, 1 / 30)) < 0.01, 'damping is frame-rate independent')
assert.ok(damp(0, 1, 10) > 0.999, 'a long stall still converges without overshoot')

console.log('model + scale + turntable ok')
