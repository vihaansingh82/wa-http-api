const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 4xx other than 429 means our payload is wrong -- retrying will not help. */
const isRetryableStatus = status => status === 408 || status === 429 || status >= 500

/**
 * Fire-and-forget webhook delivery with bounded retries.
 * `deliver()` NEVER rejects: a broken receiver must not take the bridge down.
 */
export function createWebhookSender({ url, secret, timeoutMs, maxAttempts, logger }) {
  const enabled = Boolean(url)

  async function attempt(payload, attemptNo) {
    const headers = { 'content-type': 'application/json', 'user-agent': 'wa-http-api/1.0' }
    if (secret) headers['x-webhook-secret'] = secret

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })

    if (!res.ok) {
      const err = new Error(`webhook responded ${res.status}`)
      err.status = res.status
      err.retryable = isRetryableStatus(res.status)
      throw err
    }

    logger.debug({ attemptNo, status: res.status }, 'webhook delivered')
  }

  return {
    enabled,

    async deliver(payload) {
      if (!enabled) return false

      for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
        try {
          await attempt(payload, attemptNo)
          return true
        } catch (err) {
          const retryable = err.retryable !== false
          const last = attemptNo === maxAttempts || !retryable

          logger[last ? 'error' : 'warn'](
            { err: err.message, status: err.status, attemptNo, maxAttempts, retryable },
            last ? 'webhook delivery failed, giving up' : 'webhook delivery failed, retrying'
          )

          if (last) return false
          // 500ms, 1s, 2s, ... capped so a slow receiver cannot stall us for long.
          await sleep(Math.min(500 * 2 ** (attemptNo - 1), 8000))
        }
      }
      return false
    }
  }
}
