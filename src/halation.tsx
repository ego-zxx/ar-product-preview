import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Mesh } from 'three'
import {
  CustomBlending,
  OneFactor,
  PerspectiveCamera,
  SRGBColorSpace,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
} from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

/**
 * Halation: the glow a real lens spreads out of a bright highlight.
 *
 * Every other camera-matching effect here is per-material, because a fragment
 * shader can only see its own pixel. Halation cannot be: light bleeding from a
 * highlight into its neighbours is by definition a screen-space operation, so
 * this is the one effect that needs a pass of its own.
 *
 * The awkward part is that in an immersive session three renders straight into
 * a framebuffer the XR compositor owns. The way in is that three binds that
 * framebuffer before running the frame callbacks, so a callback can note the
 * binding, render a bright pass into its own target, restore the binding, and
 * leave a full-screen quad in the scene to add the glow back during the normal
 * render. Nothing about the session's own render path is taken over.
 *
 * The glow's alpha is added as well as its colour, because our layer is
 * alpha-blended over the camera feed: raising alpha where the glow falls is
 * what lets the highlight bleed onto the real room behind it rather than
 * stopping at the object's edge.
 *
 * ponytail: fixed threshold and strength, no HDR buffer. The bright pass runs
 * at quarter resolution and the whole effect switches itself off if the
 * session cannot hold frame rate, since the phones this runs on have no
 * headroom to spare. ?nohalation=1 disables it outright.
 */

/** Whether the pass is actually running, for the ?debug=1 readout. */
export const halationStatus = { on: false }

/** Bright pass resolution, as a fraction of the session's framebuffer. */
const SCALE = 0.25
/**
 * Only highlights above this bleed. Display-referred, so 1.0 is clipping white.
 * Set high on purpose: a lit product is not a light source, and at 0.72 the
 * whole of a bright bun qualified, wrapping the model in a golden halo that
 * read as a dirty edge rather than as halation.
 */
const THRESHOLD = 0.93
/** Softness of that threshold, so a highlight fades in rather than switching on. */
const KNEE = 0.07
const STRENGTH = 0.22
/** Below this the effect disables itself for the rest of the session. */
const MIN_FPS = 22

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

/** Separable blur. The first pass also does the bright cut, to save a target. */
const BLUR = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uStep;
  uniform float uCut;
  varying vec2 vUv;

  vec3 tap(vec2 uv) {
    vec3 c = texture2D(tSrc, uv).rgb;
    if (uCut < 0.5) return c;
    float l = max(c.r, max(c.g, c.b));
    float s = clamp((l - ${THRESHOLD.toFixed(3)}) / ${KNEE.toFixed(3)}, 0.0, 1.0);
    return c * s * s;
  }

  void main() {
    vec3 sum = tap(vUv) * 0.227027;
    sum += (tap(vUv + uStep) + tap(vUv - uStep)) * 0.194595;
    sum += (tap(vUv + uStep * 2.0) + tap(vUv - uStep * 2.0)) * 0.121622;
    sum += (tap(vUv + uStep * 3.0) + tap(vUv - uStep * 3.0)) * 0.054054;
    sum += (tap(vUv + uStep * 4.0) + tap(vUv - uStep * 4.0)) * 0.016216;
    gl_FragColor = vec4(sum, 1.0);
  }
`

/**
 * Drawn last in the normal render, adding colour and alpha. Positions are
 * already in clip space, so no camera is involved and the quad cannot be
 * culled or moved by the session's own view matrices.
 */
const COMPOSITE = /* glsl */ `
  uniform sampler2D tGlow;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec3 g = texture2D(tGlow, vUv).rgb * uStrength;
    // the glow must lighten the real room too, so it carries its own alpha
    float a = clamp(dot(g, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    gl_FragColor = vec4(g, a);
  }
`

export function Halation() {
  const { gl, scene } = useThree()
  const disabled = useMemo(
    () => new URLSearchParams(location.search).get('nohalation') === '1',
    [],
  )

  const targets = useMemo(() => {
    const make = () => {
      const t = new WebGLRenderTarget(2, 2)
      // matched to the session's own target, so the blur and the composite
      // work on the same encoding the main render produced
      t.texture.colorSpace = SRGBColorSpace
      t.texture.generateMipmaps = false
      return t
    }
    return { scene: make(), ping: make() }
  }, [])

  const blur = useMemo(
    () =>
      new FullScreenQuad(
        new ShaderMaterial({
          uniforms: { tSrc: { value: null }, uStep: { value: new Vector2() }, uCut: { value: 1 } },
          vertexShader: VERTEX,
          fragmentShader: BLUR,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    [],
  )

  const composite = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { tGlow: { value: null }, uStrength: { value: STRENGTH } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: COMPOSITE,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // add both colour and alpha: the first glows, the second lets the glow
        // reach past the object onto the camera feed
        blending: CustomBlending,
        blendSrc: OneFactor,
        blendDst: OneFactor,
        blendSrcAlpha: OneFactor,
        blendDstAlpha: OneFactor,
      }),
    [],
  )

  const quad = useRef<Mesh>(null)
  const camera = useMemo(() => {
    const c = new PerspectiveCamera()
    // driven entirely by matrices copied from the session's camera
    c.matrixAutoUpdate = false
    return c
  }, [])
  const off = useRef(disabled)
  const frames = useRef(0)
  const since = useRef(0)

  useEffect(
    () => () => {
      targets.scene.dispose()
      targets.ping.dispose()
      blur.dispose()
      composite.dispose()
    },
    [targets, blur, composite],
  )

  useFrame(() => {
    const mesh = quad.current
    if (!mesh) return
    if (off.current || !gl.xr.isPresenting) {
      mesh.visible = false
      halationStatus.on = false
      return
    }

    // give up for the rest of the session rather than hold the frame rate down
    const now = performance.now()
    frames.current++
    if (now - since.current > 2000) {
      const fps = (frames.current * 1000) / (now - since.current)
      if (since.current > 0 && fps < MIN_FPS) {
        off.current = true
        mesh.visible = false
        halationStatus.on = false
        return
      }
      frames.current = 0
      since.current = now
    }

    const xrCamera = gl.xr.getCamera()
    const view = xrCamera.cameras[0] ?? xrCamera
    if (!view) return

    // the target three bound for this session's frame, to be restored below
    const sessionTarget = gl.getRenderTarget()
    const ctx = gl.getContext()
    const width = Math.max(2, Math.floor(ctx.drawingBufferWidth * SCALE))
    const height = Math.max(2, Math.floor(ctx.drawingBufferHeight * SCALE))
    if (targets.scene.width !== width || targets.scene.height !== height) {
      targets.scene.setSize(width, height)
      targets.ping.setSize(width, height)
    }

    camera.projectionMatrix.copy(view.projectionMatrix)
    camera.projectionMatrixInverse.copy(view.projectionMatrixInverse)
    camera.matrixWorld.copy(view.matrixWorld)

    // the quad must not photograph itself
    mesh.visible = false
    // a plain render, so three uses this camera and this target instead of
    // substituting the session's array camera and framebuffer
    gl.xr.enabled = false
    // reuse the shadow map the main render built; rebuilding it for a blurred
    // quarter-resolution glow would double the frame's shadow cost
    const shadowAuto = gl.shadowMap.autoUpdate
    gl.shadowMap.autoUpdate = false
    try {
      gl.setRenderTarget(targets.scene)
      gl.clear()
      gl.render(scene, camera)

      const material = blur.material as ShaderMaterial
      material.uniforms.tSrc.value = targets.scene.texture
      material.uniforms.uCut.value = 1
      material.uniforms.uStep.value.set(1 / width, 0)
      gl.setRenderTarget(targets.ping)
      blur.render(gl)

      material.uniforms.tSrc.value = targets.ping.texture
      material.uniforms.uCut.value = 0
      material.uniforms.uStep.value.set(0, 1 / height)
      gl.setRenderTarget(targets.scene)
      blur.render(gl)
    } catch {
      // a pass that cannot run is not worth a broken session
      off.current = true
    } finally {
      gl.xr.enabled = true
      gl.shadowMap.autoUpdate = shadowAuto
      gl.setRenderTarget(sessionTarget)
    }

    composite.uniforms.tGlow.value = targets.scene.texture
    mesh.visible = !off.current
    halationStatus.on = mesh.visible
  })

  if (disabled) return null
  return (
    <mesh
      ref={quad}
      material={composite}
      frustumCulled={false}
      renderOrder={999}
      visible={false}
      raycast={() => null}
    >
      <planeGeometry args={[2, 2]} />
    </mesh>
  )
}
