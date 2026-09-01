/**
 * Where the API lives. Empty in dev, where Vite proxies /api and /models to
 * localhost:8788. In production the frontend and API are on different hosts
 * (Vercel can't persist state), so VITE_API_URL points at the API host.
 */
const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')

export const api = (path: string) => `${BASE}${path}`

/** Model URLs come back from the API as /models/<file> — same host as the API. */
export const assetUrl = (url: string) => (url.startsWith('/') ? `${BASE}${url}` : url)
