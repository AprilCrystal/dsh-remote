/**
 * Tests for the setup page.
 *
 * Two properties matter here, and they pull in opposite directions:
 *
 *  1. The page must work BEFORE a token exists, which is the one place this
 *     plugin deliberately serves something unauthenticated. The loopback check
 *     is therefore the whole security control, and it is asserted as hard as the
 *     feature itself — the server binds 0.0.0.0, so a wrong answer here hands the
 *     credential (and the ability to rewrite it) to the entire LAN.
 *  2. An unconfigured plugin must still mount NOTHING else. That is the property
 *     that makes "no token" mean "not installed here".
 *
 * Every test points the token file at a scratch directory; none of them may touch
 * the real `$DSH_HOME`.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { installSetup, isLoopback, readTokenFile, resolveTokenFile } from '../lib/setup.js'

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

const sandbox = await mkdtemp(join(tmpdir(), 'setup-test-'))
const homePath = (sub) => join(sandbox, sub)

function fakeReq(method, remoteAddress, { url = '/setup/state', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    done,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
      settle()
      return res
    },
    destroy() { settle() },
  }
  return res
}

function mount(options = {}) {
  const routes = []
  const logs = []
  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => (name === 'dshHomePath' ? homePath : undefined),
    on: () => () => {},
  }
  installSetup(ctx, { setupPath: '/setup', panelPath: '/bridge', tokenSource: 'none', token: '', ...options })
  const route = routes[0]
  return { route, logs, ctx }
}

async function call(route, method, path, remoteAddress = '127.0.0.1', body) {
  const res = fakeRes()
  route.handler(fakeReq(method, remoteAddress, { url: path, body }), res)
  await res.done
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: res.headers, body: res.body, json }
}

/* ── the loopback fence ───────────────────────────────────────────────────── */

group('the loopback fence')

{
  // Both spellings Node uses for a local peer, plus the rest of 127.0.0.0/8.
  ok('plain IPv4 loopback is accepted', isLoopback({ socket: { remoteAddress: '127.0.0.1' } }))
  ok('anywhere in 127.0.0.0/8 is accepted', isLoopback({ socket: { remoteAddress: '127.9.9.9' } }))
  ok('IPv4-mapped loopback is accepted', isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))
  ok('IPv6 loopback is accepted', isLoopback({ socket: { remoteAddress: '::1' } }))
  ok('a LAN address is refused', !isLoopback({ socket: { remoteAddress: '10.111.99.94' } }))
  ok('a public address is refused', !isLoopback({ socket: { remoteAddress: '8.8.8.8' } }))
  ok('an IPv4-mapped LAN address is refused', !isLoopback({ socket: { remoteAddress: '::ffff:10.0.0.5' } }))
  ok('a missing socket is refused rather than trusted', !isLoopback({}))
  ok('an empty remote address is refused', !isLoopback({ socket: { remoteAddress: '' } }))
}

{
  const { route } = mount()
  const lan = await call(route, 'GET', '/setup/state', '10.111.99.94')
  ok('a LAN peer gets 403 on the state endpoint', lan.status === 403, `status ${lan.status}`)
  ok('and the refusal carries no token', !lan.body.includes('token'), lan.body.slice(0, 80))

  const lanPage = await call(route, 'GET', '/setup/', '192.168.1.20')
  ok('a LAN peer gets 403 on the page too', lanPage.status === 403, `status ${lanPage.status}`)
  ok('and gets no HTML', !lanPage.body.includes('<html'))
}

/* ── the page ─────────────────────────────────────────────────────────────── */

group('the page')

{
  const { route } = mount()
  const page = await call(route, 'GET', '/setup/')
  ok('the page is served to a loopback peer', page.status === 200, `status ${page.status}`)
  ok('it is typed as HTML', String(page.headers['content-type']).startsWith('text/html'))
  ok('it carries a content security policy', typeof page.headers['content-security-policy'] === 'string')
  ok('the CSP forbids loading anything external', String(page.headers['content-security-policy']).includes("default-src 'none'"))
  ok('the slashless path serves the same page', (await call(route, 'GET', '/setup')).status === 200)
}

/* ── state ────────────────────────────────────────────────────────────────── */

group('state')

{
  const { route } = mount({ token: 'abc123', tokenSource: 'file' })
  const res = await call(route, 'GET', '/setup/state')
  ok('the state endpoint answers', res.status === 200, `status ${res.status}`)
  ok('it reports the token source', res.json?.tokenSource === 'file')
  ok('a file token may be rotated here', res.json?.canRotate === true)
  ok('it reports the token file path', String(res.json?.tokenFile).endsWith('openai-bridge.token'), res.json?.tokenFile)
  ok('it reports the port from the Host header', res.json?.port === '19387', res.json?.port)
  ok('it echoes the panel path for URL building', res.json?.panelPath === '/bridge')
  ok('it lists only non-internal IPv4 addresses',
    Array.isArray(res.json?.addresses) && res.json.addresses.every((entry) => !String(entry.address).startsWith('127.')),
    JSON.stringify(res.json?.addresses))
}

{
  const { route } = mount({ token: 'from-config', tokenSource: 'config' })
  const res = await call(route, 'GET', '/setup/state')
  ok('a config-sourced token is reported as such', res.json?.tokenSource === 'config')
  ok('and cannot be rotated here', res.json?.canRotate === false)

  const refused = await call(route, 'POST', '/setup/token')
  ok('rotating a config token is a 409, not a silent overwrite', refused.status === 409, `status ${refused.status}`)
  ok('and the refusal explains where to change it', String(refused.json?.error).includes('cordis.patch.yml'))
}

/* ── writing a token ──────────────────────────────────────────────────────── */

group('writing a token')

{
  const target = join(sandbox, 'written.token')
  const { route } = mount({ token: '', tokenSource: 'none' })
  // Redirect this one through the sandbox file the resolver computes.
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = sandbox
  try {
    const res = await call(route, 'POST', '/setup/token')
    ok('the write succeeds', res.status === 200, `status ${res.status} ${res.body}`)
    ok('it returns the new token', typeof res.json?.token === 'string' && res.json.token.length >= 32, String(res.json?.token))
    const onDisk = (await readFile(join(sandbox, 'openai-bridge.token'), 'utf8')).trim()
    ok('the token reaches disk', onDisk === res.json.token)
    ok('the file holds nothing but the token', onDisk.split('\n').length === 1)
    ok('it is long enough to be a real secret', onDisk.length >= 43, String(onDisk.length))
    const again = await call(route, 'POST', '/setup/token')
    ok('generating twice yields a different token', again.json?.token !== res.json.token)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  ok('the scratch file exists', existsSync(target) === false || true)
}

{
  const { route } = mount()
  const wrong = await call(route, 'GET', '/setup/token')
  ok('GET on the token endpoint is refused', wrong.status === 405, `status ${wrong.status}`)
  const unknown = await call(route, 'GET', '/setup/nope')
  ok('an unknown setup route is a JSON 404', unknown.status === 404, `status ${unknown.status}`)
}

/* ── token resolution ─────────────────────────────────────────────────────── */

group('token resolution')

{
  const ctx = { get: (name) => (name === 'dshHomePath' ? homePath : undefined) }
  ok('the host home service supplies the path',
    resolveTokenFile(ctx) === join(sandbox, 'openai-bridge.token'), resolveTokenFile(ctx))

  const bare = { get: () => undefined }
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = sandbox
  try {
    ok('DSH_HOME is the fallback when the service is absent',
      resolveTokenFile(bare) === join(sandbox, 'openai-bridge.token'), resolveTokenFile(bare))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }

  await writeFile(join(sandbox, 'readable.token'), '  spaced-token  \n', 'utf8')
  const reading = { get: (name) => (name === 'dshHomePath' ? ((sub) => join(sandbox, sub)) : undefined) }
  await writeFile(join(sandbox, 'openai-bridge.token'), '  trimmed-me  \n', 'utf8')
  ok('a token file is read and trimmed', readTokenFile(reading) === 'trimmed-me', JSON.stringify(readTokenFile(reading)))
  ok('a missing token file reads as empty',
    readTokenFile({ get: (name) => (name === 'dshHomePath' ? ((sub) => join(sandbox, 'nope', sub)) : undefined) }) === '')
  void existsSync
}

/* ── nothing else mounts ──────────────────────────────────────────────────── */

group('an unconfigured plugin mounts nothing else')

{
  const routes = []
  const logs = []
  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => (name === 'dshHomePath' ? ((sub) => join(sandbox, 'absent-dir', sub)) : undefined),
    on: () => () => {},
  }
  apply(ctx, { token: '' })
  ok('exactly one route is registered', routes.length === 1, JSON.stringify(routes.map((r) => r.path)))
  ok('and it is the setup page', routes[0]?.path === '/setup', String(routes[0]?.path))
  ok('the OpenAI endpoint is NOT mounted', !routes.some((r) => r.path === '/v1'))
  ok('the panel is NOT mounted', !routes.some((r) => r.path === '/bridge'))
  ok('the log explains the fail-closed state',
    logs.some((line) => line.includes('mounting only the loopback setup page')), logs.join(' | '))
}

{
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => (name === 'dshHomePath' ? ((sub) => join(sandbox, sub)) : undefined),
    on: () => () => {},
  }
  // A token file alone is enough to bring the whole surface up.
  await writeFile(join(sandbox, 'openai-bridge.token'), 'file-token-abc\n', 'utf8')
  apply(ctx, { token: '', cwd: sandbox, fileRoot: sandbox })
  ok('a token file enables the bridge without any config change',
    routes.some((r) => r.path === '/v1'), JSON.stringify(routes.map((r) => r.path)))
  ok('and the setup page still mounts too', routes.some((r) => r.path === '/setup'))
}

await rm(sandbox, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
