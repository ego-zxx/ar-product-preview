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

export const occlusionUniforms = {
  uDepth: { value: null as DataTexture | null },
  /** maps normalized view coords -> normalized depth-buffer coords */
  uDepthUv: { value: new Matrix4() },
  uRawToMeters: { value: 0.001 },
  uResolution: { value: [1, 1] as [number, number] },
  /** metres of slack, so a surface doesn't clip the object resting on it */
  uBias: { value: 0.035 },
  uEnabled: { value: 0 },
}

// The only way to inspect the depth path is on a real device over the
// DevTools protocol, so the uniforms are reachable by name.
;(globalThis as Record<string, unknown>).__occlusion = () => occlusionStatus()

let texture: DataTexture | null = null
let lastW = 0
let lastH = 0
let lastError = ''

export const occlusionStatus = () => ({
  enabled: occlusionUniforms.uEnabled.value === 1,
  size: `${lastW}x${lastH}`,
  rawToMeters: occlusionUniforms.uRawToMeters.value,
  error: lastError,
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

  occlusionUniforms.uDepthUv.value.fromArray(info.normDepthBufferFromNormView.matrix)
  occlusionUniforms.uRawToMeters.value = info.rawValueToMeters
  occlusionUniforms.uResolution.value = [drawWidth, drawHeight]
  occlusionUniforms.uEnabled.value = 1
  return true
}

const patched = new WeakSet<Material>()

/** Inject the depth test into a material's shader. Safe to call repeatedly. */
export function patchForOcclusion(material: Material) {
  if (patched.has(material)) return
  patched.add(material)

  material.onBeforeCompile = (shader) => {
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
        uniform float uEnabled;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uEnabled > 0.5) {
          vec2 viewUv = gl_FragCoord.xy / uResolution;
          vec2 depthUv = (uDepthUv * vec4(viewUv, 0.0, 1.0)).xy;
          if (depthUv.x >= 0.0 && depthUv.x <= 1.0 && depthUv.y >= 0.0 && depthUv.y <= 1.0) {
            vec2 packed = texture2D(uDepth, depthUv).rg;
            // little-endian uint16 split across the two channels
            float raw = packed.r * 255.0 + packed.g * 255.0 * 256.0;
            float realDepth = raw * uRawToMeters;
            // realDepth == 0 means the sensor had no reading there
            if (realDepth > 0.0 && realDepth < vViewDepth - uBias) discard;
          }
        }`,
      )
  }
  material.needsUpdate = true
}
