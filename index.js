import { config } from './src/config.js'
import { logger } from './src/logger.js'
import { createWhatsAppClient } from './src/whatsapp.js'
import { createServer } from './src/server.js'

// A dropped WhatsApp socket or a dead webhook receiver must never take the
// process down, so nothing is left to Node's default crash-on-rejection.
process.on('unhandledRejection', reason => {
  logger.error({ err: reason }, 'unhandled promise rejection')
})

process.on('uncaughtException', err => {
  logger.fatal({ err }, 'uncaught exception, shutting down')
  shutdown('uncaughtException', 1)
})

const client = createWhatsAppClient()
const app = createServer(client)

const server = app.listen(config.port, config.host, () => {
  logger.info(
    {
      url: `http://${config.host}:${config.port}`,
      authDir: config.authDir,
      sendDelayMs: config.sendDelayMs,
      webhook: config.webhookUrl || '(disabled)'
    },
    'HTTP API listening'
  )
})

let shuttingDown = false

function shutdown(signal, code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  const done = () => process.exit(code)
  // Do not hang forever on a lingering keep-alive connection.
  const force = setTimeout(done, 10000)
  force.unref()

  server.close(() => {
    client
      .stop()
      .catch(err => logger.error({ err }, 'error while stopping the WhatsApp client'))
      .finally(done)
  })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal))
}

await client.start()
