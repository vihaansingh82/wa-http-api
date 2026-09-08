import { createClient } from '@supabase/supabase-js'
import { createHash, randomBytes } from 'node:crypto'
import { config } from './config.js'
import { logger } from './logger.js'
import { ApiError } from './errors.js'

const log = logger.child({ module: 'supabase' })

export const supabaseConfigured = Boolean(
  config.supabaseUrl && config.supabaseServiceKey && config.supabasePublishableKey
)

/**
 * Service-role client. It bypasses row-level security, which is exactly why it
 * lives only here and never leaves the server: every query made through it must
 * filter by user_id itself, because the database will not do it for us.
 */
export const admin = supabaseConfigured
  ? createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null

function requireSupabase() {
  if (!admin) {
    throw ApiError.unavailable(
      'Supabase is not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY.'
    )
  }
  return admin
}

/** Throw the Supabase error as an ApiError rather than leaking a raw PostgrestError. */
function unwrap({ data, error }, context) {
  if (error) {
    log.error({ err: error.message, code: error.code, context }, 'supabase query failed')
    throw ApiError.gateway(`Database error while ${context}.`, { code: error.code })
  }
  return data
}

const sha256 = value => createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------- identity ---

/**
 * Resolve a Supabase access token to a profile.
 *
 * Cached briefly: the dashboards poll, and every poll would otherwise be a
 * round trip to Supabase just to re-validate the same JWT.
 */
const tokenCache = new Map()
const TOKEN_CACHE_MS = 30_000

export async function profileForAccessToken(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 20) return null
  const db = requireSupabase()

  const hit = tokenCache.get(accessToken)
  if (hit && hit.at + TOKEN_CACHE_MS > Date.now()) return hit.profile

  const { data, error } = await db.auth.getUser(accessToken)
  if (error || !data?.user) {
    tokenCache.set(accessToken, { at: Date.now(), profile: null })
    return null
  }

  const profile = await getProfile(data.user.id)
  // A suspended account keeps a technically valid JWT until it expires, so the
  // check has to happen here rather than trusting the token alone.
  const usable = profile && profile.status === 'active' ? profile : null

  tokenCache.set(accessToken, { at: Date.now(), profile: usable })
  if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value)
  return usable
}

/** Drop cached tokens for a user, so a suspension takes effect immediately. */
export function invalidateTokenCache(userId) {
  for (const [token, entry] of tokenCache) {
    if (!entry.profile || entry.profile.id === userId) tokenCache.delete(token)
  }
}

export async function getProfile(userId) {
  const db = requireSupabase()
  const { data, error } = await db.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) {
    log.error({ err: error.message }, 'could not load profile')
    return null
  }
  return data
}

export async function listProfiles() {
  const db = requireSupabase()
  return unwrap(
    await db.from('profiles').select('*').order('created_at', { ascending: false }),
    'listing accounts'
  )
}

export async function updateProfile(userId, patch) {
  const db = requireSupabase()
  const allowed = {}
  for (const key of ['full_name', 'company', 'role', 'status']) {
    if (patch[key] !== undefined) allowed[key] = patch[key]
  }
  if (!Object.keys(allowed).length) throw ApiError.badRequest('Nothing to update.')

  const data = unwrap(
    await db.from('profiles').update(allowed).eq('id', userId).select().maybeSingle(),
    'updating an account'
  )
  if (!data) throw ApiError.notFound('No such account.')
  invalidateTokenCache(userId)
  return data
}

/** Remove the auth user; the profile and all tenant rows cascade away. */
export async function deleteAccount(userId) {
  const db = requireSupabase()
  const { error } = await db.auth.admin.deleteUser(userId)
  if (error) throw ApiError.gateway(`Could not delete the account: ${error.message}`)
  invalidateTokenCache(userId)
  return { deleted: true }
}

// ------------------------------------------------------------------- keys ---

const KEY_PREFIX = 'wak_'

/** Mint an API key. The plaintext is returned once and never stored. */
export async function createApiKey(userId, name = 'default') {
  const db = requireSupabase()
  const secret = KEY_PREFIX + randomBytes(32).toString('base64url')
  const row = unwrap(
    await db
      .from('api_keys')
      .insert({
        user_id: userId,
        name: String(name).slice(0, 60) || 'default',
        key_prefix: secret.slice(0, 12),
        key_hash: sha256(secret)
      })
      .select()
      .single(),
    'creating an API key'
  )
  return { ...row, key: secret }
}

export async function listApiKeys(userId) {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }),
    'listing API keys'
  )
}

export async function revokeApiKey(userId, keyId) {
  const db = requireSupabase()
  const data = unwrap(
    await db
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select()
      .maybeSingle(),
    'revoking an API key'
  )
  if (!data) throw ApiError.notFound('No such active key.')
  return data
}

/**
 * Resolve an API key to its owner. Looked up by hash, so the plaintext is never
 * compared against anything stored.
 */
const keyCache = new Map()
const KEY_CACHE_MS = 30_000

export async function profileForApiKey(key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null
  const db = requireSupabase()

  const hit = keyCache.get(key)
  if (hit && hit.at + KEY_CACHE_MS > Date.now()) return hit.profile

  const { data, error } = await db
    .from('api_keys')
    .select('id, user_id, profiles!inner(*)')
    .eq('key_hash', sha256(key))
    .is('revoked_at', null)
    .maybeSingle()

  if (error || !data) {
    keyCache.set(key, { at: Date.now(), profile: null })
    return null
  }

  const profile = data.profiles?.status === 'active' ? data.profiles : null
  keyCache.set(key, { at: Date.now(), profile })
  if (keyCache.size > 500) keyCache.delete(keyCache.keys().next().value)

  // Fire and forget: a usage timestamp is not worth failing a request over.
  db.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {})
    .catch(() => {})

  return profile
}

// --------------------------------------------------------------- sessions ---

export async function upsertSessionState(userId, patch) {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('wa_sessions')
      .upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' })
      .select()
      .single(),
    'saving session state'
  )
}

export async function getSessionState(userId) {
  const db = requireSupabase()
  const { data } = await db.from('wa_sessions').select('*').eq('user_id', userId).maybeSingle()
  return data ?? null
}

export async function listSessionStates() {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('wa_sessions')
      .select('*, profiles!inner(id, email, full_name, company, role, status)')
      .order('updated_at', { ascending: false }),
    'listing sessions'
  )
}

// ------------------------------------------------------ contacts & messages ---

export async function upsertContact(userId, contact) {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('contacts')
      .upsert({ user_id: userId, ...contact }, { onConflict: 'user_id,jid' })
      .select()
      .single(),
    'saving a contact'
  )
}

export async function recordMessage(userId, message) {
  const db = requireSupabase()
  // onConflict on (user_id, wa_id): WhatsApp can deliver the same id twice, and
  // a duplicate should update the row rather than fail the whole handler.
  const { data, error } = await db
    .from('wa_messages')
    .upsert({ user_id: userId, ...message }, { onConflict: 'user_id,wa_id' })
    .select()
    .maybeSingle()

  if (error) {
    log.error({ err: error.message, jid: message.jid }, 'could not record message')
    return null
  }
  return data
}

export async function listThreads(userId, { limit = 50 } = {}) {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(limit),
    'listing conversations'
  )
}

export async function listMessages(userId, jid, { limit = 100 } = {}) {
  const db = requireSupabase()
  const rows = unwrap(
    await db
      .from('wa_messages')
      .select('*')
      .eq('user_id', userId)
      .eq('jid', jid)
      .order('sent_at', { ascending: false })
      .limit(limit),
    'loading a conversation'
  )
  return rows.reverse()
}

export async function markThreadRead(userId, jid) {
  const db = requireSupabase()
  return unwrap(
    await db
      .from('contacts')
      .update({ unread: 0 })
      .eq('user_id', userId)
      .eq('jid', jid)
      .select()
      .maybeSingle(),
    'marking a conversation read'
  )
}

export async function bumpUsage(userId, field) {
  const db = requireSupabase()
  const day = new Date().toISOString().slice(0, 10)
  // No atomic increment through the REST client, so read-modify-write. A lost
  // update here costs one unit off a dashboard counter, nothing more.
  const { data } = await db
    .from('usage_daily')
    .select('*')
    .eq('user_id', userId)
    .eq('day', day)
    .maybeSingle()

  const next = { user_id: userId, day, sent: 0, received: 0, failed: 0, ...(data ?? {}) }
  next[field] = (next[field] ?? 0) + 1
  await db.from('usage_daily').upsert(next, { onConflict: 'user_id,day' })
}

export async function usageSeries(userId, days = 14) {
  const db = requireSupabase()
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  let query = db.from('usage_daily').select('*').gte('day', since).order('day')
  if (userId) query = query.eq('user_id', userId)
  return unwrap(await query, 'loading usage')
}

export async function writeAudit({ userId, actor, action, detail }) {
  if (!admin) return
  try {
    await admin.from('audit_log').insert({
      user_id: userId ?? null,
      actor: actor ?? null,
      action,
      detail: detail ?? null
    })
  } catch (err) {
    log.error({ err, action }, 'could not write audit row')
  }
}

export async function listAudit({ userId, limit = 100 } = {}) {
  const db = requireSupabase()
  let query = db.from('audit_log').select('*').order('at', { ascending: false }).limit(limit)
  if (userId) query = query.eq('user_id', userId)
  return unwrap(await query, 'loading the audit log')
}

// ------------------------------------------------------------------- admin ---

/** Counts for the admin dashboard, in one round trip each. */
export async function adminOverview() {
  const db = requireSupabase()
  const [accounts, sessions, contacts, messages] = await Promise.all([
    db.from('profiles').select('id, role, status'),
    db.from('wa_sessions').select('state'),
    db.from('contacts').select('id', { count: 'exact', head: true }),
    db.from('wa_messages').select('id', { count: 'exact', head: true })
  ])

  const profiles = accounts.data ?? []
  const states = sessions.data ?? []
  const tally = key =>
    states.reduce((acc, row) => ((acc[row[key]] = (acc[row[key]] ?? 0) + 1), acc), {})

  return {
    accounts: {
      total: profiles.length,
      admins: profiles.filter(p => p.role === 'admin').length,
      clients: profiles.filter(p => p.role === 'client').length,
      suspended: profiles.filter(p => p.status === 'suspended').length
    },
    sessions: { total: states.length, byState: tally('state') },
    contacts: contacts.count ?? 0,
    messages: messages.count ?? 0
  }
}
