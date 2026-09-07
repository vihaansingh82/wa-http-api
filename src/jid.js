import { isJidGroup, jidNormalizedUser } from 'baileys'
import { ApiError } from './errors.js'

const USER_SERVERS = new Set(['s.whatsapp.net', 'c.us', 'lid'])
const MIN_DIGITS = 7
const MAX_DIGITS = 15 // E.164 maximum

/**
 * Turn a loosely formatted recipient into a JID Baileys will accept.
 *
 * Accepts:
 *   "+91 98765 43210", "(91) 98765-43210", "919876543210"  -> "919876543210@s.whatsapp.net"
 *   "919876543210@s.whatsapp.net", "...@c.us", "...@lid"   -> normalised user JID
 *   "1234567890-1234567890@g.us"                           -> passed through untouched
 *
 * Throws ApiError(400) on anything it cannot make sense of.
 */
export function normaliseJid(input, field = 'to') {
  if (typeof input !== 'string') {
    throw ApiError.badRequest(`"${field}" must be a string.`)
  }

  const value = input.trim()
  if (!value) {
    throw ApiError.badRequest(`"${field}" must not be empty.`)
  }

  if (value.includes('@')) {
    // Group JIDs are opaque server-side identifiers -- never rewrite them.
    if (isJidGroup(value)) return value

    const server = value.slice(value.lastIndexOf('@') + 1).toLowerCase()
    if (!USER_SERVERS.has(server)) {
      throw ApiError.badRequest(
        `"${field}" has unsupported JID server "@${server}". Use a phone number, @s.whatsapp.net, @lid or @g.us.`
      )
    }

    const normalised = jidNormalizedUser(value)
    if (!normalised || normalised.startsWith('@')) {
      throw ApiError.badRequest(`"${field}" is not a valid JID.`)
    }
    return normalised
  }

  let digits = value.replace(/\D/g, '')
  // "00" is an international dialling prefix, not part of the number.
  if (digits.startsWith('00')) digits = digits.slice(2)

  if (!digits) {
    throw ApiError.badRequest(`"${field}" contains no digits.`)
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    throw ApiError.badRequest(
      `"${field}" must contain ${MIN_DIGITS}-${MAX_DIGITS} digits including the country code (got ${digits.length}).`
    )
  }

  return `${digits}@s.whatsapp.net`
}

/** The bare digits of a user JID, for onWhatsApp lookups and webhook payloads. */
export function jidToNumber(jid) {
  const user = jid.split('@')[0] ?? ''
  return user.split(':')[0] ?? ''
}

export const isGroupJid = jid => Boolean(isJidGroup(jid))
