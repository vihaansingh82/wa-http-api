// Static checks on the dashboards: module scripts parse, every element id the
// script touches exists, no secret is baked in, and the two invariants that
// caused real bugs before.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const PAGES = [
  { name: 'landing', file: 'public/index.html' },
  { name: 'client', file: 'public/app/index.html' },
  { name: 'admin', file: 'public/admin/index.html' }
]

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

/** The inner HTML of the element carrying this id, by matching nested tags. */
function innerHtmlOf(html, id) {
  const at = html.indexOf(`id="${id}"`)
  if (at === -1) return null
  const tagStart = html.lastIndexOf('<', at)
  const tag = html.slice(tagStart + 1).match(/^([a-zA-Z][\w-]*)/)?.[1]
  if (!tag) return null
  const openEnd = html.indexOf('>', at)
  if (openEnd === -1) return null
  if (html[openEnd - 1] === '/') return ''

  const open = new RegExp(`<${tag}\\b`, 'gi')
  const close = new RegExp(`</${tag}\\s*>`, 'gi')
  let depth = 1
  let cursor = openEnd + 1
  while (depth > 0 && cursor < html.length) {
    open.lastIndex = cursor
    close.lastIndex = cursor
    const nextOpen = open.exec(html)
    const nextClose = close.exec(html)
    if (!nextClose) return html.slice(openEnd + 1)
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++
      cursor = nextOpen.index + nextOpen[0].length
    } else {
      depth--
      if (depth === 0) return html.slice(openEnd + 1, nextClose.index)
      cursor = nextClose.index + nextClose[0].length
    }
  }
  return html.slice(openEnd + 1)
}

// ---- the shared module ------------------------------------------------------
console.log('--- shared.js ---')
const sharedPath = fileURLToPath(new URL('public/shared.js', root))
const shared = await readFile(sharedPath, 'utf8')
try {
  execFileSync(process.execPath, ['--check', sharedPath], { stdio: 'pipe' })
  check('shared.js parses', true)
} catch (err) {
  check('shared.js parses', false, String(err.stderr || err.message).split('\n').slice(0, 3).join('\n        '))
}
check('shared.js exports the auth surface', ['signIn', 'signUp', 'signOut', 'requestPasswordReset', 'updatePassword', 'consumeAuthFragment'].every(name => shared.includes('export async function ' + name) || shared.includes('export function ' + name)))
check('shared.js exports an api helper', shared.includes('export async function api('))
// "CDN" appears in a comment explaining why there is no CDN, so match real URLs.
check(
  'no CDN dependency',
  !/https?:\/\/[^'"\s]*(cdn|unpkg|jsdelivr|esm\.sh)/i.test(shared),
  'something is loaded from a third-party origin'
)
check('a recovery link is scrubbed from the address bar', shared.includes('history.replaceState'), 'tokens would otherwise stay in browser history')
check('the API helper refreshes once on 401', /status === 401 && retry/.test(shared))

// ---- each page --------------------------------------------------------------
for (const page of PAGES) {
  console.log(`\n--- ${page.name} (${page.file}) ---`)
  const file = fileURLToPath(new URL(page.file, root))
  const html = await readFile(file, 'utf8')

  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map(m => m[1])
  check(`${page.name}: exactly one module script`, scripts.length === 1, String(scripts.length))
  const js = scripts[0] ?? ''

  const tmp = path.join(tmpdir(), `wa-page-${page.name}-${Date.now()}.mjs`)
  await writeFile(tmp, js, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    check(`${page.name}: script parses`, true)
  } catch (err) {
    check(`${page.name}: script parses`, false, String(err.stderr || err.message).split('\n').slice(0, 4).join('\n        '))
  }

  // every $('id') must resolve to a real element
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
  const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
  const missing = [...referenced].filter(id => !declared.has(id))
  check(`${page.name}: all ${referenced.size} referenced ids exist`, missing.length === 0, 'missing: ' + missing.join(', '))

  // no orphans left from an earlier revision
  const quoted = new Set([
    ...[...js.matchAll(/'([A-Za-z][\w-]*)'/g)].map(m => m[1]),
    // Ids also reach the script as unquoted object keys, e.g. TABS = { tabSend: 'paneSend' }
    ...[...js.matchAll(/\b([A-Za-z][\w-]*)\s*:/g)].map(m => m[1])
  ])
  const orphans = [...declared].filter(id => !referenced.has(id) && !quoted.has(id))
  check(`${page.name}: no orphaned ids`, orphans.length === 0, 'unreferenced: ' + orphans.join(', '))

  // the bug that broke the old console: an element the script touches must not
  // live inside a container the script rewrites wholesale
  const rewritten = new Set([
    ...[...js.matchAll(/\$\('([^']+)'\)\.innerHTML\s*=/g)].map(m => m[1]),
    ...[...js.matchAll(/\$\('([^']+)'\)\.replaceChildren\(/g)].map(m => m[1])
  ])
  const nested = []
  for (const container of rewritten) {
    const inner = innerHtmlOf(html, container)
    if (inner == null) continue
    for (const m of inner.matchAll(/\bid="([^"]+)"/g)) {
      if (m[1] !== container && referenced.has(m[1])) nested.push(`${m[1]} inside #${container}`)
    }
  }
  check(`${page.name}: no scripted id nested in a rewritten container`, nested.length === 0, nested.join('; '))

  // secrets
  // The variable name legitimately appears in setup instructions, so look for an
  // actual secret instead: a JWT literal or a Supabase secret-key prefix.
  check(
    `${page.name}: no secret key literal`,
    !/eyJ[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]+/.test(html)
  )
  check(`${page.name}: no long hex literal`, !/\b[0-9a-f]{40,}\b/.test(html))
  check(`${page.name}: no wa_/wak_ literal`, !/\bwak?_[A-Za-z0-9_-]{30,}/.test(html))

  // theming and structure
  check(`${page.name}: has a title`, /<title>[^<]+<\/title>/.test(html))
  check(`${page.name}: viewport meta`, html.includes('name="viewport"'))
  check(`${page.name}: uses the shared stylesheet`, html.includes('href="/shared.css"'))
}

// ---- shared.css -------------------------------------------------------------
console.log('\n--- shared.css ---')
const css = await readFile(fileURLToPath(new URL('public/shared.css', root)), 'utf8')
check('light palette on bare :root', /:root\s*\{[^}]*--bg:/.test(css))
check('dark palette declared', css.includes('prefers-color-scheme: dark'))
check('body paints an explicit background token', /body\s*\{[^}]*background:\s*var\(--bg\)/.test(css))
check('braces balance', (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length)

// ---- docs match the routes --------------------------------------------------
console.log('\n--- routes vs dashboards ---')
const clientSrc = await readFile(fileURLToPath(new URL('src/routes-client.js', root)), 'utf8')
const adminSrc = await readFile(fileURLToPath(new URL('src/routes-admin.js', root)), 'utf8')
const clientHtml = await readFile(fileURLToPath(new URL('public/app/index.html', root)), 'utf8')
const adminHtml = await readFile(fileURLToPath(new URL('public/admin/index.html', root)), 'utf8')

const routesIn = src => [...src.matchAll(/router\.(get|post|patch|delete)\('([^']+)'/g)].map(m => m[2])
// A route the dashboard calls but the server does not define is a dead button.
const called = html => [...html.matchAll(/api\('(\/[^']*)'/g)].map(m => m[1].split('?')[0])

const clientRoutes = routesIn(clientSrc)
const adminRoutePaths = routesIn(adminSrc).map(p => '/admin' + p)
const known = [...clientRoutes, ...adminRoutePaths]

const matches = (calledPath, routePath) => {
  const a = calledPath.split('/').filter(Boolean)
  const b = routePath.split('/').filter(Boolean)
  if (a.length !== b.length) return false
  return b.every((seg, i) => seg.startsWith(':') || seg === a[i])
}

for (const [label, html] of [['client', clientHtml], ['admin', adminHtml]]) {
  const dead = called(html)
    // paths built by concatenation end up as prefixes; only check literals
    .filter(p => !p.endsWith('/'))
    .filter(p => !known.some(route => matches(p, route) || p.startsWith(route)))
  check(`${label}: every api() call maps to a real route`, dead.length === 0, 'no route for: ' + dead.join(', '))
}
check('sanity: routes were actually discovered', known.length > 12, String(known.length))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
