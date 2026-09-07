// Runs every suite in this folder as its own process and aggregates the result.
//
// Separate processes on purpose: each suite sets its own env (API_KEY,
// TOKEN_STORE, SEND_DELAY_MS) before importing src/config.js, which reads the
// environment once at import time. Sharing one process would let the first
// suite's config leak into the rest.
import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = (await readdir(here)).filter(f => f.endsWith('.test.mjs')).sort()

const run = file =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(here, file)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('close', code => resolve({ file, code, out }))
  })

const results = []
for (const file of files) {
  process.stdout.write(`${file.padEnd(22)} `)
  const result = await run(file)
  const passed = (result.out.match(/^PASS/gm) || []).length
  const failed = (result.out.match(/^FAIL/gm) || []).length
  console.log(result.code === 0 ? `${passed} passed` : `FAILED (${passed} passed, ${failed} failed)`)
  results.push({ ...result, passed, failed })
}

const broken = results.filter(r => r.code !== 0)
const total = results.reduce((n, r) => n + r.passed, 0)

if (broken.length) {
  for (const r of broken) {
    console.log(`\n${'='.repeat(60)}\n${r.file} (exit ${r.code})\n${'='.repeat(60)}`)
    console.log(r.out.trimEnd())
  }
  console.log(`\n${broken.length} of ${results.length} suites failed`)
  process.exit(1)
}

console.log(`\n${total} checks passed across ${results.length} suites`)
