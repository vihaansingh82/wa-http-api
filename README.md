# wa-http-api

A self-hosted, **multi-tenant** WhatsApp HTTP API. Each client signs up, links
their own WhatsApp by scanning a QR, and gets their own API key. Built on
[Baileys](https://github.com/WhiskeySockets/Baileys) **v7**, Express 5 and
Supabase.

- **Two dashboards** — a client dashboard at `/app` and an admin dashboard at `/admin`
- **Supabase Auth** — sign-up, email confirmation and password reset, no auth code of our own
- **One WhatsApp socket per client**, with per-tenant credentials on disk
- **CRM built in** — conversations, contacts, tags, consent and opt-out tracking
- Node.js 22+, ES modules, no build step, no frontend framework

> **Read this before selling it.** This drives WhatsApp Web through an
> unofficial client. Bulk outreach to people who did not opt in is the fastest
> way to get a number banned, and a ban takes that client's whole integration
> down. For sanctioned commercial messaging, use the official
> [WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api).
> Contacts here carry `consent` and `opted_out` fields, and an opted-out contact
> cannot be messaged by any route — deliberately.

---

## How it fits together

```
Browser ──── Supabase Auth ─────► access token
   │                                   │
   │  /app  (client dashboard)         │  Authorization: Bearer …
   │  /admin (admin dashboard)         ▼
   └────────────────────────► Node server ────► Supabase Postgres (RLS)
                                   │
                                   ├─► Baileys socket for tenant A
                                   ├─► Baileys socket for tenant B
                                   └─► …
```

- **Supabase** owns accounts and all tenant data: profiles, contacts, messages,
  API keys, usage and the audit log.
- **The Node server** owns the WhatsApp connections. It talks to Supabase with
  the service-role key, so **every query it makes filters by `user_id` itself** —
  row-level security is bypassed by that key and cannot save us.
- **The browser** talks to Supabase directly only for auth. All data goes through
  this server's API.

### Roles

| Role | Can |
| --- | --- |
| `client` | Link one WhatsApp, send and receive, manage their own contacts and API keys |
| `admin` | Everything a client can, plus manage every account, session and the audit log |

**The first account to sign up becomes the admin.** After that, every new signup
is a client. That is a database trigger, not app logic, so it holds even if
someone hits the Supabase API directly.

---

## Setup

### 1. A Supabase project

Create one (the free tier is enough), then apply the four migrations in
[supabase/migrations/](supabase/migrations/) — either with the Supabase CLI
(`supabase db push`) or by pasting them into the SQL editor in order.

They create `profiles`, `wa_sessions`, `api_keys`, `contacts`, `wa_messages`,
`campaigns`, `usage_daily` and `audit_log`, turn on row-level security for all
of them, and add the trigger that mirrors `auth.users` into `profiles`.

> **Use a dedicated project.** Supabase Auth is per-project, so sharing one with
> another app means that app's users can sign into this dashboard and yours
> appear in its user list. Table names like `messages` collide too.

### 2. Configure and run

```bash
npm install
cp .env.example .env
```

Fill in from **Supabase → Project Settings → API**:

```ini
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...   # safe in the browser
SUPABASE_SERVICE_ROLE_KEY=...                 # SECRET, server only
PUBLIC_URL=http://localhost:3000              # for reset/confirm links
```

```bash
npm start
```

Then open <http://localhost:3000/app> and **create the first account** — it
becomes the admin.

### 3. Email links

Password reset and email confirmation are sent by Supabase. In
**Authentication → URL Configuration**, add your `PUBLIC_URL` to the redirect
allow-list, including `/app/**`, or the links in those emails will refuse to come
back to your dashboard.

Supabase's built-in mailer is rate-limited and only for testing. For real use,
set your own SMTP under **Authentication → Emails**.

---

## The dashboards

### `/app` — client

1. **Sign up / sign in**, with a working *forgot password* flow.
2. **Link WhatsApp** — a QR that refreshes itself as WhatsApp rotates it.
3. **Overview** — sent/received/failed over 14 days, connection state.
4. **Inbox** — conversation threads, with replies sent straight from the browser.
5. **Contacts** — status, tags, consent, one-click opt-out.
6. **Send** — text, media by URL, and a number lookup.
7. **API keys** — create and revoke. The full key is shown **once**.

### `/admin` — admin

- **Overview** — service-wide traffic, account and session counts, process memory.
- **Accounts** — promote/demote, suspend/reinstate, delete. Suspending kills the
  client's live socket immediately rather than waiting for their token to expire.
- **Sessions** — every client's WhatsApp state, and whether a socket is actually
  running *in this process* (the two can disagree after a restart).
- **Audit** — who did what, when.

Admins are protected from locking everyone out: you cannot demote, suspend or
delete your own account, and the last remaining admin cannot be demoted.

---

## Authentication

Two credentials, both sent to the same API:

| | Session token | API key |
| --- | --- | --- |
| Looks like | a Supabase JWT | `wak_…` |
| Sent as | `Authorization: Bearer …` | `x-api-key: …` |
| Used by | the dashboards | your own scripts |
| Stored | in the browser | **hashed** (SHA-256) in `api_keys` |
| Reaches `/api/admin/*` | yes, if admin | **never** |

That last row is deliberate: a leaked client key must not be able to suspend
accounts or delete other tenants, so admin routes require a real login.

---

## API

Everything is under `/api` and scoped to whoever the credential belongs to.
**No endpoint takes a user id** — there is nothing to tamper with.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness (public) |
| GET | `/api/public-config` | Supabase URL + publishable key for the dashboards (public) |
| GET | `/api/me` | Your profile |
| PATCH | `/api/me` | Update your name/company |
| GET | `/api/session` | WhatsApp connection state |
| POST | `/api/session/start` | Start your connection |
| GET | `/api/session/qr` | Current QR as a PNG data URL |
| POST | `/api/session/logout` | Unlink your phone |
| GET | `/api/keys` | List your API keys |
| POST | `/api/keys` | Create one (returns the plaintext once) |
| DELETE | `/api/keys/:id` | Revoke one |
| POST | `/api/send/text` | Send a text |
| POST | `/api/send/media` | Send image/video/document by URL |
| GET | `/api/check/:number` | Is the number on WhatsApp? |
| GET | `/api/inbox/threads` | Conversation list |
| GET | `/api/inbox/threads/:jid` | Messages in one thread |
| POST | `/api/inbox/threads/:jid/read` | Mark read |
| GET/POST | `/api/contacts` | List / create |
| PATCH/DELETE | `/api/contacts/:id` | Update / delete |
| GET | `/api/usage` | Daily counters |
| GET | `/api/admin/overview` | Service KPIs *(admin session)* |
| GET | `/api/admin/accounts` | All accounts *(admin session)* |
| PATCH/DELETE | `/api/admin/accounts/:id` | Manage an account *(admin session)* |
| GET | `/api/admin/sessions` | All WhatsApp sessions *(admin session)* |
| POST | `/api/admin/sessions/:userId/start\|stop` | Control one *(admin session)* |
| GET | `/api/admin/audit` | Audit log *(admin session)* |

### Sending

```bash
KEY="wak_your_key"
API="http://localhost:3000"

curl -s -X POST $API/api/send/text \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"to": "+91 98765 43210", "message": "Hello"}'
```

```json
{
  "sent": true,
  "isGroup": false,
  "id": "3EB0C767D82B0F3A2B1C",
  "to": "918285861066@s.whatsapp.net",
  "requested": "8285861066@s.whatsapp.net",
  "resolved": true,
  "timestamp": 1757248521
}
```

`202` means *queued*, not *delivered* — see [Rate limiting](#rate-limiting).

### Recipients are resolved, not guessed

Before every send the recipient goes through `onWhatsApp`, and the JID it returns
is the one used. This matters more than it sounds: gluing `@s.whatsapp.net` onto
whatever digits you typed produces a **syntactically valid JID belonging to
nobody** when the country code is missing. WhatsApp accepts that stanza and
silently discards it — so the API would answer `202 sent` and nothing would
arrive.

So `8285861066` becomes `918285861066@s.whatsapp.net`, and the response tells you
it happened. A number genuinely not on WhatsApp gets `404 recipient_not_found`
rather than a false success. `VERIFY_RECIPIENT=false` skips the lookup.

Groups (`@g.us`) are passed through untouched. `@broadcast` is rejected.

---

## Rate limiting

Each tenant has its own serial queue guaranteeing at least `SEND_DELAY_MS`
(default 3000) between two of *their* sends. Firing messages back to back is what
gets numbers flagged.

- With the default delay, 20 queued messages take about a minute to drain.
- Past `MAX_QUEUE_SIZE` waiting, sends fail fast with `503` instead of growing
  memory. Watch `queued` in `GET /api/session`.
- A queued message whose socket drops fails with `503` rather than being sent
  late on a new connection.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | *(required)* | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | *(required)* | Browser-safe key |
| `SUPABASE_SERVICE_ROLE_KEY` | *(required)* | **Secret.** Bypasses RLS; server only |
| `PUBLIC_URL` | *(empty)* | Origin for reset/confirmation links |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP listener |
| `AUTH_DIR` | `./auth` | Per-tenant WhatsApp credentials live under `auth/tenants/<id>/` |
| `MAX_TENANT_SESSIONS` | `25` | Cap on simultaneous sockets. Both deploy configs lower it to `5` to match a 512 MB instance |
| `VERIFY_RECIPIENT` | `true` | Resolve recipients before sending |
| `SEND_DELAY_MS` | `3000` | Minimum gap between a tenant's sends |
| `MAX_QUEUE_SIZE` | `500` | Queue depth before `503` |
| `WEBHOOK_URL` | *(empty)* | Forward inbound messages here too |
| `WEBHOOK_SECRET` | *(empty)* | Sent as `x-webhook-secret` |
| `LOG_LEVEL` / `LOG_PRETTY` | `info` / `false` | Logging |

**`AUTH_DIR` is a pile of credentials.** Anyone with a copy can send messages as
any linked client. It is gitignored; keep it on a persistent disk and back it up
like a password store.

`MAX_TENANT_SESSIONS` is the real capacity limit: each socket is a live WebSocket
plus its own Signal store. When the cap is hit, an idle session is evicted (a
connected one only as a last resort) — its credentials stay on disk and the next
request starts it again. Budget roughly 1 GB of RAM per 10 tenants and raise the
cap and the instance size together; see [DEPLOY.md](DEPLOY.md).

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)**. The short version: this is stateful and
always-on, so it needs a persistent disk, exactly one instance, and no
scale-to-zero. That rules out Vercel, Netlify, Workers and Lambda, and most free
tiers. [render.yaml](render.yaml) and [fly.toml](fly.toml) are pre-configured.

## Tests

```bash
npm test
```

127 checks across three suites, no framework and no network — Supabase and
Baileys are both injected as fakes:

| Suite | Covers |
| --- | --- |
| `test/api.test.mjs` | Auth, **tenant isolation**, admin gating, self-lockout guards, opt-out enforcement, validation |
| `test/messages.test.mjs` | Webhook retry/backoff, inbound filtering, payload extraction |
| `test/page.test.mjs` | Both dashboards: scripts parse, every element id resolves, no secret literals, every `api()` call maps to a real route |

Two are worth calling out. `api.test.mjs` asserts that **every data call carries
a user id** and that no route accepts one from the caller — that is the whole
tenant boundary. `page.test.mjs` fails if a dashboard calls an endpoint the
server does not define, so a dead button cannot ship.

## Baileys v7 notes

v7 changed things most tutorials still get wrong:

| Older pattern | v7 |
| --- | --- |
| `@whiskeysockets/baileys` | package is now **`baileys`** |
| CommonJS `require()` | **ESM-only** (`"type": "module"`) |
| `printQRInTerminal: true` | **removed** — read `qr` off `connection.update` yourself |
| `makeInMemoryStore` | gone; keep your own state |
| `node-cache` | ships `@cacheable/node-cache` |
| Node 16/18 | **Node 20+**, enforced by a preinstall check |

## Project layout

```
index.js                boot, signals, session restore after restart
src/config.js           env parsing, fails fast at startup
src/supabase.js         service-role client: identity, keys, CRM, admin queries
src/auth.js             session-or-API-key authentication, admin gating
src/tenants.js          one Baileys socket per client, with eviction
src/whatsapp.js         a single WhatsApp connection (instantiated per tenant)
src/routes-client.js    everything a client can do with their own account
src/routes-admin.js     service management
src/server.js           Express wiring, static dashboards, error shape
src/queue.js            per-tenant serial send queue
src/jid.js              loose number -> JID normalisation
src/validate.js         body validation, media content building
src/messages.js         inbound filtering and payload extraction
src/webhook.js          webhook delivery with bounded retries
src/errors.js           ApiError -> HTTP status mapping
public/index.html       landing page
public/app/             client dashboard
public/admin/           admin dashboard
public/shared.{css,js}  design system + Supabase auth over plain fetch
supabase/migrations/    the database schema
```

## Status codes

| Code | Meaning |
| --- | --- |
| `200` / `202` | OK / send queued |
| `400 bad_request` | Malformed JSON, missing field, bad number or URL |
| `401 unauthorized` | Missing, invalid or expired credential |
| `403 forbidden` | Authenticated but not permitted (non-admin, API key on an admin route, opted-out recipient) |
| `404 not_found` | No such route or record |
| `404 recipient_not_found` | Recipient not reachable on WhatsApp |
| `409 conflict` | Already linked, or a guarded admin action |
| `502 upstream_error` | WhatsApp or Supabase did not cooperate |
| `503 service_unavailable` | Not linked, no QR yet, queue full, or Supabase unconfigured |
| `500 internal_error` | Unexpected. Logged, never returned |

## License

MIT
