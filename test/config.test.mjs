// Startup validation. config.js reads the environment once at import, so each
// case runs in its own process.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'


// A file:// URL, not a filesystem path: dynamic import() rejects bare Windows
// paths, which would make every case "throw" and quietly invert this suite.
const configUrl = new URL('../src/config.js', import.meta.url).href
const projectDir = fileURLToPath(new URL('../', import.meta.url))

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

/** Import config.js with a given environment; report whether it refused. */
function load(env) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`],
    { cwd: projectDir, env: { ...process.env, LOG_LEVEL: 'silent', ...env }, encoding: 'utf8' }
  )
  return {
    threw: result.status !== 0,
    message: (result.stderr.match(/Error: ([^\n]*)/) || [])[1] ?? result.stderr.slice(0, 200)
  }
}

const jwtFor = role =>
  'eyJhbGciOiJIUzI1NiJ9.' +
  Buffer.from(JSON.stringify({ iss: 'supabase', role })).toString('base64url') +
  '.signature'

// ---- the service-role slot --------------------------------------------------
// The dashboard shows the publishable and secret keys next to each other, so
// pasting the wrong one is the likely mistake. Caught at startup rather than as
// a confusing permission error on the first query.
console.log('--- SUPABASE_SERVICE_ROLE_KEY ---')

const publishable = load({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abcdef1234567890' })
check('a publishable key is refused', publishable.threw, 'accepted it')
check('and the message says which slot it belongs in', /SUPABASE_PUBLISHABLE_KEY/.test(publishable.message), publishable.message)

const anon = load({ SUPABASE_SERVICE_ROLE_KEY: jwtFor('anon') })
check('a legacy anon JWT is refused', anon.threw, 'accepted it')
check('the anon message names the real key to use', /service_role|secret key/.test(anon.message), anon.message)

const wrongRole = load({ SUPABASE_SERVICE_ROLE_KEY: jwtFor('authenticated') })
check('a token for another role is refused', wrongRole.threw)
check('and it names the role it found', /"authenticated"/.test(wrongRole.message), wrongRole.message)

check('unrecognisable junk is refused', load({ SUPABASE_SERVICE_ROLE_KEY: 'hunter2' }).threw)

check('a service_role JWT is accepted', !load({ SUPABASE_SERVICE_ROLE_KEY: jwtFor('service_role') }).threw)
check('a new-style sb_secret_ key is accepted', !load({ SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_abcdefghijklmnop' }).threw)
check('an empty value is accepted (server runs, warns, refuses auth)', !load({ SUPABASE_SERVICE_ROLE_KEY: '' }).threw)

// ---- other env validation ---------------------------------------------------
console.log('\n--- other variables ---')
check('a malformed WEBHOOK_URL is refused', load({ WEBHOOK_URL: 'not a url' }).threw)
check('a non-http WEBHOOK_URL is refused', load({ WEBHOOK_URL: 'ftp://example.com/hook' }).threw)
check('a valid WEBHOOK_URL is accepted', !load({ WEBHOOK_URL: 'https://example.com/hook' }).threw)

check('an out-of-range PORT is refused', load({ PORT: '70000' }).threw)
check('a non-numeric PORT is refused', load({ PORT: 'eighty' }).threw)
check('a valid PORT is accepted', !load({ PORT: '8080' }).threw)

check('MAX_TENANT_SESSIONS below range is refused', load({ MAX_TENANT_SESSIONS: '0' }).threw)
check('MAX_TENANT_SESSIONS above range is refused', load({ MAX_TENANT_SESSIONS: '10000' }).threw)

// The whole point of the empty-key path: the server must still boot so the
// dashboards can explain the problem instead of the process dying.
console.log('\n--- degraded start ---')
const bare = load({ SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '' })
check('config loads with no Supabase settings at all', !bare.threw, bare.message)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
