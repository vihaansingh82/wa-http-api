import 'dotenv/config'
import path from 'node:path'

const str = (name, fallback) => {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`)
  }
  return value
}

const bool = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

const apiKey = str('API_KEY', '')
if (!apiKey) {
  throw new Error('API_KEY is required. Copy .env.example to .env and set a long random value.')
}
if (apiKey.length < 16) {
  throw new Error('API_KEY must be at least 16 characters.')
}

const webhookUrl = str('WEBHOOK_URL', '')
if (webhookUrl) {
  const parsed = new URL(webhookUrl) // throws on malformed URLs, which is what we want at boot
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`WEBHOOK_URL must be http(s), got "${parsed.protocol}"`)
  }
}

export const config = {
  port: int('PORT', 3000, { min: 1, max: 65535 }),
  host: str('HOST', '0.0.0.0'),
  apiKey,
  authDir: path.resolve(str('AUTH_DIR', './auth')),
  sessionName: str('SESSION_NAME', 'wa-http-api'),
  sendDelayMs: int('SEND_DELAY_MS', 3000, { min: 0, max: 600000 }),
  maxQueueSize: int('MAX_QUEUE_SIZE', 500, { min: 1, max: 100000 }),
  webhookUrl,
  webhookSecret: str('WEBHOOK_SECRET', ''),
  webhookTimeoutMs: int('WEBHOOK_TIMEOUT_MS', 10000, { min: 500, max: 120000 }),
  webhookMaxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
  logLevel: str('LOG_LEVEL', 'info'),
  logPretty: bool('LOG_PRETTY', false),
  // Backoff for automatic reconnects.
  reconnect: {
    baseDelayMs: 1000,
    maxDelayMs: 60000
  }
}
