import { randomBytes } from 'node:crypto'
import { ApiError } from './errors.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'pairing' })

/**
 * The "Link WhatsApp" flow, modelled on WhatsApp Web itself: possession of the
 * phone is the credential. A browser opens a claim, shows the QR, and the phone
 * that scans it proves the operator is present -- so on a successful pairing we
 * mint a device token and hand it back to that claim.
 *
 * The claim id is the reason a second browser watching the same pairing cannot
 * pick up the token: it is generated per attempt and never leaves the opener.
 */
export function createPairingFlow({ client, tokens, ttlMs, deliverToPhone }) {
  /** @type {Map<string, {state: string, createdAt: number, token: string|null, user: object|null}>} */
  const claims = new Map()

  function sweep() {
    const now = Date.now()
    for (const [id, claim] of claims) {
      if (now - claim.createdAt > ttlMs) claims.delete(id)
    }
  }

  return {
    /** Begin a pairing attempt. Returns the claim id the browser polls with. */
    start() {
      sweep()
      if (client.isConnected()) {
        throw ApiError.conflict('Already linked to WhatsApp. Log out first to link a different phone.', {
          user: client.status().user?.id ?? null
        })
      }

      const claimId = randomBytes(18).toString('base64url')
      claims.set(claimId, { state: 'awaiting_scan', createdAt: Date.now(), token: null, user: null })
      log.info({ claimId: claimId.slice(0, 6) + '…' }, 'pairing claim opened')
      return { claimId, expiresInMs: ttlMs }
    },

    /**
     * Poll a claim. While unpaired this carries the current QR; once the phone
     * has scanned, it carries the freshly minted token exactly once.
     */
    status(claimId) {
      sweep()
      const claim = claims.get(claimId)
      if (!claim) {
        return { state: 'expired', message: 'This pairing attempt expired. Start a new one.' }
      }

      if (claim.state === 'paired') {
        const token = claim.token
        // Hand the plaintext over once, then forget it.
        claim.token = null
        return {
          state: 'paired',
          user: claim.user,
          ...(token ? { token } : { tokenAlreadyCollected: true })
        }
      }

      let qr = null
      try {
        qr = client.getQr().dataUrl
      } catch {
        // No QR yet, or the socket paired between the two calls; either way the
        // next poll resolves it.
      }
      return { state: 'awaiting_scan', qr }
    },

    /**
     * Called when the socket reaches 'open'. Only mints a token if a browser is
     * actually waiting on a claim -- an ordinary reconnect must not create one.
     */
    async onConnected(user) {
      sweep()
      const waiting = [...claims.entries()].filter(([, c]) => c.state === 'awaiting_scan')
      if (!waiting.length) return

      const { token } = await tokens.create('console')
      for (const [, claim] of waiting) {
        claim.state = 'paired'
        claim.token = token
        claim.user = user
      }
      log.info({ claims: waiting.length }, 'pairing succeeded, device token minted')

      if (deliverToPhone) {
        // Best effort: the browser already has the token, so a failed send here
        // is an inconvenience, not a broken flow.
        client
          .sendToSelf(
            'Your WhatsApp API token\n\n' +
              token +
              '\n\nUse it as the x-api-key header. Anyone with this token can send messages as you ' +
              'and it will not be shown again. Delete this message once you have stored it; ' +
              'POST /logout revokes it.'
          )
          .then(() => log.info('token delivered to the linked phone'))
          .catch(err => log.warn({ err: err.message }, 'could not deliver the token to the phone'))
      }
    }
  }
}
