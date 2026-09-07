// Unit checks for webhook retry behaviour and incoming-message extraction.
process.env.API_KEY = 'test-api-key-0123456789'
process.env.LOG_LEVEL = 'silent'

import http from 'node:http'

const root = new URL('../', import.meta.url)
const { createWebhookSender } = await import(new URL('src/webhook.js', root))
const { buildWebhookPayload, shouldForward, getMessageType, getMessageText, unwrapMessage } =
  await import(new URL('src/messages.js', root))

let failures = 0
const expect = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`, ok ? '' : `\n        got ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`)
}

const silent = { debug() {}, info() {}, warn() {}, error() {} }

// ---------------------------------------------------------------- webhook
function startReceiver(handler) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
      received.push({ body: JSON.parse(body || '{}'), secret: req.headers['x-webhook-secret'] })
      handler(received.length, res)
    })
  })
  return new Promise(resolve => {
    server.listen(0, () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/hook` }))
  })
}

console.log('--- webhook ---')
{
  // Fails twice with 500, then succeeds: should deliver on attempt 3.
  const { server, received, url } = await startReceiver((n, res) => {
    res.writeHead(n < 3 ? 500 : 200).end()
  })
  const sender = createWebhookSender({ url, secret: 's3cret', timeoutMs: 2000, maxAttempts: 3, logger: silent })
  expect('retries 5xx and succeeds on attempt 3', await sender.deliver({ hi: 1 }), true)
  expect('receiver saw 3 attempts', received.length, 3)
  expect('secret header forwarded', received[0].secret, 's3cret')
  server.close()
}
{
  // Always 500: gives up after maxAttempts and resolves false (never throws).
  const { server, received, url } = await startReceiver((_n, res) => res.writeHead(503).end())
  const sender = createWebhookSender({ url, secret: '', timeoutMs: 2000, maxAttempts: 3, logger: silent })
  expect('gives up after maxAttempts', await sender.deliver({ hi: 2 }), false)
  expect('exactly maxAttempts attempts', received.length, 3)
  server.close()
}
{
  // 400 is our fault: no point retrying.
  const { server, received, url } = await startReceiver((_n, res) => res.writeHead(400).end())
  const sender = createWebhookSender({ url, secret: '', timeoutMs: 2000, maxAttempts: 3, logger: silent })
  expect('does not retry a 4xx', await sender.deliver({ hi: 3 }), false)
  expect('only one attempt for 4xx', received.length, 1)
  server.close()
}
{
  // Nothing listening at all: must resolve false rather than reject.
  const sender = createWebhookSender({ url: 'http://127.0.0.1:1/hook', secret: '', timeoutMs: 500, maxAttempts: 2, logger: silent })
  expect('connection refused resolves false', await sender.deliver({ hi: 4 }), false)
}
{
  const sender = createWebhookSender({ url: '', secret: '', timeoutMs: 500, maxAttempts: 2, logger: silent })
  expect('disabled sender reports enabled=false', sender.enabled, false)
  expect('disabled sender is a no-op', await sender.deliver({ hi: 5 }), false)
}

// ------------------------------------------------------------- extraction
console.log('\n--- incoming messages ---')
const msg = (over = {}) => ({
  key: { remoteJid: '919876543210@s.whatsapp.net', fromMe: false, id: 'AAA', ...(over.key ?? {}) },
  pushName: 'Asha',
  messageTimestamp: 1757260800,
  message: { conversation: 'hello there' },
  ...over
})

expect('forwards a normal 1:1 text', shouldForward(msg()), true)
expect('skips own messages', shouldForward(msg({ key: { fromMe: true } })), false)
expect('skips status broadcasts', shouldForward(msg({ key: { remoteJid: 'status@broadcast' } })), false)
expect('skips other broadcasts', shouldForward(msg({ key: { remoteJid: '12345@broadcast' } })), false)
expect('skips protocol-only stanzas', shouldForward(msg({ message: null })), false)
expect('skips a message with no key', shouldForward({}), false)

expect('type of a plain text', getMessageType({ conversation: 'x' }), 'conversation')
expect('type ignores messageContextInfo', getMessageType({ messageContextInfo: {}, imageMessage: { caption: 'c' } }), 'imageMessage')
expect('type of an empty content', getMessageType({}), 'unknown')
expect('text of an extendedTextMessage', getMessageText({ extendedTextMessage: { text: 'link msg' } }), 'link msg')
expect('text falls back to an image caption', getMessageText({ imageMessage: { caption: 'a cap' } }), 'a cap')
expect('text is null when there is none', getMessageText({ stickerMessage: {} }), null)
expect('unwraps ephemeral wrappers', getMessageType(unwrapMessage({ ephemeralMessage: { message: { videoMessage: { caption: 'v' } } } })), 'videoMessage')
expect('unwraps view-once v2', getMessageText(unwrapMessage({ viewOnceMessageV2: { message: { imageMessage: { caption: 'once' } } } })), 'once')

const direct = buildWebhookPayload(msg(), { sessionName: 'test' })
expect('1:1 payload', direct, {
  session: 'test',
  id: 'AAA',
  from: '919876543210@s.whatsapp.net',
  fromNumber: '919876543210',
  isGroup: false,
  groupJid: null,
  participant: '919876543210@s.whatsapp.net',
  participantNumber: '919876543210',
  pushName: 'Asha',
  timestamp: 1757260800,
  type: 'conversation',
  text: 'hello there',
  receivedAt: direct.receivedAt
})

const group = buildWebhookPayload(
  msg({
    key: { remoteJid: '1234567890-1111@g.us', participant: '919999999999@s.whatsapp.net' },
    message: { imageMessage: { caption: 'look' } }
  }),
  { sessionName: 'test' }
)
expect('group payload marks isGroup and the real sender', {
  from: group.from,
  isGroup: group.isGroup,
  groupJid: group.groupJid,
  participant: group.participant,
  participantNumber: group.participantNumber,
  fromNumber: group.fromNumber,
  type: group.type,
  text: group.text
}, {
  from: '1234567890-1111@g.us',
  isGroup: true,
  groupJid: '1234567890-1111@g.us',
  participant: '919999999999@s.whatsapp.net',
  participantNumber: '919999999999',
  fromNumber: null,
  type: 'imageMessage',
  text: 'look'
})

// A protobuf Long, as Baileys actually delivers timestamps.
const longish = buildWebhookPayload(msg({ messageTimestamp: { low: 1757260800, high: 0, unsigned: true } }), {})
expect('handles a Long timestamp', longish.timestamp, 1757260800)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
