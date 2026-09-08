import path from 'node:path'
import { ApiError } from './errors.js'

/** Reject anything that is not a plain JSON object body. */
export function requireBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('Request body must be a JSON object.')
  }
  return body
}

export function requireString(body, field, { maxLength = 4096, minLength = 1 } = {}) {
  const value = body[field]
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`"${field}" is required and must be a string.`)
  }
  const trimmed = value.trim()
  if (trimmed.length < minLength) {
    throw ApiError.badRequest(`"${field}" must not be empty.`)
  }
  if (value.length > maxLength) {
    throw ApiError.badRequest(`"${field}" must be at most ${maxLength} characters.`)
  }
  return value
}

export function optionalString(body, field, { maxLength = 1024 } = {}) {
  const value = body[field]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw ApiError.badRequest(`"${field}" must be a string when provided.`)
  }
  if (value.length > maxLength) {
    throw ApiError.badRequest(`"${field}" must be at most ${maxLength} characters.`)
  }
  return value
}

export function requireEnum(body, field, allowed) {
  const value = body[field]
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw ApiError.badRequest(`"${field}" must be one of: ${allowed.join(', ')}.`)
  }
  return value
}

/**
 * Validate a media URL. Only http(s) is allowed -- file:// and friends would let
 * a caller read the container filesystem through Baileys.
 */
export function requireHttpUrl(body, field = 'url') {
  const raw = requireString(body, field, { maxLength: 2048 })
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw ApiError.badRequest(`"${field}" must be a valid absolute URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw ApiError.badRequest(`"${field}" must use http or https, got "${parsed.protocol}".`)
  }
  return parsed
}

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
}

export function fileNameFromUrl(url) {
  const base = path.posix.basename(decodeURIComponent(url.pathname))
  return base && base !== '/' ? base : 'file'
}

export function mimeTypeFromUrl(url, fallback = 'application/octet-stream') {
  const ext = path.posix.extname(url.pathname).toLowerCase()
  return MIME_BY_EXTENSION[ext] ?? fallback
}

export const MEDIA_TYPES = ['image', 'video', 'document']

/**
 * Turn a validated /send/media body into the content object Baileys expects.
 * `document` is the only type where mimetype is mandatory, so we derive one
 * from the URL when the caller did not supply it.
 */
export function buildMediaContent({ type, source, caption, mimetype, fileName, gif }) {
  const withCaption = caption ? { caption } : {}

  if (type === 'image') {
    return { image: source, ...withCaption, ...(mimetype ? { mimetype } : {}) }
  }

  if (type === 'video') {
    // gifPlayback loops it silently and labels it GIF. The file is still an mp4:
    // WhatsApp has not accepted real .gif uploads for years, so a caller sending
    // an actual .gif gets a still image unless it is converted first.
    return {
      video: source,
      ...withCaption,
      ...(gif ? { gifPlayback: true } : {}),
      ...(mimetype ? { mimetype } : {})
    }
  }

  return {
    document: source,
    // Required by Baileys for a document, so it always gets a value -- an
    // unknown type is better than a rejected send.
    mimetype: mimetype ?? 'application/octet-stream',
    fileName: fileName ?? 'file',
    ...withCaption
  }
}

// ===========================================================================
// Richer message types
// ===========================================================================

/**
 * Where the bytes for a media message come from.
 *
 * Two shapes are accepted, and exactly one must be present:
 *   { url: "https://…" }            -> Baileys streams it from the URL
 *   { base64: "…" } or a data: URI  -> decoded here into a Buffer
 *
 * Returning Baileys' own WAMediaUpload shape means the caller does not have to
 * care which was used.
 */
export function mediaSource(body, { maxBytes }) {
  const raw = typeof body.base64 === 'string' && body.base64 ? body.base64 : body.url

  if (typeof raw !== 'string' || !raw.trim()) {
    throw ApiError.badRequest('Provide either "url" (http/https) or "base64" for the media.')
  }

  // A data: URI can arrive in either field; treat both the same way.
  const dataUri = /^data:([^;,]*)(;[^,]*)?,/.exec(raw)
  if (dataUri || body.base64) {
    let payload = raw
    let mimetype = null

    if (dataUri) {
      if (!/;base64/i.test(dataUri[2] ?? '')) {
        throw ApiError.badRequest('Only base64-encoded data URIs are supported.')
      }
      mimetype = dataUri[1] || null
      payload = raw.slice(dataUri[0].length)
    }

    // Reject before decoding: base64 is 4/3 the size of the bytes it carries,
    // so this bounds the allocation rather than discovering it afterwards.
    if (payload.length > Math.ceil((maxBytes * 4) / 3) + 4) {
      throw ApiError.badRequest(`Media is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`)
    }
    if (!/^[A-Za-z0-9+/\r\n=_-]+$/.test(payload)) {
      throw ApiError.badRequest('"base64" is not valid base64.')
    }

    const buffer = Buffer.from(payload, 'base64')
    if (!buffer.length) throw ApiError.badRequest('"base64" decoded to nothing.')
    if (buffer.length > maxBytes) {
      throw ApiError.badRequest(`Media is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`)
    }
    return { source: buffer, mimetype, fileName: null }
  }

  const url = requireHttpUrl({ url: raw }, 'url')
  return { source: { url: url.toString() }, mimetype: mimeTypeFromUrl(url, null), fileName: fileNameFromUrl(url) }
}

/** A coordinate, rejecting the strings and NaNs that JSON happily carries. */
export function requireCoordinate(body, field, limit) {
  const value = body[field]
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || Math.abs(n) > limit) {
    throw ApiError.badRequest(`"${field}" must be a number between -${limit} and ${limit}.`)
  }
  return n
}

/** Optional positive integer, for things like a voice note's duration. */
export function optionalInt(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = body[field]
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw ApiError.badRequest(`"${field}" must be an integer between ${min} and ${max}.`)
  }
  return n
}

/** A list of JIDs to mention, normalised the same way a recipient is. */
export function optionalMentions(body, normalise) {
  const value = body.mentions
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw ApiError.badRequest('"mentions" must be an array of numbers or JIDs.')
  if (value.length > 64) throw ApiError.badRequest('"mentions" is limited to 64 entries.')
  return value.map((entry, i) => normalise(entry, `mentions[${i}]`))
}

// vCard is a line-based format: a raw comma, semicolon or newline inside a
// value would end the field early and corrupt the card.
const VCARD_ESCAPE = value =>
  String(value)
    .replace(/([,;\\])/g, '\\$1')
    .replace(/\r?\n/g, '\\n')

/**
 * Build the vCard WhatsApp expects for a contact card.
 *
 * The `waid=` parameter on TEL is what makes the card resolve to a real
 * WhatsApp account on the recipient's phone; without it the card still arrives
 * but is inert, which looks like a bug to whoever receives it.
 */
export function buildVCard({ fullName, number, organization, email }) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${VCARD_ESCAPE(fullName)}`,
    `N:;${VCARD_ESCAPE(fullName)};;;`
  ]
  if (organization) lines.push(`ORG:${VCARD_ESCAPE(organization)};`)
  if (email) lines.push(`EMAIL;type=INTERNET:${VCARD_ESCAPE(email)}`)
  lines.push(`TEL;type=CELL;type=VOICE;waid=${number}:+${number}`)
  lines.push('END:VCARD')
  return lines.join('\n')
}

/** Validate the `contacts` array of a contact-card send. */
export function requireContactCards(body, jidToNumber, normalise) {
  const list = Array.isArray(body.contacts) ? body.contacts : [body]
  if (!list.length) throw ApiError.badRequest('"contacts" must contain at least one contact.')
  if (list.length > 25) throw ApiError.badRequest('"contacts" is limited to 25 entries.')

  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw ApiError.badRequest(`"contacts[${i}]" must be an object.`)
    }
    const number = jidToNumber(normalise(entry.number ?? entry.phone ?? entry.jid, `contacts[${i}].number`))
    const fullName = requireString(entry, 'fullName' in entry ? 'fullName' : 'name', { maxLength: 120 })
    return {
      displayName: fullName,
      vcard: buildVCard({
        fullName,
        number,
        organization: optionalString(entry, 'organization', { maxLength: 120 }),
        email: optionalString(entry, 'email', { maxLength: 200 })
      })
    }
  })
}

/** Poll question and options. WhatsApp itself caps a poll at 12 options. */
export function requirePoll(body) {
  const name = requireString(body, 'question' in body ? 'question' : 'name', { maxLength: 255 })
  const values = body.options ?? body.values
  if (!Array.isArray(values) || values.length < 2) {
    throw ApiError.badRequest('"options" must be an array of at least 2 choices.')
  }
  if (values.length > 12) throw ApiError.badRequest('"options" is limited to 12 choices.')

  const seen = new Set()
  const cleaned = values.map((value, i) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw ApiError.badRequest(`"options[${i}]" must be a non-empty string.`)
    }
    if (value.length > 100) throw ApiError.badRequest(`"options[${i}]" must be at most 100 characters.`)
    // WhatsApp silently drops a poll with duplicate options rather than erroring.
    if (seen.has(value)) throw ApiError.badRequest(`"options" contains "${value}" twice.`)
    seen.add(value)
    return value
  })

  const selectableCount = optionalInt(body, 'selectableCount', { min: 1, max: cleaned.length }) ?? 1
  return { name, values: cleaned, selectableCount }
}

/**
 * A single emoji for a reaction. An empty string is meaningful -- it is how
 * WhatsApp removes a reaction -- so it is allowed through deliberately.
 */
export function requireReaction(body, field = 'emoji') {
  const value = body[field]
  if (value === '' || value === null) return ''
  if (typeof value !== 'string') throw ApiError.badRequest(`"${field}" must be a string.`)
  // Grapheme count, not code units: one emoji is often several code points.
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
  if (graphemes.length !== 1) {
    throw ApiError.badRequest(`"${field}" must be exactly one emoji, or "" to remove the reaction.`)
  }
  return value
}
