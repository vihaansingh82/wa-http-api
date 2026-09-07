// Static checks on the console page: script syntax, and that every element id
// the script reaches for actually exists in the markup.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const file = fileURLToPath(new URL('../public/index.html', import.meta.url))
const html = await readFile(file, 'utf8')

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

// ---- 1. script syntax -------------------------------------------------------
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
check('exactly one inline script', scripts.length === 1, String(scripts.length))
const js = scripts[0] ?? ''

const tmpJs = path.join(tmpdir(), 'wa-console-' + Date.now() + '.mjs')
await writeFile(tmpJs, js, 'utf8')
try {
  execFileSync(process.execPath, ['--check', tmpJs], { stdio: 'pipe' })
  check('script parses as valid JS', true)
} catch (err) {
  check('script parses as valid JS', false, String(err.stderr || err.message).split('\n').slice(0, 4).join('\n        '))
}

// ---- 2. every $('id') resolves to a real element ---------------------------
const declaredIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]))
const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))
// ids created at runtime by innerHTML, so they are legitimately absent at rest
const runtimeIds = new Set(['restart'])

const missing = [...referenced].filter(id => !declaredIds.has(id) && !runtimeIds.has(id))
check(`all ${referenced.size} referenced ids exist in the markup`, missing.length === 0, 'missing: ' + missing.join(', '))

// ---- 3. no leftover ids from the previous version of the page ---------------
// Ids reach the script three ways: $('x'), a string arg like show('x', …), and
// querySelector. Collect every quoted string so this does not cry wolf.
const quoted = new Set([...js.matchAll(/'([A-Za-z][\w-]*)'/g)].map(m => m[1]))
const orphans = [...declaredIds].filter(id => !referenced.has(id) && !quoted.has(id))
check('no orphaned ids left behind', orphans.length === 0, 'unreferenced: ' + orphans.join(', '))

// ---- 4. handlers are attached to buttons that exist ------------------------
const handlerIds = [...js.matchAll(/\$\('([^']+)'\)\.(onclick|onchange)/g)].map(m => m[1])
const badHandlers = handlerIds.filter(id => !declaredIds.has(id) && !runtimeIds.has(id))
check(`all ${handlerIds.length} handler targets exist`, badHandlers.length === 0, badHandlers.join(', '))

// ---- 4b. no scripted element may live inside a container we overwrite ------
// The bug: #startPair sat inside #qrHolder, and redrawing the QR replaced that
// element's children -- deleting the button. Every later refresh then threw on
// a null node. So: any id the script touches must not be nested inside a
// container the script rewrites wholesale.
const rewritten = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)\.innerHTML\s*=/g)].map(m => m[1]),
  ...[...js.matchAll(/\$\('([^']+)'\)\.replaceChildren\(/g)].map(m => m[1])
])
check('script rewrites at least one container (guard is live)', rewritten.size > 0, [...rewritten].join(','))

/** The inner HTML of the element carrying this id, by matching nested tags. */
function innerHtmlOf(id) {
  const at = html.indexOf(`id="${id}"`)
  if (at === -1) return null
  const tagStart = html.lastIndexOf('<', at)
  const tag = html.slice(tagStart + 1).match(/^([a-zA-Z][\w-]*)/)?.[1]
  if (!tag) return null
  const openEnd = html.indexOf('>', at)
  if (openEnd === -1) return null
  if (html[openEnd - 1] === '/') return '' // self-closed, no children

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

// Prove the extractor works before trusting what it reports.
check('nesting extractor finds a known child', (innerHtmlOf('main') ?? '').includes('id="tabDocs"'))
check('nesting extractor reports an empty container as empty', innerHtmlOf('qrHolder') === '')

const nestingViolations = []
for (const container of rewritten) {
  const inner = innerHtmlOf(container)
  if (inner == null) continue
  for (const m of inner.matchAll(/\bid="([^"]+)"/g)) {
    if (m[1] !== container && referenced.has(m[1])) {
      nestingViolations.push(`${m[1]} is inside #${container}`)
    }
  }
}
check('no scripted id nested in a rewritten container', nestingViolations.length === 0, nestingViolations.join('; '))

// ---- 4c. the one-time token screen is never left on a timer ----------------
const routeFn = js.match(/function route\(\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
check('route() guards the token screen', /tokenScreen'\)\.hidden\)\s*return/.test(routeFn), routeFn.slice(0, 160))

// ---- 5. no secrets baked into the shipped file -----------------------------
check('no wa_ token literal in the file', !/wa_[A-Za-z0-9_-]{40,}/.test(html))
check('no hex API key literal in the file', !/\b[0-9a-f]{48,}\b/.test(html))
check('token placeholder used in docs', html.includes('YOUR_TOKEN'))

// ---- 6. theming and structure ----------------------------------------------
check('declares a light palette on bare :root', /:root\s*\{[^}]*--bg:/.test(html))
check('declares a dark palette', html.includes('prefers-color-scheme: dark'))
check('body gets an explicit background token', /body\s*\{[^}]*background:\s*var\(--bg\)/.test(html))
check('has a title', /<title>[^<]+<\/title>/.test(html))
check('viewport meta present', html.includes('name="viewport"'))

// ---- 7. every documented endpoint exists in the server ---------------------
const server = await readFile(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8')
const documented = [...js.matchAll(/method: '(GET|POST)', path: '([^']+)'/g)].map(m => [m[1], m[2]])
check('docs list at least 10 endpoints', documented.length >= 10, String(documented.length))

const routeMissing = documented.filter(([method, p]) => {
  const expressPath = p.replace(/:(\w+)/g, ':$1')
  const re = new RegExp(`app\\.${method.toLowerCase()}\\('${expressPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`)
  return !re.test(server)
})
check('every documented endpoint is a real route', routeMissing.length === 0, routeMissing.map(r => r.join(' ')).join(', '))

// and the reverse: no route left undocumented
const realRoutes = [...server.matchAll(/app\.(get|post)\('([^']+)'/g)]
  .map(m => [m[1].toUpperCase(), m[2]])
  .filter(([, p]) => p !== '/health')
const undocumented = realRoutes.filter(([m, p]) => !documented.some(([dm, dp]) => dm === m && dp === p))
check('no route is missing from the docs', undocumented.length === 0, undocumented.map(r => r.join(' ')).join(', '))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
