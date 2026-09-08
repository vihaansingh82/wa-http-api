import { ApiError } from './errors.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'auth' })

/** Bearer token from the Authorization header, if present. */
function bearer(req) {
  const header = req.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/**
 * Built around an injected `store` rather than importing Supabase directly, so
 * the whole authorisation path can be exercised against a fake in tests. The
 * real store is src/supabase.js.
 */
export function makeAuth(store) {
  /**
   * Two ways in, both resolving to the same thing: a profile.
   *
   * - A Supabase access token, which is what the dashboards send after login.
   * - An API key (`wak_…`), which is what a client's own scripts send.
   *
   * Everything downstream reads `req.profile` and never has to care which.
   */
  async function authenticate(req, _res, next) {
    try {
      if (!store.supabaseConfigured) {
        throw ApiError.unavailable(
          'Supabase is not configured on this server, so nobody can be authenticated. ' +
            'Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY.'
        )
      }

      const apiKey = req.get('x-api-key')
      if (apiKey) {
        const profile = await store.profileForApiKey(apiKey)
        if (!profile) throw ApiError.unauthorized('That API key is not valid or has been revoked.')
        req.profile = profile
        req.authKind = 'api_key'
        return next()
      }

      const token = bearer(req)
      if (token) {
        const profile = await store.profileForAccessToken(token)
        if (!profile) throw ApiError.unauthorized('Your session has expired. Sign in again.')
        req.profile = profile
        req.authKind = 'session'
        return next()
      }

      throw ApiError.unauthorized('Sign in, or send an API key as x-api-key.')
    } catch (err) {
      if (!(err instanceof ApiError)) {
        log.error({ err }, 'authentication failed unexpectedly')
        return next(ApiError.gateway('Could not verify your identity.'))
      }
      if (err.status === 401) {
        log.warn(
          { path: req.path, kind: req.get('x-api-key') ? 'api_key' : 'session' },
          'rejected credential'
        )
      }
      next(err)
    }
  }

  /** Gate a route on the admin role. Must run after authenticate. */
  function requireAdmin(req, _res, next) {
    if (req.profile?.role !== 'admin') {
      log.warn({ userId: req.profile?.id, path: req.path }, 'non-admin tried an admin route')
      return next(ApiError.forbidden('This action requires an admin account.'))
    }
    next()
  }

  /**
   * Admin routes manage the service, so they are deliberately closed to API
   * keys: a leaked client key must not be able to suspend accounts or delete
   * other tenants. Session only, which means a real login.
   */
  function requireAdminSession(req, res, next) {
    if (req.authKind !== 'session') {
      return next(ApiError.forbidden('Admin actions require a signed-in session, not an API key.'))
    }
    return requireAdmin(req, res, next)
  }

  return { authenticate, requireAdmin, requireAdminSession }
}
