import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import {
  Box3, DirectionalLight, DoubleSide, Group, Matrix4, Mesh, Object3D, Plane,
  PMREMGenerator, Quaternion, Raycaster, Vector2, Vector3,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { XREstimatedLight } from 'three/addons/webxr/XREstimatedLight.js'
import {
  XRSpace, useXR, useXRHitTest, useXRInputSourceEvent, useXRPlaneGeometry, useXRPlanes,
} from '@react-three/xr'
import { Damper } from './damper'
import { CoffeeCup, Faucet } from './models'
import type { Product } from './products'
import { Model, groundingOffset } from './Model'
import { shadowTint } from './materials'
import { occlusionStatus, patchForOcclusion, updateOcclusion } from './occlusion'

const UP = new Vector3(0, 1, 0)

/**
 * Meshes built from ARCore's detected planes. They serve twice: as depth-only
 * occluders, and as the only surfaces an object may be dragged onto — which is
 * what stops objects floating in mid-air.
 */
const surfaces = new Set<Object3D>()
let surfaceCache: Object3D[] = []
let surfaceCacheSize = -1
/** Raycasting wants an array; rebuild it only when the set actually changes. */
const surfaceList = () => {
  if (surfaceCacheSize !== surfaces.size) {
    surfaceCache = [...surfaces]
    surfaceCacheSize = surfaces.size
  }
  return surfaceCache
}

export type Placed = {
  id: number
  product: Product
  yaw: number
  anchor?: XRAnchor
  matrix?: Matrix4
}
export type Draft = { product: Product }

/**
 * How far from the tap ray an object can sit and still be selected, in metres.
 * Requiring a direct hit on a small product is unusable on a handheld phone.
 */
export const SELECT_TOLERANCE = 0.14

/**
 * Live gesture state, written by the DOM overlay and read in the frame loop so
 * dragging never triggers a React render.
 */
export type Gesture = {
  mode: 'none' | 'move' | 'rotate'
  /** primary finger, for dragging */
  x: number
  y: number
  /** angle between two fingers, for twisting */
  twist: number
  /** overlay buttons also emit an XR select; ignore selects until this time */
  suppressSelectUntil: number
}
export const newGesture = (): Gesture => ({
  mode: 'none', x: 0, y: 0, twist: 0, suppressSelectUntil: 0,
})

/**
 * Shortest signed angle from a to b, in (-PI, PI].
 *
 * Finger twist comes from atan2, which wraps at +/-PI. Comparing raw angles
 * caps rotation at half a turn and jumps on the wrap; accumulating the shortest
 * delta each frame instead allows unlimited rotation in either direction.
 */
export const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/**
 * Yaw that turns a model's +Z front toward the camera, given the camera's
 * forward direction. model-viewer does this on placement so the product's
 * front greets you rather than whichever side the hit pose happened to give.
 */
export const faceCameraYaw = (dirX: number, dirZ: number) => Math.atan2(-dirX, -dirZ)

/**
 * Lights the model from the room it is actually standing in.
 *
 * ARCore's light estimate gives three things, and all three matter:
 *  - spherical harmonics -> ambient colour and intensity, so a warm room makes
 *    a warm object
 *  - a primary light direction -> the shadow falls where the real shadows fall,
 *    which is the single strongest cue that something is really there
 *  - a live reflection cube map -> chrome and glass reflect the real room
 *    rather than a canned studio
 *
 * Falls back silently to the static rig when a runtime declines it. three's
 * XREstimatedLight is used rather than a hand-rolled probe: it handles the
 * cube map format negotiation and the frame plumbing correctly.
 */
/**
 * Brightness of the room, as measured by the light estimate. Band 0 of the
 * spherical harmonics is the average radiance, so its luminance is the one
 * number that says how bright this room is.
 */
export const roomLight = { ambient: 0 }

export type Diag = {
  fps: number
  lit: boolean
  occlusion: boolean
  /** actual XR framebuffer vs the screen — reveals resolution loss */
  fb: string
  anisotropy: number
  shadowFrom: string
  /** room brightness from the light estimate, and the exposure trim it drives */
  ambient: number
  exposure: number
}

/**
 * Live readout of what the renderer is actually doing, behind ?debug=1.
 *
 * Several rounds of "make it more realistic" were spent reasoning about
 * lighting that may never have switched on. This reports the facts instead:
 * whether the room estimate is driving the scene, what resolution the session
 * really renders at, and whether occlusion is running.
 */
export function DiagnosticsProbe({ lit, onSample }: { lit: boolean; onSample: (d: Diag) => void }) {
  const { gl, scene } = useThree()
  const frames = useRef(0)
  const since = useRef(performance.now())
  useFrame(() => {
    frames.current++
    const now = performance.now()
    if (now - since.current < 1000) return
    const fps = Math.round((frames.current * 1000) / (now - since.current))
    frames.current = 0
    since.current = now

    // renderState.baseLayer is null when three renders through a projection
    // layer, which is the modern path — read the live drawing buffer instead.
    const ctx = gl.getContext()
    const screen = `${Math.round(window.innerWidth * devicePixelRatio)}x${Math.round(
      window.innerHeight * devicePixelRatio,
    )}`
    const fb = `${ctx.drawingBufferWidth}x${ctx.drawingBufferHeight} vs ${screen}`

    const ambient = Number(roomLight.ambient.toFixed(2))
    const exposure = Number(gl.toneMappingExposure.toFixed(2))
    let anisotropy = 0
    let shadowFrom = 'none'
    scene.traverse((o) => {
      const m = (o as Mesh).material as { map?: { anisotropy?: number } } | undefined
      if (m?.map?.anisotropy) anisotropy = Math.max(anisotropy, m.map.anisotropy)
      const l = o as unknown as { isDirectionalLight?: boolean; castShadow?: boolean; parent?: { name?: string } }
      if (l.isDirectionalLight && l.castShadow) {
        shadowFrom = l.parent?.name === 'room-light' ? 'room' : 'fixed'
      }
    })
    onSample({ fps, lit, occlusion: occlusionStatus().enabled, fb, anisotropy, shadowFrom, ambient, exposure })
  })
  return null
}

/**
 * Exposure matching. The phone auto-exposes the camera feed toward mid-grey
 * whatever the room's real brightness, while our render does not — so in a dim
 * room the object comes out brighter than everything around it, which is the
 * mismatch in the burger screenshot. This is the compositor's exposure match,
 * driven by the only light meter we have.
 *
 * A Lambertian surface returns irradiance * albedo / PI, and three scales SH
 * band 0 by 0.886227, so mid-grey (0.5) renders at 0.141 * c0. Solving for a
 * mid-grey target of 0.18 gives the reference level below.
 *
 * ponytail: the trim may only darken. The reported symptom is objects sitting
 * brighter than the room, and the estimate is not a light meter, so lifting on
 * a guessed reference could undo the fixes above. ?debug=1 now prints the room
 * level; raise EXPOSURE_MAX once there are real numbers from a dim room.
 */
export const EXPOSURE_REFERENCE = 1.28
export const EXPOSURE_MIN = 0.78
export const EXPOSURE_MAX = 1

export const exposureTrim = (ambient: number) =>
  ambient <= 0
    ? 1
    : Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, EXPOSURE_REFERENCE / ambient))

export function EstimatedLighting({ onActive }: { onActive: (on: boolean) => void }) {
  const { gl, scene } = useThree()
  const active = useRef<XREstimatedLight | null>(null)
  const exposure = useRef(new Damper(400))
  const level = useRef(1)
  // SH band 0 is the average radiance: it gives the shadow its colour and the
  // render its exposure
  useFrame((_, dt) => {
    const light = active.current
    if (!light) return
    const dc = light.lightProbe.sh.coefficients[0]
    const peak = Math.max(dc.x, dc.y, dc.z)
    if (peak > 0) shadowTint.setRGB(dc.x / peak, dc.y / peak, dc.z / peak).multiplyScalar(0.25)
    roomLight.ambient = 0.2126 * dc.x + 0.7152 * dc.y + 0.0722 * dc.z
    level.current = exposure.current.update(
      level.current,
      exposureTrim(roomLight.ambient),
      dt * 1000,
      1,
    )
    gl.toneMappingExposure = level.current
  })
  useEffect(() => {
    const xrLight = new XREstimatedLight(gl, true)
    // XREstimatedLight extends Group without setting .type, so it reports as
    // 'Group'. Tag it, or nothing downstream can tell whose light this is.
    xrLight.name = 'room-light'
    // shadows should come from the estimated key light, not a fixed one
    xrLight.directionalLight.castShadow = true
    xrLight.directionalLight.shadow.mapSize.set(1024, 1024)
    // indoor light is diffuse; a crisp shadow edge is one of the loudest CG tells
    xrLight.directionalLight.shadow.radius = 9
    xrLight.directionalLight.shadow.camera.near = 0.1
    xrLight.directionalLight.shadow.camera.far = 12
    xrLight.directionalLight.shadow.camera.left = -2
    xrLight.directionalLight.shadow.camera.right = 2
    xrLight.directionalLight.shadow.camera.top = 2
    xrLight.directionalLight.shadow.camera.bottom = -2
    xrLight.directionalLight.shadow.bias = -0.0004
    xrLight.directionalLight.shadow.normalBias = 0.02

    const previousEnvironment = scene.environment
    const previousIntensity = scene.environmentIntensity
    const start = () => {
      scene.add(xrLight)
      if (xrLight.environment) {
        scene.environment = xrLight.environment
        scene.environmentIntensity = 1
        // The estimated reflection cube map already carries the room's ambient.
        // Leaving the SH probe lit as well counts that ambient a second time,
        // which is most of why the object read brighter than the room it sits
        // in. three re-sets the probe's intensity every frame but never touches
        // visibility, so this is the one switch that stays off.
        xrLight.lightProbe.visible = false
      }
      active.current = xrLight
      onActive(true)
    }
    const end = () => {
      scene.remove(xrLight)
      scene.environment = previousEnvironment
      scene.environmentIntensity = previousIntensity
      xrLight.lightProbe.visible = true
      gl.toneMappingExposure = 1
      active.current = null
      roomLight.ambient = 0
      shadowTint.setRGB(0, 0, 0)
      onActive(false)
    }
    xrLight.addEventListener('estimationstart', start)
    xrLight.addEventListener('estimationend', end)
    return () => {
      xrLight.removeEventListener('estimationstart', start)
      xrLight.removeEventListener('estimationend', end)
      scene.remove(xrLight)
      scene.environment = previousEnvironment
      scene.environmentIntensity = previousIntensity
      xrLight.lightProbe.visible = true
      gl.toneMappingExposure = 1
      active.current = null
      roomLight.ambient = 0
      shadowTint.setRGB(0, 0, 0)
      onActive(false)
    }
  }, [gl, scene, onActive])
  return null
}

/**
 * How much of the synthetic studio to use while the room's own estimate is not
 * available. RoomEnvironment is a bright white box with light panels; at full
 * strength it lights the object like a showroom no matter how dim the actual
 * room is, which is both too bright and too uniform. Dimmed, it survives as a
 * source of reflections without claiming to be the room's light.
 */
export const ENV_FALLBACK_INTENSITY = 0.35

export function Env() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    scene.environmentIntensity = ENV_FALLBACK_INTENSITY
    return () => {
      scene.environment = null
      scene.environmentIntensity = 1
      env.dispose()
      pmrem.dispose()
    }
  }, [gl, scene])
  return null
}

/**
 * Detected surfaces rendered depth-only: they write to the depth buffer but not
 * to colour, so anything behind them is hidden by the real world.
 *
 * ponytail: plane occlusion only — real per-pixel occlusion needs the WebXR
 * Depth API, which this device (Galaxy A33) does not support. Planes cover
 * tables/walls/floors; they cannot occlude a laptop or your hand.
 */
function PlaneOccluder({ plane }: { plane: XRPlane }) {
  const geometry = useXRPlaneGeometry(plane)
  const register = (m: Object3D | null) => {
    if (m) surfaces.add(m)
    else surfaces.forEach((o) => !o.parent && surfaces.delete(o))
  }
  return (
    <XRSpace space={plane.planeSpace}>
      <mesh ref={register} geometry={geometry} renderOrder={-1}>
        <meshBasicMaterial
          userData={{ noOcclusion: true }}
          colorWrite={false}
          // nudge the occluder back so an object resting on the plane doesn't
          // z-fight with it and lose its base
          polygonOffset
          polygonOffsetFactor={1}
          polygonOffsetUnits={1}
        />
      </mesh>
    </XRSpace>
  )
}

export function PlaneOcclusion() {
  const planes = useXRPlanes()
  return (
    <>
      {planes.map((plane, i) => (
        <PlaneOccluder key={i} plane={plane} />
      ))}
    </>
  )
}

/**
 * Real-world occlusion. Off by default (see occlusion.ts) — kept switchable so
 * it can be tuned on a device that grants usable depth.
 */
export function DepthOcclusion() {
  const { gl, scene } = useThree()
  useFrame((_s, _d, frame) => {
    if (!frame) return
    const ref = gl.xr.getReferenceSpace()
    const pose = ref ? frame.getViewerPose(ref) : null
    const view = pose?.views[0]
    if (!view) return
    const ctx = gl.getContext()
    if (!updateOcclusion(frame, view, ctx.drawingBufferWidth, ctx.drawingBufferHeight)) return
    // materials appear as products load, so keep sweeping
    scene.traverse((o) => {
      const m = (o as { material?: unknown }).material
      if (!m) return
      for (const mat of Array.isArray(m) ? m : [m]) patchForOcclusion(mat as never)
    })
  })
  return null
}

/**
 * Catches the object's real shadow. ShadowMaterial is invisible except where a
 * shadow falls, so the plane itself never shows — only the object's actual
 * silhouette from the light, soft-edged. A painted blob was the same shape
 * for a faucet and a cup; this is not.
 */
function ShadowCatcher({ size = 0.5 }: { size?: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0012, 0]} receiveShadow renderOrder={1}>
      <planeGeometry args={[size, size]} />
      <shadowMaterial transparent opacity={0.33} depthWrite={false} userData={{ noOcclusion: true }} />
    </mesh>
  )
}

/**
 * Overhead key light that casts the shadows. It follows the user so the shadow
 * frustum is always centred where objects get placed — a fixed ortho box would
 * leave anything across the room unshadowed. Near-vertical, because a shadow
 * from a direction the room's light doesn't come from looks wrong; straight
 * down is the neutral choice and matches most ceiling lighting.
 *
 * ponytail: 1024 map over a 4m box is ~4mm per texel, softened by PCF radius.
 * Raise mapSize to 2048 for crisper shadows on phones with headroom.
 */
export function KeyLight() {
  const light = useRef<DirectionalLight>(null)
  const { camera } = useThree()
  useFrame(() => {
    const l = light.current
    if (!l) return
    l.target.position.set(camera.position.x, 0, camera.position.z)
    l.position.set(camera.position.x + 0.4, camera.position.y + 3.5, camera.position.z + 0.7)
    l.target.updateMatrixWorld()
  })
  return (
    <directionalLight
      ref={light}
      intensity={1.15}
      castShadow
      shadow-mapSize={[1024, 1024]}
      shadow-radius={9}
      shadow-bias={-0.0004}
      shadow-normalBias={0.02}
      shadow-camera-left={-2}
      shadow-camera-right={2}
      shadow-camera-top={2}
      shadow-camera-bottom={-2}
      shadow-camera-near={0.1}
      shadow-camera-far={12}
    />
  )
}


function FixedPlacement({
  matrix, yaw, product, innerRef,
}: {
  matrix: Matrix4; yaw: number; product: Product
  innerRef: (o: Object3D | null) => void
}) {
  const pos = useRef(new Vector3()).current
  const quat = useRef(new Quaternion()).current
  const scl = useRef(new Vector3()).current
  useEffect(() => {
    matrix.decompose(pos, quat, scl)
  }, [matrix, pos, quat, scl])
  return (
    <group ref={innerRef} position={pos} quaternion={quat}>
      <group rotation-y={yaw}>
        <Model product={product} /></group>
    </group>
  )
}

export function Placement({
  objects, draft, selectedId, commitRef, gestureRef, resumeRef, uiHidden,
  onCommit, onTap, onSurface, onError,
}: {
  objects: Placed[]
  draft: Draft | null
  selectedId: number | null
  commitRef: React.RefObject<(() => void) | null>
  /** filled with a function that reopens a placed object for editing */
  resumeRef: React.RefObject<((id: number) => boolean) | null>
  gestureRef: React.RefObject<Gesture>
  /** clean view: no reticle either, the room should be uncluttered */
  uiHidden: boolean
  onCommit: (p: { anchor?: XRAnchor; matrix?: Matrix4; yaw: number }) => void
  onTap: (nearestId: number | null) => void
  onSurface: (found: boolean) => void
  onError: (msg: string) => void
}) {
  const { gl, camera } = useThree()
  const reticleRef = useRef<Group>(null)
  const draftRef = useRef<Group>(null)
  const matrix = useRef(new Matrix4()).current
  const hitPos = useRef(new Vector3()).current
  const hasHit = useRef(false)
  const placedRefs = useRef(new Map<number, Object3D>()).current
  const pendingLock = useRef(false)
  const lastSurface = useRef<boolean | null>(null)
  const lastMode = useRef<Gesture['mode']>('none')
  const prevTwist = useRef(0)
  /** offset from the ray hit to the object when a drag began */
  const grab = useRef(new Vector3()).current
  /**
   * A fixed horizontal plane captured when the drag begins. Raycasting against
   * ARCore's plane meshes every frame is jittery — it re-estimates their
   * geometry constantly, so the hit point jumps. A mathematical plane is
   * perfectly stable, and the surface snap below still keeps the object
   * resting on whatever is actually beneath it.
   */
  const dragPlane = useRef(new Plane()).current
  const scratch = useRef(new Vector3()).current

  // Critically damped springs (model-viewer's approach): velocity, no overshoot.
  const dampX = useRef(new Damper()).current
  const dampY = useRef(new Damper()).current
  const dampZ = useRef(new Damper()).current
  const dampYaw = useRef(new Damper()).current
  /** where the draft is heading; the dampers carry it there */
  const goal = useRef(new Vector3()).current
  const goalYaw = useRef(0)

  // ARCore hit-testing on the touch's own ray: a point on a REAL surface
  // under the finger. This is how model-viewer drags, and it is both smoother
  // than raycasting our own plane meshes (whose geometry ARCore keeps
  // re-estimating) and grounded, unlike a mathematical plane.
  const session = useXR((st) => st.session)
  const transientSrc = useRef<XRTransientInputHitTestSource | null>(null)
  useEffect(() => {
    const s = session
    if (!s || !s.requestHitTestSourceForTransientInput) return
    let cancelled = false
    // typed as possibly returning undefined; ?. short-circuits the whole chain
    s.requestHitTestSourceForTransientInput({ profile: 'generic-touchscreen', entityTypes: ['plane'] })
      ?.then((src) => {
        if (cancelled) src.cancel()
        else transientSrc.current = src
      })
      .catch(() => {
        // fine: dragging falls back to the stable plane below
      })
    return () => {
      cancelled = true
      transientSrc.current?.cancel()
      transientSrc.current = null
    }
  }, [session])
  /** read in the select handler, which must not close over a stale prop */
  const draftLive = useRef<Draft | null>(null)
  draftLive.current = draft
  const rayOrigin = useRef(new Vector3()).current
  const rayDir = useRef(new Vector3()).current
  const objPos = useRef(new Vector3()).current

  // Draft pose lives here, not in React state: dragging updates it every frame.
  const draftPos = useRef(new Vector3()).current
  const draftYaw = useRef(0)

  const raycaster = useRef(new Raycaster()).current
  const centre = useRef(new Vector2(0, 0)).current
  const downRay = useRef(new Raycaster()).current
  const above = useRef(new Vector3()).current
  const DOWN = useRef(new Vector3(0, -1, 0)).current

  // Planes only. A feature-point hit can sit anywhere in mid-air, which is what
  // made models float; planes give a pose that lies on a real surface.
  useXRHitTest(
    (results, getWorldMatrix) => {
      try {
        const hit = results[0]
        hasHit.current = !!hit && getWorldMatrix(matrix, hit)
        if (hasHit.current) hitPos.setFromMatrixPosition(matrix)
      } catch (e) {
        hasHit.current = false
        onError(`hit-test: ${(e as Error).message}`)
      }
    },
    'viewer',
    'plane',
  )

  /** Where the finger's ray meets the plane the object is being dragged on. */
  const fingerOnPlane = (g: Gesture, out: Vector3) => {
    centre.set((g.x / window.innerWidth) * 2 - 1, -(g.y / window.innerHeight) * 2 + 1)
    raycaster.setFromCamera(centre, camera)
    return raycaster.ray.intersectPlane(dragPlane, out) ? out : null
  }

  /**
   * Where the finger is, in the world. Prefers ARCore's hit on the touch ray (a
   * point on a real surface); off any surface it falls back to the drag plane,
   * so the object holds its height rather than vanishing or dropping.
   */
  const fingerHit = (g: Gesture, frame: XRFrame | undefined, out: Vector3) => {
    const src = transientSrc.current
    const ref = gl.xr.getReferenceSpace()
    if (src && frame && ref) {
      for (const r of frame.getHitTestResultsForTransientInput(src)) {
        const pose = r.results[0]?.getPose(ref)
        if (pose) {
          const p = pose.transform.position
          return out.set(p.x, p.y, p.z)
        }
      }
    }
    return fingerOnPlane(g, out)
  }

  useFrame((_s, delta, frame) => {
    if (hasHit.current !== lastSurface.current) {
      lastSurface.current = hasHit.current
      onSurface(hasHit.current)
    }

    const reticle = reticleRef.current
    // Once something is placed there is nothing left to aim at, so the reticle
    // only shows while the scene is still empty.
    if (reticle) {
      reticle.visible = hasHit.current && !draft && !uiHidden && objects.length === 0
    }
    if (reticle?.visible) reticle.position.copy(hitPos)

    // --- gestures on the live draft ---
    const g = gestureRef.current
    const dtMs = Math.min(delta, 0.1) * 1000 // clamp a stall so the spring can't leap
    if (draft && g) {
      if (g.mode !== lastMode.current) {
        prevTwist.current = g.twist
        if (g.mode === 'move') {
          // Fallback plane at the object's current height, for when the finger
          // leaves every surface mid-drag.
          dragPlane.setFromNormalAndCoplanarPoint(UP, draftPos)
          // Grab the object where it is. Without this it jumps to sit under the
          // finger the moment a drag starts, which reads as teleporting.
          grab.set(0, 0, 0)
          const hit = fingerHit(g, frame, scratch)
          if (hit) grab.subVectors(draftPos, hit)
          goal.copy(draftPos)
        }
        lastMode.current = g.mode
      }

      if (g.mode === 'rotate') {
        // Accumulate the shortest delta each frame, so rotation never stops at
        // half a turn and never jumps when atan2 wraps.
        goalYaw.current -= angleDelta(prevTwist.current, g.twist)
        prevTwist.current = g.twist
      } else if (g.mode === 'move') {
        const hit = fingerHit(g, frame, scratch)
        if (hit) goal.copy(hit).add(grab)
      }
    }

    // Settle onto whatever is beneath — but not mid-drag. Dragging across a
    // table edge holds height and the object drops on release, as in
    // model-viewer, instead of fighting the finger every frame.
    if (draft && g?.mode !== 'move' && surfaces.size) {
      above.copy(draftPos).y += 0.5
      downRay.set(above, DOWN)
      const below = downRay.intersectObjects(surfaceList(), false)
      if (below.length) goal.y = below[0].point.y
    }

    if (draft) {
      draftPos.x = dampX.update(draftPos.x, goal.x, dtMs, 1)
      draftPos.y = dampY.update(draftPos.y, goal.y, dtMs, 1)
      draftPos.z = dampZ.update(draftPos.z, goal.z, dtMs, 1)
      draftYaw.current = dampYaw.update(draftYaw.current, goalYaw.current, dtMs, Math.PI)
    }

    const d = draftRef.current
    if (d) d.visible = !!draft
    if (d && draft) {
      d.position.copy(draftPos)
      d.quaternion.setFromAxisAngle(UP, draftYaw.current)
    }

    if (pendingLock.current && draft) {
      pendingLock.current = false
      const yaw = draftYaw.current
      const q = new Quaternion().setFromAxisAngle(UP, yaw)
      const pos = draftPos.clone()
      const fallback = new Matrix4().compose(pos, q, new Vector3(1, 1, 1))
      const refSpace = gl.xr.getReferenceSpace()
      if (frame?.createAnchor && refSpace) {
        frame
          .createAnchor(
            new XRRigidTransform(
              { x: pos.x, y: pos.y, z: pos.z },
              { x: q.x, y: q.y, z: q.z, w: q.w },
            ),
            refSpace,
          )!
          .then((anchor) => onCommit(anchor ? { anchor, yaw } : { matrix: fallback, yaw }))
          .catch(() => onCommit({ matrix: fallback, yaw }))
      } else {
        onCommit({ matrix: fallback, yaw })
      }
    }
  })

  useEffect(() => {
    commitRef.current = () => {
      pendingLock.current = true
    }
    return () => {
      commitRef.current = null
    }
  }, [commitRef])

  /**
   * Adopt a placed object's live pose as the draft, so unlocking it to move
   * does not make it jump back to the reticle. The pose is read here because
   * an anchored object's position only exists in the scene graph, not in the
   * record App holds.
   */
  useEffect(() => {
    resumeRef.current = (id: number) => {
      const node = placedRefs.get(id)
      const record = objects.find((o) => o.id === id)
      if (!node || !record) return false
      node.getWorldPosition(draftPos)
      goal.copy(draftPos)
      draftYaw.current = goalYaw.current = record.yaw
      dampX.reset()
      dampY.reset()
      dampZ.reset()
      dampYaw.reset()
      lastMode.current = 'none'
      return true
    }
    return () => {
      resumeRef.current = null
    }
  }, [resumeRef, objects, placedRefs, draftPos, goal, dampX, dampY, dampZ, dampYaw])

  useXRInputSourceEvent(
    'all',
    'select',
    (event) => {
      // A tap on an overlay button also arrives here; without this, pressing
      // Deselect immediately re-selects whatever is under the reticle.
      const g = gestureRef.current
      if (g && performance.now() < g.suppressSelectUntil) return
      // Lifting the fingers after a twist or a drag emits a select. Acting on it
      // reset the draft's rotation and position — the pose jumped back the
      // moment you let go. While positioning, only Lock and Cancel apply.
      if (draftLive.current) return
      if (!hasHit.current) return

      // Aim the pick where the FINGER touched, not at the screen centre.
      // Picking down the centre line meant selecting an object required
      // pointing the whole phone at it rather than simply tapping it.
      const refSpace = gl.xr.getReferenceSpace()
      const pose = refSpace ? event.frame?.getPose(event.inputSource.targetRaySpace, refSpace) : null
      if (pose) {
        const { position: pp, orientation: po } = pose.transform
        rayOrigin.set(pp.x, pp.y, pp.z)
        rayDir.set(0, 0, -1).applyQuaternion(new Quaternion(po.x, po.y, po.z, po.w))
        raycaster.set(rayOrigin, rayDir)
      } else {
        raycaster.setFromCamera(centre.set(0, 0), camera)
      }

      let picked: number | null = null
      let nearest = Infinity
      for (const [id, obj] of placedRefs) {
        const hits = raycaster.intersectObject(obj, true)
        if (hits.length && hits[0].distance < nearest) {
          nearest = hits[0].distance
          picked = id
        }
      }
      // A tap near a small object should still find it: fall back to the object
      // closest to the ray. Hitting a 4cm faucet spout exactly is not realistic
      // on a handheld phone.
      if (picked == null) {
        let closest = SELECT_TOLERANCE
        for (const [id, obj] of placedRefs) {
          obj.getWorldPosition(objPos)
          if (raycaster.ray.origin.distanceTo(objPos) > 6) continue // ignore far scenery
          const d = raycaster.ray.distanceToPoint(objPos)
          if (d < closest) {
            closest = d
            picked = id
          }
        }
      }
      if (picked == null) {
        // starting a fresh draft: land it, face it toward the user, no momentum
        draftPos.copy(hitPos)
        goal.copy(hitPos)
        camera.getWorldDirection(scratch)
        draftYaw.current = goalYaw.current = faceCameraYaw(scratch.x, scratch.z)
        dampX.reset()
        dampY.reset()
        dampZ.reset()
        dampYaw.reset()
      }
      onTap(picked)
    },
    [onTap],
  )

  return (
    <>
      <group ref={reticleRef} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.06, 0.07, 48]} />
          <meshBasicMaterial
            color="#c9a227" side={DoubleSide} transparent opacity={0.9}
            userData={{ noOcclusion: true }}
          />
        </mesh>
      </group>

      <group ref={draftRef} visible={false}>
        {draft && (
          <>
            <Model product={draft.product} /></>
        )}
      </group>

      {objects.map((o) => {
        let space: XRSpace | undefined
        try {
          space = o.anchor?.anchorSpace
        } catch {
          space = undefined
        }
        const setRef = (g: Object3D | null) => {
          if (g) placedRefs.set(o.id, g)
          else placedRefs.delete(o.id)
        }
        return space ? (
          <XRSpace key={o.id} space={space}>
            <group ref={setRef} rotation-y={o.yaw}>
              <Model product={o.product} /></group>
          </XRSpace>
        ) : o.matrix ? (
          <FixedPlacement
            key={o.id}
            matrix={o.matrix}
            yaw={o.yaw}
            product={o.product}
            innerRef={setRef}
          />
        ) : null
      })}
    </>
  )
}
