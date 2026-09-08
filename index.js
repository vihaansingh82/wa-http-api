import { config } from './src/config.js'
import { logger } from './src/logger.js'
import { createServer } from './src/server.js'
import { createTenantManager } from './src/tenants.js'
import { supabaseConfigured } from './src/supabase.js'

// Declared before the handlers below, which can fire while the server is still
// being created: reading a `const` in that window would throw a ReferenceError
// from inside the crash handler and hide the original error.
let server = null
let shuttingDown = false

// A dropped WhatsApp socket or a dead webhook receiver must never take the
// process down, so nothing is left to Node's default crash-on-rejection.
process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'unhandled promise rejection')
})

process.on('uncaughtException', err => {
  logger.fatal({ err }, 'uncaught exception, shutting down')
  shutdown('uncaughtException', 1)
})

const tenants = createTenantManager()
const app = createServer(tenants)

server = app.listen(config.port, config.host, () => {
  logger.info(
    {
      url: `http://${config.host}:${config.port}`,
      clientDashboard: '/app',
      adminDashboard: '/admin',
      authDir: config.authDir,
      maxTenantSessions: config.maxTenantSessions,
      supabase: supabaseConfigured ? config.supabaseUrl : '(not configured)'
    },
    'HTTP API listening'
  )

  if (!supabaseConfigured) {
    logger.warn(
      'Supabase is not configured, so nobody can sign in. Set SUPABASE_URL, ' +
        'SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY, then restart.'
    )
  }
})

function shutdown(signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  const done = () => process.exit(code)
  // Do not hang forever on a lingering keep-alive connection.
  const force = setTimeout(done, 15000)
  force.unref()

  const stopSessions = () =>
    tenants
      .stopAll()
      .catch(err => logger.error({ err }, 'error while stopping tenant sessions'))
      .finally(done)

  // Crashing before listen() means there is no server to close.
  if (server) server.close(stopSessions)
  else stopSessions()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

// Bring back the sessions that were connected before this process started, so a
// restart or deploy does not silently leave every client offline.
if (supabaseConfigured) {
  const { restored } = await tenants.restorePreviouslyConnected()
  if (restored) logger.info({ restored }, 'sessions restored after start')
}
