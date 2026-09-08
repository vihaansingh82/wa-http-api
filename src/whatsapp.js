import { rm } from 'node:fs/promises'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState
} from 'baileys'
import NodeCache from '@cacheable/node-cache'
import qrcodeTerminal from 'qrcode-terminal'
import QRCode from 'qrcode'
import { config } from './config.js'
import { logger as baseLogger, baileysLogger } from './logger.js'
import { ApiError } from './errors.js'
import { createSendQueue } from './queue.js'
import { createWebhookSender } from './webhook.js'
import { buildWebhookPayload, shouldForward } from './messages.js'
import { isGroupJid, jidToNumber } from './jid.js'

/** How many recently sent messages to keep so Baileys can answer retry requests. */
const SENT_CACHE_LIMIT = 200

/** How many whole messages to keep so they can be quoted or forwarded. */
const RECENT_CACHE_LIMIT = 500

/** Resolved recipient JIDs, so a repeat send skips the lookup. */
const RECIPIENT_CACHE_LIMIT = 500

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 401/403 mean the session is dead server-side: reconnecting would loop forever. */
const isSessionDead = statusCode =>
  statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.forbidden

/**
 * One WhatsApp connection. Instantiate it per tenant with its own authDir --
 * the auth folder IS the session, so two tenants sharing one would fight over
 * the same credentials.
 */
export function createWhatsAppClient({
  authDir = config.authDir,
  label = 'default',
  onConnected,
  onStateChange,
  onMessage
} = {}) {
  const logger = baseLogger.child({ tenant: label })
  const queue = createSendQueue({
    minDelayMs: config.sendDelayMs,
    maxSize: config.maxQueueSize,
    logger: logger.child({ module: 'queue' })
  })

  const webhook = createWebhookSender({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    timeoutMs: config.webhookTimeoutMs,
    maxAttempts: config.webhookMaxAttempts,
    logger: logger.child({ module: 'webhook' })
  })

  const msgRetryCounterCache = new NodeCache()
  /** @type {Map<string, import('baileys').proto.IMessage>} */
  const sentMessages = new Map()
  /**
   * Whole messages, both directions, keyed by WhatsApp's message id.
   *
   * Replying and forwarding need the original message, not just its id --
   * Baileys builds the quote out of its content. Reacting, deleting and pinning
   * need only the key, which can be rebuilt from a stored row, so those still
   * work for messages older than this cache.
   * @type {Map<string, import('baileys').WAMessage>}
   */
  const recentMessages = new Map()
  /** @type {Map<string, string>} input JID -> the JID WhatsApp actually uses */
  const recipientCache = new Map()

  let sock = null
  let connectionState = 'close'
  let qr = null
  let qrDataUrl = null
  let qrGeneratedAt = null
  let lastDisconnect = null
  let reconnectAttempts = 0
  let starting = false
  let stopped = false
  let reconnectTimer = null
  let waVersion = null

  const isConnected = () => connectionState === 'open' && Boolean(sock?.user)

  function requireConnection() {
    if (!isConnected()) {
      throw ApiError.unavailable('WhatsApp is not connected. Scan the QR at GET /qr first.', {
        connection: connectionState
      })
    }
    return sock
  }

  function rememberSent(id, message) {
    if (!id || !message) return
    sentMessages.set(id, message)
    if (sentMessages.size > SENT_CACHE_LIMIT) {
      sentMessages.delete(sentMessages.keys().next().value)
    }
  }

  /** Keep a whole message around so it can be quoted or forwarded later. */
  function remember(msg) {
    const id = msg?.key?.id
    if (!id || !msg.message) return
    recentMessages.set(id, msg)
    if (recentMessages.size > RECENT_CACHE_LIMIT) {
      recentMessages.delete(recentMessages.keys().next().value)
    }
  }

  /**
   * The key identifying a message, for reacting, deleting or pinning.
   *
   * Preferring the cached key matters: it carries `participant`, which a group
   * message needs and which cannot be reconstructed from a stored row.
   */
  function keyFor({ messageId, jid, fromMe = false }) {
    const cached = recentMessages.get(messageId)
    if (cached?.key) return cached.key
    if (!jid) {
      throw ApiError.badRequest(
        'That message is not in this server\'s recent cache, so "to" is required to locate it.'
      )
    }
    return { remoteJid: jid, id: messageId, fromMe: Boolean(fromMe) }
  }

  /** The whole message, required for quoting and forwarding. */
  function requireRemembered(messageId) {
    const found = recentMessages.get(messageId)
    if (!found) {
      throw ApiError.notFound(
        `Message ${messageId} is not in this server's recent cache (the last ${RECENT_CACHE_LIMIT} ` +
          'messages). Replying to and forwarding older messages is not supported.',
        { messageId }
      )
    }
    return found
  }

  /**
   * The coarse state the dashboards and database care about, as opposed to the
   * raw socket state. Kept separate so a UI never has to reason about
   * Baileys internals.
   */
  function publicState() {
    if (connectionState === 'open') return 'connected'
    if (qrDataUrl) return 'awaiting_scan'
    if (connectionState === 'connecting') return 'connecting'
    if (lastDisconnect?.reason === 'loggedOut') return 'logged_out'
    if (lastDisconnect) return 'error'
    return 'idle'
  }

  /** Tell the owner something changed. Never allowed to throw into the socket. */
  function publishState() {
    if (!onStateChange) return
    Promise.resolve(
      onStateChange({
        state: publicState(),
        connection: connectionState,
        user: sock?.user ? { id: sock.user.id, name: sock.user.name ?? null } : null,
        hasQr: Boolean(qrDataUrl),
        qrGeneratedAt,
        lastDisconnect
      })
    ).catch(err => logger.error({ err }, 'onStateChange hook failed'))
  }

  async function setQr(next) {
    qr = next ?? null
    qrGeneratedAt = next ? new Date().toISOString() : null
    if (!next) {
      qrDataUrl = null
      publishState()
      return
    }
    qrcodeTerminal.generate(next, { small: true })
    logger.info('scan the QR above, or fetch it as an image from GET /qr')
    try {
      qrDataUrl = await QRCode.toDataURL(next, { margin: 1, width: 512 })
    } catch (err) {
      qrDataUrl = null
      logger.error({ err }, 'failed to render QR as a data URL')
    }
    publishState()
  }

  async function clearAuthState() {
    logger.warn({ authDir }, 'clearing auth state')
    await rm(authDir, { recursive: true, force: true })
  }

  /**
   * Drop the current socket without letting its dying `connection.update`
   * trigger another reconnect.
   */
  function teardownSocket() {
    if (!sock) return
    const dying = sock
    sock = null
    try {
      dying.ev.removeAllListeners('connection.update')
      dying.ev.removeAllListeners('creds.update')
      dying.ev.removeAllListeners('messages.upsert')
      Promise.resolve(dying.end(undefined)).catch(err =>
        logger.debug({ err }, 'socket end rejected')
      )
    } catch (err) {
      logger.debug({ err }, 'error while tearing down the old socket')
    }
  }

  function backoffDelay() {
    const { baseDelayMs, maxDelayMs } = config.reconnect
    const exponential = Math.min(baseDelayMs * 2 ** reconnectAttempts, maxDelayMs)
    // Jitter keeps several instances from stampeding WhatsApp in lockstep.
    return Math.round(exponential * (0.75 + Math.random() * 0.5))
  }

  function scheduleReconnect(delayMs) {
    if (stopped || reconnectTimer) return
    logger.info({ delayMs, attempt: reconnectAttempts }, 'scheduling reconnect')
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      start().catch(err => logger.error({ err }, 'reconnect failed'))
    }, delayMs)
  }

  async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect: disconnect, qr: nextQr } = update

    if (nextQr) await setQr(nextQr)

    if (connection) {
      connectionState = connection
      logger.info({ connection }, 'connection state changed')
      publishState()
    }

    if (connection === 'open') {
      reconnectAttempts = 0
      lastDisconnect = null
      await setQr(null)
      logger.info({ user: sock?.user?.id, version: waVersion }, 'connected to WhatsApp')

      if (onConnected) {
        const user = sock?.user ? { id: sock.user.id, name: sock.user.name ?? null } : null
        // Never let a pairing-side failure knock the socket over.
        await Promise.resolve(onConnected(user)).catch(err =>
          logger.error({ err }, 'onConnected hook failed')
        )
      }
      return
    }

    if (connection !== 'close') return

    const error = disconnect?.error
    const statusCode = error?.output?.statusCode ?? error?.output?.payload?.statusCode
    lastDisconnect = {
      at: (disconnect?.date ?? new Date()).toISOString(),
      statusCode: statusCode ?? null,
      reason: Object.keys(DisconnectReason).find(key => DisconnectReason[key] === statusCode) ?? null,
      message: error?.message ?? null
    }
    logger.warn({ ...lastDisconnect }, 'connection closed')
    publishState()

    teardownSocket()
    if (stopped) return

    if (isSessionDead(statusCode)) {
      // Dead credentials can never reconnect; wipe them so a fresh QR is issued.
      await clearAuthState()
      await setQr(null)
      reconnectAttempts = 0
      scheduleReconnect(1000)
      return
    }

    if (statusCode === DisconnectReason.restartRequired) {
      // Expected right after a successful pairing, so no backoff.
      reconnectAttempts = 0
      scheduleReconnect(0)
      return
    }

    reconnectAttempts += 1
    scheduleReconnect(backoffDelay())
  }

  async function handleMessagesUpsert({ messages, type }) {
    if (type !== 'notify') return

    for (const msg of messages) {
      // Cached before the forwarding filter: a reply or a reaction needs the
      // original message even when it was never worth sending to a webhook.
      remember(msg)

      if (!shouldForward(msg)) continue

      const payload = buildWebhookPayload(msg, { sessionName: config.sessionName })
      logger.info(
        { from: payload.from, type: payload.type, isGroup: payload.isGroup },
        'incoming message'
      )

      if (onMessage) {
        // Persistence must not be able to stall or break the event stream.
        Promise.resolve(onMessage(payload, msg)).catch(err =>
          logger.error({ err }, 'onMessage hook failed')
        )
      }

      if (!webhook.enabled) continue
      // Not awaited on purpose: a slow receiver must not stall the event stream.
      webhook.deliver(payload).catch(err => logger.error({ err }, 'webhook sender threw'))
    }
  }

  async function start() {
    if (starting || stopped) return
    starting = true
    try {
      const { state, saveCreds } = await useMultiFileAuthState(authDir)

      if (!waVersion) {
        const { version, isLatest } = await fetchLatestBaileysVersion()
        waVersion = version
        logger.info({ version, isLatest }, 'using WhatsApp Web version')
      }

      connectionState = 'connecting'
      sock = makeWASocket({
        version: waVersion,
        logger: baileysLogger,
        browser: Browsers.ubuntu('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
        },
        msgRetryCounterCache,
        markOnlineOnConnect: false,
        // A full history sync is slow and useless to an HTTP bridge.
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        // Lets Baileys resend a message the peer failed to decrypt.
        getMessage: async key => sentMessages.get(key.id) ?? undefined
      })

      sock.ev.on('creds.update', () => {
        saveCreds().catch(err => logger.error({ err }, 'failed to persist creds'))
      })
      sock.ev.on('connection.update', update => {
        handleConnectionUpdate(update).catch(err =>
          logger.error({ err }, 'connection.update handler failed')
        )
      })
      sock.ev.on('messages.upsert', event => {
        handleMessagesUpsert(event).catch(err =>
          logger.error({ err }, 'messages.upsert handler failed')
        )
      })
    } catch (err) {
      connectionState = 'close'
      teardownSocket()
      reconnectAttempts += 1
      logger.error({ err, attempt: reconnectAttempts }, 'failed to start socket')
      if (!stopped) scheduleReconnect(backoffDelay())
    } finally {
      starting = false
    }
  }

  async function stop() {
    stopped = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    queue.clear('Server is shutting down.')
    teardownSocket()
    connectionState = 'close'
  }

  /**
   * Turn a recipient into the JID WhatsApp actually uses, by asking WhatsApp.
   *
   * Appending @s.whatsapp.net to whatever digits the caller typed is not enough:
   * a national number without its country code produces a syntactically valid
   * JID that belongs to nobody. WhatsApp accepts the stanza and silently drops
   * it, so the send reports success and the message never arrives. onWhatsApp
   * resolves the number using the linked account's own country, and returns the
   * real JID -- so we send where it says, or refuse.
   */
  async function resolveRecipient(jid) {
    if (!config.verifyRecipient) return jid
    // Groups and LIDs are already server-side identifiers; there is nothing to resolve.
    if (isGroupJid(jid) || jid.endsWith('@lid')) return jid

    const cached = recipientCache.get(jid)
    if (cached) return cached

    const active = requireConnection()
    const number = jidToNumber(jid)
    const results = await active.onWhatsApp(number)
    const match = results?.[0]

    if (!match?.exists || !match.jid) {
      throw new ApiError(
        404,
        'recipient_not_found',
        `${number} is not reachable on WhatsApp. If you left off the country code, add it (91 for India, so 91${number}).`,
        { number, checked: true }
      )
    }

    recipientCache.set(jid, match.jid)
    if (recipientCache.size > RECIPIENT_CACHE_LIMIT) {
      recipientCache.delete(recipientCache.keys().next().value)
    }
    if (match.jid !== jid) {
      logger.info({ from: jid, to: match.jid }, 'recipient resolved to a different jid')
    }
    return match.jid
  }

  /** Turn caller options into Baileys' send options. */
  function sendOptions({ replyTo } = {}) {
    return replyTo ? { quoted: requireRemembered(replyTo) } : {}
  }

  /**
   * Push a send through the global throttle, then remember it for retries.
   *
   * `resolve: false` skips the onWhatsApp lookup. Operations that act on an
   * existing message -- react, delete, edit, pin -- already hold the exact JID
   * of the conversation the message lives in, and re-resolving it could hand
   * back a different one, which would address the wrong chat.
   */
  async function enqueueSend(input, content, label, options = {}, { resolve = true } = {}) {
    const active = requireConnection()
    const jid = resolve ? await resolveRecipient(input) : input
    return queue.add(async () => {
      // Re-check: the connection may have dropped while this waited in the queue.
      if (!isConnected() || sock !== active) {
        throw ApiError.unavailable('WhatsApp disconnected while this message was queued.')
      }
      let sent
      try {
        sent = await sock.sendMessage(jid, content, options)
      } catch (err) {
        if (err instanceof ApiError) throw err
        // Baileys fetches a media URL itself, from this server. An unreachable
        // host surfaces as a bare TypeError, which would otherwise be reported
        // as an internal error when it is really the caller's URL that is wrong.
        const detail = [err?.message, err?.cause?.message].filter(Boolean).join(': ')
        if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|certificate|socket hang up/i.test(detail)) {
          throw ApiError.gateway(`Could not fetch the media: ${detail}`, {
            hint: 'The URL has to be publicly reachable from this server. Send base64 instead if it is not.'
          })
        }
        throw err
      }
      if (!sent) {
        throw ApiError.gateway('WhatsApp did not acknowledge the message.')
      }
      rememberSent(sent.key?.id, sent.message)
      remember(sent)
      return {
        id: sent.key?.id ?? null,
        to: jid,
        // Surfaced when WhatsApp resolved the recipient to a different JID than
        // the caller asked for -- usually a missing country code.
        ...(jid === input ? {} : { requested: input, resolved: true }),
        timestamp: sent.messageTimestamp ? Number(sent.messageTimestamp) : null
      }
    }, label)
  }

  return {
    start,
    stop,
    isConnected,

    get connectionState() {
      return connectionState
    },

    get state() {
      return publicState()
    },

    status() {
      return {
        state: publicState(),
        connection: connectionState,
        connected: isConnected(),
        user: sock?.user ? { id: sock.user.id, name: sock.user.name ?? null } : null,
        hasQr: Boolean(qrDataUrl),
        queued: queue.size,
        webhookConfigured: webhook.enabled,
        lastDisconnect
      }
    },

    /** The pairing QR as a data URL. Throws 409 when already paired. */
    getQr() {
      if (isConnected()) {
        throw ApiError.conflict('Already connected. POST /logout first if you want a new QR.', {
          user: sock?.user?.id ?? null
        })
      }
      if (!qrDataUrl) {
        throw ApiError.unavailable('No QR available yet. Retry in a few seconds.', {
          connection: connectionState
        })
      }
      return { qr, dataUrl: qrDataUrl, generatedAt: qrGeneratedAt }
    },

    sendText(jid, message, opts = {}) {
      const content = { text: message }
      if (opts.mentions?.length) content.mentions = opts.mentions
      if (opts.viewOnce) content.viewOnce = true
      // `null` is Baileys' way of suppressing the preview it would otherwise
      // generate; omitting the key is not the same thing.
      if (opts.linkPreview === false) content.linkPreview = null
      return enqueueSend(jid, content, 'text', sendOptions(opts))
    },

    /** Message the linked account itself. Handy for a self-test that bothers nobody. */
    sendToSelf(message) {
      const me = sock?.user?.id
      if (!me) throw ApiError.unavailable('Not connected, so there is no own JID to send to.')
      return enqueueSend(jidNormalizedUser(me), { text: message }, 'self')
    },

    sendMedia(jid, content, opts = {}) {
      const body = { ...content }
      if (opts.mentions?.length) body.mentions = opts.mentions
      if (opts.viewOnce) body.viewOnce = true
      return enqueueSend(jid, body, 'media', sendOptions(opts))
    },

    sendLocation(jid, { latitude, longitude, name, address }, opts = {}) {
      return enqueueSend(
        jid,
        {
          location: {
            degreesLatitude: latitude,
            degreesLongitude: longitude,
            ...(name ? { name } : {}),
            ...(address ? { address } : {})
          }
        },
        'location',
        sendOptions(opts)
      )
    },

    /** One or more contact cards. WhatsApp shows a single card differently from a list. */
    sendContacts(jid, { contacts, displayName }, opts = {}) {
      return enqueueSend(
        jid,
        {
          contacts: {
            displayName:
              displayName ??
              (contacts.length === 1 ? contacts[0].displayName : `${contacts.length} contacts`),
            contacts
          }
        },
        'contacts',
        sendOptions(opts)
      )
    },

    sendPoll(jid, poll, opts = {}) {
      return enqueueSend(jid, { poll }, 'poll', sendOptions(opts))
    },

    sendSticker(jid, { source, animated }, opts = {}) {
      return enqueueSend(
        jid,
        { sticker: source, ...(animated ? { isAnimated: true } : {}) },
        'sticker',
        sendOptions(opts)
      )
    },

    sendAudio(jid, { source, voiceNote, seconds, mimetype }, opts = {}) {
      return enqueueSend(
        jid,
        {
          audio: source,
          ptt: Boolean(voiceNote),
          // A voice note must be opus or WhatsApp renders it as a file attachment
          // with no waveform, which is not what the caller asked for.
          mimetype: mimetype ?? (voiceNote ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
          ...(seconds ? { seconds } : {})
        },
        'audio',
        sendOptions(opts)
      )
    },

    /** React to a message. An empty emoji removes an existing reaction. */
    react(jid, { messageId, emoji, fromMe }) {
      const key = keyFor({ messageId, jid, fromMe })
      return enqueueSend(jid, { react: { text: emoji, key } }, 'reaction', {}, { resolve: false })
    },

    /** Delete for everyone. Deleting someone else's message needs group admin. */
    deleteMessage(jid, { messageId, fromMe }) {
      const key = keyFor({ messageId, jid, fromMe })
      return enqueueSend(jid, { delete: key }, 'delete', {}, { resolve: false })
    },

    /** Edit your own message. WhatsApp only allows this within ~15 minutes. */
    editMessage(jid, { messageId, text }) {
      const key = keyFor({ messageId, jid, fromMe: true })
      if (!key.fromMe) throw ApiError.badRequest('You can only edit your own messages.')
      return enqueueSend(jid, { text, edit: key }, 'edit', {}, { resolve: false })
    },

    /** Forward a message this server has seen recently to another chat. */
    forwardMessage(jid, { messageId }) {
      return enqueueSend(jid, { forward: requireRemembered(messageId) }, 'forward')
    },

    /** Pin or unpin a message in the chat, for 24h, 7d or 30d. */
    pinMessage(jid, { messageId, fromMe, unpin = false, seconds = 604800 }) {
      const key = keyFor({ messageId, jid, fromMe })
      return enqueueSend(
        jid,
        {
          pin: key,
          type: unpin ? proto.PinInChat.Type.UNPIN_FOR_ALL : proto.PinInChat.Type.PIN_FOR_ALL,
          time: seconds
        },
        unpin ? 'unpin' : 'pin',
        {},
        { resolve: false }
      )
    },

    async checkNumber(number) {
      const active = requireConnection()
      const results = await active.onWhatsApp(number)
      const match = results?.[0]
      return { number, exists: Boolean(match?.exists), jid: match?.jid ?? null }
    },

    async logout() {
      const active = sock
      try {
        if (active && isConnected()) await active.logout()
      } catch (err) {
        // A failed remote logout still means we want the local session gone.
        logger.warn({ err }, 'remote logout failed, clearing local session anyway')
      }

      teardownSocket()
      connectionState = 'close'
      sentMessages.clear()
      await setQr(null)
      await clearAuthState()

      reconnectAttempts = 0
      // Let WhatsApp settle before we start pairing again.
      await sleep(500)
      await start()
      return { loggedOut: true }
    }
  }
}
