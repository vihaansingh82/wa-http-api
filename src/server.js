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

/** Constant-time comparison so the admin key cannot be guessed byte by byte. */
function adminKeyMatches(provided) {
  const a = Buffer.from(String(provided))
  const b = Buffer.from(config.apiKey)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Accept the credential from `x-api-key` or a bearer header, whichever is set. */
function presentedCredential(req) {
  const header = req.get('x-api-key')
  if (header) return header
  const auth = req.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

/**
 * Loopback callers are treated as the operator sitting at the machine, which is
 * what makes "open localhost and click Link WhatsApp" work with no bootstrap
 * secret. Proxy headers are deliberately not consulted -- only the real peer.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Headers that only ever appear when something forwarded the request. Their
 * presence is proof this is NOT a direct local connection, whatever the socket
 * says.
 */
const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'fly-client-ip'
]

/**
 * A reverse proxy or tunnel (cloudflared, ngrok, nginx, Render, Fly) connects to
 * this process over loopback, so the peer address alone would make every visitor
 * on the internet look local -- and hand them the pairing routes, which mint API
 * tokens. So a forwarded request is never local, and the exemption can be turned
 * off outright with TRUST_LOOPBACK_PAIRING=false.
 */
const isLoopback = req => {
  if (!config.trustLoopbackPairing) return false
  if (FORWARDED_HEADERS.some(header => req.get(header))) return false
  return LOOPBACK.has(req.socket?.remoteAddress ?? '')
}

export function createServer(client, { tokens, pairing }) {
  /** Admin key or any live device token gets you in. */
  function authenticate(req, _res, next) {
    const provided = presentedCredential(req)
    if (provided) {
      if (adminKeyMatches(provided)) {
        req.auth = { kind: 'admin' }
        return next()
      }
      const tokenId = tokens.verify(provided)
      if (tokenId) {
        req.auth = { kind: 'device', tokenId }
        return next()
      }
    }
    httpLogger.warn({ path: req.path, ip: req.socket?.remoteAddress }, 'rejected request with bad credential')
    return next(ApiError.unauthorized('Missing or invalid credential. Send the API key or a device token as x-api-key.'))
  }

  /** The pairing routes are open on loopback and locked down everywhere else. */
  function pairingGate(req, _res, next) {
    if (isLoopback(req) || config.allowRemotePairing) return next()
    const provided = presentedCredential(req)
    if (provided && adminKeyMatches(provided)) return next()
    httpLogger.warn({ ip: req.socket?.remoteAddress }, 'rejected remote pairing attempt')
    return next(
      ApiError.unauthorized(
        'Pairing can only be started from this machine. Send the admin API key, or set ALLOW_REMOTE_PAIRING=true if you have put the server behind your own access control.'
      )
    )
  }

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
  // The console at / holds no secrets: it gets its token from the pairing flow
  // below and keeps it in the browser's localStorage.
  // No max-age on the HTML. The console ships with the server, so a cached copy
  // goes stale the moment the server is updated -- which stranded a real user on
  // an old page. ETags keep revalidation down to a 304.
  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
      }
    })
  )

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

  // --- pairing: loopback-open, so the console needs no bootstrap secret ----
  app.post('/pair/start', pairingGate, (_req, res) => {
    res.status(201).json(pairing.start())
  })

  app.get('/pair/status/:claimId', pairingGate, (req, res) => {
    res.json(pairing.status(req.params.claimId))
  })

  // Already linked but on a new browser: mint a token without re-pairing. Same
  // loopback gate, so being at the machine is still what authorises it.
  app.post('/pair/token', pairingGate, async (_req, res) => {
    if (!client.isConnected()) {
      throw ApiError.unavailable('Not linked yet. Start a pairing at POST /pair/start.')
    }
    const { id, token } = await tokens.create('console')
    res.status(201).json({ id, token, user: client.status().user })
  })

  // --- everything below needs the admin key or a device token --------------
  app.use(authenticate)

  app.get('/status', (req, res) => {
    res.json({
      session: config.sessionName,
      ...client.status(),
      authenticatedAs: req.auth.kind,
      deviceTokens: tokens.list()
    })
  })

  app.post('/tokens/revoke', async (_req, res) => {
    const revoked = await tokens.revokeAll()
    res.json({ revoked, message: 'All device tokens revoked. The admin API key still works.' })
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
    // The session is gone, so every device token it backed must go too --
    // otherwise an old token would keep working against the next pairing.
    const revoked = await tokens.revokeAll()
    const result = await client.logout()
    res.json({
      ...result,
      revokedTokens: revoked,
      message: 'Session cleared and device tokens revoked. Link again from the console at /.'
    })
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
