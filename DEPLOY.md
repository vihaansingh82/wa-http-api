# Deploying

This is a stateful, always-on service, not a stateless web app. Three
constraints decide whether a host will work at all:

| Constraint | Why | If you ignore it |
| --- | --- | --- |
| **Persistent disk** for `AUTH_DIR` | It holds *every client's* WhatsApp credentials | Every deploy forgets them and all your clients re-scan |
| **Exactly one instance** | WhatsApp allows one connection per linked device | Two instances fight over each session and get kicked off as duplicates |
| **No scale-to-zero / no sleeping** | Each session is a long-lived WebSocket | Sleeping drops every socket, and repeated re-linking is what gets numbers flagged |

That rules out Vercel, Netlify, Cloudflare Workers and Lambda entirely (no
long-lived sockets), and most **free** tiers, which either sleep or give you no
disk. Budget for the smallest paid instance — roughly $2–7/month.

> Forced re-pairing is a real ban risk, not a theoretical one. On a multi-tenant
> deployment it is worse: one lost disk means every client re-scans at once.

**Capacity.** `MAX_TENANT_SESSIONS` is the real limit. Each linked client is a
live WebSocket plus its own Signal store, so plan memory per tenant rather than
per request. Past the cap, idle sessions are evicted and restart on next use;
connected ones are dropped only as a last resort.

The code default is `25`, which suits a machine with several GB. Both deploy
configs deliberately override it to **5**, because they specify a 512 MB
instance and 25 sockets there is an OOM loop — and an OOM loop re-pairs every
client over and over, which is the exact failure this whole page is about.
Budget roughly **1 GB per 10 tenants** and raise the cap and the instance size
together:

| Where | Instance size | `MAX_TENANT_SESSIONS` |
| --- | --- | --- |
| [fly.toml](fly.toml) `[[vm]] memory` | `512mb` | `5` |
| [render.yaml](render.yaml) `plan` | `0.5c-512mb` | `5` |
| Either, scaled up | `2gb` / `1c-2g` | `20` |

---

## 1. Supabase first

The app cannot start usefully without it. Create a project (free tier is fine),
then apply the migrations in [supabase/migrations/](supabase/migrations/) in
order — `supabase db push` with the CLI, or paste each file into the SQL editor.

Use a **dedicated project**. Supabase Auth is per-project, so sharing one with
another app means that app's users can sign into this dashboard, and your
clients show up in its user list.

From **Project Settings → API**, collect:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY` — anon/publishable, safe in the browser
- `SUPABASE_SERVICE_ROLE_KEY` — **secret**, bypasses row-level security

Then in **Authentication → URL Configuration**, add your deployed origin to the
redirect allow-list including `/app/**`, or password-reset and confirmation
emails will refuse to come back to your dashboard.

Supabase's built-in mailer is rate-limited and meant for testing. Set your own
SMTP under **Authentication → Emails** before onboarding real clients.

---

## Option A — Fly.io (recommended)

Cheapest way to get a real volume plus an always-on machine.

```bash
fly auth login
fly launch --no-deploy --copy-config --name sandesh-api
fly volumes create sandesh_data --size 1 --region sin

fly secrets set \
  SUPABASE_URL=https://YOUR-PROJECT.supabase.co \
  SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
  SUPABASE_SERVICE_ROLE_KEY=... \
  PUBLIC_URL=https://sandesh-api.fly.dev

fly deploy
fly logs
```

[fly.toml](fly.toml) pins what matters: the volume at `/data`,
`AUTH_DIR=/data/auth`, `auto_stop_machines = false`, `min_machines_running = 1`,
and a `/health` check. Edit `app` and `primary_region` before the first deploy —
`app` must be globally unique across all of Fly, so `sandesh-api` may already be
taken — `fly apps create sandesh-api` tells you, and any suffix works.

A freshly created Fly volume is owned by `root`, so a container starting
straight as an unprivileged user cannot write to it and every session dies with
`EACCES` on its first write — which reads like a WhatsApp fault and is not one.
[docker-entrypoint.sh](docker-entrypoint.sh) handles this: it takes ownership of
`AUTH_DIR` as root, then drops to the `node` user before exec'ing the server.
Nothing to configure, but that is why the image does not end on `USER node`.

For push-to-deploy, add `FLY_API_TOKEN` (from `fly tokens create deploy`) as a
GitHub Actions secret — [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
runs the tests first, and skips itself when the secret is absent.

## Option B — Render (Blueprint, no CLI)

1. **New → Blueprint**, point it at this repo. It reads [render.yaml](render.yaml).
2. Render prompts for the four `sync: false` variables — paste them in. They are
   never committed to git.
3. Approve. It creates the service on `0.5c-512mb` with a 1 GB disk at
   `/var/data`.

`autoDeployTrigger: commit` redeploys on every push to `main`. Sessions survive
because they live on the disk, not in the image.

**Why not the free plan.** Render will not attach a persistent disk to a free
instance, and free instances sleep. Either one forces repeated re-pairing. The
disk is $0.25/GB per month on top of compute.

**If the instance restarts under memory pressure**, move `plan` up to `1c-2g`.
512 MB is thin once several tenants are linked, and an OOM loop reconnects
everyone over and over — the thing worth paying to avoid.

## Option C — Any VPS with Docker

```bash
git clone https://github.com/vihaansingh82/wa-http-api.git
cd wa-http-api
cp .env.example .env
nano .env            # the four SUPABASE_* / PUBLIC_URL values

docker compose up -d
docker compose logs -f
```

[docker-compose.yml](docker-compose.yml) keeps the session tree on a named
volume, so `down && up` preserves every link. Put a reverse proxy with TLS in
front before exposing it.

---

## After deploying

1. Open `https://your-app.example.com/app` and **create the first account**. It
   becomes the admin — that is a database trigger, not app logic.
2. Sign in, click **Link WhatsApp**, scan the QR.
3. Send clients to the same `/app` URL. Each signs up, links their own phone and
   gets their own API key. They cannot see each other.
4. Manage everyone at `https://your-app.example.com/admin`.

Restarts are handled: on boot the server reconnects every session that was
connected before it stopped, sequentially rather than all at once.

---

## Environment variables

Four are required:

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | **Required.** Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | **Required.** Browser-safe key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Required and secret.** Bypasses row-level security — server only |
| `PUBLIC_URL` | **Required** for reset and confirmation links to return correctly |
| `AUTH_DIR` | Must be on the persistent disk. Already set in both configs |
| `MAX_TENANT_SESSIONS` | Cap on simultaneous sockets. Your real capacity limit |
| `SEND_DELAY_MS` | Per-tenant gap between sends, default 3000 |
| `MAX_MEDIA_MB` | Largest base64 media in a body, default 16 |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | Optional inbound forwarding |
| `LOG_PRETTY` | Leave `false` so logs stay JSON |

`PORT` is supplied by the platform and read automatically.

## Before you expose it publicly

- **TLS.** Credentials travel in headers. Fly and Render terminate TLS for you;
  on a VPS use Caddy or nginx.
- **Never ship the service-role key to a browser.** It bypasses row-level
  security entirely. Only `SUPABASE_PUBLISHABLE_KEY` is served to the page, via
  `GET /api/public-config`.
- **`/health` is public** by design so healthchecks work. It reveals only
  liveness, whether Supabase is configured, and a live-session count.
- **Turn on email confirmation** in Supabase before opening signup, or anyone
  can create an account with someone else's address.

## Backing up the sessions

Losing the disk means **every client** re-scans. Each tenant has a folder under
`auth/tenants/<user-id>/`; the whole tree is what matters:

```bash
# Fly
fly ssh console -C "tar czf - -C /data auth" > sandesh-auth-backup.tar.gz

# Docker
docker compose exec sandesh tar czf - -C /app auth > sandesh-auth-backup.tar.gz
```

Treat that tarball like a password store: anyone holding it can send messages as
**any** linked client. Restore by unpacking it into `AUTH_DIR` with the service
stopped.

Supabase handles its own backups; check the retention on your plan.

## Upgrading

Both git-based options redeploy on push to `main`. Sessions live on the disk and
survive. Baileys tracks WhatsApp Web closely, so pull new versions periodically:

```bash
npm update baileys && npm test    # verify, then push
```
