import { DataTexture, Matrix4, RGFormat, UnsignedByteType, type Material } from 'three'

/**
 * Real-world occlusion from the WebXR Depth API, CPU path.
 *
 * three.js renders an occluder automatically, but only when the runtime grants
 * depth-sensing as 'gpu-optimized'. Phones like the Galaxy S20 FE only offer
 * 'cpu-optimized', so the depth buffer arrives as bytes and nothing consumes
 * it. This uploads that buffer as a texture and injects a test into every
 * model's fragment shader: if the real world is nearer than the fragment, the
 * fragment is discarded — so a hand, a laptop or a table edge hides the object.
 */

/**
 * Depth occlusion is OFF by default.
 *
 * On the hardware to hand the depth buffer is 160x90 for a 1080x2400 screen and
 * noisy, and it has twice made the result worse than no occlusion at all —
 * chewing holes in the model, and once hiding it entirely. Plane occlusion
 * (walls and tables) carries the realism instead, and this stays available for
 * tuning:  __occlusionUniforms.uEnabled.value = 1
 */
export let depthOcclusionEnabled = false

export const occlusionUniforms = {
  uDepth: { value: null as DataTexture | null },
  /** maps normalized view coords -> normalized depth-buffer coords */
  uDepthUv: { value: new Matrix4() },
  uRawToMeters: { value: 0.001 },
  uResolution: { value: [1, 1] as [number, number] },
  /**
   * Metres of slack before the real world is allowed to hide a fragment.
   * The depth buffer is ~160x90 for a 1080p screen and noisy, and an object
   * resting on a surface is at almost the same depth as that surface — a small
   * bias lets noise eat holes in the object. Only occlude when something is
   * clearly in front.
   */
  uBias: { value: 0.12 },
  /** one depth texel, for neighbour taps */
  uTexel: { value: [1 / 160, 1 / 90] as [number, number] },
  /**
   * Extra vertical flip when sampling. Off by default: the runtime's
   * normDepthBufferFromNormView already carries the orientation, and flipping
   * on top of it double-flips — every fragment then reads a near depth and the
   * whole model is discarded.
   */
  uFlipY: { value: 0 },
  /** 1 = paint the sampled depth instead of shading, to check alignment */
  uDebug: { value: 0 },
  uEnabled: { value: 0 },
}

// The only way to inspect the depth path is on a real device over the
// DevTools protocol, so the uniforms are reachable by name.
;(globalThis as Record<string, unknown>).__occlusion = () => occlusionStatus()
;(globalThis as Record<string, unknown>).__occlusionUniforms = occlusionUniforms

export const setDepthOcclusion = (on: boolean) => {
  depthOcclusionEnabled = on
  if (!on) occlusionUniforms.uEnabled.value = 0
}
;(globalThis as Record<string, unknown>).__setDepthOcclusion = setDepthOcclusion

let texture: DataTexture | null = null
let lastW = 0
let lastH = 0
let lastError = ''

export const occlusionStatus = () => ({
  enabled: occlusionUniforms.uEnabled.value === 1,
  size: `${lastW}x${lastH}`,
  rawToMeters: occlusionUniforms.uRawToMeters.value,
  error: lastError,
  materialsPatched: patchedCount,
  shadersCompiled: compiledCount,
})

/** Feed one frame's depth buffer in. Returns false when depth isn't available. */
export function updateOcclusion(
  frame: XRFrame,
  view: XRView,
  drawWidth: number,
  drawHeight: number,
): boolean {
  let info: XRCPUDepthInformation | undefined
  try {
    info = frame.getDepthInformation?.(view) as XRCPUDepthInformation | undefined
  } catch (e) {
    lastError = (e as Error).message
    occlusionUniforms.uEnabled.value = 0
    return false
  }
  if (!info?.data) {
    lastError = 'no depth information for this view'
    occlusionUniforms.uEnabled.value = 0
    return false
  }
  lastError = ''

  const { width, height } = info
  // luminance-alpha: 2 bytes per texel, little-endian uint16 raw depth
  const bytes = new Uint8Array(info.data)

  if (!texture || lastW !== width || lastH !== height) {
    texture?.dispose()
    texture = new DataTexture(bytes, width, height, RGFormat, UnsignedByteType)
    texture.flipY = false
    lastW = width
    lastH = height
    occlusionUniforms.uDepth.value = texture
  } else {
    texture.image.data = bytes
  }
  texture.needsUpdate = true

  if (!depthOcclusionEnabled) {
    occlusionUniforms.uEnabled.value = 0
    return false
  }
  occlusionUniforms.uTexel.value = [1 / width, 1 / height]
  occlusionUniforms.uDepthUv.value.fromArray(info.normDepthBufferFromNormView.matrix)
  occlusionUniforms.uRawToMeters.value = info.rawValueToMeters
  occlusionUniforms.uResolution.value = [drawWidth, drawHeight]
  occlusionUniforms.uEnabled.value = 1
  return true
}

const patched = new WeakSet<Material>()
let patchedCount = 0
let compiledCount = 0

/** Inject the depth test into a material's shader. Safe to call repeatedly. */
export function patchForOcclusion(material: Material) {
  if (patched.has(material)) return
  // helpers must always draw; occluding the reticle makes the app look dead
  if (material.userData?.noOcclusion) return
  patched.add(material)

  patchedCount++
  material.onBeforeCompile = (shader) => {
    compiledCount++
    Object.assign(shader.uniforms, occlusionUniforms)

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vViewDepth;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvViewDepth = -mvPosition.z;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vViewDepth;
        uniform sampler2D uDepth;
        uniform mat4 uDepthUv;
        uniform float uRawToMeters;
        uniform vec2 uResolution;
        uniform float uBias;
        uniform vec2 uTexel;
        uniform float uEnabled;

        float realDepthAt(vec2 uv) {
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
          vec2 packed = texture2D(uDepth, uv).rg;
          // little-endian uint16 split across the two channels
          return (packed.r * 255.0 + packed.g * 255.0 * 256.0) * uRawToMeters;
        }`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uEnabled > 0.5) {
          vec2 viewUv = gl_FragCoord.xy / uResolution;
          if (uFlipY > 0.5) viewUv.y = 1.0 - viewUv.y;
          vec2 depthUv = (uDepthUv * vec4(viewUv, 0.0, 1.0)).xy;

          // Sample the texel and its neighbours, and keep the FARTHEST reading.
          // A single noisy texel then cannot punch a hole in the object: every
          // tap has to agree the real world is in front before we discard.
          float farthest = 0.0;
          float samples = 0.0;
          vec2 offsets[5];
          offsets[0] = vec2(0.0, 0.0);
          offsets[1] = vec2( uTexel.x, 0.0);
          offsets[2] = vec2(-uTexel.x, 0.0);
          offsets[3] = vec2(0.0,  uTexel.y);
          offsets[4] = vec2(0.0, -uTexel.y);
          for (int i = 0; i < 5; i++) {
            float d = realDepthAt(depthUv + offsets[i]);
            if (d > 0.0) { farthest = max(farthest, d); samples += 1.0; }
          }
          // need most taps to carry real data, else the reading is untrustworthy
          if (samples >= 4.0 && farthest < vViewDepth - uBias) discard;

          if (uDebug > 0.5) {
            // near = red, far = blue, over ~3m; misalignment is obvious on sight
            float d = clamp(realDepthAt(depthUv) / 3.0, 0.0, 1.0);
            gl_FragColor = vec4(1.0 - d, 0.0, d, 1.0);
          }
        }`,
      )
  }
  material.needsUpdate = true
}
