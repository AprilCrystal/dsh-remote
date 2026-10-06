/**
 * Standalone guard for the panel's one structural trap.
 *
 * The entire page — HTML, CSS and the browser script — lives inside ONE template
 * literal in lib/panel.js. A backtick anywhere inside it, including inside a
 * comment, terminates the literal early and produces a parse error somewhere
 * unrelated. That happened four times while building this panel, so it is now
 * checked by a script that does NOT import panel.js: the main test file imports
 * it, which means a syntax error there stops the guard from ever running.
 *
 * Run: node test/shell-guard.mjs
 * Exit: 0 when clean, 1 with the offending lines listed.
 */

import { readNormalized } from './source.mjs'
import { readFileSync } from 'node:fs'

const BT = String.fromCharCode(96)
const source = readNormalized(new URL('../lib/panel.js', import.meta.url), 'utf8')

const open = source.indexOf('html' + BT + '<!doctype html>')
if (open === -1) {
  console.error('FAIL: could not locate the shell template opener')
  process.exit(1)
}
const close = source.indexOf('</html>' + BT, open)
if (close === -1) {
  console.error('FAIL: could not locate the shell template closer')
  process.exit(1)
}

// +5 skips the four characters of `html` plus the opening backtick.
const shell = source.slice(open + 5, close)
const offenders = shell
  .split('\n')
  .map((line, index) => ({ number: index + 1, line: line.trim() }))
  .filter((entry) => entry.line.includes(BT))

if (offenders.length > 0) {
  console.error('FAIL: a backtick inside the shell terminates the template early')
  for (const entry of offenders) {
    console.error('  line ' + String(entry.number) + ': ' + entry.line.slice(0, 100))
  }
  console.error('\nUse string concatenation inside the shell, never a template literal.')
  process.exit(1)
}

// A second trap: a tagged template yields `undefined` for any segment holding an
// invalid escape, so a plain regex \s in the embedded script would silently
// degrade the whole page to the text "undefined". The tag uses raw strings to
// avoid that; assert it stays that way.
if (!source.includes('strings.raw')) {
  console.error('FAIL: the html tag must read strings.raw, or invalid escapes become undefined')
  process.exit(1)
}

console.log('OK: shell has no stray backtick, and the html tag reads raw strings')
