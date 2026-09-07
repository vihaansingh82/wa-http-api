# wa-http-api

A small self-hosted HTTP API in front of a personal WhatsApp account, built on
[Baileys](https://github.com/WhiskeySockets/Baileys) **v7** and Express 5.
Pair once by scanning a QR, then send and receive messages over plain HTTP.

- Node.js 20+, ES modules, no build step
- Session persisted to disk via `useMultiFileAuthState`
- Auto-reconnect with exponential backoff, and a fresh QR when the device is unlinked
- One global outgoing throttle (`SEND_DELAY_MS`) to reduce ban risk
- Incoming messages forwarded to your own webhook, with retries
- Browser console that links by QR and issues its own API token, no manual setup

> **Heads-up:** this drives WhatsApp Web as an unofficial client. Sending bulk or
> unsolicited messages from a personal number is a good way to get it banned.
> For anything commercial, use the official WhatsApp Business Cloud API instead.

---

## Baileys v7 notes

v7 changed a few things that most tutorials still get wrong, so if you are
adapting older code:

| Older pattern | v7 |
| --- | --- |
| `@whiskeysockets/baileys` | package is now **`baileys`** |
| CommonJS `require()` | package is **ESM-only** (`"type": "module"`) |
| `printQRInTerminal: true` | **removed** — read `qr` off `connection.update` and render it yourself |
| `@adiwajshing/keyed-db`, `makeInMemoryStore` | gone; keep your own state |
| `node-cache` | Baileys ships `@cacheable/node-cache` |
| Node 16/18 | **Node 20+** is enforced by a preinstall check |

This project reads the QR from `connection.update`, prints it with
`qrcode-terminal`, and renders the same string to a PNG data URL for `GET /qr`.

---

## Setup

```bash
git clone <your-repo> wa-http-api && cd wa-http-api
npm install

cp .env.example .env
# Generate an API key and paste it into .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm start
```

Now open <http://localhost:3000> and click **Link WhatsApp**. Scan the code with
your phone and you are done — the console mints its own API token as soon as the
phone connects.

A QR is also printed to the terminal if you would rather scan it there. Either
way, once `connection state changed: open` appears in the log you are linked.
The session lives in `AUTH_DIR` (`./auth` by default) and is reused on restart,
so this is a one-time step.

### The web console

Open the server root in a browser and you get a control panel that works the way
WhatsApp Web does — click, scan, done:

```
http://localhost:3000
```

1. Click **Link WhatsApp**. A QR appears and refreshes itself as WhatsApp
   rotates it.
2. Scan it from your phone (Settings → Linked devices → Link a device).
3. The moment it connects, the server **mints an API token for you** and the
   console signs itself in with it. Nothing to copy, nothing to paste.

The token is also DMed to your own WhatsApp chat, so it lands on the phone as
well — turn that off with `SEND_TOKEN_TO_PHONE=false` if you would rather no
credential ever touched a chat log.

After that the panel has two tabs:

- **Console** — live status, send text, send media, number lookup, unlink.
- **API docs** — the whole reference, in the page: every endpoint with its
  request body, a copy-ready curl example **with your own token already filled
  in**, and a sample response. Plus recipient formats, the webhook payload,
  rate-limiting behaviour, and the error table. A *mask my token* checkbox
  swaps in a placeholder when you want to screenshot it.

It is plain static HTML served by the API itself, so it talks to the same
origin — no CORS, no proxy, no build step. The HTML is sent with
`Cache-Control: no-cache` so an updated server never leaves you on a stale page.

## Authentication

There are two kinds of credential, both presented as `x-api-key` (or
`Authorization: Bearer …`):

| | **Admin key** | **Device token** |
| --- | --- | --- |
| Where it comes from | `API_KEY` in `.env` | minted when a phone completes pairing |
| Looks like | whatever you set | `wa_…` |
| Stored | your `.env` | **hashed** (SHA-256) in `TOKEN_STORE` |
| Survives `POST /logout` | yes | no — revoked |
| Good for | scripts, cron, curl | the console, per-browser access |

**Why pairing is allowed to mint a credential.** The QR is the authentication:
whoever scans it is holding the phone that owns the account. That is the same
argument WhatsApp Web makes. So `POST /pair/start` needs no prior secret — but
**only from loopback**, on the assumption that being at the machine is itself
meaningful. From any other address it returns `401` unless you send the admin
key, or set `ALLOW_REMOTE_PAIRING=true` because you have put your own
authentication in front of the server.

Tokens are stored only as a SHA-256 hash, so a leaked `tokens.json` cannot be
replayed against the API, and the plaintext genuinely cannot be shown twice.

If you expose this beyond localhost, put it behind TLS and your own access
control. A credential is the only thing standing between the internet and your
WhatsApp account.

### Configuration

Every setting is an environment variable; see [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `API_KEY` | *(required)* | Admin key, min 16 chars. Never expires, survives logout |
| `AUTH_DIR` | `./auth` | Where the session is stored |
| `SESSION_NAME` | `wa-http-api` | Label included in webhook payloads |
| `TOKEN_STORE` | `./data/tokens.json` | Where hashed device tokens live |
| `SEND_TOKEN_TO_PHONE` | `true` | Also DM a new token to your own WhatsApp chat |
| `PAIR_CLAIM_TTL_MS` | `600000` | How long a pairing attempt stays claimable |
| `ALLOW_REMOTE_PAIRING` | `false` | Let non-loopback callers start a pairing |
| `VERIFY_RECIPIENT` | `true` | Resolve each recipient via onWhatsApp before sending |
| `SEND_DELAY_MS` | `3000` | Minimum gap between two outgoing sends |
| `MAX_QUEUE_SIZE` | `500` | Queue depth before sends are rejected with 503 |
| `WEBHOOK_URL` | *(empty)* | Where incoming messages are POSTed; empty disables forwarding |
| `WEBHOOK_SECRET` | *(empty)* | Sent as `x-webhook-secret` so your receiver can verify the caller |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt webhook timeout |
| `WEBHOOK_MAX_ATTEMPTS` | `3` | Webhook attempts before giving up |
| `LOG_LEVEL` | `info` | pino level |
| `LOG_PRETTY` | `false` | Human-readable logs (leave off in Docker) |

**`AUTH_DIR` is a credential.** Anyone with a copy of that folder can send
messages as you. Do not commit it (it is in `.gitignore`) and do not bake it
into an image. `TOKEN_STORE` holds only hashes, so it is not replayable, but it
is gitignored too.

---

## Endpoints

Most routes need a credential in `x-api-key` (the admin key or a device
token). The console, `/health` and the pairing routes are the exceptions noted
in the table.
Errors are always JSON: `{ "error": "<code>", "message": "...", "details": {...} }`.

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | public | Browser console (static HTML, no secrets) |
| GET | `/health` | public | Liveness + connection flag |
| POST | `/pair/start` | loopback | Begin a pairing, returns a claim id |
| GET | `/pair/status/:claimId` | loopback | Poll a pairing: QR, then the minted token |
| POST | `/pair/token` | loopback | Mint a token when already linked (new browser) |
| GET | `/status` | credential | Diagnostics: linked user, queue depth, tokens, last disconnect |
| GET | `/qr` | credential | Current pairing QR as a PNG data URL |
| POST | `/send/text` | credential | Send a text message |
| POST | `/send/media` | credential | Send an image, video or document by URL |
| GET | `/check/:number` | credential | Is this number registered on WhatsApp? |
| POST | `/tokens/revoke` | credential | Revoke every device token (admin key keeps working) |
| POST | `/logout` | credential | Unlink the phone, wipe the session, revoke all tokens |

"loopback" means no credential is needed from `127.0.0.1`; from anywhere else
the admin key is required. See [Authentication](#authentication).

Set a shell variable first so the examples stay short:

```bash
export KEY="paste-your-API_KEY-here"
export API="http://localhost:3000"
```

### GET /health

No API key needed — point your load balancer or Docker healthcheck here.

```bash
curl -s $API/health
```

```json
{ "status": "ok", "connected": true, "connection": "open", "queued": 0, "uptimeSeconds": 412 }
```

### Pairing from the command line

The console does this for you, but the same three calls work from a shell —
which is also how you would drive pairing from your own front end.

```bash
# 1. open a claim (no credential needed from this machine)
CLAIM=$(curl -s -X POST $API/pair/start | jq -r .claimId)

# 2. poll: while unpaired this returns the QR as a data URL
curl -s $API/pair/status/$CLAIM
# {"state":"awaiting_scan","qr":"data:image/png;base64,iVBOR..."}

# 3. after you scan, the same poll returns the token, exactly once
curl -s $API/pair/status/$CLAIM
# {"state":"paired","user":{...},"token":"wa_Xa9..."}
```

- `state` is one of `awaiting_scan`, `paired`, `expired`.
- `token` appears on the **first** poll after pairing; later polls return
  `"tokenAlreadyCollected": true` instead. Store it when you see it.
- A claim expires after `PAIR_CLAIM_TTL_MS` (default 10 minutes).

Already linked and just need a token for another browser or script:

```bash
curl -s -X POST $API/pair/token
# {"id":"a1b2c3d4e5f6","token":"wa_...","user":{...}}
```

### GET /status

```bash
curl -s -H "x-api-key: $KEY" $API/status
```

```json
{
  "session": "wa-http-api",
  "connection": "open",
  "connected": true,
  "user": { "id": "919876543210:12@s.whatsapp.net", "name": "Asha" },
  "hasQr": false,
  "queued": 0,
  "webhookConfigured": true,
  "lastDisconnect": null
}
```

### GET /qr

```bash
curl -s -H "x-api-key: $KEY" $API/qr
```

```json
{
  "qr": "2@zX9...",
  "dataUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
  "generatedAt": "2026-09-07T11:25:21.816Z"
}
```

- `409 conflict` — already paired. `POST /logout` first if you want a new QR.
- `503 service_unavailable` — no QR yet, retry in a few seconds.

Save it straight to a file and open it:

```bash
curl -s -H "x-api-key: $KEY" $API/qr \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const{dataUrl}=JSON.parse(s);require('fs').writeFileSync('qr.png',Buffer.from(dataUrl.split(',')[1],'base64'))})"
```

### POST /send/text

Body: `{ "to": string, "message": string }`

```bash
curl -s -X POST $API/send/text \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"to": "+91 98765 43210", "message": "Hello from the API"}'
```

```json
{
  "sent": true,
  "isGroup": false,
  "id": "3EB0C767D82B0F3A2B1C",
  "to": "919876543210@s.whatsapp.net",
  "timestamp": 1757248521
}
```

`202 Accepted` means the message left this process; delivery to the handset is
asynchronous. To a group, pass the group JID:

```bash
curl -s -X POST $API/send/text \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"to": "120363021234567890@g.us", "message": "Standup in 5"}'
```

### POST /send/media

Body: `{ "to": string, "url": string, "type": "image" | "video" | "document", "caption"?: string, "mimetype"?: string, "fileName"?: string }`

The URL must be `http`/`https` and reachable from the server — WhatsApp never
sees it, Baileys downloads and re-uploads the bytes.

```bash
# image with a caption
curl -s -X POST $API/send/media \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"to": "919876543210", "type": "image", "url": "https://picsum.photos/600/400.jpg", "caption": "Site photo"}'

# video
curl -s -X POST $API/send/media \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"to": "919876543210", "type": "video", "url": "https://example.com/clip.mp4", "caption": "Walkthrough"}'

# document -- mimetype and fileName are derived from the URL when omitted
curl -s -X POST $API/send/media \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -d '{"to": "919876543210", "type": "document", "url": "https://example.com/invoice-4471.pdf", "fileName": "Invoice 4471.pdf"}'
```

```json
{
  "sent": true,
  "type": "document",
  "isGroup": false,
  "id": "3EB0C7A11F9E4D2C88",
  "to": "919876543210@s.whatsapp.net",
  "timestamp": 1757248644
}
```

### GET /check/:number

Asks WhatsApp whether a number is registered (`onWhatsApp`). Note that a `+`
inside a URL path must be percent-encoded as `%2B`, so it is easier to leave it out:

```bash
curl -s -H "x-api-key: $KEY" $API/check/919876543210
```

```json
{ "number": "919876543210", "exists": true, "jid": "919876543210@s.whatsapp.net" }
```

```bash
# a number that is not on WhatsApp
curl -s -H "x-api-key: $KEY" $API/check/12025550123
# {"number":"12025550123","exists":false,"jid":null}
```

### POST /logout

Unlinks this device on the phone, deletes `AUTH_DIR`, and immediately starts a
new pairing so a fresh QR shows up at `GET /qr`.

```bash
curl -s -X POST -H "x-api-key: $KEY" $API/logout
```

```json
{ "loggedOut": true, "revokedTokens": 2, "message": "Session cleared and device tokens revoked. Link again from the console at /." }
```

---

## Number handling

`to` accepts loose input and is normalised to a JID internally:

| Input | Becomes |
| --- | --- |
| `+91 98765 43210` | `919876543210@s.whatsapp.net` |
| `(91) 98765-43210` | `919876543210@s.whatsapp.net` |
| `0091 98765 43210` | `919876543210@s.whatsapp.net` |
| `919876543210@c.us` | `919876543210@s.whatsapp.net` |
| `919876543210:12@s.whatsapp.net` | `919876543210@s.whatsapp.net` |
| `120363021234567890@g.us` | passed through unchanged |

Rules: non-digits are stripped, a leading `00` international prefix is dropped,
and the result must be 7–15 digits. Group JIDs (`@g.us`) are opaque and never
rewritten. `@broadcast` and `status@broadcast` are rejected.

### Recipients are resolved, not guessed

Before every send the recipient goes through `onWhatsApp`, and the JID it
returns is the one actually used. This matters more than it sounds.

Gluing `@s.whatsapp.net` onto whatever digits you typed produces a
**syntactically valid JID that belongs to nobody** when the country code is
missing. WhatsApp accepts that stanza and silently discards it — so the API
answers `202 sent` and the message never arrives. That is the worst kind of
failure, because nothing looks wrong at either end.

So `8285861066` is resolved to `918285861066@s.whatsapp.net` (WhatsApp applies
the linked account's own country), and the response says so:

```json
{
  "sent": true,
  "to": "918285861066@s.whatsapp.net",
  "requested": "8285861066@s.whatsapp.net",
  "resolved": true
}
```

A number that genuinely is not on WhatsApp gets `404 recipient_not_found` with
a message suggesting the country code, rather than a false success. Resolutions
are cached, so repeat sends to the same recipient skip the lookup.

Set `VERIFY_RECIPIENT=false` to skip it and send blind — only sensible if you
already hold exact JIDs.

---

## Incoming messages

When `WEBHOOK_URL` is set, every new inbound message is POSTed there as JSON.
Messages you sent yourself (`key.fromMe`) and status broadcasts are ignored,
and only `notify`-type upserts are forwarded — not history sync.

```json
{
  "session": "wa-http-api",
  "id": "3A9F2C1B77E4",
  "from": "120363021234567890@g.us",
  "fromNumber": null,
  "isGroup": true,
  "groupJid": "120363021234567890@g.us",
  "participant": "919999999999@s.whatsapp.net",
  "participantNumber": "919999999999",
  "pushName": "Asha",
  "timestamp": 1757260800,
  "type": "imageMessage",
  "text": "look at this",
  "receivedAt": "2026-09-07T12:00:00.000Z"
}
```

- `from` is the chat. In a group, `participant` is the person who actually sent it; in a 1:1 chat the two match.
- `type` is the Baileys message key (`conversation`, `extendedTextMessage`, `imageMessage`, `audioMessage`, `documentMessage`, …). Ephemeral and view-once wrappers are unwrapped first.
- `text` is the body or caption, or `null` for messages that have no text.
- `WEBHOOK_SECRET`, if set, arrives as the `x-webhook-secret` header — check it before trusting the payload.

Delivery is retried up to `WEBHOOK_MAX_ATTEMPTS` times with 500ms/1s/2s backoff.
`4xx` responses other than `408`/`429` are treated as permanent and not retried.
A failing webhook is logged and dropped — it never crashes the bridge and never
blocks the WhatsApp event stream.

Quick receiver to watch what arrives:

```bash
node -e "require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d).on('end',()=>{console.log(b);s.writeHead(200).end('ok')})}).listen(4000)"
# then set WEBHOOK_URL=http://localhost:4000/hook and restart
```

---

## Rate limiting

All outgoing sends pass through one serial FIFO queue that guarantees at least
`SEND_DELAY_MS` (default 3000) between two sends. A burst of API calls therefore
drains at a steady pace rather than firing at once, which is the behaviour that
gets numbers flagged.

Consequences worth knowing:

- `202` means *queued and handed to WhatsApp*, not *delivered*.
- With the default delay, 20 queued messages take about a minute to drain.
- Once `MAX_QUEUE_SIZE` messages are waiting, further sends fail fast with
  `503 service_unavailable` instead of growing memory without bound. Check
  `queued` in `GET /status` if you are pushing volume.

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for the full guide. The short version: this is a
stateful, always-on service, so it needs a persistent disk for the session, a
single instance, and no scale-to-zero. That rules out Vercel, Netlify, Workers
and Lambda outright, and most free tiers.

Two git-based paths are pre-configured:

- **Fly.io** — [fly.toml](fly.toml) with a volume at `/data`, one always-on
  machine, and a `/health` check. Push-to-deploy via
  [.github/workflows/deploy.yml](.github/workflows/deploy.yml).
- **Render** — [render.yaml](render.yaml) Blueprint: New > Blueprint, point it
  at the repo. Attaches a 1 GB disk and generates `API_KEY` for you.

Or run it on any VPS with [docker-compose.yml](docker-compose.yml).

One deployment wrinkle worth knowing: pairing is credential-free only from
loopback, so on a deployed instance you paste the admin key into the console
once, then link by QR. [DEPLOY.md](DEPLOY.md#linking-your-phone-after-deploying)
walks through it.

---

## Docker

```bash
docker build -t wa-http-api .

docker run -d --name wa \
  -p 3000:3000 \
  --env-file .env \
  -e AUTH_DIR=/app/auth \
  -v wa-auth:/app/auth \
  --init \
  wa-http-api

# scan the QR from the container log
docker logs -f wa
```

Or with Compose (`docker compose up -d`), which wires the same volume and
`--init` for you — see [docker-compose.yml](docker-compose.yml).

The `wa-auth` volume is what keeps you paired across rebuilds. Delete it and
you have to scan a new QR.

---

## Behaviour on disconnect

| Situation | What happens |
| --- | --- |
| Network blip, `connectionClosed`, `connectionLost`, `timedOut` | Reconnect with exponential backoff (1s → 60s, jittered), reset on success |
| `restartRequired` (515, normal right after pairing) | Immediate reconnect, no backoff |
| `loggedOut` (401) or `forbidden` (403) | **No** reconnect loop: `AUTH_DIR` is wiped and a fresh QR is issued |
| Process receives `SIGTERM`/`SIGINT` | HTTP server drains, queued sends are rejected, socket closes |

`unhandledRejection` and `uncaughtException` are both trapped and logged, so a
dropped socket or a dead webhook receiver cannot take the process down.

---

## Project layout

```
index.js              boot, signal handling, process-level error traps
src/config.js         env parsing and validation (fails fast at startup)
src/logger.js         pino logger + the child logger handed to Baileys
src/whatsapp.js       socket lifecycle, QR, reconnect, send/check/logout
src/server.js         Express app, auth middleware, routes, error handler
src/jid.js            loose number -> JID normalisation
src/validate.js       body validation and media content building
src/queue.js          serial send queue with a minimum delay
src/webhook.js        webhook delivery with bounded retries
src/messages.js       inbound filtering and payload extraction
src/errors.js         ApiError -> HTTP status mapping
test/                 five suites, run with npm test
src/tokens.js         device tokens, hashed at rest, atomic serialised writes
src/pairing.js        the Link WhatsApp claim flow
public/index.html     the browser console (no build step, no secrets)
```

## Tests

```bash
npm test
```

124 checks across five suites, no test framework and no network access
required — everything runs against a stubbed Baileys client and local HTTP
servers:

| Suite | Covers |
| --- | --- |
| `test/http.test.mjs` | Every route: auth, validation rejections, status codes, error shape |
| `test/messages.test.mjs` | Webhook retry/backoff behaviour, inbound filtering, payload extraction |
| `test/pairing.test.mjs` | The link flow end to end: claim, QR, one-time token, revocation |
| `test/tokens.test.mjs` | Token store under concurrency, hashing at rest, the loopback pairing gate |
| `test/page.test.mjs` | Console page: script parses, every element id resolves, docs match the routes |

Two of those are worth calling out: `page.test.mjs` fails if an endpoint exists
in `server.js` but not in the in-page docs (or vice versa), so the reference
cannot drift; and `tokens.test.mjs` fires 25 concurrent mints against a racing
revoke, which is how the token-store write race was found.

---

## Status codes

| Code | Meaning |
| --- | --- |
| `200` / `202` | OK / send queued |
| `400 bad_request` | Malformed JSON, missing field, bad number or URL |
| `401 unauthorized` | Missing or wrong `x-api-key` |
| `404 not_found` | No such route |
| `404 recipient_not_found` | Recipient not reachable on WhatsApp, often a missing country code |
| `409 conflict` | `GET /qr` or `POST /pair/start` while already linked |
| `502 upstream_error` | WhatsApp did not acknowledge the message |
| `503 service_unavailable` | Not connected, no QR yet, or send queue full |
| `500 internal_error` | Anything unexpected (details are logged, not returned) |

## License

MIT
