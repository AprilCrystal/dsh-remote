/**
 * Run every suite, with the shell guard FIRST.
 *
 * This exists because of a failure mode that cost real time six times over: a
 * single stray backtick anywhere in the shell template makes `lib/panel.js`
 * unparseable, and then every suite that imports it fails with "Unexpected
 * identifier" — fourteen confusing failures for one character. The guard names the
 * real cause, so it must never be the thing that runs second.
 *
 * Output is INHERITED rather than captured, deliberately: in a confined sandbox a
 * Node child process cannot be captured through piped stdio, and the captured run
 * silently reported no output and a failure for a suite that passes. So the
 * verdict here comes from exit codes, and each suite's own lines go straight to
 * the terminal where they can be read.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const node = process.execPath

const run = (file) => spawnSync(node, [join(here, file)], { stdio: 'inherit' }).status

console.log('=== shell guard (first, so a stray backtick is named and not guessed) ===')
if (run('shell-guard.mjs') !== 0) {
  console.log('\nthe shell template is broken. Every suite below would fail for that one')
  console.log('reason, which is exactly the cascade this guard exists to prevent.')
  process.exit(1)
}

const suites = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
const failed = []

console.log(`\n=== ${String(suites.length)} suites ===`)
for (const suite of suites) {
  const status = run(suite)
  if (status !== 0) failed.push(suite)
  console.log(`--- ${suite}: ${status === 0 ? 'ok' : 'FAILED'}\n`)
}

console.log(`=== ${String(suites.length - failed.length)}/${String(suites.length)} suites ok ===`)
if (failed.length > 0) console.log(`failed: ${failed.join(', ')}`)
process.exit(failed.length === 0 ? 0 : 1)
