import type { Material } from 'three'

/**
 * Sensor grain on the rendered object.
 *
 * Camera video is never clean — it carries sensor noise that rises in shadow.
 * A render is perfectly clean, and that mismatch is a large part of why a
 * virtual object reads as sitting *on* the video rather than *in* it. Matching
 * a little of that noise is a standard compositing trick, and costs one line
 * in the fragment shader.
 *
 * ponytail: fixed amplitude, not measured from the feed. Sampling the camera's
 * actual noise floor needs camera-access, which is a separate permission.
 */
export const grainUniforms = {
  uGrainTime: { value: 0 },
  uGrainAmount: { value: 0.022 },
}

export const stepGrain = (t: number) => {
  grainUniforms.uGrainTime.value = t % 1000
}

const patched = new WeakSet<Material>()

/** Chains onto any existing onBeforeCompile rather than replacing it. */
export function patchForGrain(material: Material) {
  if (patched.has(material)) return
  patched.add(material)
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    Object.assign(shader.uniforms, grainUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uGrainTime;
        uniform float uGrainAmount;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          // cheap hash noise; the time term stops it looking like a static
          // pattern stuck to the surface
          float n = fract(sin(dot(gl_FragCoord.xy + uGrainTime,
                                  vec2(12.9898, 78.233))) * 43758.5453);
          // scale with darkness, as real sensor noise does
          float shade = 1.0 - dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor.rgb += (n - 0.5) * uGrainAmount * (0.4 + shade);
        }`,
      )
  }
  material.needsUpdate = true
}
