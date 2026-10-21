import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Express 4 does not catch rejected promises; without this, one bad request crashes the process. */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req as Req, res, next).catch(next)
  }
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    // A streaming (SSE) response already started; close it rather than writing a second response.
    if (!res.writableEnded) res.end()
    return
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) })
    return
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: err.flatten() })
    return
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' })
    return
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large' })
    return
  }
  console.error(`[error] ${req.method} ${req.path}:`, err instanceof Error ? err.stack : err)
  res.status(500).json({ error: 'Internal server error' })
}
