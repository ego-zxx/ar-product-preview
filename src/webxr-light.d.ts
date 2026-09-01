// WebXR Lighting Estimation — shipped in Chrome, not yet in @types/webxr.
// https://immersive-web.github.io/lighting-estimation/
interface XRLightEstimate {
  readonly sphericalHarmonicsCoefficients: Float32Array
  readonly primaryLightDirection: DOMPointReadOnly
  readonly primaryLightIntensity: DOMPointReadOnly
}
interface XRLightProbe extends EventTarget {
  readonly probeSpace: XRSpace
}
interface XRSession {
  requestLightProbe(options?: {
    reflectionFormat?: 'srgba8' | 'rgba16f'
  }): Promise<XRLightProbe>
}
interface XRFrame {
  getLightEstimate(probe: XRLightProbe): XRLightEstimate | null
}
interface XRWebGLBinding {
  getReflectionCubeMap(probe: XRLightProbe): WebGLTexture | null
}
