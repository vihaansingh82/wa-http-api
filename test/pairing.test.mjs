// Drives the browser pairing flow end to end against a stubbed WhatsApp client.
process.env.API_KEY = 'admin-api-key-0123456789'
process.env.LOG_LEVEL = 'silent'
process.env.SEND_DELAY_MS = '0'

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const tmp = await mkdtemp(path.join(tmpdir(), 'wa-tokens-'))
process.env.TOKEN_STORE = path.join(tmp, 'tokens.json')

const root = new URL('../', import.meta.url)
const { createServer } = await import(new URL('src/server.js', root))
const { createTokenStore } = await import(new URL('src/tokens.js', root))
const { createPairingFlow } = await import(new URL('src/pairing.js', root))
const { ApiError } = await import(new URL('src/errors.js', root))

let failures = 0
function check(label, cond, detail) {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

// ---- stub client -----------------------------------------------------------
const state = { connected: false, selfSends: [] }
const client = {
  isConnected: () => state.connected,
  status: () => ({
    connection: state.connected ? 'open' : 'close',
    connected: state.connected,
    user: state.connected ? { id: '919876543210:12@s.whatsapp.net', name: 'Asha' } : null,
    hasQr: !state.connected, queued: 0, webhookConfigured: false, lastDisconnect: null
  }),
  getQr: () => {
    if (state.connected) throw ApiError.conflict('Already connected.')
    return { qr: 'raw', dataUrl: 'data:image/png;base64,QQQQ', generatedAt: 'now' }
  },
  sendToSelf: async msg => { state.selfSends.push(msg); return { id: 'SELF1' } },
  sendText: async (jid, message) => ({ id: 'M1', to: jid, timestamp: 1 }),
  sendMedia: async (jid) => ({ id: 'M2', to: jid, timestamp: 2 }),
  checkNumber: async n => ({ number: n, exists: true, jid: n + '@s.whatsapp.net' }),
  logout: async () => { state.connected = false; return { loggedOut: true } }
}

const tokens = createTokenStore(process.env.TOKEN_STORE)
await tokens.load()
let pairing
const pairingRef = { onConnected: u => pairing.onConnected(u) }
pairing = createPairingFlow({ client, tokens, ttlMs: 600000, deliverToPhone: true })

const app = createServer(client, { tokens, pairing })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

const call = async (path, init = {}) => {
  const res = await fetch(base + path, init)
  let body; try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}
const post = (p, tok) => call(p, { method: 'POST', ...(tok ? { headers: { 'x-api-key': tok } } : {}) })

// ---- 1. nothing works without a credential ---------------------------------
console.log('--- before linking ---')
check('GET /status is 401 with no credential', (await call('/status')).status === 401)
check('GET / (console) is public', (await fetch(base + '/')).status === 200)
check('GET /health is public', (await call('/health')).status === 200)

// ---- 2. start a pairing, unauthenticated, from loopback --------------------
const started = await post('/pair/start')
check('POST /pair/start needs no credential on loopback', started.status === 201, JSON.stringify(started.body))
const claimId = started.body?.claimId
check('claim id returned', typeof claimId === 'string' && claimId.length > 10)

const polled = await call('/pair/status/' + encodeURIComponent(claimId))
check('poll returns awaiting_scan + a QR', polled.body?.state === 'awaiting_scan' && polled.body?.qr?.startsWith('data:image/png'), JSON.stringify(polled.body))

const bogus = await call('/pair/status/does-not-exist')
check('unknown claim reports expired', bogus.body?.state === 'expired', JSON.stringify(bogus.body))

// ---- 3. the phone scans ----------------------------------------------------
console.log('\n--- phone scans ---')
state.connected = true
await pairingRef.onConnected(client.status().user)

const paired = await call('/pair/status/' + encodeURIComponent(claimId))
const issued = paired.body?.token
check('poll now returns paired + a token', paired.body?.state === 'paired' && typeof issued === 'string', JSON.stringify(paired.body))
check('token carries the wa_ prefix', issued?.startsWith('wa_'), issued)
check('user echoed back', paired.body?.user?.id === '919876543210:12@s.whatsapp.net')

const again = await call('/pair/status/' + encodeURIComponent(claimId))
check('token is handed over only once', !again.body?.token && again.body?.tokenAlreadyCollected === true, JSON.stringify(again.body))

// token was DMed to the phone
check('token delivered to own chat', state.selfSends.length === 1 && state.selfSends[0].includes(issued))

// ---- 4. the minted token actually authenticates -----------------------------
console.log('\n--- using the minted token ---')
const withToken = await call('/status', { headers: { 'x-api-key': issued } })
check('GET /status works with the device token', withToken.status === 200, JSON.stringify(withToken.body))
check('status reports device auth', withToken.body?.authenticatedAs === 'device', JSON.stringify(withToken.body?.authenticatedAs))

const bearer = await call('/status', { headers: { authorization: 'Bearer ' + issued } })
check('Authorization: Bearer also accepted', bearer.status === 200)

const adminStatus = await call('/status', { headers: { 'x-api-key': process.env.API_KEY } })
check('admin key still works', adminStatus.status === 200 && adminStatus.body?.authenticatedAs === 'admin')

check('a wrong token is rejected', (await call('/status', { headers: { 'x-api-key': 'wa_' + 'A'.repeat(43) } })).status === 401)
const sent = await call('/send/text', { method: 'POST', headers: { 'x-api-key': issued, 'content-type': 'application/json' }, body: JSON.stringify({ to: '919876543210', message: 'hi' }) })
check('device token can send', sent.status === 202, JSON.stringify(sent.body))

// ---- 5. store hygiene -------------------------------------------------------
console.log('\n--- token store on disk ---')
const onDisk = JSON.parse(await readFile(process.env.TOKEN_STORE, 'utf8'))
check('store holds exactly one token', onDisk.tokens.length === 1)
check('plaintext token is NOT on disk', !JSON.stringify(onDisk).includes(issued))
check('only a sha256 hash is stored', /^[0-9a-f]{64}$/.test(onDisk.tokens[0].hash))
check('GET /status never leaks hashes', !JSON.stringify(withToken.body).includes(onDisk.tokens[0].hash))

// ---- 6. already linked: new browser mints without re-pairing ----------------
console.log('\n--- already linked ---')
const conflict = await post('/pair/start')
check('POST /pair/start is 409 once linked', conflict.status === 409, JSON.stringify(conflict.body))
const minted = await post('/pair/token')
check('POST /pair/token mints for a new browser', minted.status === 201 && minted.body?.token?.startsWith('wa_'), JSON.stringify(minted.body))
check('second token also authenticates', (await call('/status', { headers: { 'x-api-key': minted.body.token } })).status === 200)

// ---- 7. logout revokes everything -------------------------------------------
console.log('\n--- logout ---')
const out = await post('/logout', issued)
check('logout succeeds', out.status === 200, JSON.stringify(out.body))
check('logout reports revoked count', out.body?.revokedTokens === 2, JSON.stringify(out.body?.revokedTokens))
check('the old token is now dead', (await call('/status', { headers: { 'x-api-key': issued } })).status === 401)
check('the second token is dead too', (await call('/status', { headers: { 'x-api-key': minted.body.token } })).status === 401)
check('admin key survives logout', (await call('/status', { headers: { 'x-api-key': process.env.API_KEY } })).status === 200)
const emptied = JSON.parse(await readFile(process.env.TOKEN_STORE, 'utf8'))
check('store emptied on disk', emptied.tokens.length === 0)

// ---- 8. an ordinary reconnect must NOT mint a token -------------------------
console.log('\n--- reconnect hygiene ---')
state.connected = true
await pairingRef.onConnected(client.status().user)
check('reconnect with no pending claim mints nothing', tokens.list().length === 0, JSON.stringify(tokens.list()))

server.close()
await rm(tmp, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
