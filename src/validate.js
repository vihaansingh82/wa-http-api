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
export function buildMediaContent({ type, url, caption, mimetype, fileName }) {
  const source = { url: url.toString() }

  if (type === 'image') {
    return { image: source, ...(caption ? { caption } : {}), ...(mimetype ? { mimetype } : {}) }
  }

  if (type === 'video') {
    return { video: source, ...(caption ? { caption } : {}), ...(mimetype ? { mimetype } : {}) }
  }

  return {
    document: source,
    mimetype: mimetype ?? mimeTypeFromUrl(url),
    fileName: fileName ?? fileNameFromUrl(url),
    ...(caption ? { caption } : {})
  }
}
