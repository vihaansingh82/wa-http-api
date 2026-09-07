# wa-http-api

A small self-hosted HTTP API in front of a personal WhatsApp account, built on
[Baileys](https://github.com/WhiskeySockets/Baileys) **v7** and Express 5.
Pair once by scanning a QR, then send and receive messages over plain HTTP.

- Node.js 20+, ES modules, no build step
- Session persisted to disk via `useMultiFileAuthState`
- Auto-reconnect with exponential backoff, and a fresh QR when the device is unlinked
- One global outgoing throttle (`SEND_DELAY_MS`) to reduce ban risk
- Incoming messages forwarded to your own webhook, with retries

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

A QR code appears in the terminal. On your phone open
**WhatsApp → Settings → Linked devices → Link a device** and scan it — or open
<http://localhost:3000> and scan it from the browser console described below.

Once `connection state changed: open` shows up in the log, you are paired. The
credentials live in `AUTH_DIR` (`./auth` by default) and are reused on restart.

### The web console

Opening the server root in a browser gives you a single-page control panel for
everything the API does — pairing QR, live connection status, send text, send
media, number lookup, logout:

```
http://localhost:3000
```

It is plain static HTML served by the API itself, so it talks to the same origin
(no CORS, no proxy, no build step). Two things worth knowing:

- **No secret is baked into the page.** You paste the API key into the panel
  once; it is kept in that browser's `localStorage` and sent as `x-api-key` like
  any other client would. The HTML is public — the endpoints behind it are not.
- The panel polls `/health`, `/status` and `/qr` every 5 seconds so the QR stays
  current as WhatsApp rotates it.

If you expose this server beyond localhost, put it behind TLS and your own
access control. The API key is the only thing standing between the internet and
your WhatsApp account.

### Configuration

Every setting is an environment variable; see [.env.example](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `API_KEY` | *(required)* | Shared secret for the `x-api-key` header, min 16 chars |
| `AUTH_DIR` | `./auth` | Where the session is stored |
| `SESSION_NAME` | `wa-http-api` | Label included in webhook payloads |
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
into an image.

---

## Endpoints

All routes except `GET /health` require the header `x-api-key: $API_KEY`.
Errors are always JSON: `{ "error": "<code>", "message": "...", "details": {...} }`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/` | Browser console (public, static HTML) |
| GET | `/health` | Liveness + connection flag (public) |
| GET | `/status` | Fuller diagnostics: paired user, queue depth, last disconnect |
| GET | `/qr` | Current pairing QR as a PNG data URL |
| POST | `/send/text` | Send a text message |
| POST | `/send/media` | Send an image, video or document by URL |
| GET | `/check/:number` | Is this number registered on WhatsApp? |
| POST | `/logout` | Unlink the device and wipe the local session |

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
{ "loggedOut": true, "message": "Session cleared. A new QR will appear at GET /qr shortly." }
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
and the result must be 7–15 digits **including the country code** — a local
number without one will reach the wrong person or nobody. Group JIDs (`@g.us`)
are opaque and never rewritten. `@broadcast` and `status@broadcast` are rejected.

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
public/index.html     the browser console (no build step, no secrets)
```

## Status codes

| Code | Meaning |
| --- | --- |
| `200` / `202` | OK / send queued |
| `400 bad_request` | Malformed JSON, missing field, bad number or URL |
| `401 unauthorized` | Missing or wrong `x-api-key` |
| `404 not_found` | No such route |
| `409 conflict` | `GET /qr` while already paired |
| `502 upstream_error` | WhatsApp did not acknowledge the message |
| `503 service_unavailable` | Not connected, no QR yet, or send queue full |
| `500 internal_error` | Anything unexpected (details are logged, not returned) |

## License

MIT
