/**
 * Tests for multi-root file browsing, over real HTTP against the real panel.
 *
 * The interesting parts are not "does it list a directory" — that already worked
 * — but the two things the single-root version could not express: a virtual root
 * that lists drives, and a containment check that accepts absolute paths while
 * still refusing anything outside every allow-listed root. A widened browse root
 * is exactly the kind of change that quietly turns a fence into decoration, so
 * the refusals are asserted as hard as the successes.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join as joinPath, sep } from 'node:path'
import { installPanel } from '../lib/panel.js'

let passed = 0
let failed = 0

function ok(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function group(name) {
  console.log(`\n${name}`)
}

const TOKEN = 'browse-token'
const COOKIE = `dsh_bridge=${TOKEN}`
const slash = (value) => String(value).split(sep).join('/')

async function serve(options = {}) {
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => () => {},
  }
  installPanel(ctx, {
    token: TOKEN,
    basePath: '/bridge',
    runtime: {
      serialize: (_id, operation) => operation(),
      ensureAgent: async (sessionId) => ({ session: { key: sessionId } }),
      driveTurn: async () => ({ text: '' }),
    },
    ...options,
  })
  const server = createServer((req, res) => routes[0].handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) }
}

async function files(origin, path) {
  const res = await fetch(`${origin}/bridge/api/files?path=${encodeURIComponent(path)}`, {
    headers: { cookie: COOKIE },
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

async function readFileApi(origin, path) {
  const res = await fetch(`${origin}/bridge/api/file?path=${encodeURIComponent(path)}`, {
    headers: { cookie: COOKIE },
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, json, text }
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const sandbox = await mkdtemp(joinPath(tmpdir(), 'browse-test-'))
const rootA = joinPath(sandbox, 'alpha')
const rootB = joinPath(sandbox, 'beta')
const outside = joinPath(sandbox, 'outside')
await mkdir(joinPath(rootA, 'inner'), { recursive: true })
await mkdir(rootB, { recursive: true })
await mkdir(outside, { recursive: true })
await writeFile(joinPath(rootA, 'readme.txt'), 'hello from alpha', 'utf8')
await writeFile(joinPath(rootA, 'inner', 'deep.txt'), 'deep', 'utf8')
await writeFile(joinPath(rootB, 'beta.txt'), 'beta', 'utf8')
await writeFile(joinPath(outside, 'secret.txt'), 'should never be readable', 'utf8')

const A = slash(rootA)
const B = slash(rootB)

let live

try {
  live = await serve({ fileRoot: [rootA, rootB], inboxRoot: rootA })

  group('the virtual root')

  {
    const res = await files(live.origin, '')
    ok('the virtual root loads', res.status === 200, `status ${res.status}`)
    ok('it reports itself as the top', res.json?.path === '' && res.json?.parent === null)
    ok('it lists both roots', res.json?.entries.length === 2, JSON.stringify(res.json?.entries))
    const byPath = Object.fromEntries((res.json?.entries ?? []).map((e) => [e.path, e]))
    ok('each root is navigable by its own path', byPath[A] !== undefined && byPath[B] !== undefined,
      JSON.stringify(Object.keys(byPath)))
    ok('root entries are directories', byPath[A]?.type === 'dir')
    ok('the configured roots are echoed for the client', res.json?.roots?.length === 2)
  }

  group('listing inside a root')

  {
    const res = await files(live.origin, A)
    ok('a root lists its contents', res.status === 200, `status ${res.status}`)
    const names = (res.json?.entries ?? []).map((e) => e.name).sort()
    ok('the file is there', names.includes('readme.txt'), JSON.stringify(names))
    ok('the subdirectory is there', names.includes('inner'))
    ok('dirs sort before files', res.json?.entries?.[0]?.type === 'dir')
    const readme = res.json.entries.find((e) => e.name === 'readme.txt')
    ok('each entry carries a navigable absolute path', readme?.path === `${A}/readme.txt`, readme?.path)
    ok('being at a root means its parent is the virtual root', res.json?.parent === '')
    ok('an entry path round-trips back into a listing', await (async () => {
      const deeper = await files(live.origin, readme.path)
      return deeper.status === 400
    })())
  }

  {
    const res = await files(live.origin, `${A}/inner`)
    ok('a nested directory lists', res.status === 200, `status ${res.status}`)
    ok('its parent is the root above it', res.json?.parent === A, res.json?.parent)
    ok('the nested file is reachable', (res.json?.entries ?? []).some((e) => e.name === 'deep.txt'))
  }

  group('containment is still a fence')

  {
    const traversal = await files(live.origin, '../')
    ok('a traversal path is refused', traversal.status === 400, `status ${traversal.status}`)
    const deep = await files(live.origin, `${A}/../../outside`)
    ok('an embedded traversal is refused', deep.status === 400, `status ${deep.status}`)

    const escaped = await files(live.origin, slash(outside))
    ok('an absolute path outside every root is refused', escaped.status === 403, `status ${escaped.status}`)
    const escapedFile = await readFileApi(live.origin, `${slash(outside)}/secret.txt`)
    ok('so is reading a file outside every root', escapedFile.status === 403, `status ${escapedFile.status}`)
    ok('the refusal does not leak the content', !escapedFile.text.includes('should never be readable'))

    const missing = await files(live.origin, `${A}/nope`)
    ok('a missing path is a 404, not a 500', missing.status === 404, `status ${missing.status}`)
  }

  group('reading through a browsable path')

  {
    const res = await readFileApi(live.origin, `${A}/readme.txt`)
    ok('a file inside a root reads', res.status === 200, `status ${res.status}`)
    ok('its text comes back', res.json?.text === 'hello from alpha', JSON.stringify(res.json?.text))
    ok('a directory is refused as a file', (await readFileApi(live.origin, A)).status === 400)
  }

  await live.close()
  live = undefined

  group('a single root keeps its old shape')

  {
    const single = await serve({ fileRoot: rootA, inboxRoot: rootA })
    try {
      const root = await files(single.origin, '')
      ok('the root lists its contents, not itself', root.status === 200, `status ${root.status}`)
      ok('the root is the top, so there is no way up', root.json?.parent === null)
      ok('paths stay relative at the root', root.json?.path === '')
      const readme = root.json.entries.find((e) => e.name === 'readme.txt')
      ok('entry paths stay relative too', readme?.path === 'readme.txt', readme?.path)
      const inner = await files(single.origin, 'inner')
      ok('a relative subdirectory still resolves', inner.status === 200, `status ${inner.status}`)
      ok('its parent is the empty root path', inner.json?.parent === '', inner.json?.parent)
      ok('an absolute path is still refused for one root', (await files(single.origin, slash(rootB))).status === 403)
    } finally {
      await single.close()
    }
  }

  group('whole-machine mode')

  {
    const whole = await serve({ fileRoot: '*', inboxRoot: rootA })
    try {
      const root = await files(whole.origin, '')
      ok('the virtual root lists drives', root.status === 200 && root.json.entries.length > 0,
        JSON.stringify(root.json?.entries))
      const paths = (root.json?.entries ?? []).map((e) => e.path)
      ok('drive paths are absolute and navigable', paths.every((p) => /^[A-Za-z]:\/$/u.test(p)),
        JSON.stringify(paths))
      ok('the system drive is among them', paths.includes('C:/'), JSON.stringify(paths))
      const listed = await files(whole.origin, 'C:/')
      ok('a drive root can be listed', listed.status === 200, `status ${listed.status} ${listed.text.slice(0, 80)}`)
      ok('the drive listing is non-empty', (listed.json?.entries ?? []).length > 0)
    } finally {
      await whole.close()
    }
  }
} finally {
  if (live !== undefined) await live.close()
  await rm(sandbox, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
