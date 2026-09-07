# Deploying

This is a stateful, always-on service, not a stateless web app. Three
constraints decide whether a host will work at all:

| Constraint | Why | If you ignore it |
| --- | --- | --- |
| **Persistent disk** for `AUTH_DIR` and `TOKEN_STORE` | The auth folder *is* the WhatsApp session | Every deploy and restart forgets it — you re-scan the QR each time |
| **Exactly one instance** | WhatsApp allows one connection per linked device | A second instance sharing the session gets kicked off as a duplicate |
| **No scale-to-zero / no sleeping** | The WhatsApp socket is a long-lived WebSocket | Sleeping drops the socket; repeated re-linking is exactly the pattern that gets numbers flagged |

That rules out Vercel, Netlify, Cloudflare Workers and Lambda entirely (no
long-lived sockets), and it rules out most **free** tiers, which either sleep or
give you no disk. Budget for the smallest paid instance — roughly $2–7/month
depending on host.

> Repeated forced re-pairing is a real ban risk, not a theoretical one. Getting
> the disk right is the difference between linking once and linking weekly.

---

## Option A — Fly.io (recommended)

Cheapest way to get a real volume plus an always-on machine.

```bash
# one-time
fly auth login
fly launch --no-deploy --copy-config --name my-wa-api   # pick your own name
fly volumes create wa_data --size 1 --region sin        # match primary_region
fly secrets set API_KEY=$(openssl rand -hex 32)

fly deploy
fly logs
```

[fly.toml](fly.toml) already pins the parts that matter: the volume mounted at
`/data`, `AUTH_DIR=/data/auth`, `TOKEN_STORE=/data/tokens.json`,
`auto_stop_machines = false`, and `min_machines_running = 1`. Edit `app` and
`primary_region` before the first deploy.

Deploy on every push to `main` instead of by hand: add your `FLY_API_TOKEN`
(from `fly tokens create deploy`) as a GitHub Actions secret — the workflow in
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) does the rest.

## Option B — Render (Blueprint, no CLI)

Pure git-based, all in the browser.

1. **New → Blueprint**, point it at this repo. It reads
   [render.yaml](render.yaml).
2. Approve it. The blueprint creates the service on the `0.5c-512mb` plan,
   attaches a 1 GB disk at `/var/data`, and **generates `API_KEY` for you**.
3. Copy that key from **Environment** in the dashboard — you need it once, to
   link your phone.
4. Open `https://<your-service>.onrender.com/`, paste the key, scan the QR.

`autoDeployTrigger: commit` means every push to `main` redeploys. The session
survives because it lives on the disk, not in the image.

**Why not the free plan.** Render will not attach a persistent disk to a free
instance, and a free instance sleeps when idle, which drops the WhatsApp
socket. Either one forces repeated re-pairing. The disk itself is $0.25/GB per
month on top of compute.

**If the instance restarts under memory pressure**, move `plan` up to `1c-2g`.
512 MB is enough in normal operation, but an OOM loop reconnects to WhatsApp
over and over, which is the thing worth paying to avoid.

## Option C — Any VPS with Docker

Most control, and usually the cheapest per GB of RAM.

```bash
git clone https://github.com/vihaansingh82/wa-http-api.git
cd wa-http-api
cp .env.example .env
# set API_KEY to something long and random
nano .env

docker compose up -d
docker compose logs -f      # the QR prints here on first run
```

[docker-compose.yml](docker-compose.yml) puts the session on a named volume
(`wa-auth`), so `docker compose down && up` keeps you linked. Put a reverse
proxy with TLS in front before exposing it — see below.

---

## Linking your phone after deploying

The pairing routes are open **without a credential only from `127.0.0.1`**.
That is on purpose: otherwise anyone who found your URL could start a pairing.
On a deployed instance your browser is not loopback, so:

1. Open `https://your-app.example.com/`.
2. The page asks for your admin key. Paste the `API_KEY` you set (Fly) or that
   Render generated.
3. Click **Link WhatsApp**, scan the QR with your phone.
4. A device token is minted for that browser, and DMed to your own WhatsApp
   chat. From then on the console signs itself in.

You can also scan from the deploy logs, where the QR is printed as ASCII:

```bash
fly logs                    # Fly
docker compose logs -f      # Docker
```

If you have put the service behind your own authentication (an identity-aware
proxy, a VPN, Cloudflare Access) and want the button to work with no key, set
`ALLOW_REMOTE_PAIRING=true`. Do not set it on a service that is open to the
internet — it lets a stranger occupy your one session slot.

---

## Environment variables to set

Only one is required:

| Variable | Notes |
| --- | --- |
| `API_KEY` | **Required.** Long and random: `openssl rand -hex 32`. This is the admin credential |
| `AUTH_DIR` | Must point onto the persistent disk. Already set in both configs |
| `TOKEN_STORE` | Same. Already set in both configs |
| `WEBHOOK_URL` | Optional. Where inbound messages are POSTed |
| `WEBHOOK_SECRET` | Optional but recommended if you set a webhook |
| `SEND_DELAY_MS` | Defaults to 3000. Raise it if you send a lot |
| `LOG_PRETTY` | Leave `false` so logs stay JSON for the platform's log viewer |

`PORT` is supplied by the platform and read automatically.

## Before you expose it publicly

- **TLS.** The API key travels in a header. Over plain HTTP it is readable by
  anything on the path. Fly and Render terminate TLS for you; on a VPS use
  Caddy or nginx with a certificate.
- **Rotate the key** if it has ever been in a screenshot, a chat, or a log.
- **Restrict access** if you can. This endpoint can send messages as you — an
  allowlist, a VPN, or Cloudflare Access in front is worth more than a long key.
- **`/health` is public** by design, so healthchecks work without a credential.
  It reveals only liveness and whether a phone is linked.

## Backing up the session

Losing the disk means re-scanning the QR — not the end of the world, but avoid
it. The whole session is the `auth/` folder:

```bash
# Fly
fly ssh console -C "tar czf - -C /data auth" > wa-auth-backup.tar.gz

# Docker
docker compose exec wa-http-api tar czf - -C /app auth > wa-auth-backup.tar.gz
```

Treat that tarball exactly like a password: anyone holding it can send messages
as you. Restore by unpacking it back into `AUTH_DIR` while the service is
stopped.

## Upgrading

Both git-based options redeploy on push to `main`. The session is on the disk
and survives. Baileys tracks WhatsApp Web closely, so pull new versions
periodically:

```bash
npm update baileys && npm start   # verify locally, then push
```
