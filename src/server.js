import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { logger } from './logger.js'
import { ApiError } from './errors.js'
import { makeAuth } from './auth.js'
import { clientRoutes } from './routes-client.js'
import { adminRoutes } from './routes-admin.js'
import * as supabaseStore from './supabase.js'

const httpLogger = logger.child({ module: 'http' })

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

/**
 * The store is injected so the whole request path can be tested against a
 * fake. It defaults to the real Supabase-backed module.
 */
export function createServer(tenants, { store = supabaseStore } = {}) {
  const { authenticate, requireAdminSession } = makeAuth(store)
  const app = express()
  app.disable('x-powered-by')

  /**
   * Two body limits, not one.
   *
   * Media can be posted as base64, which needs megabytes; every other route
   * needs kilobytes. Applying the large limit everywhere would let any endpoint
   * be used to make the server buffer megabytes per request, so the big limit is
   * scoped to the routes that actually carry media.
   */
  const BASE64_MEDIA_ROUTES = new Set([
    '/api/send/media',
    '/api/send/sticker',
    '/api/send/audio'
  ])
  const smallJson = express.json({ limit: '256kb' })
  const largeJson = express.json({ limit: `${config.maxMediaMb + 8}mb` })

  app.use((req, res, next) =>
    (BASE64_MEDIA_ROUTES.has(req.path) ? largeJson : smallJson)(req, res, next)
  )

  // Body-parser failures arrive as generic errors that would otherwise fall
  // through to the 500 handler, hiding a plain client mistake behind
  // "Something went wrong".
  app.use((err, req, _res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return next(ApiError.badRequest('Request body is not valid JSON.'))
    }
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      const limitKb = Math.round((err.limit ?? 0) / 1024)
      return next(
        new ApiError(
          413,
          'payload_too_large',
          BASE64_MEDIA_ROUTES.has(req.path)
            ? `Body is larger than the ${Math.round(limitKb / 1024)} MB limit. Raise MAX_MEDIA_MB, or send the media as a URL instead of base64.`
            : `Body is larger than the ${limitKb} KB limit for this route.`,
          { limitBytes: err.limit ?? null, receivedBytes: err.length ?? null }
        )
      )
    }
    next(err)
  })

  // ---- public -------------------------------------------------------------
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      supabase: store.supabaseConfigured,
      liveSessions: tenants.size,
      uptimeSeconds: Math.round(process.uptime())
    })
  })

  /**
   * The dashboards need the project URL and publishable key to sign in. Both
   * are designed to be public -- the publishable key grants nothing on its own,
   * because row-level security decides what a token can reach. The service-role
   * key is never included here.
   */
  app.get('/api/public-config', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabasePublishableKey,
      publicUrl: config.publicUrl || null,
      configured: store.supabaseConfigured
    })
  })

  // ---- authenticated API --------------------------------------------------
  app.use('/api/admin', authenticate, requireAdminSession, adminRoutes(tenants, store))
  app.use('/api', authenticate, clientRoutes(tenants, store))

  // ---- dashboards ---------------------------------------------------------
  // Static HTML with no secrets in it; the pages authenticate in the browser
  // against Supabase and then call the API above with the resulting token.
  const noCacheHtml = (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
  }

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', etag: true, setHeaders: noCacheHtml }))

  // Both dashboards are single pages, so any deep link inside them resolves to
  // the page itself rather than a 404 (/admin/accounts, /app/inbox, …).
  app.get('/admin{/*path}', (_req, res) => {
    res.set('Cache-Control', 'no-cache')
    res.sendFile(path.join(PUBLIC_DIR, 'admin', 'index.html'))
  })

  app.get('/app{/*path}', (_req, res) => {
    res.set('Cache-Control', 'no-cache')
    res.sendFile(path.join(PUBLIC_DIR, 'app', 'index.html'))
  })

  // ---- fallbacks ----------------------------------------------------------
  app.use((req, _res, next) => {
    next(ApiError.notFound(`No route for ${req.method} ${req.path}.`))
  })

  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {})
      })
    }

    httpLogger.error({ err, method: req.method, path: req.path }, 'unhandled request error')
    res.status(500).json({
      error: 'internal_error',
      message: 'Something went wrong handling the request.'
    })
  })

  return app
}
