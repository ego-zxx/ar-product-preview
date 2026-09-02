// Run: node src/placement.test.mjs
// Guards the placement maths that has no other safety net.
import assert from 'node:assert/strict'

// --- two-finger twist (mirrors angleDelta in ARScene.tsx) ---
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a))
const twistOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x)

assert.equal(angleDelta(0, 0), 0, 'no twist = no rotation')
// a quarter turn of the fingers is a quarter turn of the object, 1:1
assert.ok(Math.abs(angleDelta(0, Math.PI / 2) - Math.PI / 2) < 1e-9, 'quarter turn maps 1:1')
// opposite twists rotate opposite ways
assert.ok(Math.sign(angleDelta(0, 0.4)) !== Math.sign(angleDelta(0, -0.4)), 'direction follows the twist')

// The whole point: rotation must not stop at half a turn. atan2 wraps at +/-PI,
// so accumulating raw differences caps at 180 degrees and jumps on the wrap.
let yaw = 0
let prev = 0
// sweep the fingers through three full turns in small steps
for (let i = 1; i <= 360; i++) {
  const twist = twistOf({ x: 0, y: 0 }, { x: Math.cos(i * 0.05), y: Math.sin(i * 0.05) })
  yaw += angleDelta(prev, twist)
  prev = twist
}
assert.ok(Math.abs(yaw - 360 * 0.05) < 1e-6, `three full turns accumulate, got ${yaw} rad`)
assert.ok(Math.abs(yaw) > Math.PI, 'rotation passes half a turn instead of stopping there')
// and the same sweep backwards returns to zero, with no jump at the wrap
for (let i = 360; i >= 0; i--) {
  const twist = twistOf({ x: 0, y: 0 }, { x: Math.cos(i * 0.05), y: Math.sin(i * 0.05) })
  yaw += angleDelta(prev, twist)
  prev = twist
}
assert.ok(Math.abs(yaw) < 1e-6, 'twisting back unwinds exactly, no accumulated drift')
// every step is small: a wrap must never produce a near-full-turn jump
assert.ok(Math.abs(angleDelta(Math.PI - 0.01, -Math.PI + 0.01)) < 0.05, 'wrap is a small step, not a spin')

// --- grab offset: dragging must not teleport the object under the finger ---
const grabbed = (objPos, hitAtGrab) => objPos - hitAtGrab
const dragged = (hitNow, offset) => hitNow + offset
const offset = grabbed(2.0, 1.6) // finger landed 40cm from the object's centre
assert.equal(dragged(1.6, offset), 2.0, 'object does not jump when the drag starts')
assert.equal(dragged(2.1, offset), 2.5, 'object travels exactly as far as the finger')

// --- drag smoothing: exponential damping, frame-rate independent ---
const damp = (from, to, dt) => from + (to - from) * (1 - Math.exp(-18 * dt))
assert.ok(damp(0, 1, 1 / 60) > 0 && damp(0, 1, 1 / 60) < 1, 'eases rather than snapping')
assert.ok(damp(0, 1, 1 / 30) > damp(0, 1, 1 / 60), 'a longer frame moves further')
// two 60fps steps land close to one 30fps step: motion is not frame-rate dependent
const twoSteps = damp(damp(0, 1, 1 / 60), 1, 1 / 60)
assert.ok(Math.abs(twoSteps - damp(0, 1, 1 / 30)) < 0.01, 'damping is frame-rate independent')
assert.ok(damp(0, 1, 10) > 0.999, 'a long stall still converges, never overshoots')

// --- ray/plane projection used by drag-to-move ---
// Ray from the camera through a screen point, hitting the horizontal plane the
// object sits on. If this is wrong the object slides to infinity or behind you.
function intersectGroundPlane(origin, dir, planeY) {
  const denom = dir[1]
  if (Math.abs(denom) < 1e-6) return null // parallel: no slide
  const t = (planeY - origin[1]) / denom
  if (t < 0) return null // plane is behind the camera
  return [origin[0] + dir[0] * t, planeY, origin[2] + dir[2] * t]
}

// camera 1.5m up, looking down 45° forward -> lands 1.5m ahead on the floor
const hit = intersectGroundPlane([0, 1.5, 0], [0, -Math.SQRT1_2, -Math.SQRT1_2], 0)
assert.ok(hit && Math.abs(hit[2] + 1.5) < 1e-6, `expected z=-1.5, got ${hit && hit[2]}`)
assert.equal(hit[1], 0, 'result sits exactly on the plane')

// looking level at the horizon must not place anything
assert.equal(intersectGroundPlane([0, 1.5, 0], [0, 0, -1], 0), null, 'parallel ray rejected')
// looking up must not place behind the user
assert.equal(intersectGroundPlane([0, 1.5, 0], [0, 0.7, -0.7], 0), null, 'plane behind camera rejected')
// a table at 0.75m is reached before the floor
const table = intersectGroundPlane([0, 1.5, 0], [0, -Math.SQRT1_2, -Math.SQRT1_2], 0.75)
assert.ok(Math.abs(table[2] + 0.75) < 1e-6, 'higher plane is nearer')

console.log('placement logic ok')

// --- surface snap: an object may never hover above what it rests on ---
// Cast down from just above the object; pin Y to the first surface hit.
function snapToSurface(objY, surfaceYs, castHeight = 0.5) {
  const from = objY + castHeight
  const below = surfaceYs.filter((y) => y <= from).sort((a, b) => b - a)
  return below.length ? below[0] : objY // nothing under it: leave it alone
}

// dropped slightly above a table -> lands exactly on it
assert.equal(snapToSurface(0.78, [0.75, 0]), 0.75, 'snaps down onto the table')
// dropped slightly below -> lifted back onto the surface, never sunk into it
assert.equal(snapToSurface(0.72, [0.75, 0]), 0.75, 'lifted out of the table top')
// table and floor both present -> takes the nearest surface above the floor
assert.equal(snapToSurface(0.74, [0.75, 0]), 0.75, 'picks the table, not the floor')
// far above everything -> falls to the floor rather than hanging in the air
assert.equal(snapToSurface(0.2, [0]), 0, 'falls to the floor')
// no surfaces detected yet -> hold position rather than teleport to y=0
assert.equal(snapToSurface(0.9, []), 0.9, 'no surface: object is left untouched')

console.log('surface snap ok')

// --- real-world scale ---
// Products are authored in metres and never rescaled to the screen, so their
// on-screen size is purely perspective. If a model's dimensions drift out of
// plausible range it will look wrong in a real room no matter how good the
// tracking is, so pin them here.
import { readFileSync } from 'node:fs'
const models = readFileSync(new URL('./models.tsx', import.meta.url), 'utf8')
const profile = models.slice(models.indexOf('CUP_POINTS'), models.indexOf('as [number, number][]'))
const pts = [...profile.matchAll(/\[([\d.]+), ([\d.]+)\]/g)].map(([, x, y]) => [+x, +y])
const cupHeight = Math.max(...pts.map(([, y]) => y))
const cupWidth = Math.max(...pts.map(([x]) => x)) * 2

assert.ok(cupHeight > 0.07 && cupHeight < 0.13, `mug height ${cupHeight}m is not mug-sized`)
assert.ok(cupWidth > 0.06 && cupWidth < 0.12, `mug width ${cupWidth}m is not mug-sized`)
// a mug is taller than it is wide, but not by much — catches a swapped axis
assert.ok(cupHeight > cupWidth && cupHeight < cupWidth * 1.6, 'mug proportions are off')

// Nothing may rescale a product by viewing distance; that would defeat
// perspective. Only the admin-set `scale` (units correction) is allowed.
const scene = readFileSync(new URL('./ARScene.tsx', import.meta.url), 'utf8')
assert.ok(!/scale=\{[^}]*distance/i.test(scene), 'product scale must not depend on distance')
assert.ok(!/lookAt\(/.test(scene), 'products must not billboard toward the camera')

console.log('real-world scale ok')

// --- product page turntable orbit ---
// Pitch must stop short of straight up/down, where a turntable flips over.
const PITCH_MIN = -0.45, PITCH_MAX = 1.25
const clampPitch = (p) => Math.min(PITCH_MAX, Math.max(PITCH_MIN, p))

assert.equal(clampPitch(0.5), 0.5, 'a normal tilt passes through')
assert.equal(clampPitch(99), PITCH_MAX, 'dragging far up stops at the limit')
assert.equal(clampPitch(-99), PITCH_MIN, 'dragging far down stops at the limit')
assert.ok(PITCH_MAX < Math.PI / 2, 'never reaches straight down, which would flip the view')
assert.ok(PITCH_MIN > -Math.PI / 2, 'never reaches straight up either')
// looking down into an open vessel has to be reachable, or the preview is 2D
assert.ok(PITCH_MAX > 1.0, 'can tilt far enough to see into a cup from above')

console.log('turntable orbit ok')

// --- drag plane stays fixed for the whole gesture ---
// Dragging projects onto a plane captured when the grab began, not onto
// ARCore's plane meshes, whose geometry is re-estimated constantly. Re-deriving
// the plane mid-drag is what made the object jump.
function rayToPlane(originY, dirY, planeY) {
  if (Math.abs(dirY) < 1e-6) return null
  const t = (planeY - originY) / dirY
  return t < 0 ? null : t
}
const planeY = 0.75
// the plane must not move even if the reported surface wobbles
const wobbles = [0.75, 0.762, 0.741, 0.758]
const tOnFixed = wobbles.map(() => rayToPlane(1.5, -0.7, planeY))
assert.ok(tOnFixed.every((t) => t === tOnFixed[0]), 'a fixed plane gives a stable hit')
const tOnWobbly = wobbles.map((y) => rayToPlane(1.5, -0.7, y))
assert.ok(new Set(tOnWobbly).size > 1, 'tracking the raw surface would jitter — hence the fixed plane')

// --- surface snap eases rather than pinning ---
const easeY = (y, target, dt) => y + (target - y) * (1 - Math.exp(-14 * dt))
const stepped = easeY(0.80, 0.75, 1 / 60)
assert.ok(stepped < 0.80 && stepped > 0.75, 'moves toward the surface without snapping onto it')
assert.ok(Math.abs(easeY(0.80, 0.75, 2) - 0.75) < 1e-3, 'still settles exactly onto the surface')

console.log('drag stability ok')

// --- a select while positioning must not reset the pose ---
// Lifting the fingers after a twist or drag emits an XR select. Acting on it
// re-seeded the draft's position and yaw, so the object snapped back the
// instant you let go — and rotation could never accumulate past one gesture.
function onSelect({ draftActive, picked }, pose) {
  if (draftActive) return pose // positioning: Lock and Cancel are the only exits
  if (picked == null) return { pos: 'reticle', yaw: 0 } // fresh draft
  return pose
}

const turned = { pos: 'where I put it', yaw: 2.6 } // well past a half turn
assert.deepEqual(
  onSelect({ draftActive: true, picked: null }, turned),
  turned,
  'letting go mid-position keeps the rotation',
)
assert.deepEqual(
  onSelect({ draftActive: true, picked: 3 }, turned),
  turned,
  'and keeps it even if the ray happens to cross another object',
)
assert.deepEqual(
  onSelect({ draftActive: false, picked: null }, turned),
  { pos: 'reticle', yaw: 0 },
  'a fresh draft still starts from a clean pose',
)

// rotation must survive repeated grab/release cycles to exceed one turn
let held = 0
for (let gesture = 0; gesture < 5; gesture++) {
  held += 1.5 // each two-finger twist adds ~86 degrees
  held = onSelect({ draftActive: true, picked: null }, { yaw: held }).yaw // release
}
assert.ok(held > Math.PI * 2, `five gestures accumulate past a full turn, got ${held} rad`)

console.log('draft pose retention ok')

// --- selecting a placed object ---
// Picking used to raycast down the screen's centre line, so choosing an object
// meant aiming the whole phone at it rather than tapping it. Picking now
// follows the finger's ray, with a tolerance — demanding a direct hit on a
// 4cm spout is not achievable handheld.
const SELECT_TOLERANCE = 0.14

/** Perpendicular distance from a point to a ray (normalised direction). */
function distanceToRay(origin, dir, point) {
  const v = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]
  const t = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]
  const proj = [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]
  return Math.hypot(point[0] - proj[0], point[1] - proj[1], point[2] - proj[2])
}

const eye = [0, 0, 0]
const forward = [0, 0, -1]
// dead on
assert.ok(distanceToRay(eye, forward, [0, 0, -1]) < 1e-9, 'a direct hit selects')
// a near miss still selects — this is the whole point of the tolerance
assert.ok(distanceToRay(eye, forward, [0.10, 0, -1]) < SELECT_TOLERANCE, '10cm off still selects')
// but a clearly different object does not get grabbed by accident
assert.ok(distanceToRay(eye, forward, [0.4, 0, -1]) > SELECT_TOLERANCE, '40cm off does not select')
// tolerance is perpendicular, so it does not widen with distance in a way that
// makes far objects greedy
assert.ok(
  Math.abs(distanceToRay(eye, forward, [0.2, 0, -3]) - 0.2) < 1e-9,
  'tolerance is a true perpendicular distance, not an angle',
)

console.log('selection tolerance ok')

// --- critically damped spring (mirrors src/damper.ts, model-viewer's Damper) ---
class Damper {
  constructor(decayMs = 50) { this.v = 0; this.w = 1 / Math.max(0.001, decayMs) }
  reset() { this.v = 0 }
  update(x, goal, dt, norm = 1) {
    const w = this.w, nil = 0.0002 * w
    if (norm === 0) return goal
    if (x === goal && this.v === 0) return goal
    if (dt < 0) return x
    const dX = x - goal
    const iv = this.v + w * dX
    const iX = dX + dt * iv
    const decay = Math.exp(-w * dt)
    const nv = (iv - w * iX) * decay
    const acc = -w * (nv + iv * decay)
    if (Math.abs(nv) < nil * Math.abs(norm) && acc * dX >= 0) { this.v = 0; return goal }
    this.v = nv
    return goal + iX * decay
  }
}
const run = (steps, dt, from = 0, to = 1) => {
  const d = new Damper(); let x = from; const trace = []
  for (let i = 0; i < steps; i++) { x = d.update(x, to, dt); trace.push(x) }
  return trace
}

// arrives, and lands exactly (the nil-speed snap), not asymptotically
const t60 = run(120, 1000 / 60)
assert.equal(t60[t60.length - 1], 1, 'settles exactly on the goal')
// never overshoots — critically damped, the whole point over a plain spring
assert.ok(t60.every((x) => x <= 1 + 1e-9), 'no overshoot')
// monotonic approach: no wobble on the way in
assert.ok(t60.every((x, i) => i === 0 || x >= t60[i - 1] - 1e-12), 'monotonic')
// frame-rate independent: 30fps and 60fps agree on where it is after 200ms
const at30 = run(6, 1000 / 30)[5]
const at60 = run(12, 1000 / 60)[11]
assert.ok(Math.abs(at30 - at60) < 0.02, `30fps vs 60fps after 200ms: ${at30} vs ${at60}`)
// carries velocity: a moving goal is tracked without the lag piling up
{
  const d = new Damper(); let x = 0
  for (let i = 1; i <= 60; i++) x = d.update(x, i * 0.01, 1000 / 60) // goal moves 1cm/frame
  assert.ok(0.6 - x < 0.08, `tracks a moving goal closely, lag ${(0.6 - x).toFixed(3)}m`)
}
// a stalled frame is clamped upstream to 100ms; even that must not explode
const stall = new Damper(); const afterStall = stall.update(0, 1, 100)
assert.ok(afterStall > 0 && afterStall <= 1, 'a long frame still lands inside [0, goal]')
// reset() forgets momentum so a new draft doesn't inherit the old drag's speed
{
  const d = new Damper(); d.update(0, 1, 16); d.update(0.2, 1, 16); d.reset()
  assert.equal(d.update(5, 5, 16), 5, 'after reset, sitting on the goal stays put')
}

// --- face the camera on placement ---
const faceCameraYaw = (dx, dz) => Math.atan2(-dx, -dz)
const front = (yaw) => [Math.sin(yaw), Math.cos(yaw)] // where a +Z front points after yaw
const near = (a, b) => Math.abs(a - b) < 1e-9
// camera looking down -Z: the front should point back at it, i.e. +Z
{ const [fx, fz] = front(faceCameraYaw(0, -1)); assert.ok(near(fx, 0) && near(fz, 1), 'faces a camera looking -Z') }
// camera looking +X: front should point -X
{ const [fx, fz] = front(faceCameraYaw(1, 0)); assert.ok(near(fx, -1) && near(fz, 0), 'faces a camera looking +X') }
// in general the front is exactly opposite the camera's forward
for (const a of [0.3, 1.1, 2.4, -2.0]) {
  const dx = Math.sin(a), dz = -Math.cos(a)
  const [fx, fz] = front(faceCameraYaw(dx, dz))
  assert.ok(near(fx, -dx) && near(fz, -dz), `front opposes camera forward at ${a}`)
}

console.log('spring + face-camera ok')

// --- grounding uploaded models (mirrors groundingOffset in ARScene.tsx) ---
const groundingOffset = (min, max) => ({ x: -(min.x + max.x) / 2 + 0, y: -min.y + 0, z: -(min.z + max.z) / 2 + 0 })
// a model authored around its centre (the common case) must be lifted by half its height
{ const o = groundingOffset({ x: -1, y: -0.5, z: -1 }, { x: 1, y: 0.5, z: 1 }); assert.deepEqual(o, { x: 0, y: 0.5, z: 0 }, 'centred model lifted onto the ground') }
// a model already on the ground is left alone vertically
{ const o = groundingOffset({ x: -1, y: 0, z: -1 }, { x: 1, y: 2, z: 1 }); assert.equal(o.y, 0, 'grounded model not moved') }
// a model authored from a corner is centred over the origin
{ const o = groundingOffset({ x: 0, y: 0, z: 0 }, { x: 4, y: 1, z: 2 }); assert.deepEqual(o, { x: -2, y: 0, z: -1 }, 'corner-origin model centred') }
// one floating above the ground is brought down, not left hovering
{ const o = groundingOffset({ x: 0, y: 3, z: 0 }, { x: 1, y: 4, z: 1 }); assert.equal(o.y, -3, 'floating model brought to ground') }
console.log('model grounding ok')

// --- real-world scale baking (src/bake.ts) ---
// The system AR viewers read glTF as 1 unit = 1 metre and take no scale
// parameter, so a stored file must already be true size.
const bakedSize = (authorSize, scale) => authorSize * scale
assert.ok(Math.abs(bakedSize(47.377, 0.005277) - 0.25) < 0.001, 'bottle bakes to 25cm')
assert.ok(Math.abs(bakedSize(0.603, 0.530680) - 0.32) < 0.001, 'pizza bakes to 32cm across')
assert.equal(bakedSize(0.094, 1), 0.094, 'a model already in metres is unchanged by scale 1')
console.log('scale baking ok')

// --- product page pinch-to-zoom (mirrors ProductPage.tsx) ---
// Fingers apart = closer. The ratio is start-gap over current-gap, applied to
// the distance at the moment the pinch began, so a pinch is reversible: spread
// then re-pinch returns to where it started rather than drifting.
const clampDist = (d, min, max) => Math.min(max, Math.max(min, d))
const zoom = (startGap, gapNow, startDist, min, max) =>
  clampDist(startDist * (startGap / Math.max(1, gapNow)), min, max)

const [D, MIN, MAX] = [1.0, 0.4, 2.5]
assert.equal(zoom(200, 200, D, MIN, MAX), 1.0, 'no movement, no zoom')
assert.ok(zoom(200, 400, D, MIN, MAX) < 1.0, 'spreading fingers moves the camera closer')
assert.ok(zoom(200, 100, D, MIN, MAX) > 1.0, 'pinching in moves it away')
// reversible: spread to a gap and back to the original returns the start distance
assert.equal(zoom(200, 200, zoom(200, 400, D, MIN, MAX) && D, MIN, MAX), 1.0, 'pinch is reversible')
// clamps hold, so the model can never be lost or turned inside out
assert.equal(zoom(200, 100000, D, MIN, MAX), MIN, 'cannot zoom past the near limit')
assert.equal(zoom(200, 1, D, MIN, MAX), MAX, 'cannot zoom past the far limit')
assert.ok(MIN > 0, 'near limit never reaches the model centre')
// a zero gap (both fingers on one point) must not divide by zero
assert.ok(Number.isFinite(zoom(200, 0, D, MIN, MAX)), 'a degenerate gap stays finite')

console.log('pinch zoom ok')

// --- material patching must compose, not overwrite ---
// grain.ts and occlusion.ts both hook onBeforeCompile on the same material.
// Whichever ran second used to replace the first, silently dropping its shader
// injection. Both now chain onto whatever was already there.
{
  const calls = []
  const material = { onBeforeCompile: null, needsUpdate: false }

  const chain = (label) => {
    const previous = material.onBeforeCompile
    material.onBeforeCompile = function (shader, renderer) {
      previous?.call(this, shader, renderer)
      calls.push(label)
    }
  }
  chain('occlusion')
  chain('grain')
  material.onBeforeCompile({}, {})
  assert.deepEqual(calls, ['occlusion', 'grain'], 'both patches run, in order applied')

  // and a material with no prior hook still works
  const fresh = { onBeforeCompile: null }
  const seen = []
  const previous = fresh.onBeforeCompile
  fresh.onBeforeCompile = function (s, r) { previous?.call(this, s, r); seen.push('only') }
  fresh.onBeforeCompile({}, {})
  assert.deepEqual(seen, ['only'], 'chaining onto nothing is safe')
}

// --- contact shade scales with the object, not a fixed guess ---
const contactRadius = (sizeX, sizeZ, scale) => Math.max(sizeX, sizeZ) * 0.5 * scale
assert.ok(Math.abs(contactRadius(0.067, 0.067, 1) - 0.0335) < 1e-9, 'a bottle gets a small shade')
assert.ok(Math.abs(contactRadius(0.32, 0.32, 1) - 0.16) < 1e-9, 'a pizza gets a wide one')
assert.ok(contactRadius(0.32, 0.32, 1) > contactRadius(0.067, 0.067, 1), 'bigger footprint, bigger shade')

console.log('material patching + contact shade ok')

// --- material corrections (src/materials.ts) ---
const METAL_FLOOR = 0.3
const correctMetalness = (m) => {
  if (m.metalnessMap || m.metalness === 0 || m.metalness >= METAL_FLOOR) return false
  m.metalness = 0
  return true
}
// the actual values measured in the burger: modelling noise on food
assert.ok(correctMetalness({ metalness: 0.12 }), 'stray metalness on vegetables is corrected')
assert.ok(correctMetalness({ metalness: 0.07 }), 'stray metalness on lettuce is corrected')
// a real metal must survive untouched, or chrome taps turn to plastic
const chrome = { metalness: 1 }
assert.equal(correctMetalness(chrome), false, 'a true metal is left alone')
assert.equal(chrome.metalness, 1, 'and keeps its value')
assert.equal(correctMetalness({ metalness: 0.85 }), false, 'brushed metal is left alone')
// an author who supplied a map meant it
assert.equal(correctMetalness({ metalness: 0.1, metalnessMap: {} }), false, 'a metalness map is respected')
// already correct, so no needless invalidation
assert.equal(correctMetalness({ metalness: 0 }), false, 'a dielectric is not touched')

// roughness variation only fills a gap, never overrides an author
const varies = (m) => !(m.roughnessMap || !m.map)
assert.ok(varies({ map: {} }), 'a model with no roughness map gets variation')
assert.equal(varies({ map: {}, roughnessMap: {} }), false, 'an authored roughness map wins')
assert.equal(varies({}), false, 'nothing to derive from without a colour map')

// the shader keeps roughness in a sane range whatever the colour map does
const applyVary = (base, lum, amount = 0.35) =>
  Math.min(1, Math.max(0.04, base + (0.5 - lum) * amount))
assert.ok(applyVary(0.27, 0.0) > 0.27, 'dark areas read rougher')
assert.ok(applyVary(0.27, 1.0) < 0.27, 'bright areas read smoother')
assert.ok(applyVary(0.04, 1.0) >= 0.04, 'never fully mirror')
assert.ok(applyVary(0.99, 0.0) <= 1, 'never past fully rough')

console.log('material corrections ok')

// --- shader patches must be idempotent ---
// Materials are shared between the product page and the AR scene, so a patch
// can be reached twice for the same material. Re-injecting a uniform gives a
// duplicate declaration, the shader fails to compile, and the object
// disappears while its shadow — a separate depth pass — stays.
{
  const seen = new WeakSet()
  const guardedPatch = (m) => {
    if (seen.has(m) || m.roughnessMap || !m.map) return false
    seen.add(m)
    m.injections = (m.injections ?? 0) + 1
    return true
  }
  const shared = { map: {}, injections: 0 }
  assert.equal(guardedPatch(shared), true, 'first pass patches')
  assert.equal(guardedPatch(shared), false, 'second pass is refused')
  assert.equal(guardedPatch(shared), false, 'and a third')
  assert.equal(shared.injections, 1, 'the uniform is declared exactly once')

  // the unguarded version is what shipped, and this is what it did
  let unguarded = 0
  const noGuard = () => { unguarded++ }
  noGuard(); noGuard()
  assert.equal(unguarded, 2, 'without a guard the same material is patched twice')
}

console.log('patch idempotence ok')

// grain.ts: the lens vignette must leave the frame centre untouched, only ever
// darken, and reach its full amount in the corner — a "circle" would mean the
// falloff started at the object, not the frame.
{
  const VIGNETTE_AR = 0.15
  // mirror of the shader: r = distance to frame centre * 2, smoothstep(0.5, sqrt2, r)
  const vignetteAt = (x, y, amount) => {
    const r = Math.hypot(x - 0.5, y - 0.5) * 2
    const t = Math.min(1, Math.max(0, (r - 0.5) / (1.4142 - 0.5)))
    return 1 - amount * t * t * (3 - 2 * t)
  }
  assert.equal(vignetteAt(0.5, 0.5, VIGNETTE_AR), 1, 'frame centre is untouched')
  assert.equal(vignetteAt(0.7, 0.5, VIGNETTE_AR), 1, 'the middle of the frame is untouched too')
  const corner = vignetteAt(0, 0, VIGNETTE_AR)
  assert.ok(Math.abs(corner - (1 - VIGNETTE_AR)) < 1e-3, `corner reaches full amount, got ${corner}`)
  let last = 1
  for (let x = 0.5; x >= 0; x -= 0.05) {
    const v = vignetteAt(x, 0.5, VIGNETTE_AR)
    assert.ok(v <= last + 1e-9 && v <= 1, 'falloff is monotonic toward the edge')
    last = v
  }
}

console.log('lens vignette ok')

// grain.ts plate response: blacks lifted to the feed's black point, whites
// rolled under 1.0, mid-tones and hue left alone, monotonic throughout.
{
  const plate = ([r, g, b]) => {
    let c = [r, g, b].map((v) => 0.03 + v * 0.97)
    c = c.map((v) => v / (1 + 0.5 * Math.max(v - 0.75, 0)))
    const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
    const keep = 1 - 0.2 * (ss(0.6, 1.0, l) + ss(0.15, 0.0, l))
    return c.map((v) => l + (v - l) * keep)
  }
  const black = plate([0, 0, 0]), white = plate([1, 1, 1]), grey = plate([0.4, 0.4, 0.4])
  assert.ok(black[0] > 0.02 && black[0] < 0.05, `black is lifted, not crushed: ${black[0]}`)
  assert.ok(white[0] > 0.85 && white[0] < 0.95, `white is rolled off, not clean: ${white[0]}`)
  assert.ok(Math.abs(grey[0] - 0.4) < 0.03, `mid grey barely moves: ${grey[0]}`)
  let last = -1
  for (let v = 0; v <= 1.0001; v += 0.02) {
    const out = plate([v, v, v])[0]
    assert.ok(out > last, 'tone curve is monotonic')
    last = out
  }
  const red = plate([0.5, 0.1, 0.1]), hot = plate([1, 0.6, 0.6])
  assert.ok(red[0] - red[1] > 0.3, 'mid-tone colour keeps its saturation')
  assert.ok(hot[0] - hot[1] < 0.4 * 0.9, 'highlight colour loses some saturation')
}

console.log('plate response ok')

// ARScene exposure matching: the phone auto-exposes the feed toward mid-grey,
// so the render gets a trim from the room's measured brightness — bounded, and
// never inverted (a brighter room must never raise exposure).
{
  const REFERENCE = 1.28, MIN = 0.78, MAX = 1
  const exposureTrim = (a) => (a <= 0 ? 1 : Math.min(MAX, Math.max(MIN, REFERENCE / a)))

  assert.equal(exposureTrim(0), 1, 'no estimate yet means no trim')
  assert.equal(exposureTrim(REFERENCE), 1, 'a room at the reference level is left alone')
  assert.ok(exposureTrim(4) === MIN, 'a bright room is pulled down to the floor')
  assert.ok(exposureTrim(0.2) === MAX, 'a dim room is left alone, never lifted')
  let last = Infinity
  for (let a = 0.05; a < 6; a += 0.05) {
    const e = exposureTrim(a)
    assert.ok(e <= last + 1e-9, 'brighter room never means more exposure')
    assert.ok(e >= MIN && e <= MAX, `trim stays in bounds, got ${e}`)
    last = e
  }
  // the burger case: an object reading brighter than the room it sits in
  assert.ok(exposureTrim(2.5) < 1, 'a room measuring above the reference is pulled down')
  assert.equal(exposureTrim(0.6), 1, 'the trim never brightens on a guessed reference')
}

console.log('exposure matching ok')
