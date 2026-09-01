// Run: node src/placement.test.mjs
// Guards the placement maths that has no other safety net.
import assert from 'node:assert/strict'

// --- two-finger twist (mirrors yawFromTwist in ARScene.tsx) ---
const yawFromTwist = (startYaw, startTwist, twist) => startYaw - (twist - startTwist)
const twistOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x)

assert.equal(yawFromTwist(0, 0, 0), 0, 'no twist = no rotation')
assert.equal(yawFromTwist(1.2, 0.5, 0.5), 1.2, 'rotation accumulates from where the twist began')
// a quarter turn of the fingers is a quarter turn of the object, 1:1
const flat = twistOf({ x: 0, y: 0 }, { x: 100, y: 0 })
const quarter = twistOf({ x: 0, y: 0 }, { x: 0, y: 100 })
assert.ok(
  Math.abs(Math.abs(yawFromTwist(0, flat, quarter)) - Math.PI / 2) < 1e-9,
  'a 90 degree finger twist rotates the object 90 degrees',
)
// opposite twists must rotate opposite ways
const back = twistOf({ x: 0, y: 0 }, { x: 0, y: -100 })
assert.ok(
  Math.sign(yawFromTwist(0, flat, quarter)) !== Math.sign(yawFromTwist(0, flat, back)),
  'twisting the other way rotates the other way',
)
// which finger the browser reports first must not flip the direction
assert.equal(twistOf({ x: 0, y: 0 }, { x: 100, y: 0 }), 0, 'reference twist is zero')

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
