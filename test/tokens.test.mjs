// Hammers the token store concurrently (the bug the pairing test caught), and
// checks the pairing gate really does reject a non-loopback caller.
process.env.API_KEY = 'admin-api-key-0123456789'
process.env.LOG_LEVEL = 'silent'
process.env.SEND_DELAY_MS = '0'

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir, networkInterfaces } from 'node:os'
import path from 'node:path'

const tmp = await mkdtemp(path.join(tmpdir(), 'wa-tok-'))
process.env.TOKEN_STORE = path.join(tmp, 'tokens.json')

const root = new URL('../', import.meta.url)
const { createTokenStore } = await import(new URL('src/tokens.js', root))

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

// ---- 1. concurrent mints + verifies + a revoke ------------------------------
console.log('--- token store under concurrency ---')
const store = createTokenStore(process.env.TOKEN_STORE)
await store.load()

// 25 mints in flight at once, each followed by verifies that touch lastUsedAt
// (which persists) -- exactly the interleaving that corrupted the file before.
const minted = await Promise.all(Array.from({ length: 25 }, (_, i) => store.create('load-' + i)))
check('25 concurrent mints all returned tokens', minted.every(m => m.token.startsWith('wa_')))
check('all 25 ids are distinct', new Set(minted.map(m => m.id)).size === 25)
check('all 25 token strings are distinct', new Set(minted.map(m => m.token)).size === 25)

await Promise.all(minted.map(m => Promise.resolve(store.verify(m.token))))
// Let the fire-and-forget lastUsedAt writes settle.
await new Promise(r => setTimeout(r, 250))

let parsed
try {
  parsed = JSON.parse(await readFile(process.env.TOKEN_STORE, 'utf8'))
  check('store file is still valid JSON after the storm', true)
} catch (err) {
  check('store file is still valid JSON after the storm', false, err.message)
}
check('store holds all 25', parsed?.tokens?.length === 25, String(parsed?.tokens?.length))
check('no plaintext leaked to disk', !minted.some(m => JSON.stringify(parsed).includes(m.token)))
check('every entry has a sha256 hash', parsed?.tokens?.every(t => /^[0-9a-f]{64}$/.test(t.hash)))
check('lastUsedAt recorded', parsed?.tokens?.every(t => t.lastUsedAt !== null))

// ---- 2. survives a reload ---------------------------------------------------
const reloaded = createTokenStore(process.env.TOKEN_STORE)
await reloaded.load()
check('a fresh store reloads all 25 from disk', reloaded.list().length === 25)
check('a token minted before the reload still verifies', Boolean(reloaded.verify(minted[7].token)))
check('a made-up token does not verify', reloaded.verify('wa_' + 'z'.repeat(43)) === false)
check('a non-prefixed value does not verify', reloaded.verify('admin-api-key-0123456789') === false)
check('undefined does not verify', reloaded.verify(undefined) === false)

// revoke racing against verifies
await Promise.all([reloaded.revokeAll(), Promise.resolve(reloaded.verify(minted[1].token)), Promise.resolve(reloaded.verify(minted[2].token))])
await new Promise(r => setTimeout(r, 250))
try {
  const after = JSON.parse(await readFile(process.env.TOKEN_STORE, 'utf8'))
  check('file valid after revoke racing verifies', true)
  check('store emptied', after.tokens.length === 0, String(after.tokens.length))
} catch (err) {
  check('file valid after revoke racing verifies', false, err.message)
}

// ---- 3. a corrupt store must not crash the boot -----------------------------
const corruptPath = path.join(tmp, 'corrupt.json')
await (await import('node:fs/promises')).writeFile(corruptPath, '{ this is not json', 'utf8')
const corrupt = createTokenStore(corruptPath)
let booted = true
try { await corrupt.load() } catch { booted = false }
check('a corrupt store file is survivable', booted && corrupt.list().length === 0)

// ---- 4. the pairing gate rejects a non-loopback caller ----------------------
console.log('\n--- pairing gate from a non-loopback address ---')
const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(i => i && i.family === 'IPv4' && !i.internal)?.address

if (!lanIp) {
  console.log('SKIP  no non-loopback IPv4 interface on this machine')
} else {
  const { createServer } = await import(new URL('src/server.js', root))
  const { createPairingFlow } = await import(new URL('src/pairing.js', root))
  const client = {
    isConnected: () => false,
    status: () => ({ connection: 'close', connected: false, user: null, hasQr: false, queued: 0, webhookConfigured: false, lastDisconnect: null }),
    getQr: () => { throw new Error('none') }
  }
  const tokens2 = createTokenStore(path.join(tmp, 'gate.json'))
  await tokens2.load()
  const pairing = createPairingFlow({ client, tokens: tokens2, ttlMs: 60000, deliverToPhone: false })
  const app = createServer(client, { tokens: tokens2, pairing })
  const server = app.listen(0, '0.0.0.0')
  await new Promise(r => server.once('listening', r))
  const port = server.address().port

  const viaLan = await fetch(`http://${lanIp}:${port}/pair/start`, { method: 'POST' })
  check(`POST /pair/start from ${lanIp} is refused`, viaLan.status === 401, 'got ' + viaLan.status)

  const viaLanAdmin = await fetch(`http://${lanIp}:${port}/pair/start`, { method: 'POST', headers: { 'x-api-key': process.env.API_KEY } })
  check('same call WITH the admin key is allowed', viaLanAdmin.status === 201, 'got ' + viaLanAdmin.status)

  const viaLocal = await fetch(`http://127.0.0.1:${port}/pair/start`, { method: 'POST' })
  check('loopback needs no key', viaLocal.status === 201, 'got ' + viaLocal.status)

  const consoleViaLan = await fetch(`http://${lanIp}:${port}/`)
  check('the console page itself is still reachable over LAN', consoleViaLan.status === 200)

  server.close()
}

await rm(tmp, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
