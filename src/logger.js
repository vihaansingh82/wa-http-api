import pino from 'pino'
import { config } from './config.js'

export const logger = pino({
  level: config.logLevel,
  transport: config.logPretty
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined
})

// Baileys wants its own ILogger; give it a child so its very chatty output can be
// filtered separately from ours.
export const baileysLogger = logger.child({ module: 'baileys' }, { level: config.logLevel })
