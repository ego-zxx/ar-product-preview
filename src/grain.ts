import type { Material } from 'three'

/**
 * Camera-matching on the rendered object: sensor grain and lens vignette.
 *
 * Camera video is never clean — it carries sensor noise that rises in shadow,
 * and it darkens toward the corners of the frame (lens falloff the phone's ISP
 * only partly corrects). A render has neither, and that mismatch is a large
 * part of why a virtual object reads as sitting *on* the video rather than
 * *in* it. Klein & Murray (ISMAR 2008) measured which camera artefacts matter
 * for compositing; matching them is standard practice and costs a few lines
 * in the fragment shader. Both are applied per material, so there is no
 * screen-space pass — which the XR framebuffer path does not give us cheaply.
 *
 * ponytail: fixed amplitudes, not measured from the feed. Sampling the camera's
 * actual noise floor or falloff needs camera-access, a separate permission.
 */
export const grainUniforms = {
  uGrainTime: { value: 0 },
  uGrainAmount: { value: 0.022 },
  // framebuffer size, so the falloff is centred on the frame not the object
  uLensRes: { value: [1, 1] as [number, number] },
  // corner darkening; 0 outside AR, where there is no camera to match
  uVignette: { value: 0 },
  // 1 in AR: shape the object's tones like the camera's ISP shapes the feed
  uPlate: { value: 0 },
  // silhouette feather width in pixels; 0 outside AR
  uEdgeFeather: { value: 0 },
}

/**
 * Light wrap and edge softness, done by the compositor instead of by us.
 *
 * A compositor wraps background light around a foreground element's edge and
 * feathers its matte, because a photographed edge is never one pixel wide. In
 * a WebXR session the camera feed is not ours to sample — the system composites
 * it behind our layer — so a screen-space light wrap is impossible. But the
 * blend it performs is alpha-blend, and the alpha is ours. Feathering the
 * outermost pixels of the silhouette therefore makes the compositor mix the
 * real background into the object's edge: a true light wrap against the actual
 * room, not an approximation of it, and a soft matte in the same stroke.
 *
 * The width is measured in pixels via fwidth, so it stays constant whatever
 * the surface curvature — a geometric falloff alone would feather a flat panel
 * across half its face and a tight bevel not at all.
 */
export const EDGE_FEATHER_AR = 1.8
/** How much of the real background shows through at the silhouette. */
export const EDGE_ALPHA = 0.45

/** Mirror of the shader, for the test: 1 at the centre, EDGE_ALPHA at the rim. */
export const featherAt = (ndv: number, texelWidth: number, pixels: number) => {
  if (pixels <= 0) return 1
  const t = Math.min(1, Math.max(0, ndv / Math.max(texelWidth * pixels, 1e-6)))
  return EDGE_ALPHA + (1 - EDGE_ALPHA) * t * t * (3 - 2 * t)
}

/**
 * Plate response. Compositors match a CG element to footage by lifting its
 * blacks to the plate's black point, rolling its highlights off (a "white" in
 * footage measures well under 1.0) and letting saturation fall away at both
 * ends, as sensors and film do. A render has none of that: its blacks are
 * deeper and its whites cleaner than anything in the feed, which is a tell
 * even when the lighting matches.
 *
 * ponytail: fixed curve, not sampled from the feed. Lift 0.03, white → 0.89.
 */
export const PLATE_LIFT = 0.03

export const VIGNETTE_AR = 0.15

export const stepGrain = (t: number, width = 1, height = 1) => {
  grainUniforms.uGrainTime.value = t % 1000
  grainUniforms.uLensRes.value[0] = width
  grainUniforms.uLensRes.value[1] = height
}

const patched = new WeakSet<Material>()

const FEATHER = `
        {
          // distance from the silhouette, where the surface turns away from us
          float ndv = abs(dot(normalize(normal), normalize(vViewPosition)));
          // fwidth converts that to screen pixels, so the band is a fixed width
          float band = fwidth(ndv) * uEdgeFeather;
          float edge = smoothstep(0.0, max(band, 1e-6), ndv);
          gl_FragColor.a *= mix(1.0, mix(${EDGE_ALPHA.toFixed(2)}, 1.0, edge), step(0.001, uEdgeFeather));
        }`

/** Chains onto any existing onBeforeCompile rather than replacing it. */
export function patchForGrain(material: Material) {
  if (patched.has(material)) return
  patched.add(material)
  // the feather reads `normal` and `vViewPosition`, which only the lit
  // materials declare; an unlit material would fail to compile
  const lit = (material as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial === true
  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    Object.assign(shader.uniforms, grainUniforms)
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uGrainTime;
        uniform float uGrainAmount;
        uniform vec2 uLensRes;
        uniform float uVignette;
        uniform float uPlate;
        uniform float uEdgeFeather;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          // plate response, see PLATE_LIFT
          vec3 c = gl_FragColor.rgb;
          c = 0.03 + c * 0.97;
          c = c / (1.0 + 0.5 * max(c - 0.75, 0.0));
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          float keep = 1.0 - 0.2 * (smoothstep(0.6, 1.0, l) + smoothstep(0.15, 0.0, l));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(vec3(l), c, keep), uPlate);
          // lens falloff: distance from frame centre, 0 at centre, ~1.41 at a corner
          float r = distance(gl_FragCoord.xy / uLensRes, vec2(0.5)) * 2.0;
          gl_FragColor.rgb *= 1.0 - uVignette * smoothstep(0.5, 1.4142, r);
          // cheap hash noise; the time term stops it looking like a static
          // pattern stuck to the surface
          float n = fract(sin(dot(gl_FragCoord.xy + uGrainTime,
                                  vec2(12.9898, 78.233))) * 43758.5453);
          // scale with darkness, as real sensor noise does
          float shade = 1.0 - dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor.rgb += (n - 0.5) * uGrainAmount * (0.4 + shade);
        }` + (lit ? FEATHER : ''),
      )
  }
  material.needsUpdate = true
}
