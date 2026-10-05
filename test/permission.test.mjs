/**
 * Tests for the phone-triggered permission gate.
 *
 * The load-bearing assertion in here is negative: the phone must never be able
 * to read the authorization code. `action=state` is the route the phone polls,
 * and if a code ever leaks into it the whole handshake degrades into "the phone
 * authorizes itself" — which is exactly what the desktop popup exists to stop.
 *
 * The `view` key is recovered the way an operator would get it: from the popup
 * URL the gate logs. That keeps the test honest about the real path rather than
 * reaching into module internals.
 */

import { createPermissionGate } from '../lib/permission-gate.js'
import vm from 'node:vm'

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

/* ── harness ──────────────────────────────────────────────────────────────── */

function fakeService(names = ['read-only', 'workspace-write', 'danger-full-access']) {
  const applied = new Map()
  return {
    names,
    defaultPreset: 'read-only',
    applied,
    optionOf: (name) => ({ value: name, name, description: `${name} — a description` }),
    current: (session) => applied.get(session.key) ?? 'read-only',
    set: (session, name) => {
      if (!names.includes(name)) throw new Error(`unknown preset "${name}"`)
      applied.set(session.key, name)
    },
  }
}

function makeHarness(config = {}, service = fakeService()) {
  const logs = []
  const ctx = {
    get: (name) => (name === 'permissionPresets' ? service : undefined),
    logger: {
      info: (line) => logs.push(String(line)),
      warn: (line) => logs.push(String(line)),
    },
  }
  const runtime = {
    serialize: (_id, operation) => operation(),
    ensureAgent: async (sessionId) => ({ session: { key: sessionId } }),
  }
  const gate = createPermissionGate(ctx, {
    basePath: '/bridge',
    token: 'test-token',
    runtime,
    desktopPopup: false,
    ...config,
  })
  return { gate, service, logs, runtime }
}

function fakeReq(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      res.headersSent = true
      return res
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
      return res
    },
    destroy() {},
  }
  return res
}

const BASE = 'http://127.0.0.1:19387/bridge'

async function call(gate, method, rest, query = '', body) {
  const url = new URL(`${BASE}${rest}${query === '' ? '' : `?${query}`}`)
  const res = fakeRes()
  const owned = await gate.handle(fakeReq(method, body), res, url, rest)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { owned, status: res.status, headers: res.headers, body: res.body, json, res }
}

/** The popup URL is what an operator actually receives; recover the view key from it. */
function viewKeyFrom(logs) {
  for (const line of logs) {
    const match = /view=([0-9a-f]{32})/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}

function codeFromPopupBody(body) {
  return /<div class="code" id="code">(\d{6})<\/div>/.exec(body)?.[1]
}

async function popupCode(gate, id, view) {
  const state = await call(gate, 'GET', '/desktop/state', `id=${id}&view=${view}`)
  return state.json?.code
}

/* ── tests ────────────────────────────────────────────────────────────────── */

group('requesting a change')

{
  const { gate, service, logs } = makeHarness()
  const res = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 'session-aaaa',
    preset: 'danger-full-access',
  })
  ok('refuses danger-full-access from the phone', res.status === 403, `status ${res.status}`)
  ok('does not apply anything on refusal', service.applied.size === 0)
}

{
  const { gate, logs } = makeHarness()
  const res = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 'session-aaaa',
    preset: 'workspace-write',
  })
  ok('accepts an allow-listed preset', res.status === 201, `status ${res.status}`)
  ok('returns an id', typeof res.json?.id === 'string' && res.json.id.startsWith('pg-'))
  ok('reports the display mode', res.json?.mode === 'display')
  ok('does NOT return the code', res.json?.code === undefined)
  ok('does NOT return a view key', res.json?.view === undefined)
  ok('logs the desktop popup URL', viewKeyFrom(logs) !== undefined, logs.join(' | '))
}

{
  const { gate } = makeHarness()
  const res = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 'session-aaaa',
    preset: 'not-a-preset',
  })
  ok('rejects an unknown preset name', res.status === 403 || res.status === 400, `status ${res.status}`)

  const noSession = await call(gate, 'POST', '/api/perm', 'action=request', { preset: 'read-only' })
  ok('requires a session', noSession.status === 400, `status ${noSession.status}`)
}

group('the code stays on the desktop')

{
  const { gate, logs, service } = makeHarness()
  const started = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 'session-aaaa',
    preset: 'workspace-write',
  })
  const id = started.json.id
  const view = viewKeyFrom(logs)
  const code = await popupCode(gate, id, view)
  ok('the popup can read a 6-digit code', /^\d{6}$/.test(String(code)), String(code))

  const phone = await call(gate, 'GET', '/api/perm', `action=state&id=${id}`)
  ok('the phone poll succeeds', phone.status === 200, `status ${phone.status}`)
  ok('the phone poll NEVER carries the code', phone.json?.code === undefined)
  ok('the phone poll body does not contain the code', !phone.body.includes(String(code)))
  ok('the request body did not contain the code either', !started.body.includes(String(code)))

  const noView = await call(gate, 'GET', '/desktop/state', `id=${id}`)
  ok('the popup route refuses to answer without the view key', noView.status === 404, `status ${noView.status}`)

  const wrongView = await call(gate, 'GET', '/desktop/state', `id=${id}&view=${'0'.repeat(32)}`)
  ok('the popup route refuses a wrong view key', wrongView.status === 404, `status ${wrongView.status}`)

  ok('nothing was applied just by asking', service.applied.size === 0)
}

group('the handshake')

{
  const { gate, logs, service } = makeHarness()
  const started = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 'session-aaaa',
    preset: 'workspace-write',
  })
  const id = started.json.id
  const code = await popupCode(gate, id, viewKeyFrom(logs))

  const wrong = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code: '000000' })
  ok('a wrong code is refused', wrong.status === 403, `status ${wrong.status}`)
  ok('a wrong code does not change the preset', service.applied.size === 0)
  ok('a wrong code reports the attempts left', wrong.json?.attemptsLeft === 4, String(wrong.json?.attemptsLeft))

  const right = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code })
  ok('the right code is accepted', right.status === 200, `status ${right.status}`)
  ok('the preset is applied to the session', service.current({ key: 'session-aaaa' }) === 'workspace-write')
  ok('the response echoes the applied preset', right.json?.applied === 'workspace-write')

  const again = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code })
  ok('a second confirm is refused, not silently reapplied', again.status === 409, `status ${again.status}`)

  const phone = await call(gate, 'GET', '/api/perm', `action=state&id=${id}`)
  ok('the phone sees the approved status', phone.json?.status === 'approved')
}

{
  const { gate, logs } = makeHarness({ desktopPopup: false })
  const started = await call(gate, 'POST', '/api/perm', 'action=request', {
    session: 's',
    preset: 'read-only',
  })
  const id = started.json.id
  const code = await popupCode(gate, id, viewKeyFrom(logs))
  // Burn the attempt budget. The 6th wrong attempt settles it.
  let last
  for (let i = 0; i < 5; i += 1) {
    last = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code: '000000' })
  }
  ok('exhausting the attempts rejects the request', last.json?.status === 'rejected', JSON.stringify(last.json))
  const after = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code })
  ok('a rejected request can no longer be confirmed', after.status === 409, `status ${after.status}`)
}

{
  const { gate, logs } = makeHarness({ ttlMs: -1 })
  const started = await call(gate, 'POST', '/api/perm', 'action=request', { session: 's', preset: 'read-only' })
  const id = started.json.id
  const code = await popupCode(gate, id, viewKeyFrom(logs))
  const late = await call(gate, 'POST', '/api/perm', 'action=confirm', { id, code })
  ok('an expired request cannot be confirmed', late.status === 409, `status ${late.status}`)
  ok('an expired request reports the expiry', late.json?.status === 'expired', JSON.stringify(late.json))
}

{
  const { gate, logs } = makeHarness()
  const started = await call(gate, 'POST', '/api/perm', 'action=request', { session: 's', preset: 'workspace-write' })
  const id = started.json.id
  const view = viewKeyFrom(logs)
  const rejected = await call(gate, 'POST', '/desktop/reject', `id=${id}&view=${view}`)
  ok('the desktop can reject', rejected.status === 200 && rejected.json.status === 'rejected')
  const state = await call(gate, 'GET', '/api/perm', `action=state&id=${id}`)
  ok('the phone sees the desktop rejection', state.json?.status === 'rejected')
}

{
  const { gate } = makeHarness()
  const started = await call(gate, 'POST', '/api/perm', 'action=request', { session: 's', preset: 'workspace-write' })
  const cancelled = await call(gate, 'POST', '/api/perm', 'action=cancel', { id: started.json.id })
  ok('the phone can withdraw its own request', cancelled.json?.status === 'cancelled')
}

group('fixed-code mode')

{
  const { gate, logs } = makeHarness({ fixedCode: '246810' })
  const started = await call(gate, 'POST', '/api/perm', 'action=request', { session: 's', preset: 'workspace-write' })
  ok('reports the fixed mode', started.json?.mode === 'fixed')
  const view = viewKeyFrom(logs)
  const popup = await call(gate, 'GET', '/desktop/state', `id=${started.json.id}&view=${view}`)
  ok('the popup does not echo a configured code', popup.json?.code === '')
  const confirm = await call(gate, 'POST', '/api/perm', 'action=confirm', {
    id: started.json.id,
    code: '246810',
  })
  ok('the configured code is accepted', confirm.status === 200, `status ${confirm.status}`)
}

group('the popup page')

{
  const { gate, logs } = makeHarness()
  const started = await call(gate, 'POST', '/api/perm', 'action=request', { session: 's', preset: 'read-only' })
  const id = started.json.id
  const view = viewKeyFrom(logs)

  const slashless = await call(gate, 'GET', '/desktop', `id=${id}&view=${view}`)
  ok('the slashless popup URL redirects with its query intact',
    slashless.status === 308 && String(slashless.headers.location).includes(`id=${id}`),
    `${slashless.status} ${slashless.headers.location}`)

  const page = await call(gate, 'GET', '/desktop/', `id=${id}&view=${view}`)
  ok('serves the popup as HTML', page.status === 200 && String(page.headers['content-type']).startsWith('text/html'))

  const code = await popupCode(gate, id, view)
  // The popup fetches the code live rather than embedding it, so the served
  // markup must NOT contain it — that keeps the code out of anything that might
  // cache or log the response body.
  ok('the popup markup does not embed the code', code !== undefined && !page.body.includes(String(code)))

  const script = /<script>([\s\S]*?)<\/script>/.exec(page.body)?.[1]
  ok('the popup has an inline script', typeof script === 'string' && script.length > 100)
  let parseError = null
  try {
    new vm.Script(script)
  } catch (error) {
    parseError = error
  }
  ok('the popup inline script parses as JavaScript', parseError === null, String(parseError))

  const gone = await call(gate, 'GET', '/desktop/', 'id=pg-999&view=' + 'a'.repeat(32))
  ok('an unknown popup id is a typed 404, not a crash', gone.status === 404, `status ${gone.status}`)
}

group('the dialog asset')

{
  const { gate } = makeHarness()
  const asset = await call(gate, 'GET', '/permission-ui.js')
  ok('serves the dialog script', asset.status === 200, `status ${asset.status}`)
  ok('serves it as JavaScript', String(asset.headers['content-type']).startsWith('text/javascript'))
  let parseError = null
  try {
    new vm.Script(asset.body)
  } catch (error) {
    parseError = error
  }
  ok('the dialog script parses as JavaScript', parseError === null, String(parseError))
  ok('the dialog asks for the options route', asset.body.includes('action=options'))
}

group('preset options')

{
  const { gate } = makeHarness()
  const res = await call(gate, 'GET', '/api/perm', 'action=options&fresh=1')
  ok('lists only the allow-listed presets', res.json?.options.length === 2, JSON.stringify(res.json?.options))
  ok('omits danger-full-access', !JSON.stringify(res.json?.options).includes('danger-full-access'))
  ok('reports the default preset', res.json?.defaultPreset === 'read-only')
  ok('skips reading a session for a fresh conversation', res.json?.current === null)
}

{
  const service = fakeService()
  service.applied.set('session-aaaa', 'workspace-write')
  const { gate } = makeHarness({}, service)
  const res = await call(gate, 'GET', '/api/perm', 'action=options&session=session-aaaa')
  ok('reports the current preset for an existing conversation', res.json?.current === 'workspace-write')
}

group('the disable switch')

{
  const { gate } = makeHarness({ enabled: false })
  const routes = [['GET', '/permission-ui.js'], ['GET', '/desktop/'], ['GET', '/api/perm'], ['POST', '/api/perm']]
  let owns = 0
  for (const [method, rest] of routes) {
    const res = await call(gate, method, rest)
    if (res.owned !== false) owns += 1
  }
  ok('a disabled gate owns no route, so every one falls through to the 404', owns === 0)
}

group('degraded host')

{
  const ctx = {
    get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  const gate = createPermissionGate(ctx, {
    basePath: '/bridge',
    token: 't',
    runtime: { serialize: (_i, op) => op(), ensureAgent: async () => ({ session: {} }) },
    desktopPopup: false,
  })
  const res = await call(gate, 'GET', '/api/perm', 'action=options')
  ok('a host without permissionPresets answers 503 rather than throwing', res.status === 503, `status ${res.status}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
