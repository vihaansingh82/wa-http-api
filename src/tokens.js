import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from './logger.js'

const log = logger.child({ module: 'tokens' })

const PREFIX = 'wa_'
const sha256 = value => createHash('sha256').update(value).digest('hex')

/**
 * Device tokens minted after a successful WhatsApp pairing.
 *
 * Only the SHA-256 of each token is persisted, so the store file is not a
 * credential dump -- a leaked copy cannot be replayed against the API. The
 * plaintext exists exactly once, in the response that mints it.
 */
export function createTokenStore(filePath) {
  /** @type {Map<string, {hash: string, label: string, createdAt: string, lastUsedAt: string|null}>} */
  const tokens = new Map()
  let loaded = false

  async function writeNow() {
    const payload = JSON.stringify(
      { version: 1, tokens: [...tokens.entries()].map(([id, meta]) => ({ id, ...meta })) },
      null,
      2
    )
    await mkdir(path.dirname(filePath), { recursive: true })
    // Write-then-rename so a crash mid-write cannot truncate the store. The
    // random suffix matters: two writes from this same process would otherwise
    // share a temp path and clobber each other.
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, filePath)
  }

  // Writes are serialised. A lastUsedAt touch can land at the same moment as a
  // revoke, and interleaving the two produced a corrupt file.
  let writeChain = Promise.resolve()
  function persist() {
    writeChain = writeChain.then(writeNow, writeNow)
    return writeChain
  }

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(await readFile(filePath, 'utf8'))
      for (const { id, ...meta } of raw.tokens ?? []) tokens.set(id, meta)
      log.info({ count: tokens.size }, 'loaded device tokens')
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn({ err }, 'could not read the token store, starting empty')
      }
    }
  }

  return {
    load,

    /** Mint a token. The plaintext is returned once and never stored. */
    async create(label = 'console') {
      await load()
      const id = randomBytes(6).toString('hex')
      const plaintext = PREFIX + randomBytes(32).toString('base64url')
      tokens.set(id, {
        hash: sha256(plaintext),
        label,
        createdAt: new Date().toISOString(),
        lastUsedAt: null
      })
      await persist()
      log.info({ id, label }, 'minted a device token')
      return { id, token: plaintext }
    },

    /**
     * Is this a live token? Compares hashes, which are fixed length, so the
     * timing-safe compare is meaningful.
     */
    verify(provided) {
      if (typeof provided !== 'string' || !provided.startsWith(PREFIX)) return false
      const candidate = Buffer.from(sha256(provided), 'hex')

      for (const [id, meta] of tokens) {
        const known = Buffer.from(meta.hash, 'hex')
        if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
          meta.lastUsedAt = new Date().toISOString()
          // Fire and forget: a failed timestamp write must not fail the request.
          persist().catch(err => log.debug({ err }, 'could not persist lastUsedAt'))
          return id
        }
      }
      return false
    },

    /** Drop every token. Called on logout: no session means no valid devices. */
    async revokeAll() {
      await load()
      const count = tokens.size
      tokens.clear()
      await persist()
      if (count) log.info({ count }, 'revoked all device tokens')
      return count
    },

    /** Metadata only -- never the hashes. */
    list() {
      return [...tokens.entries()].map(([id, meta]) => ({
        id,
        label: meta.label,
        createdAt: meta.createdAt,
        lastUsedAt: meta.lastUsedAt
      }))
    },

    get size() {
      return tokens.size
    }
  }
}
