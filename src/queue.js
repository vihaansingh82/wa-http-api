import { ApiError } from './errors.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Serial FIFO queue that guarantees at least `minDelayMs` between the start of
 * two tasks. Everything outgoing goes through here: WhatsApp bans accounts that
 * fire messages back to back, so a single global throttle is the point.
 */
export function createSendQueue({ minDelayMs, maxSize, logger }) {
  /** @type {{ task: () => Promise<any>, label: string, resolve: Function, reject: Function }[]} */
  const pending = []
  let draining = false
  let lastStartedAt = 0

  async function drain() {
    if (draining) return
    draining = true
    try {
      while (pending.length) {
        const item = pending.shift()
        const wait = Math.max(0, lastStartedAt + minDelayMs - Date.now())
        if (wait > 0) await sleep(wait)

        lastStartedAt = Date.now()
        try {
          item.resolve(await item.task())
        } catch (err) {
          item.reject(err)
        }
      }
    } finally {
      draining = false
    }
  }

  return {
    /** Queue a send. Resolves with the task's value, rejects with the task's error. */
    add(task, label = 'send') {
      if (pending.length >= maxSize) {
        logger?.warn({ queued: pending.length, label }, 'send queue full, rejecting')
        return Promise.reject(
          ApiError.unavailable(`Send queue is full (${maxSize} waiting). Retry shortly.`, {
            queued: pending.length
          })
        )
      }

      return new Promise((resolve, reject) => {
        pending.push({ task, label, resolve, reject })
        // drain() never rejects, but keep the process safe from a stray rejection.
        drain().catch(err => logger?.error({ err }, 'send queue drain failed'))
      })
    },

    get size() {
      return pending.length
    },

    /** Reject everything still waiting -- used on shutdown. */
    clear(reason) {
      const err = ApiError.unavailable(reason)
      while (pending.length) pending.shift().reject(err)
    }
  }
}
