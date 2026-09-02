/**
 * Critically damped second-order system — the smoothing model-viewer uses for
 * placement, ported from its Damper (Apache-2.0, Google LLC).
 *
 * Unlike an exponential lerp, this carries velocity: the object has weight,
 * follows a moving finger without lag building up, and settles on its goal
 * without overshoot. A lerp has to choose between laggy and twitchy; this
 * doesn't.
 *
 * ponytail: DECAY_MS is the one knob. Lower = snappier, higher = heavier.
 */
export const DECAY_MS = 50

export class Damper {
  private velocity = 0
  private readonly naturalFrequency: number

  constructor(decayMs = DECAY_MS) {
    this.naturalFrequency = 1 / Math.max(0.001, decayMs)
  }

  /** Forget momentum, e.g. when a fresh draft is created. */
  reset() {
    this.velocity = 0
  }

  /**
   * Advance one frame. `normalization` is the scale of "small" for the
   * stop-threshold: metres for position, radians (PI) for angles.
   */
  update(x: number, goal: number, dtMs: number, normalization = 1): number {
    const w = this.naturalFrequency
    const nilSpeed = 0.0002 * w
    if (normalization === 0) return goal
    if (x === goal && this.velocity === 0) return goal
    if (dtMs < 0) return x

    // Exact solution over the step, where acceleration = w²(goal - x) - 2w·v.
    const deltaX = x - goal
    const intermediateVelocity = this.velocity + w * deltaX
    const intermediateX = deltaX + dtMs * intermediateVelocity
    const decay = Math.exp(-w * dtMs)
    const newVelocity = (intermediateVelocity - w * intermediateX) * decay
    const acceleration = -w * (newVelocity + intermediateVelocity * decay)

    // Snap the last hair rather than approach asymptotically forever.
    if (Math.abs(newVelocity) < nilSpeed * Math.abs(normalization) && acceleration * deltaX >= 0) {
      this.velocity = 0
      return goal
    }
    this.velocity = newVelocity
    return goal + intermediateX * decay
  }
}
