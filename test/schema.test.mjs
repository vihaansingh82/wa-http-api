// The migrations in supabase/migrations/ are the only record of the schema, so
// they must stay in step with what the code actually queries. A missing table
// or an unprotected one only shows up in production otherwise.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = new URL('../', import.meta.url)
const migrationsDir = fileURLToPath(new URL('supabase/migrations/', root))

let failures = 0
const check = (label, cond, detail) => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '\n        ' + (detail ?? '')}`)
}

const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort()
const sql = (
  await Promise.all(files.map(f => readFile(path.join(migrationsDir, f), 'utf8')))
).join('\n')

const SOURCES = ['src/supabase.js', 'src/routes-client.js', 'src/routes-admin.js', 'src/tenants.js']
const code = (
  await Promise.all(SOURCES.map(f => readFile(fileURLToPath(new URL(f, root)), 'utf8')))
).join('\n')

console.log('--- migrations ---')
check('migrations are present', files.length > 0, 'supabase/migrations is empty')
check('files sort into a deterministic order', files.every((f, i) => i === 0 || f > files[i - 1]), files.join(', '))

const created = new Set([...sql.matchAll(/create table public\.(\w+)/g)].map(m => m[1]))
const queried = new Set([...code.matchAll(/\.from\('(\w+)'\)/g)].map(m => m[1]))

check('schema creates tables', created.size >= 7, [...created].join(', '))
check('sanity: the code queries tables', queried.size >= 5, [...queried].join(', '))

const missing = [...queried].filter(t => !created.has(t))
check('every queried table is created by a migration', missing.length === 0, 'missing: ' + missing.join(', '))

console.log('\n--- row-level security ---')
const rlsEnabled = new Set(
  [...sql.matchAll(/alter table public\.(\w+)\s+enable row level security/g)].map(m => m[1])
)
const unprotected = [...created].filter(t => !rlsEnabled.has(t))
check('every table has RLS enabled', unprotected.length === 0, 'no RLS on: ' + unprotected.join(', '))

// A table with RLS on and no policy is unreachable from the browser. That is a
// valid choice, but it should be a deliberate one, so list them.
const withPolicies = new Set([...sql.matchAll(/create policy \w+ on public\.(\w+)/g)].map(m => m[1]))
const readable = [...created].filter(t => withPolicies.has(t))
check('the tables the dashboards read have policies', readable.length >= 7, [...withPolicies].join(', '))

console.log('\n--- privilege hygiene ---')
check(
  'trigger functions are not callable by clients',
  ['handle_new_user', 'guard_profile_privileges', 'touch_updated_at'].every(fn =>
    new RegExp(`revoke all on function public\\.${fn}\\(\\) from public, anon, authenticated`).test(sql)
  ),
  'a SECURITY DEFINER trigger function reachable via RPC is a privilege-escalation shape'
)
check('is_admin is revoked from anon', /revoke all on function public\.is_admin\(\) from public, anon/.test(sql))
check('is_admin is granted to authenticated', /grant execute on function public\.is_admin\(\) to authenticated/.test(sql), 'RLS policies call it as the querying role, so it must keep EXECUTE')

const definers = [...sql.matchAll(/create or replace function public\.(\w+)[\s\S]{0,400}?security definer/g)].map(m => m[1])
const unpinned = definers.filter(fn => {
  const body = sql.slice(sql.indexOf(`function public.${fn}`))
  return !/set search_path = public/.test(body.slice(0, 400))
})
check('every SECURITY DEFINER function pins search_path', unpinned.length === 0, 'unpinned: ' + unpinned.join(', '))

console.log('\n--- privilege escalation guard ---')
check(
  'role and status changes are guarded by a trigger',
  /only an admin may change a role/.test(sql) && /only an admin may change account status/.test(sql),
  'a client may update their own profile row, so nothing else stops them setting role=admin'
)
check('the guard is actually attached', /create trigger profiles_guard_privileges/.test(sql))
check('the first account becomes an admin', /case when first_user then 'admin' else 'client' end/.test(sql))

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
