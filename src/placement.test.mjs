// Run: node src/placement.test.mjs
// Guards the placement maths that has no other safety net.
import assert from 'node:assert/strict'

// --- mirrors the rotate maths in ARScene.tsx's frame loop ---
const yawFromDrag = (startYaw, startX, currentX) => startYaw - (currentX - startX) * 0.012

assert.equal(yawFromDrag(0, 100, 100), 0, 'no drag = no rotation')
assert.ok(yawFromDrag(0, 100, 200) < 0, 'drag right turns one way')
assert.ok(yawFromDrag(0, 100, 0) > 0, 'drag left turns the other')
assert.equal(yawFromDrag(1, 50, 50), 1, 'rotation accumulates from the drag start')
const sweep = Math.abs(yawFromDrag(0, 0, 390))
assert.ok(sweep > Math.PI / 2 && sweep < Math.PI * 2, `a screen-width sweep is usable, got ${sweep} rad`)

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
