import path from 'node:path'
import { config } from './config.js'
import { logger } from './logger.js'
import { ApiError } from './errors.js'
import { createWhatsAppClient } from './whatsapp.js'
import { jidToNumber, isGroupJid } from './jid.js'
import {
  bumpUsage,
  getSessionState,
  listSessionStates,
  recordMessage,
  upsertContact,
  upsertSessionState,
  writeAudit
} from './supabase.js'

const log = logger.child({ module: 'tenants' })

/** Each tenant's Baileys credentials live in their own folder under AUTH_DIR. */
const authDirFor = userId => path.join(config.authDir, 'tenants', userId)

/**
 * Runs one WhatsApp connection per client account.
 *
 * Every socket is a live WebSocket plus its own Signal store, so this is the
 * expensive resource in the system -- hence the cap and the idle eviction. A
 * tenant whose socket has been evicted is not broken: their credentials are
 * still on disk, and the next request starts them again.
 */
export function createTenantManager() {
  /** @type {Map<string, {client: ReturnType<typeof createWhatsAppClient>, touchedAt: number}>} */
  const live = new Map()
  let shuttingDown = false

  const touch = userId => {
    const entry = live.get(userId)
    if (entry) entry.touchedAt = Date.now()
  }

  /** Mirror socket state into Supabase so both dashboards can read it. */
  async function persistState(userId, state) {
    try {
      await upsertSessionState(userId, {
        state: state.state,
        wa_jid: state.user?.id ?? null,
        wa_name: state.user?.name ?? null,
        qr_updated_at: state.hasQr ? (state.qrGeneratedAt ?? new Date().toISOString()) : null,
        last_connected_at: state.state === 'connected' ? new Date().toISOString() : undefined,
        last_error: state.lastDisconnect?.message ?? null
      })
    } catch (err) {
      // Losing a status write must not affect the socket it describes.
      log.error({ err: err.message, userId }, 'could not persist session state')
    }
  }

  /** Store an inbound message and keep its contact row current. */
  async function persistInbound(userId, payload) {
    try {
      const jid = payload.from
      const existing = await getContactSafely(userId, jid)
      await upsertContact(userId, {
        jid,
        number: payload.isGroup ? null : jidToNumber(jid),
        name: payload.pushName ?? existing?.name ?? null,
        is_group: Boolean(payload.isGroup),
        last_message_at: new Date((payload.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
        unread: (existing?.unread ?? 0) + 1
      })
      await recordMessage(userId, {
        wa_id: payload.id,
        jid,
        direction: 'in',
        participant: payload.participant ?? null,
        push_name: payload.pushName ?? null,
        type: payload.type,
        body: payload.text,
        sent_at: new Date((payload.timestamp ?? Date.now() / 1000) * 1000).toISOString(),
        status: 'received'
      })
      await bumpUsage(userId, 'received')
    } catch (err) {
      log.error({ err: err.message, userId }, 'could not persist inbound message')
    }
  }

  async function getContactSafely(userId, jid) {
    try {
      const { admin } = await import('./supabase.js')
      if (!admin) return null
      const { data } = await admin
        .from('contacts')
        .select('name, unread')
        .eq('user_id', userId)
        .eq('jid', jid)
        .maybeSingle()
      return data
    } catch {
      return null
    }
  }

  /**
   * Free a slot when the cap is reached. Anything not connected goes first;
   * only if every socket is live do we evict the least recently used, because
   * dropping a connected tenant is a real interruption for them.
   */
  async function evictOne() {
    const candidates = [...live.entries()].sort((a, b) => {
      const aLive = a[1].client.isConnected() ? 1 : 0
      const bLive = b[1].client.isConnected() ? 1 : 0
      if (aLive !== bLive) return aLive - bLive
      return a[1].touchedAt - b[1].touchedAt
    })
    const [userId, entry] = candidates[0] ?? []
    if (!userId) return false

    log.warn({ userId, connected: entry.client.isConnected() }, 'evicting a session to free a slot')
    await entry.client.stop()
    live.delete(userId)
    return true
  }

  /** Start (or return) this tenant's connection. */
  async function ensure(userId) {
    if (shuttingDown) throw ApiError.unavailable('Server is shutting down.')

    const existing = live.get(userId)
    if (existing) {
      touch(userId)
      return existing.client
    }

    if (live.size >= config.maxTenantSessions && !(await evictOne())) {
      throw ApiError.unavailable(
        `This server is at its limit of ${config.maxTenantSessions} live WhatsApp sessions.`
      )
    }

    const client = createWhatsAppClient({
      authDir: authDirFor(userId),
      label: userId.slice(0, 8),
      onStateChange: state => persistState(userId, state),
      onConnected: user =>
        writeAudit({ userId, actor: 'system', action: 'wa.connected', detail: { jid: user?.id } }),
      onMessage: payload => persistInbound(userId, payload)
    })

    live.set(userId, { client, touchedAt: Date.now() })
    log.info({ userId, live: live.size }, 'starting a tenant session')
    await client.start()
    return client
  }

  /** The connection if it is already running, without starting one. */
  function peek(userId) {
    const entry = live.get(userId)
    if (entry) touch(userId)
    return entry?.client ?? null
  }

  async function stop(userId) {
    const entry = live.get(userId)
    if (!entry) return false
    await entry.client.stop()
    live.delete(userId)
    return true
  }

  /**
   * Reconnect tenants that were connected before the process restarted, so a
   * deploy does not leave everyone offline until they happen to open the
   * dashboard.
   */
  async function restorePreviouslyConnected() {
    try {
      const rows = await listSessionStates()
      const wanted = rows
        .filter(row => row.state === 'connected' && row.profiles?.status === 'active')
        .slice(0, config.maxTenantSessions)

      if (!wanted.length) return { restored: 0 }
      log.info({ count: wanted.length }, 'restoring sessions that were connected before restart')

      // Sequentially, not in parallel: a burst of simultaneous handshakes is
      // both slow and conspicuous to WhatsApp.
      let restored = 0
      for (const row of wanted) {
        try {
          await ensure(row.user_id)
          restored++
        } catch (err) {
          log.error({ err: err.message, userId: row.user_id }, 'could not restore a session')
        }
      }
      return { restored }
    } catch (err) {
      log.error({ err: err.message }, 'session restore failed')
      return { restored: 0, error: err.message }
    }
  }

  /** Record an outgoing message against the tenant's CRM. */
  async function persistOutbound(userId, { waId, jid, body, type = 'text', campaignId = null }) {
    try {
      const existing = await getContactSafely(userId, jid)
      await upsertContact(userId, {
        jid,
        number: isGroupJid(jid) ? null : jidToNumber(jid),
        name: existing?.name ?? null,
        is_group: isGroupJid(jid),
        last_message_at: new Date().toISOString(),
        unread: existing?.unread ?? 0
      })
      await recordMessage(userId, {
        wa_id: waId,
        jid,
        direction: 'out',
        type,
        body,
        sent_at: new Date().toISOString(),
        status: 'sent',
        campaign_id: campaignId
      })
      await bumpUsage(userId, 'sent')
    } catch (err) {
      log.error({ err: err.message, userId }, 'could not persist outbound message')
    }
  }

  return {
    ensure,
    peek,
    stop,
    restorePreviouslyConnected,
    persistOutbound,

    get size() {
      return live.size
    },

    /** What the admin dashboard shows about the live process, not the database. */
    liveSummary() {
      return [...live.entries()].map(([userId, entry]) => ({
        userId,
        state: entry.client.state,
        connected: entry.client.isConnected(),
        queued: entry.client.status().queued,
        touchedAt: new Date(entry.touchedAt).toISOString()
      }))
    },

    /** Read the stored row when the socket is not running. */
    async stateFor(userId) {
      const client = peek(userId)
      if (client) {
        const status = client.status()
        return {
          state: client.state,
          connected: status.connected,
          user: status.user,
          hasQr: status.hasQr,
          queued: status.queued,
          live: true
        }
      }
      const row = await getSessionState(userId)
      return {
        state: row?.state === 'connected' ? 'idle' : (row?.state ?? 'idle'),
        connected: false,
        user: row?.wa_jid ? { id: row.wa_jid, name: row.wa_name } : null,
        hasQr: false,
        queued: 0,
        live: false,
        lastConnectedAt: row?.last_connected_at ?? null
      }
    },

    async stopAll() {
      shuttingDown = true
      await Promise.all([...live.values()].map(entry => entry.client.stop().catch(() => {})))
      live.clear()
    }
  }
}
