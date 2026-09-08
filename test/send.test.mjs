// The richer message types: what reaches Baileys for each one, what is
// rejected before it gets there, and which of them honour an opt-out.
process.env.LOG_LEVEL = 'silent'
process.env.SEND_DELAY_MS = '0'
process.env.MAX_MEDIA_MB = '2'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
process.env.SUPABASE_SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.testsignature'

const root = new URL('../', import.meta.url)
const { createServer } = await import(new URL('src/server.js', root))

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

const ALICE = {
  id: 'user-alice', email: 'alice@acme.test', full_name: 'Alice', company: 'Acme',
  role: 'client', status: 'active', created_at: '2026-01-01T00:00:00Z'
}

const optedOut = new Set()

const store = {
  supabaseConfigured: true,
  profileForAccessToken: async token => (token === 'tok-alice' ? ALICE : null),
  profileForApiKey: async () => null,
  writeAudit: async () => {},
  admin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: (_col, jid) => ({
            maybeSingle: async () => ({
              data: optedOut.has(jid) ? { opted_out: true, name: 'Blocked' } : null
            })
          })
        })
      })
    })
  }
}

/** Records exactly what each client method was handed. */
const calls = []
const record = name => async (...args) => {
  calls.push({ name, args })
  return { id: 'M-' + name, to: args[0], timestamp: 1 }
}

const client = {
  isConnected: () => true,
  state: 'connected',
  status: () => ({ state: 'connected', connected: true, queued: 0 }),
  sendText: record('sendText'),
  sendMedia: record('sendMedia'),
  sendLocation: record('sendLocation'),
  sendContacts: record('sendContacts'),
  sendPoll: record('sendPoll'),
  sendSticker: record('sendSticker'),
  sendAudio: record('sendAudio'),
  react: record('react'),
  deleteMessage: record('deleteMessage'),
  editMessage: record('editMessage'),
  pinMessage: record('pinMessage'),
  forwardMessage: record('forwardMessage')
}

const persisted = []
const tenants = {
  size: 1,
  ensure: async () => client,
  peek: () => client,
  stop: async () => true,
  stateFor: async () => ({ state: 'connected', connected: true }),
  persistOutbound: async (userId, msg) => persisted.push({ userId, ...msg }),
  liveSummary: () => [],
  restorePreviouslyConnected: async () => ({ restored: 0 }),
  stopAll: async () => {}
}

const app = createServer(tenants, { store })
const server = app.listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const base = `http://127.0.0.1:${server.address().port}`

async function post(path, body) {
  const res = await fetch(base + '/api' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* a non-JSON body is itself the finding */ }
  return { status: res.status, body: parsed, raw: text }
}

const last = name => [...calls].reverse().find(c => c.name === name)
const TO = '919876543210'
const JID = '919876543210@s.whatsapp.net'

// ------------------------------------------------------------------ location ---
{
  const res = await post('/send/location', { to: TO, latitude: 19.076, longitude: 72.8777, name: 'Mumbai' })
  check('location: accepted', res.status === 202, res.raw)
  const arg = last('sendLocation')?.args[1]
  check('location: coordinates passed through as numbers',
    arg?.latitude === 19.076 && arg?.longitude === 72.8777, JSON.stringify(arg))
  check('location: name passed', arg?.name === 'Mumbai')

  check('location: rejects a non-numeric latitude',
    (await post('/send/location', { to: TO, latitude: 'north', longitude: 1 })).status === 400)
  check('location: rejects an out-of-range latitude',
    (await post('/send/location', { to: TO, latitude: 91, longitude: 1 })).status === 400)
  check('location: rejects an out-of-range longitude',
    (await post('/send/location', { to: TO, latitude: 1, longitude: 181 })).status === 400)
}

// ------------------------------------------------------------------- contact ---
{
  const res = await post('/send/contact', { to: TO, name: 'Asha', number: '919000000001', organization: 'Acme' })
  check('contact: accepted', res.status === 202, res.raw)
  const cards = last('sendContacts')?.args[1]?.contacts
  check('contact: one card built', cards?.length === 1)
  check('contact: vcard carries waid so it resolves on the phone',
    cards?.[0]?.vcard.includes('waid=919000000001'), cards?.[0]?.vcard)
  check('contact: vcard has the display name', cards?.[0]?.vcard.includes('FN:Asha'))

  const multi = await post('/send/contact', {
    to: TO,
    contacts: [
      { name: 'Asha', number: '919000000001' },
      { name: 'Bharat', number: '919000000002' }
    ]
  })
  check('contact: multiple cards accepted', multi.status === 202, multi.raw)
  check('contact: both cards built', last('sendContacts')?.args[1]?.contacts.length === 2)
  check('contact: response reports the count', multi.body?.contacts === 2)

  check('contact: rejects an empty list', (await post('/send/contact', { to: TO, contacts: [] })).status === 400)
  check('contact: rejects a card with no number',
    (await post('/send/contact', { to: TO, contacts: [{ name: 'X' }] })).status === 400)
}

// ---------------------------------------------------------------------- poll ---
{
  const res = await post('/send/poll', { to: TO, question: 'Lunch?', options: ['Idli', 'Dosa', 'Vada'] })
  check('poll: accepted', res.status === 202, res.raw)
  const poll = last('sendPoll')?.args[1]
  check('poll: question and options passed', poll?.name === 'Lunch?' && poll?.values.length === 3)
  check('poll: selectableCount defaults to 1', poll?.selectableCount === 1)

  check('poll: rejects fewer than two options',
    (await post('/send/poll', { to: TO, question: 'q', options: ['only'] })).status === 400)
  check('poll: rejects duplicate options',
    (await post('/send/poll', { to: TO, question: 'q', options: ['A', 'A'] })).status === 400)
  check('poll: rejects more than twelve options',
    (await post('/send/poll', { to: TO, question: 'q', options: Array.from({ length: 13 }, (_, i) => 'o' + i) })).status === 400)
  check('poll: rejects selectableCount above the option count',
    (await post('/send/poll', { to: TO, question: 'q', options: ['A', 'B'], selectableCount: 5 })).status === 400)
}

// --------------------------------------------------------------------- media ---
{
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

  const byUrl = await post('/send/media', { to: TO, type: 'image', url: 'https://example.test/a.jpg' })
  check('media: url still works', byUrl.status === 202, byUrl.raw)
  check('media: url becomes a Baileys url source',
    last('sendMedia')?.args[1]?.image?.url === 'https://example.test/a.jpg')

  const byBase64 = await post('/send/media', { to: TO, type: 'image', base64: png })
  check('media: base64 accepted', byBase64.status === 202, byBase64.raw)
  check('media: base64 becomes a Buffer', Buffer.isBuffer(last('sendMedia')?.args[1]?.image))

  const byDataUri = await post('/send/media', { to: TO, type: 'image', url: 'data:image/png;base64,' + png })
  check('media: data URI accepted', byDataUri.status === 202, byDataUri.raw)
  check('media: data URI becomes a Buffer', Buffer.isBuffer(last('sendMedia')?.args[1]?.image))

  const gif = await post('/send/media', { to: TO, type: 'video', url: 'https://example.test/a.mp4', isGif: true })
  check('media: gif accepted', gif.status === 202, gif.raw)
  check('media: gif sets gifPlayback rather than a gif mimetype',
    last('sendMedia')?.args[1]?.gifPlayback === true)

  const doc = await post('/send/media', { to: TO, type: 'document', base64: png, fileName: 'report.pdf' })
  check('media: document gets a custom file name', last('sendMedia')?.args[1]?.fileName === 'report.pdf', doc.raw)
  check('media: document always carries a mimetype',
    typeof last('sendMedia')?.args[1]?.mimetype === 'string')

  check('media: rejects file:// urls',
    (await post('/send/media', { to: TO, type: 'image', url: 'file:///etc/passwd' })).status === 400)
  check('media: rejects a body with neither url nor base64',
    (await post('/send/media', { to: TO, type: 'image' })).status === 400)
  check('media: rejects an unknown type',
    (await post('/send/media', { to: TO, type: 'hologram', url: 'https://example.test/a.jpg' })).status === 400)

  // MAX_MEDIA_MB is 2 in this suite, so 3 MB of bytes must be refused.
  const tooBig = await post('/send/media', { to: TO, type: 'image', base64: 'A'.repeat(4 * 1024 * 1024) })
  check('media: rejects base64 over the size cap', tooBig.status === 400, `status ${tooBig.status}`)
}

// -------------------------------------------------------------------- sticker ---
{
  const res = await post('/send/sticker', { to: TO, url: 'https://example.test/s.webp' })
  check('sticker: accepted', res.status === 202, res.raw)
  check('sticker: source passed', Boolean(last('sendSticker')?.args[1]?.source))
  check('sticker: animated flag passed',
    (await post('/send/sticker', { to: TO, url: 'https://example.test/s.webp', animated: true })).status === 202 &&
      last('sendSticker')?.args[1]?.animated === true)
}

// ---------------------------------------------------------------------- audio ---
{
  const res = await post('/send/audio', { to: TO, url: 'https://example.test/a.mp3' })
  check('audio: accepted', res.status === 202, res.raw)
  check('audio: not a voice note by default', last('sendAudio')?.args[1]?.voiceNote === false)

  await post('/send/audio', { to: TO, url: 'https://example.test/a.ogg', voiceNote: true, seconds: 12 })
  check('audio: voiceNote and seconds passed',
    last('sendAudio')?.args[1]?.voiceNote === true && last('sendAudio')?.args[1]?.seconds === 12)
  check('audio: rejects a non-integer duration',
    (await post('/send/audio', { to: TO, url: 'https://example.test/a.ogg', seconds: 1.5 })).status === 400)
}

// ------------------------------------------------------ options on every send ---
{
  await post('/send/text', { to: TO, message: 'hi', replyTo: 'ABC123', viewOnce: true, mentions: ['919000000009'] })
  const opts = last('sendText')?.args[2]
  check('options: replyTo passed through', opts?.replyTo === 'ABC123')
  check('options: viewOnce passed through', opts?.viewOnce === true)
  check('options: mentions normalised to JIDs',
    opts?.mentions?.[0] === '919000000009@s.whatsapp.net', JSON.stringify(opts?.mentions))

  await post('/send/text', { to: TO, message: 'no preview', linkPreview: false })
  check('options: linkPreview:false passed through', last('sendText')?.args[2]?.linkPreview === false)

  check('options: rejects mentions that are not an array',
    (await post('/send/text', { to: TO, message: 'x', mentions: 'nope' })).status === 400)
}

// ------------------------------------------------------- message operations ---
{
  const react = await post('/messages/3EB0ABC/react', { to: TO, emoji: '👍' })
  check('react: accepted', react.status === 202, react.raw)
  check('react: message id and emoji passed',
    last('react')?.args[1]?.messageId === '3EB0ABC' && last('react')?.args[1]?.emoji === '👍')
  check('react: empty emoji allowed, it removes the reaction',
    (await post('/messages/3EB0ABC/react', { to: TO, emoji: '' })).status === 202)
  check('react: rejects two emoji',
    (await post('/messages/3EB0ABC/react', { to: TO, emoji: '👍👎' })).status === 400)

  check('delete: accepted', (await post('/messages/3EB0ABC/delete', { to: TO })).status === 202)
  check('delete: defaults to your own message', last('deleteMessage')?.args[1]?.fromMe === true)

  const edit = await post('/messages/3EB0ABC/edit', { to: TO, message: 'fixed' })
  check('edit: accepted', edit.status === 202, edit.raw)
  check('edit: new text passed', last('editMessage')?.args[1]?.text === 'fixed')
  check('edit: rejects an empty message', (await post('/messages/3EB0ABC/edit', { to: TO, message: '  ' })).status === 400)

  check('pin: accepted', (await post('/messages/3EB0ABC/pin', { to: TO })).status === 202)
  check('pin: defaults to 7 days', last('pinMessage')?.args[1]?.seconds === 604800)
  check('pin: unpin flag passed',
    (await post('/messages/3EB0ABC/pin', { to: TO, unpin: true })).status === 202 &&
      last('pinMessage')?.args[1]?.unpin === true)
  check('pin: rejects a duration WhatsApp does not accept',
    (await post('/messages/3EB0ABC/pin', { to: TO, seconds: 3600 })).status === 400)

  check('forward: accepted', (await post('/messages/3EB0ABC/forward', { to: TO })).status === 202)
  check('forward: source message id passed', last('forwardMessage')?.args[1]?.messageId === '3EB0ABC')
}

// -------------------------------------------------------------- opt-out gate ---
{
  optedOut.add(JID)
  const blocked = ['/send/text', '/send/location', '/send/contact', '/send/poll', '/send/sticker', '/send/audio']
  const bodies = {
    '/send/text': { to: TO, message: 'hi' },
    '/send/location': { to: TO, latitude: 1, longitude: 2 },
    '/send/contact': { to: TO, name: 'A', number: '919000000001' },
    '/send/poll': { to: TO, question: 'q', options: ['A', 'B'] },
    '/send/sticker': { to: TO, url: 'https://example.test/s.webp' },
    '/send/audio': { to: TO, url: 'https://example.test/a.mp3' }
  }
  for (const path of blocked) {
    const res = await post(path, bodies[path])
    check(`opt-out: ${path} refused with 403`, res.status === 403, `got ${res.status}`)
  }
  const fwd = await post('/messages/3EB0ABC/forward', { to: TO })
  check('opt-out: forward refused too', fwd.status === 403, `got ${fwd.status}`)

  // Deleting your own message in that chat is not outreach, so it stays allowed.
  const del = await post('/messages/3EB0ABC/delete', { to: TO })
  check('opt-out: delete still allowed, it is not outreach', del.status === 202, `got ${del.status}`)
  optedOut.delete(JID)
}

// ------------------------------------------------------------- body limits ---
{
  // A body-parser failure used to fall through to the 500 handler, reporting
  // "Something went wrong" for what is plainly a client mistake.
  const huge = await post('/send/text', { to: TO, message: 'x'.repeat(300 * 1024) })
  check('body limit: oversized text is 413, not 500', huge.status === 413, `got ${huge.status}`)
  check('body limit: 413 carries a machine-readable code',
    huge.body?.error === 'payload_too_large', JSON.stringify(huge.body))
  check('body limit: 413 names the limit', typeof huge.body?.details?.limitBytes === 'number')

  // MAX_MEDIA_MB is 2 here, so the media routes accept a 300 KB body the text
  // route rejects -- proving the two limits really are separate.
  const mediaOk = await post('/send/media', {
    to: TO, type: 'image', url: 'https://example.test/a.jpg', caption: 'y'.repeat(300 * 1024)
  })
  check('body limit: media route accepts what the text route rejected',
    mediaOk.status !== 413, `got ${mediaOk.status}`)

  const malformed = await fetch(base + '/api/send/text', {
    method: 'POST',
    headers: { authorization: 'Bearer tok-alice', 'content-type': 'application/json' },
    body: '{not json'
  })
  check('body limit: malformed JSON is still 400', malformed.status === 400, `got ${malformed.status}`)
}

// ----------------------------------------------------------------- isolation ---
{
  await post('/send/poll', { to: TO, question: 'scoped?', options: ['A', 'B'] })
  const mine = persisted.filter(p => p.userId === ALICE.id)
  check('every send is recorded against the caller', mine.length === persisted.length && mine.length > 0)
  check('unauthenticated sends are refused',
    (await fetch(base + '/api/send/poll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: TO, question: 'q', options: ['A', 'B'] })
    })).status === 401)
}

server.close()
console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
