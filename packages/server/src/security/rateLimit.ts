import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import type { NextFunction, Request, Response } from 'express'
import { getConfig } from '../config.js'

export class RateLimitedError extends Error {
  constructor(public retryAfterSec: number, message = 'Rate limit exceeded') {
    super(message)
    this.name = 'RateLimitedError'
  }
}

const limiters = new Map<string, RateLimiterMemory>()

function limiter(name: string, points: number, durationSec: number): RateLimiterMemory {
  const key = `${name}:${points}:${durationSec}`
  let l = limiters.get(key)
  if (!l) {
    l = new RateLimiterMemory({ keyPrefix: name, points, duration: durationSec })
    limiters.set(key, l)
  }
  return l
}

async function consume(name: string, points: number, durationSec: number, key: string): Promise<void> {
  if (points <= 0) return
  try {
    await limiter(name, points, durationSec).consume(key)
  } catch (res) {
    if (res instanceof RateLimiterRes) throw new RateLimitedError(Math.ceil(res.msBeforeNext / 1000))
    throw res
  }
}

/** Per-app and per-client limits on upstream tool calls (dashboard and MCP). */
export async function consumeToolCall(appId: string, appLimitOverride: number | null, clientKey: string): Promise<void> {
  const { rate } = getConfig()
  await consume('tool-app', appLimitOverride ?? rate.appPerMin, 60, appId)
  await consume('tool-client', rate.clientPerMin, 60, clientKey)
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

type KeyFn = (req: Request) => string

export function rateLimit(name: 'auth' | 'api' | 'sse', keyFn: KeyFn = clientIp) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { rate } = getConfig()
    const [points, duration] =
      name === 'auth' ? [rate.authPer15Min, 15 * 60] : name === 'sse' ? [rate.sseConnectPerMin, 60] : [rate.apiPerMin, 60]
    try {
      await consume(name, points, duration, keyFn(req))
      next()
    } catch (err) {
      if (err instanceof RateLimitedError) {
        res.set('Retry-After', String(err.retryAfterSec)).status(429).json({ error: 'Too many requests, slow down' })
        return
      }
      next(err)
    }
  }
}

export function resetRateLimitsForTesting(): void {
  limiters.clear()
}
