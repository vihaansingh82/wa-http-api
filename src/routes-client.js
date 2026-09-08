import express from 'express'
import { ApiError } from './errors.js'
import { normaliseJid, isGroupJid, jidToNumber } from './jid.js'
import {
  MEDIA_TYPES,
  buildMediaContent,
  optionalString,
  requireBody,
  requireEnum,
  requireHttpUrl,
  requireString
} from './validate.js'

/**
 * Everything a client can do with their own account. Every handler is scoped to
 * `req.profile.id` -- the service-role key bypasses row-level security, so this
 * layer is the only thing keeping one tenant out of another's data. There is no
 * route here that takes a user id from the caller.
 */
export function clientRoutes(tenants, store) {
  const {
    admin, createApiKey, listApiKeys, listMessages, listThreads, markThreadRead,
    revokeApiKey, updateProfile, usageSeries, writeAudit
  } = store

  const router = express.Router()

  const me = req => req.profile.id

  // ---- account ------------------------------------------------------------
  router.get('/me', (req, res) => {
    res.json({
      id: req.profile.id,
      email: req.profile.email,
      fullName: req.profile.full_name,
      company: req.profile.company,
      role: req.profile.role,
      status: req.profile.status,
      createdAt: req.profile.created_at,
      authKind: req.authKind
    })
  })

  router.patch('/me', async (req, res) => {
    const body = requireBody(req.body)
    const patch = {}
    const fullName = optionalString(body, 'fullName', { maxLength: 120 })
    const company = optionalString(body, 'company', { maxLength: 120 })
    if (fullName !== undefined) patch.full_name = fullName
    if (company !== undefined) patch.company = company
    // role and status are deliberately not accepted here: a client changing
    // their own role is privilege escalation, and the database trigger would
    // reject it anyway.
    res.json(await updateProfile(me(req), patch))
  })

  // ---- WhatsApp session ---------------------------------------------------
  router.get('/session', async (req, res) => {
    res.json(await tenants.stateFor(me(req)))
  })

  router.post('/session/start', async (req, res) => {
    const client = await tenants.ensure(me(req))
    await writeAudit({ userId: me(req), actor: req.profile.email, action: 'session.start' })
    res.status(202).json({ ...client.status(), starting: true })
  })

  router.get('/session/qr', async (req, res) => {
    // Starting on demand: a client opening the dashboard for the first time
    // should get a QR without having to press something else first.
    const client = await tenants.ensure(me(req))
    if (client.isConnected()) {
      throw ApiError.conflict('Already linked. Log out first to link a different phone.')
    }
    const status = client.status()
    if (!status.hasQr) {
      throw ApiError.unavailable('No QR yet, retry in a few seconds.', { state: client.state })
    }
    const { qr, dataUrl, generatedAt } = client.getQr()
    res.json({ qr, dataUrl, generatedAt })
  })

  router.post('/session/logout', async (req, res) => {
    const client = tenants.peek(me(req))
    if (!client) {
      await tenants.stop(me(req))
      return res.json({ loggedOut: true, note: 'No live session; nothing to disconnect.' })
    }
    const result = await client.logout()
    await writeAudit({ userId: me(req), actor: req.profile.email, action: 'session.logout' })
    res.json(result)
  })

  // ---- API keys -----------------------------------------------------------
  router.get('/keys', async (req, res) => {
    res.json(await listApiKeys(me(req)))
  })

  router.post('/keys', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const name = optionalString(body, 'name', { maxLength: 60 }) ?? 'default'
    const created = await createApiKey(me(req), name)
    await writeAudit({
      userId: me(req),
      actor: req.profile.email,
      action: 'key.create',
      detail: { id: created.id, name }
    })
    // `key` is present exactly once, in this response.
    res.status(201).json(created)
  })

  router.delete('/keys/:id', async (req, res) => {
    const revoked = await revokeApiKey(me(req), req.params.id)
    await writeAudit({
      userId: me(req),
      actor: req.profile.email,
      action: 'key.revoke',
      detail: { id: revoked.id }
    })
    res.json({ revoked: true, id: revoked.id })
  })

  // ---- sending ------------------------------------------------------------
  async function connectedClient(req) {
    const client = tenants.peek(me(req)) ?? (await tenants.ensure(me(req)))
    if (!client.isConnected()) {
      throw ApiError.unavailable('WhatsApp is not linked yet. Scan the QR in your dashboard first.', {
        state: client.state
      })
    }
    return client
  }

  router.post('/send/text', async (req, res) => {
    const body = requireBody(req.body)
    const to = normaliseJid(body.to)
    const message = requireString(body, 'message', { maxLength: 65536 })

    await assertNotOptedOut(me(req), to)
    const client = await connectedClient(req)
    const result = await client.sendText(to, message)
    await tenants.persistOutbound(me(req), { waId: result.id, jid: result.to, body: message })
    res.status(202).json({ sent: true, isGroup: isGroupJid(result.to), ...result })
  })

  router.post('/send/media', async (req, res) => {
    const body = requireBody(req.body)
    const to = normaliseJid(body.to)
    const type = requireEnum(body, 'type', MEDIA_TYPES)
    const url = requireHttpUrl(body, 'url')
    const caption = optionalString(body, 'caption', { maxLength: 4096 })
    const mimetype = optionalString(body, 'mimetype', { maxLength: 255 })
    const fileName = optionalString(body, 'fileName', { maxLength: 255 })

    await assertNotOptedOut(me(req), to)
    const client = await connectedClient(req)
    const content = buildMediaContent({ type, url, caption, mimetype, fileName })
    const result = await client.sendMedia(to, content)
    await tenants.persistOutbound(me(req), {
      waId: result.id,
      jid: result.to,
      body: caption ?? `[${type}]`,
      type
    })
    res.status(202).json({ sent: true, type, isGroup: isGroupJid(result.to), ...result })
  })

  router.get('/check/:number', async (req, res) => {
    const jid = normaliseJid(req.params.number, 'number')
    if (isGroupJid(jid)) throw ApiError.badRequest('Only phone numbers can be checked.')
    const client = await connectedClient(req)
    res.json(await client.checkNumber(jidToNumber(jid)))
  })

  /**
   * A contact who opted out must not receive anything, from a campaign or from
   * a one-off send. Enforcing it here rather than only in the campaign runner
   * means there is no path around it.
   */
  async function assertNotOptedOut(userId, jid) {
    if (!admin) return
    const { data } = await admin
      .from('contacts')
      .select('opted_out, name')
      .eq('user_id', userId)
      .eq('jid', jid)
      .maybeSingle()
    if (data?.opted_out) {
      throw ApiError.forbidden(
        `${data.name ?? jidToNumber(jid)} has opted out of messages. Clear the opt-out on the contact to send again.`
      )
    }
  }

  // ---- inbox --------------------------------------------------------------
  router.get('/inbox/threads', async (req, res) => {
    res.json(await listThreads(me(req), { limit: 100 }))
  })

  router.get('/inbox/threads/:jid', async (req, res) => {
    res.json(await listMessages(me(req), req.params.jid, { limit: 200 }))
  })

  router.post('/inbox/threads/:jid/read', async (req, res) => {
    res.json((await markThreadRead(me(req), req.params.jid)) ?? { unread: 0 })
  })

  // ---- contacts -----------------------------------------------------------
  router.get('/contacts', async (req, res) => {
    if (!admin) throw ApiError.unavailable('Supabase is not configured.')
    let query = admin
      .from('contacts')
      .select('*')
      .eq('user_id', me(req))
      .order('updated_at', { ascending: false })
      .limit(500)

    const status = req.query.status
    if (typeof status === 'string' && status) query = query.eq('status', status)
    const tag = req.query.tag
    if (typeof tag === 'string' && tag) query = query.contains('tags', [tag])

    const { data, error } = await query
    if (error) throw ApiError.gateway('Could not load contacts.')
    res.json(data)
  })

  router.post('/contacts', async (req, res) => {
    const body = requireBody(req.body)
    const jid = normaliseJid(body.to ?? body.jid ?? body.number, 'number')
    const { data, error } = await admin
      .from('contacts')
      .upsert(
        {
          user_id: me(req),
          jid,
          number: isGroupJid(jid) ? null : jidToNumber(jid),
          name: optionalString(body, 'name', { maxLength: 120 }) ?? null,
          is_group: isGroupJid(jid),
          status: body.status ?? 'new',
          tags: Array.isArray(body.tags) ? body.tags.slice(0, 20).map(String) : [],
          notes: optionalString(body, 'notes', { maxLength: 4000 }) ?? null,
          consent: optionalString(body, 'consent', { maxLength: 200 }) ?? null
        },
        { onConflict: 'user_id,jid' }
      )
      .select()
      .single()
    if (error) throw ApiError.gateway('Could not save the contact.', { code: error.code })
    res.status(201).json(data)
  })

  router.patch('/contacts/:id', async (req, res) => {
    const body = requireBody(req.body)
    const patch = {}
    if (body.name !== undefined) patch.name = optionalString(body, 'name', { maxLength: 120 }) ?? null
    if (body.status !== undefined) patch.status = body.status
    if (body.notes !== undefined) patch.notes = optionalString(body, 'notes', { maxLength: 4000 }) ?? null
    if (body.consent !== undefined) patch.consent = optionalString(body, 'consent', { maxLength: 200 }) ?? null
    if (body.optedOut !== undefined) patch.opted_out = Boolean(body.optedOut)
    if (Array.isArray(body.tags)) patch.tags = body.tags.slice(0, 20).map(String)
    if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to update.')

    const { data, error } = await admin
      .from('contacts')
      .update(patch)
      .eq('id', req.params.id)
      .eq('user_id', me(req))
      .select()
      .maybeSingle()
    if (error) throw ApiError.gateway('Could not update the contact.')
    if (!data) throw ApiError.notFound('No such contact.')
    res.json(data)
  })

  router.delete('/contacts/:id', async (req, res) => {
    const { error } = await admin
      .from('contacts')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', me(req))
    if (error) throw ApiError.gateway('Could not delete the contact.')
    res.json({ deleted: true })
  })

  // ---- analytics ----------------------------------------------------------
  router.get('/usage', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90)
    const series = await usageSeries(me(req), days)
    const totals = series.reduce(
      (acc, row) => ({
        sent: acc.sent + row.sent,
        received: acc.received + row.received,
        failed: acc.failed + row.failed
      }),
      { sent: 0, received: 0, failed: 0 }
    )
    const { count: contacts } = await admin
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', me(req))
    res.json({ days, series, totals, contacts: contacts ?? 0 })
  })

  return router
}
