import { useEffect, useState } from 'react'
import { api } from './api'

const deviceId = (() => {
  let id = localStorage.getItem('deviceId')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('deviceId', id)
  }
  return id
})()

export type Access =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'valid'; expiresAt: number }
  | { state: 'denied'; reason: string }

async function post(url: string, body: unknown) {
  const res = await fetch(api(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: res.ok, data: await res.json() }
}

/**
 * VITE_OPEN_ACCESS=1 drops the QR gate entirely — for a demo hosted without the
 * API running, where there is nothing to issue or check passes against.
 */
const OPEN = import.meta.env.VITE_OPEN_ACCESS === '1'

export function useAccess(): Access {
  const [access, setAccess] = useState<Access>(
    OPEN ? { state: 'valid', expiresAt: Infinity } : { state: 'checking' },
  )

  useEffect(() => {
    if (OPEN) return
    let timer: ReturnType<typeof setInterval>

    const check = async (token: string) => {
      try {
        const { ok, data } = await post('/api/heartbeat', { token, deviceId })
        setAccess(
          ok
            ? { state: 'valid', expiresAt: data.expiresAt }
            : { state: 'denied', reason: data.reason },
        )
      } catch {
        // API down — leave current state alone rather than kicking the user
      }
    }

    ;(async () => {
      // QR lands here with ?t=<token>; claim it, then clean the URL
      const url = new URL(location.href)
      const fromQr = url.searchParams.get('t')
      if (fromQr) {
        const { ok, data } = await post('/api/claim', { token: fromQr, deviceId })
        if (ok) {
          localStorage.setItem('accessToken', fromQr)
          url.searchParams.delete('t')
          history.replaceState(null, '', url)
        } else {
          setAccess({ state: 'denied', reason: data.error })
          return
        }
      }
      const token = localStorage.getItem('accessToken')
      if (!token) {
        setAccess({ state: 'none' })
        return
      }
      await check(token)
      timer = setInterval(() => check(token), 30_000)
    })()

    return () => clearInterval(timer)
  }, [])

  return access
}
