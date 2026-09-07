import { timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { config } from './config.js'
import { logger } from './logger.js'
import { ApiError } from './errors.js'
import { normaliseJid, isGroupJid, jidToNumber } from './jid.js'
import {
  MEDIA_TYPES,
  buildMediaContent,
  optionalString,
  requireBody,
  requireEnum,
  requireHttpUrl,
  requireString
} from './validate.js'

const httpLogger = logger.child({ module: 'http' })

/** Resolved from this file, so the console is found whatever the cwd is. */
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')

/** Constant-time comparison so the API key cannot be guessed byte by byte. */
function keyMatches(provided) {
  const a = Buffer.from(String(provided))
  const b = Buffer.from(config.apiKey)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function apiKeyAuth(req, _res, next) {
  const provided = req.get('x-api-key')
  if (!provided || !keyMatches(provided)) {
    httpLogger.warn({ path: req.path, ip: req.ip }, 'rejected request with bad api key')
    return next(ApiError.unauthorized())
  }
  next()
}

export function createServer(client) {
  const app = express()
  app.disable('x-powered-by')
  // Deliberately not trusting proxy headers: req.ip is only used for logging,
  // and honouring X-Forwarded-For from any caller would just let it be spoofed.

  app.use(express.json({ limit: '256kb' }))

  // express.json() throws a SyntaxError on malformed input; turn it into a 400.
  app.use((err, _req, _res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return next(ApiError.badRequest('Request body is not valid JSON.'))
    }
    next(err)
  })

  // --- public -------------------------------------------------------------
  // The console at / is static HTML with no secrets in it; the operator pastes
  // the API key into the page, which keeps it in localStorage and sends it as
  // x-api-key like any other client.
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }))

  app.get('/health', (_req, res) => {
    const status = client.status()
    res.json({
      status: 'ok',
      connected: status.connected,
      connection: status.connection,
      queued: status.queued,
      uptimeSeconds: Math.round(process.uptime())
    })
  })

  // --- everything below needs the API key ---------------------------------
  app.use(apiKeyAuth)

  app.get('/status', (_req, res) => {
    res.json({ session: config.sessionName, ...client.status() })
  })

  app.get('/qr', (_req, res) => {
    const { qr, dataUrl, generatedAt } = client.getQr()
    res.json({ qr, dataUrl, generatedAt })
  })

  app.post('/send/text', async (req, res) => {
    const body = requireBody(req.body)
    const jid = normaliseJid(body.to)
    const message = requireString(body, 'message', { maxLength: 65536 })

    const result = await client.sendText(jid, message)
    res.status(202).json({ sent: true, isGroup: isGroupJid(jid), ...result })
  })

  app.post('/send/media', async (req, res) => {
    const body = requireBody(req.body)
    const jid = normaliseJid(body.to)
    const type = requireEnum(body, 'type', MEDIA_TYPES)
    const url = requireHttpUrl(body, 'url')
    const caption = optionalString(body, 'caption', { maxLength: 4096 })
    const mimetype = optionalString(body, 'mimetype', { maxLength: 255 })
    const fileName = optionalString(body, 'fileName', { maxLength: 255 })

    const content = buildMediaContent({ type, url, caption, mimetype, fileName })
    const result = await client.sendMedia(jid, content)
    res.status(202).json({ sent: true, type, isGroup: isGroupJid(jid), ...result })
  })

  app.get('/check/:number', async (req, res) => {
    // Reuse the same normalisation, then hand Baileys the bare digits.
    const jid = normaliseJid(req.params.number, 'number')
    if (isGroupJid(jid)) {
      throw ApiError.badRequest('/check only works for phone numbers, not group JIDs.')
    }

    const result = await client.checkNumber(jidToNumber(jid))
    res.json(result)
  })

  app.post('/logout', async (_req, res) => {
    const result = await client.logout()
    res.json({ ...result, message: 'Session cleared. A new QR will appear at GET /qr shortly.' })
  })

  // --- fallbacks ----------------------------------------------------------
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
