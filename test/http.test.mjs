import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
// End-to-end HTTP smoke test against a stubbed WhatsApp client.
process.env.API_KEY = 'test-api-key-0123456789'
process.env.LOG_LEVEL = 'silent'
process.env.SEND_DELAY_MS = '0'
process.env.TOKEN_STORE = require('node:path').join(require('node:os').tmpdir(), 'wa-smoke-tokens-' + Date.now() + '.json')

const root = new URL('../', import.meta.url)
const { createServer } = await import(new URL('src/server.js', root))
const { ApiError } = await import(new URL('src/errors.js', root))

const state = { connected: false, sends: [], boom: false }

const client = {
  isConnected: () => state.connected,
  status: () => ({
    connection: state.connected ? 'open' : 'close',
    connected: state.connected,
    user: state.connected ? { id: '111@s.whatsapp.net', name: 'Test' } : null,
    hasQr: !state.connected,
    queued: 0,
    webhookConfigured: false,
    lastDisconnect: null
  }),
  getQr: () => {
    if (state.connected) throw ApiError.conflict('Already connected. POST /logout first if you want a new QR.')
    return { qr: 'raw-qr', dataUrl: 'data:image/png;base64,AAAA', generatedAt: '2026-01-01T00:00:00.000Z' }
  },
  sendText: async (jid, message) => {
    if (!state.connected) throw ApiError.unavailable('WhatsApp is not connected. Scan the QR at GET /qr first.')
    state.sends.push({ jid, message })
    return { id: 'MSGID1', to: jid, timestamp: 1700000000 }
  },
  sendMedia: async (jid, content) => {
    if (state.boom) throw new Error('kaboom from baileys')
    state.sends.push({ jid, content })
    return { id: 'MSGID2', to: jid, timestamp: 1700000001 }
  },
  checkNumber: async number => ({ number, exists: number.startsWith('91'), jid: `${number}@s.whatsapp.net` }),
  logout: async () => ({ loggedOut: true })
}

const { createTokenStore } = await import(new URL('src/tokens.js', root))
const { createPairingFlow } = await import(new URL('src/pairing.js', root))
const tokens = createTokenStore(process.env.TOKEN_STORE)
await tokens.load()
const pairing = createPairingFlow({ client, tokens, ttlMs: 600000, deliverToPhone: false })
const app = createServer(client, { tokens, pairing })
const server = app.listen(0)
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const KEY = { 'x-api-key': process.env.API_KEY }
let failures = 0

async function check(label, expectedStatus, path, init = {}) {
  const res = await fetch(base + path, init)
  let body
  try {
    body = await res.json()
  } catch {
    body = '<non-json>'
  }
  const ok = res.status === expectedStatus
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${String(res.status).padEnd(3)} (want ${expectedStatus})  ${label}`,
    ok ? '' : `\n        body: ${JSON.stringify(body)}`
  )
  return body
}

const json = body => ({
  method: 'POST',
  headers: { ...KEY, 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
})

console.log('--- disconnected ---')
const health = await check('GET /health without a key', 200, '/health')
console.log('        health body:', JSON.stringify(health))
await check('GET /qr without a key', 401, '/qr')
await check('GET /qr with a wrong key', 401, '/qr', { headers: { 'x-api-key': 'nope' } })
await check('GET /qr with a same-length wrong key', 401, '/qr', { headers: { 'x-api-key': 'X'.repeat(process.env.API_KEY.length) } })
const qr = await check('GET /qr connected=false', 200, '/qr', { headers: KEY })
console.log('        qr body keys:', Object.keys(qr).join(','), '| dataUrl prefix:', String(qr.dataUrl).slice(0, 22))
await check('POST /send/text while disconnected', 503, '/send/text', json({ to: '+91 98765 43210', message: 'hi' }))

console.log('\n--- validation ---')
state.connected = true
await check('POST /send/text with no body', 400, '/send/text', { method: 'POST', headers: KEY })
await check('POST /send/text with malformed JSON', 400, '/send/text', json('{"to": '))
await check('POST /send/text with an array body', 400, '/send/text', json([1, 2]))
await check('POST /send/text with no "to"', 400, '/send/text', json({ message: 'hi' }))
await check('POST /send/text with no "message"', 400, '/send/text', json({ to: '919876543210' }))
await check('POST /send/text with a blank "message"', 400, '/send/text', json({ to: '919876543210', message: '   ' }))
await check('POST /send/text with a numeric "to"', 400, '/send/text', json({ to: 919876543210, message: 'hi' }))
await check('POST /send/text with a short "to"', 400, '/send/text', json({ to: '123', message: 'hi' }))
await check('POST /send/media with a bad "type"', 400, '/send/media', json({ to: '919876543210', type: 'audio', url: 'https://x.test/a.mp3' }))
await check('POST /send/media with a file:// url', 400, '/send/media', json({ to: '919876543210', type: 'image', url: 'file:///etc/passwd' }))
await check('POST /send/media with a relative url', 400, '/send/media', json({ to: '919876543210', type: 'image', url: '/tmp/a.png' }))
await check('GET /check on a group jid', 400, '/check/1234567890-1234%40g.us', { headers: KEY })

console.log('\n--- happy path ---')
const sent = await check('POST /send/text', 202, '/send/text', json({ to: '+91 98765 43210', message: 'hello' }))
console.log('        ->', JSON.stringify(sent))
const img = await check('POST /send/media image', 202, '/send/media', json({ to: '919876543210', type: 'image', url: 'https://x.test/p.png', caption: 'cap' }))
console.log('        ->', JSON.stringify(img))
await check('POST /send/media document (derived mime)', 202, '/send/media', json({ to: '919876543210', type: 'document', url: 'https://x.test/files/report%20q3.pdf' }))
console.log('        document content:', JSON.stringify(state.sends.at(-1).content))
await check('POST /send/text to a group jid', 202, '/send/text', json({ to: '1234567890-1234@g.us', message: 'group hi' }))
console.log('        group send jid:', state.sends.at(-1).jid)
const chk = await check('GET /check/%2B91 98765 43210', 200, '/check/%2B91%2098765%2043210', { headers: KEY })
console.log('        ->', JSON.stringify(chk))
await check('GET /qr while connected', 409, '/qr', { headers: KEY })
await check('GET /status', 200, '/status', { headers: KEY })
await check('POST /logout', 200, '/logout', { method: 'POST', headers: KEY })

console.log('\n--- failure handling ---')
state.boom = true
const err = await check('POST /send/media when baileys throws', 500, '/send/media', json({ to: '919876543210', type: 'image', url: 'https://x.test/p.png' }))
console.log('        ->', JSON.stringify(err))
await check('GET /nope', 404, '/nope', { headers: KEY })
await check('PUT /send/text', 404, '/send/text', { method: 'PUT', headers: KEY })

server.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
