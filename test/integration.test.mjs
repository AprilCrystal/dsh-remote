/**
 * Integration test: the permission gate over real HTTP, mounted through the real
 * panel route.
 *
 * `permission.test.mjs` drives the gate's own logic with stub req/res objects. It
 * cannot catch the failure this file exists for: whether `installPanel` actually
 * hands the new routes to the gate, whether the auth guard still covers the new
 * asset, and whether the token bootstrap preserves the popup's path. Those are
 * wiring facts, and wiring is exactly what breaks silently.
 *
 * So this mounts the real panel on a real `node:http` server and talks to it with
 * real requests and a hand-managed cookie.
 */

import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
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

const TOKEN = 'integration-token'

function fakeService() {
  const applied = new Map()
  const names = ['read-only', 'workspace-write', 'danger-full-access']
  return {
    names,
    defaultPreset: 'read-only',
    applied,
    optionOf: (name) => ({ value: name, name, description: `${name} description` }),
    current: (session) => applied.get(session.key) ?? 'read-only',
    set: (session, name) => {
      if (!names.includes(name)) throw new Error(`unknown preset "${name}"`)
      applied.set(session.key, name)
    },
  }
}

/** Mount the real panel and serve it on a real socket. */
async function serve(options = {}) {
  const routes = []
  const logs = []
  const service = options.service ?? fakeService()
  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: (name) => (name === 'permissionPresets' ? service : undefined),
    effect: (fn) => fn(),
    on: () => () => {},
  }
  installPanel(ctx, {
    token: TOKEN,
    fileRoot: options.fileRoot ?? joinPath(tmpdir(), 'bridge-integration'),
    basePath: '/bridge',
    runtime: {
      serialize: (_id, operation) => operation(),
      ensureAgent: async (sessionId) => ({ session: { key: sessionId } }),
      driveTurn: async () => ({ text: '' }),
    },
    permission: { desktopPopup: false, ...(options.permission ?? {}) },
  })

  const handler = routes[0]
  if (handler === undefined) throw new Error('the panel registered no route')

  const server = createServer((req, res) => handler.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin,
    logs,
    service,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const COOKIE = `dsh_bridge=${TOKEN}`

async function hit(origin, path, { method = 'GET', cookie = undefined, body = undefined } = {}) {
  const headers = {}
  if (cookie !== undefined) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(origin + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, headers: res.headers, text, json }
}

/**
 * Recover the view key for ONE request id. The log accumulates across requests,
 * so scanning for the first key would hand back an earlier request's key — and
 * the popup route would correctly refuse it.
 */
function viewKeyFor(logs, id) {
  for (const line of logs) {
    if (!line.includes(`permission request ${id} `)) continue
    const match = /view=([0-9a-f]{32})/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

let live

try {
  live = await serve()

  group('the new asset is behind the same auth guard')

  {
    const anon = await hit(live.origin, '/bridge/permission-ui.js')
    ok('an unauthenticated request for the dialog script is challenged', anon.status === 401, `status ${anon.status}`)
    ok('the challenge is HTML so a browser renders it', String(anon.headers.get('content-type')).startsWith('text/html'))

    const authed = await hit(live.origin, '/bridge/permission-ui.js', { cookie: COOKIE })
    ok('an authenticated request gets the script', authed.status === 200, `status ${authed.status}`)
    ok('it is typed as JavaScript', String(authed.headers.get('content-type')).startsWith('text/javascript'))
    ok('the script wires the options route', authed.text.includes('action=options'))
  }

  group('the fallthrough still 404s')

  {
    const bogus = await hit(live.origin, '/bridge/api/not-a-route', { cookie: COOKIE })
    ok('an unknown panel route is still a JSON 404',
      bogus.status === 404 && bogus.json?.error !== undefined, `status ${bogus.status}`)
  }

  group('the handshake over HTTP')

  let id
  let code
  let view

  {
    const options = await hit(live.origin, '/bridge/api/perm?action=options&fresh=1', { cookie: COOKIE })
    ok('the preset list loads', options.status === 200, `status ${options.status}`)
    ok('it offers exactly the two allow-listed presets', options.json?.options?.length === 2,
      JSON.stringify(options.json?.options))
    ok('danger-full-access is not offered', !JSON.stringify(options.json?.options).includes('danger-full-access'))

    const refused = await hit(live.origin, '/bridge/api/perm?action=request', {
      method: 'POST',
      cookie: COOKIE,
      body: { session: 'session-integration', preset: 'danger-full-access' },
    })
    ok('the whole route refuses danger-full-access', refused.status === 403, `status ${refused.status}`)

    const started = await hit(live.origin, '/bridge/api/perm?action=request', {
      method: 'POST',
      cookie: COOKIE,
      body: { session: 'session-integration', preset: 'workspace-write' },
    })
    ok('a request is accepted', started.status === 201, `status ${started.status} ${started.text}`)
    id = started.json.id
    view = viewKeyFor(live.logs, id)
    ok('the popup URL was logged with its view key', view !== undefined)
    ok('the HTTP response to the phone carries no code', started.json.code === undefined)
    ok('nothing is applied by asking', live.service.applied.size === 0)
  }

  {
    // The popup is opened cold by the desktop, so it arrives with the token and
    // no cookie. The bootstrap must trade that for a cookie WITHOUT dropping the
    // id and view it needs.
    const bootstrap = await hit(live.origin, `/bridge/desktop/?id=${id}&view=${view}&token=${TOKEN}`)
    ok('the cold popup URL bootstraps with a redirect', bootstrap.status === 303, `status ${bootstrap.status}`)
    const location = String(bootstrap.headers.get('location'))
    ok('the redirect keeps the request id', location.includes(`id=${id}`), location)
    ok('the redirect keeps the view key', location.includes(`view=${view}`), location)
    ok('the redirect strips the token from the URL', !location.includes('token='), location)
    const setCookie = String(bootstrap.headers.get('set-cookie'))
    ok('the redirect sets the panel cookie', setCookie.includes('dsh_bridge='), setCookie)
    ok('the cookie is HttpOnly', setCookie.includes('HttpOnly'))

    const page = await hit(live.origin, `/bridge/desktop/?id=${id}&view=${view}`, { cookie: COOKIE })
    ok('the popup renders', page.status === 200 && page.text.includes('手机端请求变更权限'),
      `status ${page.status}`)

    const state = await hit(live.origin, `/bridge/desktop/state?id=${id}&view=${view}`, { cookie: COOKIE })
    code = state.json?.code
    ok('the popup can read the code', /^\d{6}$/.test(String(code)), String(code))

    const phone = await hit(live.origin, `/bridge/api/perm?action=state&id=${id}`, { cookie: COOKIE })
    ok('the phone poll never carries the code', phone.json?.code === undefined)
    ok('the phone poll body never contains the code', !phone.text.includes(String(code)))

    const guessed = await hit(live.origin, `/bridge/desktop/state?id=${id}`, { cookie: COOKIE })
    ok('dropping the view key does not reveal the code', guessed.status === 404, `status ${guessed.status}`)
  }

  {
    const wrong = await hit(live.origin, '/bridge/api/perm?action=confirm', {
      method: 'POST',
      cookie: COOKIE,
      body: { id, code: '000000' },
    })
    ok('a wrong code is refused over HTTP', wrong.status === 403, `status ${wrong.status}`)
    ok('a wrong code changes nothing', live.service.applied.size === 0)

    const right = await hit(live.origin, '/bridge/api/perm?action=confirm', {
      method: 'POST',
      cookie: COOKIE,
      body: { id, code },
    })
    ok('the right code is accepted over HTTP', right.status === 200, `status ${right.status} ${right.text}`)
    ok('the preset actually reached the session', live.service.current({ key: 'session-integration' }) === 'workspace-write',
      String(live.service.current({ key: 'session-integration' })))

    const after = await hit(live.origin, `/bridge/api/perm?action=state&id=${id}`, { cookie: COOKIE })
    ok('the phone now sees it as approved', after.json?.status === 'approved')
  }

  group('the desktop can refuse')

  {
    const started = await hit(live.origin, '/bridge/api/perm?action=request', {
      method: 'POST',
      cookie: COOKIE,
      body: { session: 'session-integration', preset: 'read-only' },
    })
    const rejectId = started.json.id
    const rejectView = viewKeyFor(live.logs, rejectId)
    const rejected = await hit(live.origin, `/bridge/desktop/reject?id=${rejectId}&view=${rejectView}`, {
      method: 'POST',
      cookie: COOKIE,
    })
    ok('the popup can reject', rejected.status === 200 && rejected.json?.status === 'rejected',
      `status ${rejected.status}`)
    const state = await hit(live.origin, `/bridge/api/perm?action=state&id=${rejectId}`, { cookie: COOKIE })
    ok('the phone learns about the rejection', state.json?.status === 'rejected')
    ok('a rejected change never touches the preset',
      live.service.current({ key: 'session-integration' }) === 'workspace-write',
      String(live.service.current({ key: 'session-integration' })))
  }

  await live.close()
  live = undefined
} finally {
  if (live !== undefined) await live.close()
}

group('a disabled gate')

{
  const off = await serve({ permission: { enabled: false } })
  try {
    const asset = await hit(off.origin, '/bridge/permission-ui.js', { cookie: COOKIE })
    ok('the dialog script is not served when the feature is off', asset.status === 404, `status ${asset.status}`)
    const api = await hit(off.origin, '/bridge/api/perm?action=options', { cookie: COOKIE })
    ok('the permission API is not served either', api.status === 404, `status ${api.status}`)
    const panel = await hit(off.origin, '/bridge/', { cookie: COOKIE })
    ok('the panel itself still works', panel.status === 200, `status ${panel.status}`)
    ok('the panel does not reference the dialog script', !panel.text.includes('permission-ui.js'))
  } finally {
    await off.close()
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
