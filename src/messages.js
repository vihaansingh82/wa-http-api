import { isJidGroup, isJidStatusBroadcast, isJidBroadcast, toNumber } from 'baileys'
import { jidToNumber } from './jid.js'

/** Wrappers that hold the real content one level down. */
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage']

/** Peel ephemeral/view-once/edited wrappers until we reach the actual content. */
export function unwrapMessage(content) {
  let current = content
  for (let depth = 0; current && depth < 5; depth++) {
    const wrapper = WRAPPERS.find(key => current[key]?.message)
    if (!wrapper) break
    current = current[wrapper].message
  }
  return current ?? undefined
}

/** The `messageContextInfo` key is metadata, never the message type. */
const IGNORED_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage'])

export function getMessageType(content) {
  if (!content) return 'unknown'
  const keys = Object.keys(content).filter(key => !IGNORED_KEYS.has(key) && content[key] != null)
  return keys[0] ?? 'unknown'
}

/** Best-effort human-readable text for any message type. */
export function getMessageText(content) {
  if (!content) return null
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.reactionMessage?.text ||
    content.pollCreationMessage?.name ||
    content.eventMessage?.name ||
    null
  )
}

/**
 * Decide whether an upserted message should reach the webhook.
 * We skip our own sends, status broadcasts and protocol-only stanzas.
 */
export function shouldForward(msg) {
  if (!msg?.key) return false
  if (msg.key.fromMe) return false

  const remoteJid = msg.key.remoteJid
  if (!remoteJid) return false
  if (isJidStatusBroadcast(remoteJid) || isJidBroadcast(remoteJid)) return false

  return Boolean(unwrapMessage(msg.message))
}

/** Shape the webhook payload. */
export function buildWebhookPayload(msg, { sessionName } = {}) {
  const content = unwrapMessage(msg.message)
  const remoteJid = msg.key.remoteJid
  const isGroup = Boolean(isJidGroup(remoteJid))
  // In a group, `participant` is the actual sender; in a 1:1 chat it is the chat itself.
  const senderJid = isGroup ? (msg.key.participant ?? msg.participant ?? null) : remoteJid

  return {
    session: sessionName,
    id: msg.key.id ?? null,
    from: remoteJid,
    fromNumber: isGroup ? null : jidToNumber(remoteJid),
    isGroup,
    groupJid: isGroup ? remoteJid : null,
    participant: senderJid,
    participantNumber: senderJid ? jidToNumber(senderJid) : null,
    pushName: msg.pushName ?? null,
    // messageTimestamp arrives as a protobuf Long; toNumber() handles both shapes.
    timestamp: msg.messageTimestamp ? toNumber(msg.messageTimestamp) : null,
    type: getMessageType(content),
    text: getMessageText(content),
    receivedAt: new Date().toISOString()
  }
}
