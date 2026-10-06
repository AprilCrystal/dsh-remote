/**
 * Tests for forking a conversation.
 *
 * `planForkCut` carries the weight here, and it is pure for a reason: the cut is
 * the part of a fork that is easy to get subtly wrong and impossible to notice in
 * a smoke test. A child seeded one event short still looks like a conversation —
 * it just has a request with no reply, or a tool call with no result — and the
 * symptom shows up much later as an agent confused about its own history.
 *
 * The rule being mirrored is the harness session controller's: cut at a COMPLETED
 * turn, then advance to the next `turn/start`, so anything logged after the last
 * `turn/end` stays with the source rather than trailing the child.
 */

import { readNormalized } from './source.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPanel } from '../lib/panel.js'
import { planForkCut } from '../lib/index.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const TOKEN = 'fork-token'
const root = await mkdtemp(join(tmpdir(), 'fork-test-'))
const wire = readNormalized(new URL('../lib/index.js', import.meta.url), 'utf8')
const shell = readNormalized(new URL('../lib/panel.js', import.meta.url), 'utf8')

/* ── harness ──────────────────────────────────────────────────────────────── */

/** A log as `seq`-numbered events, so the cut is asserted against seq not index. */
const log = (...types) => types.map((type, seq) => ({ type, seq }))

function fakeRequest({ method = 'GET', url, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { cookie: `dsh_bridge=${TOKEN}`, host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    status: undefined,
    body: '',
    writeHead(code) { this.status = code },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    destroy() {},
  }
}

const settle = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function mount(runtime) {
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
    on: () => () => {},
  }
  installPanel(ctx, { token: TOKEN, fileRoot: root, basePath: '/bridge', runtime })
  return routes[0]
}

async function post(route, path, body) {
  const res = fakeResponse()
  route.handler(fakeRequest({ method: 'POST', url: path, body }), res)
  await settle()
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.status, body: res.body, json }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

console.log('where a fork may cut')

await check('nothing to fork is a 409, not a child with no history', () => {
  assert.throws(() => planForkCut(log('session', 'user/message', 'turn/start')), (error) => error.status === 409)
  assert.throws(() => planForkCut([]), (error) => error.status === 409)
})

await check('one completed turn cuts just past its end', () => {
  const events = log('session', 'turn/start', 'turn/end')
  assert.deepEqual(planForkCut(events), { boundarySeq: 2, cut: 3 })
})

await check('the LAST completed turn wins', () => {
  const events = log('session', 'turn/start', 'turn/end', 'turn/start', 'turn/end')
  assert.deepEqual(planForkCut(events), { boundarySeq: 4, cut: 5 })
})

await check('an unfinished turn is left behind', () => {
  // The whole point: a running turn must not be half-seeded into the child.
  const events = log('session', 'turn/start', 'turn/end', 'turn/start', 'assistant/message')
  assert.deepEqual(planForkCut(events), { boundarySeq: 2, cut: 3 })
})

await check('it lands on a turn boundary, past the trailing events', () => {
  // A title and a delivery marker sit after the last completed turn, and a new
  // turn has begun without ending. The cut has to skip the two markers and stop AT
  // the new turn/start — not at the end of the log, and not before the markers.
  const events = log('session', 'turn/start', 'turn/end', 'session/title', 'turn/start', 'assistant/message')
  assert.deepEqual(planForkCut(events), { boundarySeq: 2, cut: 4 })
})

await check('with no following turn, trailing events are simply dropped', () => {
  const events = log('session', 'turn/start', 'turn/end', 'session/title', 'session/end-seed')
  assert.deepEqual(planForkCut(events), { boundarySeq: 2, cut: 5 })
})

await check('the cut follows seq, not array position', () => {
  // Replacement events make visible seqs non-monotonic, and the controller's rule
  // is stated in seqs. A seq past the array's own length has to clamp rather than
  // hand back an index that is not one.
  const events = [{ type: 'session', seq: 0 }, { type: 'turn/start', seq: 1 }, { type: 'turn/end', seq: 9 }]
  assert.deepEqual(planForkCut(events), { boundarySeq: 9, cut: 3 })
})

await check('an event without a type does not crash it', () => {
  const events = [{ type: 'turn/end', seq: 0 }, undefined, { type: 'turn/start', seq: 2 }]
  assert.deepEqual(planForkCut(events), { boundarySeq: 0, cut: 2 })
})

console.log('the panel route')

await check('forking returns the child', async () => {
  const calls = []
  const route = mount({
    serialize: (_id, op) => op(),
    forkSession: async (sessionId) => {
      calls.push(sessionId)
      return { sessionId: 'session-child', seeded: 12 }
    },
  })
  const res = await post(route, '/bridge/api/fork', { session: 'session-parent' })
  assert.equal(res.status, 200, res.body)
  assert.equal(res.json.sessionId, 'session-child')
  assert.equal(res.json.seeded, 12)
  assert.deepEqual(calls, ['session-parent'])
})

await check('forking without a session is a 400', async () => {
  const route = mount({ serialize: (_i, o) => o(), forkSession: async () => ({ sessionId: 'x' }) })
  assert.equal((await post(route, '/bridge/api/fork', {})).status, 400)
})

await check('a runtime without forkSession is a 503, not a crash', async () => {
  const route = mount({ serialize: (_i, o) => o() })
  assert.equal((await post(route, '/bridge/api/fork', { session: 's' })).status, 503)
})

await check('the route needs POST', async () => {
  const route = mount({ serialize: (_i, o) => o(), forkSession: async () => ({ sessionId: 'x' }) })
  const res = fakeResponse()
  route.handler(fakeRequest({ method: 'GET', url: '/bridge/api/fork' }), res)
  await settle()
  assert.equal(res.status, 405)
})

await check('a refusal keeps its status and reaches the reader', async () => {
  const route = mount({
    serialize: (_i, o) => o(),
    forkSession: async () => { throw Object.assign(new Error('这段会话还没有跑完过一轮，没有可以分支的位置。'), { status: 409 }) },
  })
  const res = await post(route, '/bridge/api/fork', { session: 's' })
  assert.equal(res.status, 409)
  assert.match(String(res.json.error), /没有可以分支的位置/u)
})

console.log('mirroring the recipe')

await check('the child is seeded with a prefix, not a fresh session', () => {
  assert.match(wire, /seed,\n\s+inheritedEventCount: seed\.length,/u)
  assert.match(wire, /parentSession: sessionId,/u)
  assert.match(wire, /isSeeded: true,/u)
})

await check('it cuts through planForkCut rather than a second opinion', () => {
  assert.match(wire, /events\.slice\(0, planForkCut\(events\)\.cut\)/u)
})

await check('the observation is released on the throwing path too', () => {
  // It holds a retained read; a fork that refuses must not leak it. Asserted as the
  // actual refusal-then-throw pair rather than by counting call sites, because
  // `acquireAgent` disposes an observation of its own and a count says nothing
  // about which one is which.
  assert.match(wire, /observation\?\.\[Symbol\.dispose\]\?\.\(\)\n\s+throw Object\.assign\(new Error\('找不到这段会话。'\)/u)
  assert.match(wire, /\} finally \{\n\s+\/\/ The observation holds a retained read/u)
})

await check('a fork does not inherit the source sandbox', () => {
  // Inheriting would let a wider preset propagate by duplication.
  assert.match(wire, /ctx\.get\('permissionPresets'\)\.set\(handle\.agent\.session, permissionPreset\)/u)
  assert.match(wire, /Deliberately NOT inherited from the source/u)
})

await check('the child is attached to a workspace, or the sidebar never shows it', () => {
  const fork = wire.slice(wire.indexOf('const forkSession'))
  assert.match(fork, /workspaceRegistry/u)
  assert.match(fork, /workspace\.attachSession\(childId\)/u)
})

await check('a cold source is a 404 and an unreadable log is a 503', () => {
  assert.match(wire, /找不到这段会话。[\s\S]{0,40}status: 404/u)
  assert.match(wire, /这个进程读不了会话日志，没法分支。[\s\S]{0,40}status: 503/u)
})

console.log('the button on the phone')

await check('it lives in the drawer, one per conversation', () => {
  assert.match(shell, /const fork = el\('button','fork','分支'\);/u)
  assert.match(shell, /card\.append\(fork\);/u)
})

await check('tapping it does not also open the conversation', () => {
  // The whole card is the navigation target, so the button has to stop there.
  assert.match(shell, /fork\.onclick = \(event\) => \{\n\s+\/\/ The whole card opens the conversation, so this must not also navigate\.\n\s+event\.stopPropagation\(\);/u)
})

await check('it opens the child after refreshing the list', () => {
  assert.match(shell, /return loadDrawer\(\)\.then\(\(\) => showConversation\(out\.data\.sessionId\)\);/u)
})

await check('a failure is shown on the button, not swallowed', () => {
  assert.match(shell, /fork\.textContent = '分支失败：' \+ error\.message;/u)
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)