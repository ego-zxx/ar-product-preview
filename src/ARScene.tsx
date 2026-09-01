import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import {
  CanvasTexture, DoubleSide, Group, Matrix4, Object3D, Plane, PMREMGenerator,
  Quaternion, Raycaster, SRGBColorSpace, Vector2, Vector3,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import {
  XRSpace, useXRHitTest, useXRInputSourceEvent, useXRPlaneGeometry, useXRPlanes,
} from '@react-three/xr'
import { CoffeeCup, Faucet } from './models'
import type { Product } from './products'
import { patchForOcclusion, updateOcclusion } from './occlusion'

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

/** Reference ARCore app caps at 20 to avoid overloading tracking + renderer. */
export const MAX_OBJECTS = 20

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

export function Env() {
  const { gl, scene } = useThree()
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl)
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environment = env
    return () => {
      scene.environment = null
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

function GltfModel({ url, scale }: { url: string; scale: number }) {
  const gltf = useLoader(GLTFLoader, url)
  const scene = useRef<Object3D>(gltf.scene.clone(true)).current
  return <primitive object={scene} scale={scale} />
}

export function Model({ product }: { product: Product }) {
  return (
    <>
      <ContactShadow />
      {product.url === 'builtin:faucet' ? (
        <Faucet />
      ) : product.url === 'builtin:cup' ? (
        <CoffeeCup />
      ) : (
        <Suspense fallback={null}>
          <GltfModel url={product.url} scale={product.scale} />
        </Suspense>
      )}
    </>
  )
}

/**
 * Soft blob shadow drawn on the surface under an object. Without a contact
 * shadow the eye reads even a perfectly placed object as hovering — this does
 * more for "it's really there" than any amount of positional accuracy.
 *
 * ponytail: painted gradient, not a shadow map. A real shadow needs a light
 * direction and a depth pass per frame; this costs one texture and always
 * lands directly under the object. Swap it if directional shadows matter.
 */
const shadowTexture = (() => {
  const size = 128
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(0,0,0,0.55)')
  g.addColorStop(0.45, 'rgba(0,0,0,0.28)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
})()

function ContactShadow({ radius = 0.075 }: { radius?: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0012, 0]} renderOrder={1}>
      <planeGeometry args={[radius * 2.4, radius * 2.4]} />
      <meshBasicMaterial
        map={shadowTexture}
        transparent
        opacity={0.85}
        depthWrite={false}
      />
    </mesh>
  )
}

function SelectionRing() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
      <ringGeometry args={[0.1, 0.115, 48]} />
      <meshBasicMaterial
        color="#c9a227" side={DoubleSide} transparent opacity={0.95}
        userData={{ noOcclusion: true }}
      />
    </mesh>
  )
}

function FixedPlacement({
  matrix, yaw, product, selected, innerRef,
}: {
  matrix: Matrix4; yaw: number; product: Product; selected: boolean
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
        <Model product={product} />
        {selected && <SelectionRing />}
      </group>
    </group>
  )
}

export function Placement({
  objects, draft, selectedId, commitRef, gestureRef, uiHidden,
  onCommit, onTap, onSurface, onError,
}: {
  objects: Placed[]
  draft: Draft | null
  selectedId: number | null
  commitRef: React.RefObject<(() => void) | null>
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
  const snapTargetY = useRef<number | null>(null)
  const scratch = useRef(new Vector3()).current

  // Draft pose lives here, not in React state: dragging updates it every frame.
  const draftPos = useRef(new Vector3()).current
  const draftYaw = useRef(0)

  const raycaster = useRef(new Raycaster()).current
  const centre = useRef(new Vector2(0, 0)).current
  const downRay = useRef(new Raycaster()).current
  const dragTarget = useRef(new Vector3()).current
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

  useFrame((_s, delta, frame) => {
    if (hasHit.current !== lastSurface.current) {
      lastSurface.current = hasHit.current
      onSurface(hasHit.current)
    }

    const reticle = reticleRef.current
    if (reticle) reticle.visible = hasHit.current && !draft && !uiHidden
    if (reticle?.visible) reticle.position.copy(hitPos)

    // --- gestures on the live draft ---
    const g = gestureRef.current
    if (draft && g) {
      if (g.mode !== lastMode.current) {
        prevTwist.current = g.twist
        if (g.mode === 'move') {
          // Lock a stable plane at the object's current height for this drag.
          dragPlane.setFromNormalAndCoplanarPoint(UP, draftPos)
          // Grab the object where it is. Without this it jumps to sit under the
          // finger the moment a drag starts, which reads as teleporting.
          grab.set(0, 0, 0)
          const hit = fingerOnPlane(g, scratch)
          if (hit) grab.subVectors(draftPos, hit)
          dragTarget.copy(draftPos)
        }
        lastMode.current = g.mode
      }

      if (g.mode === 'rotate') {
        // Accumulate the shortest delta each frame, so rotation never stops at
        // half a turn and never jumps when atan2 wraps.
        draftYaw.current -= angleDelta(prevTwist.current, g.twist)
        prevTwist.current = g.twist
      } else if (g.mode === 'move') {
        const hit = fingerOnPlane(g, scratch)
        if (hit) dragTarget.copy(hit).add(grab)
      }
      if (g.mode === 'move') {
        // light damping only — the plane is stable, so this smooths the finger,
        // not the surface
        draftPos.lerp(dragTarget, 1 - Math.exp(-32 * delta))
      }
    }

    // Sit it on the surface. Cast straight down from just above the object onto
    // the detected planes and pin Y to whatever it lands on, so an object can
    // never hover — regardless of what the hit-test or a drag produced.
    if (draft && surfaces.size) {
      above.copy(draftPos).y += 0.5
      downRay.set(above, DOWN)
      const below = downRay.intersectObjects(surfaceList(), false)
      if (below.length) snapTargetY.current = below[0].point.y
      // Ease onto the surface rather than pinning Y every frame: a hard set
      // undid the drag smoothing and passed every wobble in ARCore's plane
      // estimate straight through to the object.
      if (snapTargetY.current != null) {
        draftPos.y += (snapTargetY.current - draftPos.y) * (1 - Math.exp(-14 * delta))
      }
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

  useXRInputSourceEvent(
    'all',
    'select',
    () => {
      // A tap on an overlay button also arrives here; without this, pressing
      // Deselect immediately re-selects whatever is under the reticle.
      const g = gestureRef.current
      if (g && performance.now() < g.suppressSelectUntil) return
      if (!hasHit.current) return

      // Real raycast against placed objects — a fixed proximity radius made
      // every tap near the first object select it instead of placing a new one.
      raycaster.setFromCamera(centre.set(0, 0), camera)
      let picked: number | null = null
      let nearest = Infinity
      for (const [id, obj] of placedRefs) {
        const hits = raycaster.intersectObject(obj, true)
        if (hits.length && hits[0].distance < nearest) {
          nearest = hits[0].distance
          picked = id
        }
      }
      if (picked == null) {
        draftPos.copy(hitPos)
        dragTarget.copy(hitPos)
        draftYaw.current = 0
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
            <Model product={draft.product} />
            <SelectionRing />
          </>
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
              <Model product={o.product} />
              {selectedId === o.id && <SelectionRing />}
            </group>
          </XRSpace>
        ) : o.matrix ? (
          <FixedPlacement
            key={o.id}
            matrix={o.matrix}
            yaw={o.yaw}
            product={o.product}
            selected={selectedId === o.id}
            innerRef={setRef}
          />
        ) : null
      })}
    </>
  )
}
