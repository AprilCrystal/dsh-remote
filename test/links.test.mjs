/**
 * Tests for links and local paths in a rendered reply.
 *
 * Two reported failures, and both were mine:
 *
 *  - A path in a reply, tapped, opened a 404 whose address was a wall of percent
 *    signs. `safeHref` resolved the target against the panel address, so ANY bare
 *    or relative path became an http link on this server. A path is not a URL.
 *  - A path rendered as inert text or as inline code, with no way to open it.
 *
 * The patterns are extracted from the served shell and exercised here rather than
 * re-typed, so a table of shapes is really testing the code that ships. What
 * matters most is the negative case: "http://example.com/a" contains
 * "p://example.com/a", which fits the path shape exactly, and mangling a URL into a
 * file chip would be a worse bug than the one being fixed.
 */

import { readNormalized } from './source.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const source = readNormalized(new URL('../lib/panel.js', import.meta.url), 'utf8')

/** Pull one regex literal out of the served shell and compile it for real. */
function literal(name) {
  const match = new RegExp(`const ${name} = (/.*?/[a-z]*);`, 'u').exec(source)
  assert.ok(match, `could not find the ${name} literal in the shell`)
  return new Function(`return ${match[1]}`)()
}

const PATH_SHAPE = literal('PATH_SHAPE')
const UNC_SHAPE = literal('UNC_SHAPE')
const PATH_IN_TEXT = literal('PATH_IN_TEXT')

/** The predicate the shell uses, over the same two literals. */
const looksLikePath = (value) => {
  const text = String(value).trim()
  return PATH_SHAPE.test(text) || UNC_SHAPE.test(text)
}

/**
 * The shell's scanner, reduced to what it decides: the segments of a line, each
 * either prose or a path. Mirrors `textWithPaths` including the URL guard.
 */
function scan(text) {
  const re = new RegExp(PATH_IN_TEXT.source, 'gu')
  const out = []
  let last = 0
  let match
  while ((match = re.exec(text)) !== null) {
    const quoted = match[1] !== undefined || match[2] !== undefined
    const found = match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3])
    if (!quoted) {
      const at = text.indexOf(found, match.index)
      const before = at === 0 ? '' : text[at - 1]
      if (/\w/u.test(before)) { re.lastIndex = match.index + 1; continue }
    }
    if (match.index > last) out.push({ kind: 'text', value: text.slice(last, match.index) })
    out.push({ kind: 'path', value: found })
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}

const paths = (text) => scan(text).filter((part) => part.kind === 'path').map((part) => part.value)

/* ── tests ────────────────────────────────────────────────────────────────── */

console.log('a path is not a URL')

check('safeHref only accepts an explicit scheme', () => {
  // The bug: new URL(url, location.href) resolved "notes/x.txt" against the panel
  // address, producing an http link on this server that cannot exist.
  assert.doesNotMatch(source, /new URL\(url, location\.href\)/u)
  assert.match(source, /if \(!\(\/\^https\?:\\\/\\\/\/iu\.test\(text\) \|\| \/\^mailto:\/iu\.test\(text\)\)\) return null;/u)
})

check('a relative or rooted path is never a link', () => {
  // Stated as behaviour over the rule the shell now applies.
  const isUrl = (value) => /^https?:\/\//iu.test(value) || /^mailto:/iu.test(value)
  for (const notAUrl of ['notes/x.txt', '/documents/file.txt', 'sub/dir/', './x.md', 'C:\\Users\\a.txt']) {
    assert.equal(isUrl(notAUrl), false, `${notAUrl} was treated as a URL`)
  }
  for (const url of ['http://x/y', 'https://x/y', 'mailto:a@b']) {
    assert.equal(isUrl(url), true, `${url} was not treated as a URL`)
  }
})

console.log('what counts as a path')

check('a drive letter with a separator and a segment', () => {
  for (const value of ['C:\\Users\\a.txt', 'C:/Users/a.txt', 'd:\\x', 'C:\\第1卷 奇点.txt'.replace(' ', '')]) {
    assert.equal(looksLikePath(value), true, `${value} was not a path`)
  }
})

check('a UNC share', () => {
  assert.equal(looksLikePath('\\\\server\\share\\a.txt'), true)
})

check('prose, a bare drive letter, and a URL are not paths', () => {
  for (const value of ['C:', 'C:\\', 'hello', 'http://example.com/a', 'a:b', '']) {
    assert.equal(looksLikePath(value), false, `${value} was treated as a path`)
  }
})

console.log('finding a path inside a line')

check('a bare path in prose is found', () => {
  assert.deepEqual(paths('改好了，见 C:\\Users\\21683\\a.txt'), ['C:\\Users\\21683\\a.txt'])
})

check('the quoted reference form is found, spaces and all', () => {
  assert.deepEqual(paths('见 @"C:\\Users\\21683\\第1卷 奇点.txt" 这个文件'), ['C:\\Users\\21683\\第1卷 奇点.txt'])
  assert.deepEqual(paths('"D:\\a b\\c.txt"'), ['D:\\a b\\c.txt'])
})

check('a URL is NOT turned into a file chip', () => {
  // "http://example.com/a/b" contains "p://example.com/a/b", which fits the path
  // shape exactly. Mangled URLs would be a worse bug than the one being fixed.
  assert.deepEqual(paths('see http://example.com/a/b for details'), [])
  assert.deepEqual(paths('https://x.dev/p/q'), [])
  const parts = scan('see http://example.com/a/b ok')
  assert.equal(parts.length, 1)
  assert.equal(parts[0].kind, 'text')
  assert.match(parts[0].value, /http:\/\/example\.com\/a\/b/u)
})

check('prose around a path is preserved exactly', () => {
  const parts = scan('看 C:\\a\\b.txt 这个')
  assert.deepEqual(parts.map((part) => part.kind), ['text', 'path', 'text'])
  assert.equal(parts[0].value, '看 ')
  assert.equal(parts[2].value, ' 这个')
})

check('a path at the very start is found', () => {
  assert.deepEqual(paths('C:\\a\\b.txt 是刚写的'), ['C:\\a\\b.txt'])
})

check('the URL guard exists in the shell, not just here', () => {
  assert.match(source, /function pathStartsHere\(text, index\)/u)
  assert.match(source, /return !\/\\w\/u\.test\(text\[index - 1\]\);/u)
  assert.match(source, /if \(!pathStartsHere\(text, at\)\)/u)
})

console.log('what a tap does')

check('a chip opens the viewer rather than a URL', () => {
  assert.match(source, /if \(\/\\\.\[A-Za-z0-9\]\{1,8\}\$\/u\.test\(path\)\) void showFile\(path\);/u)
  assert.match(source, /else void showFiles\(path\);/u)
})

check('inline code that is a path becomes a chip too', () => {
  // "rendered as a code field" was the other half of the report.
  assert.match(source, /if \(looksLikePath\(code\[2\]\)\) \{ parent\.append\(fileChip\(code\[2\]\)\); continue; \}/u)
})

check('prose is scanned through textWithPaths, not the plain writer', () => {
  assert.match(source, /if \(m\.index > last\) textWithPaths\(parent, part\.slice\(last, m\.index\)\);/u)
})

check('the TAIL of a run is scanned too, or a plain paragraph shows no path', () => {
  // The bug the screenshots showed: the tail went through the plain writer, so a
  // paragraph with NO inline markup — the common case for a path on its own line —
  // never reached the scanner and the path stayed inert text. Every test passed
  // because they exercised the scanner directly rather than this call site.
  assert.match(source, /if \(last < part\.length\) textWithPaths\(parent, part\.slice\(last\)\);/u)
  assert.doesNotMatch(source, /textWithBreaks\(parent, part\.slice\(last\)\)/u)
})

check('the chip is styled as a chip', () => {
  assert.match(source, /button\.filechip \{ display:inline-block;/u)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)