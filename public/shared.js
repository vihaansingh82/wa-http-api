// Shared by both dashboards: Supabase Auth over plain fetch, an API helper that
// refreshes tokens, and a few DOM utilities.
//
// No Supabase JS bundle on purpose. The auth endpoints are a handful of REST
// calls, so a CDN dependency would add weight, a third-party origin, and one
// more thing to break when offline.

export const $ = id => document.getElementById(id)
export const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props)
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

const STORE = 'wa-session'
let cfg = null

export async function loadConfig() {
  if (cfg) return cfg
  const res = await fetch('/api/public-config')
  cfg = await res.json()
  return cfg
}

// ------------------------------------------------------------------ session ---

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || 'null')
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    if (session) localStorage.setItem(STORE, JSON.stringify(session))
    else localStorage.removeItem(STORE)
    return true
  } catch {
    return false
  }
}

export const currentSession = readSession
export const signedIn = () => Boolean(readSession()?.access_token)

/** Supabase auth REST call. Returns {ok, status, body} and never throws. */
async function authFetch(pathname, { method = 'POST', body, token } = {}) {
  const conf = await loadConfig()
  if (!conf.configured) {
    return {
      ok: false,
      status: 0,
      body: { message: 'This server has no Supabase configuration, so sign-in is unavailable.' }
    }
  }
  try {
    const res = await fetch(conf.supabaseUrl + '/auth/v1' + pathname, {
      method,
      headers: {
        apikey: conf.supabaseKey,
        'content-type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })
    let parsed = null
    try {
      parsed = await res.json()
    } catch {
      parsed = null
    }
    return { ok: res.ok, status: res.status, body: parsed ?? {} }
  } catch (err) {
    return { ok: false, status: 0, body: { message: String(err.message || err) } }
  }
}

/** Supabase reports auth errors under several different keys depending on age. */
const authError = body =>
  body?.msg || body?.error_description || body?.message || body?.error || 'Something went wrong.'

export async function signUp({ email, password, fullName, company }) {
  const conf = await loadConfig()
  const result = await authFetch('/signup', {
    body: {
      email,
      password,
      data: { full_name: fullName ?? null, company: company ?? null },
      // Where the confirmation link comes back to.
      gotrue_meta_security: {},
      options: {},
      redirect_to: (conf.publicUrl || location.origin) + '/app/'
    }
  })
  if (!result.ok) throw new Error(authError(result.body))

  // With email confirmation switched on, signup returns a user but no session.
  if (result.body.access_token) {
    writeSession(result.body)
    return { session: result.body, needsConfirmation: false }
  }
  return { session: null, needsConfirmation: true }
}

export async function signIn({ email, password }) {
  const result = await authFetch('/token?grant_type=password', { body: { email, password } })
  if (!result.ok) throw new Error(authError(result.body))
  writeSession(result.body)
  return result.body
}

export async function requestPasswordReset(email) {
  const conf = await loadConfig()
  const result = await authFetch('/recover', {
    body: { email, redirect_to: (conf.publicUrl || location.origin) + '/app/#reset' }
  })
  // Deliberately not surfacing whether the address exists: that would turn this
  // form into an account-enumeration tool.
  if (!result.ok && result.status !== 400) throw new Error(authError(result.body))
  return true
}

/** Set a new password. Used both from a recovery link and from settings. */
export async function updatePassword(password, recoveryToken) {
  const token = recoveryToken ?? readSession()?.access_token
  if (!token) throw new Error('Not signed in.')
  const result = await authFetch('/user', { method: 'PUT', body: { password }, token })
  if (!result.ok) throw new Error(authError(result.body))
  return true
}

export async function signOut() {
  const session = readSession()
  if (session?.access_token) {
    await authFetch('/logout', { token: session.access_token })
  }
  writeSession(null)
}

/**
 * Swap the refresh token for a new access token. Called automatically when the
 * API answers 401, so a long-lived dashboard tab does not silently stop working.
 */
async function refresh() {
  const session = readSession()
  if (!session?.refresh_token) return null
  const result = await authFetch('/token?grant_type=refresh_token', {
    body: { refresh_token: session.refresh_token }
  })
  if (!result.ok) {
    writeSession(null)
    return null
  }
  writeSession(result.body)
  return result.body
}

/**
 * A recovery or confirmation link arrives with the tokens in the URL fragment.
 * Consume them, and scrub the address bar so the token is not left in history.
 */
export function consumeAuthFragment() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const accessToken = params.get('access_token')
  const type = params.get('type')
  const errorDescription = params.get('error_description')

  if (!accessToken && !errorDescription) return null
  history.replaceState(null, '', location.pathname)

  if (errorDescription) return { type: 'error', message: errorDescription }
  if (type === 'recovery') return { type: 'recovery', accessToken }

  // A confirmed signup hands over a full session.
  writeSession({
    access_token: accessToken,
    refresh_token: params.get('refresh_token'),
    expires_in: Number(params.get('expires_in')) || 3600,
    token_type: 'bearer'
  })
  return { type: type || 'signin' }
}

// ---------------------------------------------------------------------- api ---

/**
 * Call our own API with the session token. Retries once through a refresh on
 * 401, then gives up and reports signed-out.
 */
export async function api(pathname, { method = 'GET', body, retry = true } = {}) {
  const session = readSession()
  try {
    const res = await fetch('/api' + pathname, {
      method,
      headers: {
        ...(session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    })

    if (res.status === 401 && retry) {
      const renewed = await refresh()
      if (renewed) return api(pathname, { method, body, retry: false })
    }

    let parsed
    try {
      parsed = await res.json()
    } catch {
      parsed = { error: 'bad_response', message: 'Response was not JSON.' }
    }
    return { ok: res.ok, status: res.status, body: parsed }
  } catch (err) {
    return { ok: false, status: 0, body: { error: 'network_error', message: String(err.message || err) } }
  }
}

// ----------------------------------------------------------------------- ui ---

export function show(node, data, ok) {
  const target = typeof node === 'string' ? $(node) : node
  if (!target) return
  target.textContent = data == null ? '' : typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  target.className = 'out' + (ok === undefined ? '' : ok ? ' ok' : ' bad')
}

export function busy(button, running) {
  button.disabled = running
  if (running) {
    button.dataset.label = button.textContent
    button.textContent = 'Working…'
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label
  }
}

export const fmtWhen = value => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const days = (Date.now() - date.getTime()) / 864e5
  return days < 1
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString()
}

/** Draw a bar chart from divs. No chart library, no CDN. */
export function drawBars(host, series, pick) {
  host.replaceChildren()
  if (!series.length) {
    host.append(el('div', { className: 'empty' }, 'No activity yet.'))
    return
  }
  const values = series.map(pick)
  const peak = Math.max(...values, 1)
  const bars = el('div', { className: 'bars' })
  series.forEach((row, i) => {
    const bar = el('div')
    bar.style.height = Math.max(2, Math.round((values[i] / peak) * 100)) + '%'
    bar.title = `${row.day}: ${values[i]}`
    bars.append(bar)
  })
  host.append(
    bars,
    el(
      'div',
      { className: 'bar-axis' },
      el('span', {}, series[0].day),
      el('span', {}, `peak ${peak}`),
      el('span', {}, series.at(-1).day)
    )
  )
}
