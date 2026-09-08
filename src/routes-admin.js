import express from 'express'
import { ApiError } from './errors.js'
import { requireBody, requireEnum } from './validate.js'

/**
 * Service management. Every route here is admin-and-session-only, enforced by
 * the middleware the router is mounted behind.
 */
export function adminRoutes(tenants, store) {
  const {
    adminOverview, deleteAccount, invalidateTokenCache, listAudit, listProfiles,
    listSessionStates, updateProfile, usageSeries, writeAudit
  } = store

  const router = express.Router()

  router.get('/overview', async (_req, res) => {
    const [counts, usage] = await Promise.all([adminOverview(), usageSeries(null, 14)])
    // Roll the per-tenant daily rows up into one series for the whole service.
    const byDay = new Map()
    for (const row of usage) {
      const day = byDay.get(row.day) ?? { day: row.day, sent: 0, received: 0, failed: 0 }
      day.sent += row.sent
      day.received += row.received
      day.failed += row.failed
      byDay.set(row.day, day)
    }
    res.json({
      ...counts,
      usage: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
      process: {
        liveSessions: tenants.size,
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: Math.round(process.memoryUsage().rss / 1048576)
      }
    })
  })

  router.get('/accounts', async (_req, res) => {
    const [profiles, sessions] = await Promise.all([listProfiles(), listSessionStates()])
    const byUser = new Map(sessions.map(row => [row.user_id, row]))
    const liveIds = new Set(tenants.liveSummary().map(entry => entry.userId))

    res.json(
      profiles.map(profile => ({
        ...profile,
        session: byUser.get(profile.id)
          ? {
              state: byUser.get(profile.id).state,
              waJid: byUser.get(profile.id).wa_jid,
              waName: byUser.get(profile.id).wa_name,
              lastConnectedAt: byUser.get(profile.id).last_connected_at,
              lastError: byUser.get(profile.id).last_error
            }
          : null,
        // The database says what it last saw; this says whether a socket is
        // actually running in this process right now. They can disagree after a
        // restart, and the admin needs to be able to tell.
        liveInProcess: liveIds.has(profile.id)
      }))
    )
  })

  router.patch('/accounts/:id', async (req, res) => {
    const body = requireBody(req.body)
    const patch = {}
    if (body.role !== undefined) patch.role = requireEnum(body, 'role', ['admin', 'client'])
    if (body.status !== undefined) patch.status = requireEnum(body, 'status', ['active', 'suspended'])
    if (body.company !== undefined) patch.company = String(body.company).slice(0, 120)
    if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to update.')

    // An admin removing their own admin rights, or suspending themselves, locks
    // them out with no way back through the UI.
    if (req.params.id === req.profile.id) {
      if (patch.role === 'client') throw ApiError.conflict('You cannot remove your own admin role.')
      if (patch.status === 'suspended') throw ApiError.conflict('You cannot suspend your own account.')
    }

    if (patch.role === 'client' || patch.status === 'suspended') {
      const profiles = await listProfiles()
      const otherActiveAdmins = profiles.filter(
        p => p.id !== req.params.id && p.role === 'admin' && p.status === 'active'
      )
      if (!otherActiveAdmins.length) {
        throw ApiError.conflict('That is the only active admin. Promote another one first.')
      }
    }

    const updated = await updateProfile(req.params.id, patch)

    // A suspended client must lose their live socket immediately, not whenever
    // their token happens to expire.
    if (patch.status === 'suspended') {
      await tenants.stop(req.params.id)
      invalidateTokenCache(req.params.id)
    }

    await writeAudit({
      userId: req.params.id,
      actor: req.profile.email,
      action: 'admin.account.update',
      detail: patch
    })
    res.json(updated)
  })

  router.delete('/accounts/:id', async (req, res) => {
    if (req.params.id === req.profile.id) {
      throw ApiError.conflict('You cannot delete your own account.')
    }
    await tenants.stop(req.params.id)
    const result = await deleteAccount(req.params.id)
    await writeAudit({
      userId: null,
      actor: req.profile.email,
      action: 'admin.account.delete',
      detail: { id: req.params.id }
    })
    res.json(result)
  })

  router.get('/sessions', async (_req, res) => {
    const stored = await listSessionStates()
    res.json({
      live: tenants.liveSummary(),
      stored: stored.map(row => ({
        userId: row.user_id,
        email: row.profiles?.email,
        company: row.profiles?.company,
        state: row.state,
        waJid: row.wa_jid,
        waName: row.wa_name,
        lastConnectedAt: row.last_connected_at,
        lastError: row.last_error,
        updatedAt: row.updated_at
      }))
    })
  })

  router.post('/sessions/:userId/stop', async (req, res) => {
    const stopped = await tenants.stop(req.params.userId)
    await writeAudit({
      userId: req.params.userId,
      actor: req.profile.email,
      action: 'admin.session.stop'
    })
    res.json({ stopped })
  })

  router.post('/sessions/:userId/start', async (req, res) => {
    const client = await tenants.ensure(req.params.userId)
    await writeAudit({
      userId: req.params.userId,
      actor: req.profile.email,
      action: 'admin.session.start'
    })
    res.status(202).json({ state: client.state })
  })

  router.get('/audit', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500)
    res.json(await listAudit({ limit }))
  })

  return router
}
