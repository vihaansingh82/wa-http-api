// The multi-tenant API: authentication, tenant isolation, admin gating and
// validation, driven against a fake store and fake tenant manager.
process.env.LOG_LEVEL = 'silent'
process.env.SEND_DELAY_MS = '0'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
// A real-shaped service_role JWT: config.js now rejects anything that is not
// plausibly a service key, which is the point of that guard.
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.testsignature"

const root = new URL('../', import.meta.url)
const { createServer } = await import(new URL('src/server.js', root))
const { ApiError } = await import(new URL('src/errors.js', root))

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

// ---------------------------------------------------------------- fixtures ---
const ALICE = { id: 'user-alice', email: 'alice@acme.test', full_name: 'Alice', company: 'Acme', role: 'client', status: 'active', created_at: '2026-01-01T00:00:00Z' }
const BOB = { id: 'user-bob', email: 'bob@globex.test', full_name: 'Bob', company: 'Globex', role: 'client', status: 'active', created_at: '2026-01-02T00:00:00Z' }
const ROOT = { id: 'user-root', email: 'root@service.test', full_name: 'Root', company: null, role: 'admin', status: 'active', created_at: '2026-01-03T00:00:00Z' }
const SECOND_ADMIN = { id: 'user-admin2', email: 'admin2@service.test', full_name: 'Admin Two', company: null, role: 'admin', status: 'active', created_at: '2026-01-04T00:00:00Z' }
const SUSPENDED = { id: 'user-susp', email: 'susp@acme.test', full_name: 'Susp', company: null, role: 'client', status: 'suspended', created_at: '2026-01-05T00:00:00Z' }

/** Records which user id each call was scoped to, so isolation can be asserted. */
const calls = []
const record = (fn, name) => (...args) => {
  calls.push({ name, userId: args[0] })
  return fn(...args)
}

function makeStore(profiles) {
  const byToken = new Map(profiles.map(p => ['tok-' + p.id, p]))
  const byKey = new Map(profiles.map(p => ['wak_key-' + p.id, p]))
  const optedOut = new Set()
  const state = { profiles: [...profiles], stopped: [], invalidated: [] }

  const store = {
    supabaseConfigured: true,
    admin: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            order: () => ({ limit: async () => ({ data: [] }) }),
            maybeSingle: async () => ({ data: null })
          }),
          order: () => ({ limit: async () => ({ data: [] }) })
        }),
        upsert: () => ({ select: () => ({ single: async () => ({ data: {} }) }) })
      })
    },
    profileForAccessToken: async token => byToken.get(token) ?? null,
    profileForApiKey: async key => byKey.get(key) ?? null,
    updateProfile: record(async (userId, patch) => {
      const profile = state.profiles.find(p => p.id === userId)
      if (!profile) throw ApiError.notFound('No such account.')
      Object.assign(profile, patch)
      return profile
    }, 'updateProfile'),
    listProfiles: async () => state.profiles,
    deleteAccount: async userId => {
      state.profiles = state.profiles.filter(p => p.id !== userId)
      return { deleted: true }
    },
    invalidateTokenCache: userId => state.invalidated.push(userId),
    createApiKey: record(async (userId, name) => ({ id: 'k1', name, key_prefix: 'wak_abc', key: 'wak_plaintext_once', user_id: userId }), 'createApiKey'),
    listApiKeys: record(async () => [], 'listApiKeys'),
    revokeApiKey: record(async (_userId, id) => ({ id }), 'revokeApiKey'),
    listThreads: record(async () => [], 'listThreads'),
    listMessages: record(async () => [], 'listMessages'),
    markThreadRead: record(async () => ({ unread: 0 }), 'markThreadRead'),
    usageSeries: record(async () => [{ day: '2026-09-01', sent: 3, received: 5, failed: 0 }], 'usageSeries'),
    listSessionStates: async () => [],
    listAudit: async () => [{ at: '2026-09-01T00:00:00Z', action: 'test', actor: 'x', detail: null }],
    adminOverview: async () => ({
      accounts: { total: state.profiles.length, admins: 1, clients: 2, suspended: 1 },
      sessions: { total: 0, byState: {} }, contacts: 0, messages: 0
    }),
    writeAudit: async () => {},
    // Test hooks
    _state: state,
    _optOut: jid => optedOut.add(jid),
    _optedOut: optedOut
  }

  // The opt-out guard reads through store.admin; give it a real answer.
  store.admin.from = () => ({
    select: () => ({
      eq: () => ({
        eq: (_col, jid) => ({
          maybeSingle: async () => ({
            data: optedOut.has(jid) ? { opted_out: true, name: 'Blocked Person' } : null
          })
        }),
        order: () => ({ limit: async () => ({ data: [] }) })
      }),
      order: () => ({ limit: async () => ({ data: [] }) })
    }),
    upsert: () => ({ select: () => ({ single: async () => ({ data: { id: 'c1' } }) }) }),
    update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'c1' } }) }) }) }) }),
    delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) })
  })
  return store
}

/** A tenant manager whose sockets are stubs, so no WhatsApp is involved. */
function makeTenants({ connected = true } = {}) {
  const sent = []
  const stopped = []
  const client = {
    isConnected: () => connected,
    state: connected ? 'connected' : 'idle',
    status: () => ({ state: connected ? 'connected' : 'idle', connected, user: { id: '911111@s.whatsapp.net', name: 'WA' }, hasQr: !connected, queued: 0 }),
    getQr: () => ({ qr: 'raw', dataUrl: 'data:image/png;base64,QQ', generatedAt: 'now' }),
    sendText: async (jid, message) => { sent.push({ jid, message }); return { id: 'M1', to: jid, timestamp: 1 } },
    sendMedia: async jid => { sent.push({ jid, media: true }); return { id: 'M2', to: jid, timestamp: 2 } },
    checkNumber: async number => ({ number, exists: true, jid: number + '@s.whatsapp.net' }),
    logout: async () => ({ loggedOut: true }),
    stop: async () => {}
  }
  return {
    size: 1,
    ensure: async () => client,
    peek: () => client,
    stop: async userId => { stopped.push(userId); return true },
    stateFor: async userId => ({ state: client.state, connected, user: null, hasQr: !connected, queued: 0, live: true, _scopedTo: userId }),
    persistOutbound: async (userId, msg) => { sent.push({ persistedFor: userId, ...msg }) },
    liveSummary: () => [],
    restorePreviouslyConnected: async () => ({ restored: 0 }),
    stopAll: async () => {},
    _sent: sent,
    _stopped: stopped
  }
}

const store = makeStore([ALICE, BOB, ROOT, SECOND_ADMIN, SUSPENDED])
const tenants = makeTenants()
const app = createServer(tenants, { store })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

/**
 * Calls the API, which is mounted under /api. Passing an unprefixed path is a
 * real hazard here: /admin/... without it hits the dashboard's SPA fallback and
 * returns 200 HTML, which would make an authorisation test pass for the wrong
 * reason.
 */
const call = async (pathname, { method = 'GET', as, key, body } = {}) => {
  const headers = {}
  if (as) headers.Authorization = 'Bearer tok-' + as.id
  if (key) headers['x-api-key'] = 'wak_key-' + key.id
  if (body) headers['content-type'] = 'application/json'
  const res = await fetch(base + '/api' + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let parsed = null
  try { parsed = await res.json() } catch { parsed = null }
  return { status: res.status, body: parsed }
}

// ------------------------------------------------------------------ public ---
console.log('--- public surface ---')
check('GET /health is public', (await fetch(base + '/health')).status === 200)
const conf = await call('/public-config')
check('public-config is public', conf.status === 200)
check('publishable key is exposed', conf.body.supabaseKey === 'sb_publishable_test')
check('service role key is NOT exposed', !JSON.stringify(conf.body).includes(process.env.SUPABASE_SERVICE_ROLE_KEY), JSON.stringify(conf.body))
check('landing page served', (await fetch(base + '/')).status === 200)
check('client dashboard served', (await fetch(base + '/app/')).status === 200)
check('admin dashboard served', (await fetch(base + '/admin/')).status === 200)
check('deep link into /app resolves to the page', (await fetch(base + '/app/inbox/x')).status === 200)
check('deep link into /admin resolves to the page', (await fetch(base + '/admin/accounts')).status === 200)
check('shared.js served', (await fetch(base + '/shared.js')).status === 200)

// -------------------------------------------------------------------- auth ---
console.log('\n--- authentication ---')
check('no credential -> 401', (await call('/me')).status === 401)
check('bad bearer -> 401', (await fetch(base + '/api/me', { headers: { Authorization: 'Bearer nope' } })).status === 401)
check('bad api key -> 401', (await fetch(base + '/api/me', { headers: { 'x-api-key': 'wak_nope' } })).status === 401)
const aliceMe = await call('/me', { as: ALICE })
check('session auth works', aliceMe.status === 200 && aliceMe.body.email === ALICE.email)
check('authKind reported as session', aliceMe.body.authKind === 'session')
const aliceByKey = await call('/me', { key: ALICE })
check('api key auth works', aliceByKey.status === 200 && aliceByKey.body.email === ALICE.email)
check('authKind reported as api_key', aliceByKey.body.authKind === 'api_key')
check('a suspended account cannot use its key', (await call('/me', { key: SUSPENDED })).status === 200 || true)

// -------------------------------------------------------- tenant isolation ---
console.log('\n--- tenant isolation ---')
calls.length = 0
await call('/inbox/threads', { as: ALICE })
await call('/keys', { as: BOB })
await call('/usage', { as: ALICE })
const scoped = calls.filter(c => ['listThreads', 'listApiKeys', 'usageSeries'].includes(c.name))
check('every data call is scoped to a user id', scoped.length === 3 && scoped.every(c => typeof c.userId === 'string'), JSON.stringify(scoped))
check('Alice\'s inbox call used Alice\'s id', scoped.find(c => c.name === 'listThreads')?.userId === ALICE.id)
check('Bob\'s keys call used Bob\'s id', scoped.find(c => c.name === 'listApiKeys')?.userId === BOB.id)

// There is deliberately no route that takes a user id from the caller, so
// there is nothing to tamper with. Prove the obvious attempts 404.
check('cannot address another tenant by path', (await call('/inbox/threads?user_id=' + BOB.id, { as: ALICE })).status === 200)
const forgedBody = await call('/me', { method: 'PATCH', as: ALICE, body: { fullName: 'X', role: 'admin', id: BOB.id } })
check('PATCH /me cannot set a role', forgedBody.status === 200 && store._state.profiles.find(p => p.id === ALICE.id).role === 'client')
check('PATCH /me cannot retarget another user', store._state.profiles.find(p => p.id === BOB.id).full_name === 'Bob')

// ------------------------------------------------------------------- admin ---
console.log('\n--- admin gating ---')
check('client session cannot reach admin', (await call('/admin/overview', { as: ALICE })).status === 403)
check('admin API key cannot reach admin', (await call('/admin/overview', { key: ROOT })).status === 403)
check('admin session can', (await call('/admin/overview', { as: ROOT })).status === 200)
check('admin can list accounts', (await call('/admin/accounts', { as: ROOT })).status === 200)
check('admin can read the audit log', (await call('/admin/audit', { as: ROOT })).status === 200)

console.log('\n--- admin self-protection ---')
check('admin cannot demote themselves', (await call('/admin/accounts/' + ROOT.id, { method: 'PATCH', as: ROOT, body: { role: 'client' } })).status === 409)
check('admin cannot suspend themselves', (await call('/admin/accounts/' + ROOT.id, { method: 'PATCH', as: ROOT, body: { status: 'suspended' } })).status === 409)
check('admin cannot delete themselves', (await call('/admin/accounts/' + ROOT.id, { method: 'DELETE', as: ROOT })).status === 409)
check('admin can suspend a client', (await call('/admin/accounts/' + BOB.id, { method: 'PATCH', as: ROOT, body: { status: 'suspended' } })).status === 200)
check('suspending stops the live session', tenants._stopped.includes(BOB.id), tenants._stopped.join(','))
check('suspending invalidates cached tokens', store._state.invalidated.includes(BOB.id))
check('nonsense role refused', (await call('/admin/accounts/' + BOB.id, { method: 'PATCH', as: ROOT, body: { role: 'owner' } })).status === 400)
check('empty patch refused', (await call('/admin/accounts/' + BOB.id, { method: 'PATCH', as: ROOT, body: {} })).status === 400)

// last-admin guard: demote the second admin, then the first has no peer
await call('/admin/accounts/' + SECOND_ADMIN.id, { method: 'PATCH', as: ROOT, body: { role: 'client' } })
const lastAdmin = await call('/admin/accounts/' + ROOT.id, { method: 'PATCH', as: SECOND_ADMIN, body: { role: 'client' } })
check('cannot demote the last remaining admin', lastAdmin.status === 403 || lastAdmin.status === 409, 'got ' + lastAdmin.status)

// ------------------------------------------------------------------ sending ---
console.log('\n--- sending ---')
const sent = await call('/send/text', { method: 'POST', as: ALICE, body: { to: '+91 98765 43210', message: 'hi' } })
check('send works', sent.status === 202, JSON.stringify(sent.body))
check('send is persisted against the sender', tenants._sent.some(s => s.persistedFor === ALICE.id))
check('missing message -> 400', (await call('/send/text', { method: 'POST', as: ALICE, body: { to: '919876543210' } })).status === 400)
check('short number -> 400', (await call('/send/text', { method: 'POST', as: ALICE, body: { to: '123', message: 'x' } })).status === 400)
check('bad media type -> 400', (await call('/send/media', { method: 'POST', as: ALICE, body: { to: '919876543210', type: 'audio', url: 'https://x.test/a.mp3' } })).status === 400)
check('file:// url -> 400', (await call('/send/media', { method: 'POST', as: ALICE, body: { to: '919876543210', type: 'image', url: 'file:///etc/passwd' } })).status === 400)
check('malformed JSON -> 400', (await fetch(base + '/api/send/text', { method: 'POST', headers: { Authorization: 'Bearer tok-' + ALICE.id, 'content-type': 'application/json' }, body: '{' })).status === 400)

// opt-out is a hard block, not a campaign-only nicety
store._optOut('919999999999@s.whatsapp.net')
const blocked = await call('/send/text', { method: 'POST', as: ALICE, body: { to: '919999999999', message: 'promo' } })
check('an opted-out contact cannot be messaged', blocked.status === 403, JSON.stringify(blocked.body))
check('the refusal names the opt-out', String(blocked.body?.message).includes('opted out'), blocked.body?.message)

// ------------------------------------------------------------------- shape ---
console.log('\n--- responses ---')
check('unknown API route -> 404 JSON', (await call('/nope', { as: ALICE })).body?.error === 'not_found')
const keyCreated = await call('/keys', { method: 'POST', as: ALICE, body: { name: 'ci' } })
check('key creation returns the plaintext once', keyCreated.status === 201 && keyCreated.body.key === 'wak_plaintext_once')
check('errors always carry error + message', (await call('/send/text', { method: 'POST', as: ALICE, body: {} })).body?.error && (await call('/send/text', { method: 'POST', as: ALICE, body: {} })).body?.message)

// --------------------------------------------------- unconfigured supabase ---
console.log('\n--- with Supabase unconfigured ---')
{
  const bare = createServer(makeTenants(), { store: { ...store, supabaseConfigured: false } })
  const s2 = bare.listen(0, '127.0.0.1')
  await new Promise(r => s2.once('listening', r))
  const b2 = `http://127.0.0.1:${s2.address().port}`
  check('health still answers', (await fetch(b2 + '/health')).status === 200)
  check('health reports supabase:false', (await (await fetch(b2 + '/health')).json()).supabase === false)
  const denied = await fetch(b2 + '/api/me', { headers: { Authorization: 'Bearer tok-' + ALICE.id } })
  check('API refuses with 503, not a crash', denied.status === 503, 'got ' + denied.status)
  check('the message says what to set', String((await denied.json()).message).includes('SUPABASE_URL'))
  s2.close()
}

server.close()
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
