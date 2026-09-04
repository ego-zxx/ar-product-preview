import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'

/**
 * Measure the camera feed, so the object can be graded to it instead of guessed at.
 *
 * Everything the object's brightness depended on until now was open loop. The
 * light estimate says how bright the room is; the phone's own auto-exposure
 * decides how bright the room *looks*; and nothing connected the two, so a
 * constant tuned in one room was wrong in the next — which is exactly the
 * "sometimes darker, sometimes too light" that kept coming back.
 *
 * WebXR raw camera access closes that loop. With the `camera-access` feature
 * granted, each frame's view carries an `XRCamera` whose image can be bound as
 * a texture, so the feed becomes measurable: shrink it to 32x32, read it back,
 * and its black point, mid-tone and white point are known numbers. That is the
 * plate a compositor would grade against, and the same three numbers they would
 * pull off it.
 *
 * Read back on a throttle rather than every frame — readPixels stalls the
 * pipeline until the GPU catches up, which a phone holding 30fps cannot spare.
 *
 * ponytail: raw WebGL for the downsample rather than a three material, so
 * three's texture bookkeeping never has to be told about a texture it does not
 * own; state is handed back with resetState(). Falls back silently to the
 * previous behaviour wherever the feature is missing or refused.
 */

/** What the camera actually recorded, all display-referred 0..1. */
export const plate = {
  /** darkest tones in frame: what the object's blacks should sit on */
  black: 0,
  /** median: what the phone's auto-exposure settled on */
  mid: 0,
  /** near-white: how far from clipping the feed's brightest tones are */
  white: 1,
  measured: false,
}

/** Sample grid. 1024 samples is plenty for three percentiles and one readback. */
const GRID = 32
/** Frames between readbacks. */
const EVERY = 8

/** A correctly exposed frame sits here, which is what the phone aims for. */
export const MID_TARGET = 0.18
export const EXPOSURE_MIN = 0.75
export const EXPOSURE_MAX = 1.3

/**
 * The object should ride the phone's exposure, not the room's true brightness.
 * When the feed comes back dark the phone could not lift the room and the object
 * belongs dark with it; when it comes back bright, likewise. Softened by a square
 * root because this is a correction, not a relight.
 */
export const exposureFor = (mid: number) =>
  mid <= 0
    ? 1
    : Math.min(EXPOSURE_MAX, Math.max(EXPOSURE_MIN, Math.sqrt(mid / MID_TARGET)))

/** Roll-off that lands our white on the feed's white; mirrors the plate shader. */
export const rollFor = (white: number) =>
  white <= 0 ? 0.5 : Math.min(2, Math.max(0, (4 * (1 - white)) / white))

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D tCam;
in vec2 vUv;
out vec4 fragColour;
void main() { fragColour = texture(tCam, vUv); }`

/**
 * Raw camera access postdates the WebXR types this project depends on, so the
 * two members it adds are declared rather than pulled in.
 */
type XRCameraImage = { readonly width: number; readonly height: number }
type CameraBinding = XRWebGLBinding & {
  getCameraImage(camera: XRCameraImage): WebGLTexture | null
}

type Kit = {
  program: WebGLProgram
  vao: WebGLVertexArrayObject
  fbo: WebGLFramebuffer
  target: WebGLTexture
  pixels: Uint8Array
}

function build(gl: WebGL2RenderingContext): Kit | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('exposure probe:', gl.getShaderInfoLog(shader))
      return null
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, VERTEX)
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT)
  const program = vs && fs ? gl.createProgram() : null
  if (!vs || !fs || !program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null

  const vao = gl.createVertexArray()
  const fbo = gl.createFramebuffer()
  const target = gl.createTexture()
  if (!vao || !fbo || !target) return null
  gl.bindTexture(gl.TEXTURE_2D, target)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, GRID, GRID, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0)
  const ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.bindTexture(gl.TEXTURE_2D, null)
  if (!ready) return null

  return { program, vao, fbo, target, pixels: new Uint8Array(GRID * GRID * 4) }
}

/** Percentiles off the sampled frame, in linear light. */
function readPlate(pixels: Uint8Array) {
  const luminance = new Float64Array(GRID * GRID)
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    luminance[p] =
      0.2126 * srgbToLinear(pixels[i] / 255) +
      0.7152 * srgbToLinear(pixels[i + 1] / 255) +
      0.0722 * srgbToLinear(pixels[i + 2] / 255)
  }
  luminance.sort()
  const at = (q: number) => luminance[Math.min(luminance.length - 1, Math.floor(q * luminance.length))]
  return { black: at(0.05), mid: at(0.5), white: at(0.95) }
}

export function CameraExposure() {
  const { gl } = useThree()
  const kit = useRef<Kit | null>(null)
  const binding = useRef<CameraBinding | null>(null)
  const session = useRef<XRSession | null>(null)
  const tick = useRef(0)
  const failed = useRef(false)

  useEffect(() => {
    return () => {
      plate.measured = false
      binding.current = null
      session.current = null
    }
  }, [])

  useFrame(() => {
    if (failed.current || !gl.xr.isPresenting) return
    if (++tick.current % EVERY !== 0) return

    const current = gl.xr.getSession()
    const frame = gl.xr.getFrame()
    const space = gl.xr.getReferenceSpace()
    if (!current || !frame || !space) return

    const context = gl.getContext() as WebGL2RenderingContext
    try {
      if (session.current !== current) {
        session.current = current
        binding.current = new XRWebGLBinding(current, context) as CameraBinding
      }
      const pose = frame.getViewerPose(space)
      const view = pose?.views?.[0] as (XRView & { camera?: XRCameraImage }) | undefined
      // the feature was not granted, or this runtime does not offer it
      if (!view?.camera || !binding.current) return
      const image = binding.current.getCameraImage(view.camera)
      if (!image) return

      if (!kit.current) kit.current = build(context)
      const k = kit.current
      if (!k) {
        failed.current = true
        return
      }

      context.bindFramebuffer(context.FRAMEBUFFER, k.fbo)
      context.viewport(0, 0, GRID, GRID)
      context.disable(context.DEPTH_TEST)
      context.disable(context.BLEND)
      context.disable(context.SCISSOR_TEST)
      context.useProgram(k.program)
      context.bindVertexArray(k.vao)
      context.activeTexture(context.TEXTURE0)
      context.bindTexture(context.TEXTURE_2D, image)
      context.uniform1i(context.getUniformLocation(k.program, 'tCam'), 0)
      context.drawArrays(context.TRIANGLES, 0, 3)
      context.readPixels(0, 0, GRID, GRID, context.RGBA, context.UNSIGNED_BYTE, k.pixels)
      context.bindVertexArray(null)
      context.bindFramebuffer(context.FRAMEBUFFER, null)

      const measured = readPlate(k.pixels)
      plate.black = measured.black
      plate.mid = measured.mid
      plate.white = measured.white
      plate.measured = true
    } catch {
      // a runtime that refuses the camera should cost one frame, not the session
      failed.current = true
      plate.measured = false
    } finally {
      // three tracks GL state itself and has just been lied to
      gl.resetState()
    }
  })

  return null
}
