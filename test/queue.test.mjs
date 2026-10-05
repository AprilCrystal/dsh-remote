/**
 * Tests for inserting a message, editing it, undoing it, and sending it — and for
 * the claim that this syncs with the desktop without any sync code.
 *
 * The sync claim is the one worth stating precisely: `agent.inbox` is the SAME
 * projection the desktop GUI reads, and every mutation it exposes is a durable
 * `agent/inbox/spliced` session event. So the panel does not keep its own queue
 * and mirror it — it reads and writes that one list. A test asserts the absence of
 * a private queue, because that is the mistake that would look fine until the
 * desktop changed something the phone could not see.
 *
 * The decision surface lives in `planQueueAction` rather than inside the inbox
 * calls, because the real call path needs `@deepseek-ai/dsh-llm`, which only
 * resolves inside a running DSH. Everything a plain process cannot execute would
 * otherwise be covered by nothing at all.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPanel } from '../lib/panel.js'
import { planQueueAction } from '../lib/index.js'

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

const TOKEN = 'queue-token'
const root = await mkdtemp(join(tmpdir(), 'queue-test-'))
const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')

/* ── harness ──────────────────────────────────────────────────────────────── */

/** A locate() over a fixed queue, shaped like the real one. */
function locateOver(entries) {
  return (id) => entries[id]
}

const one = { s1: { target: 'next-turn' } }

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

async function call(route, method, path, body) {
  const res = fakeResponse()
  route.handler(fakeRequest({ method, url: path, body }), res)
  await settle()
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.status, body: res.body, json }
}

function runtimeWithQueue(overrides = {}) {
  const calls = []
  return {
    calls,
    runtime: {
      serialize: (_id, operation) => operation(),
      ensureAgent: async () => ({ session: { key: 's' } }),
      driveTurn: async () => '',
      listQueue: (sessionId) => {
        calls.push({ listQueue: sessionId })
        return { nextTurn: [{ id: 'm1', target: 'next-turn', text: '排队的话' }], nextStep: [] }
      },
      queueAction: async (sessionId, action, payload) => {
        calls.push({ sessionId, action, payload })
        return { kind: action }
      },
      ...overrides,
    },
  }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

console.log('deciding what an action means')

await check('an insert defaults to waiting its turn', () => {
  const plan = planQueueAction('insert', { text: '  hello  ' }, () => undefined)
  assert.deepEqual(plan, { kind: 'insert', target: 'next-turn', text: 'hello' })
})

await check('an insert can steer the running turn instead', () => {
  assert.equal(planQueueAction('insert', { text: 'x', target: 'next-step' }, () => undefined).target, 'next-step')
})

await check('an unknown target falls back to the polite one', () => {
  assert.equal(planQueueAction('insert', { text: 'x', target: 'nowhere' }, () => undefined).target, 'next-turn')
})

await check('an empty insert is refused', () => {
  assert.throws(() => planQueueAction('insert', { text: '   ' }, () => undefined), (error) => error.status === 400)
})

await check('edit carries the target it found, so it stays on its boundary', () => {
  const plan = planQueueAction('edit', { id: 's1', text: ' edited ' }, locateOver(one))
  assert.deepEqual(plan, { kind: 'edit', id: 's1', target: 'next-turn', text: 'edited' })
})

await check('an empty edit is refused', () => {
  assert.throws(() => planQueueAction('edit', { id: 's1', text: '' }, locateOver(one)), (error) => error.status === 400)
})

await check('dropping and sending only need the id', () => {
  assert.equal(planQueueAction('drop', { id: 's1' }, locateOver(one)).kind, 'drop')
  assert.equal(planQueueAction('send', { id: 's1' }, locateOver(one)).kind, 'send')
})

await check('an id that is not queued is a 404, for every action', () => {
  for (const action of ['edit', 'drop', 'send']) {
    assert.throws(
      () => planQueueAction(action, { id: 'gone', text: 'x' }, () => undefined),
      (error) => error.status === 404,
      `${action} did not refuse a missing id`,
    )
  }
})

await check('an unknown action is a 400 and names itself', () => {
  assert.throws(
    () => planQueueAction('explode', { id: 's1' }, locateOver(one)),
    (error) => error.status === 400 && error.message.includes('explode'),
  )
})

console.log('the panel route')

await check('the queue reads for a session', async () => {
  const { runtime, calls } = runtimeWithQueue()
  const res = await call(mount(runtime), 'GET', '/bridge/api/queue?session=session-1')
  assert.equal(res.status, 200, res.body)
  assert.equal(res.json.nextTurn.length, 1)
  assert.equal(calls[0].listQueue, 'session-1')
})

await check('reading without a session is a 400', async () => {
  const { runtime } = runtimeWithQueue()
  assert.equal((await call(mount(runtime), 'GET', '/bridge/api/queue')).status, 400)
})

await check('a runtime without the queue is a 503, not a crash', async () => {
  const res = await call(mount({ serialize: (_i, o) => o() }), 'GET', '/bridge/api/queue?session=s')
  assert.equal(res.status, 503)
})

await check('an action reaches the runtime with its payload', async () => {
  const { runtime, calls } = runtimeWithQueue()
  const res = await call(mount(runtime), 'POST', '/bridge/api/queue', {
    session: 'session-1', action: 'insert', target: 'next-step', text: 'hi',
  })
  assert.equal(res.status, 200, res.body)
  assert.equal(res.json.ok, true)
  assert.deepEqual(calls[0], {
    sessionId: 'session-1', action: 'insert', payload: { session: 'session-1', action: 'insert', target: 'next-step', text: 'hi' },
  })
})

await check('writing without a session is a 400', async () => {
  const { runtime } = runtimeWithQueue()
  assert.equal((await call(mount(runtime), 'POST', '/bridge/api/queue', { action: 'drop', id: 'm1' })).status, 400)
})

await check('a refusal keeps its status and reaches the reader', async () => {
  const { runtime } = runtimeWithQueue({
    queueAction: async () => { throw Object.assign(new Error('这条排队消息已经不在了。'), { status: 404 }) },
  })
  const res = await call(mount(runtime), 'POST', '/bridge/api/queue', { session: 's', action: 'drop', id: 'gone' })
  assert.equal(res.status, 404)
  assert.match(String(res.json.error), /已经不在了/u)
})

await check('the route takes GET and POST but not DELETE', async () => {
  const { runtime } = runtimeWithQueue()
  assert.equal((await call(mount(runtime), 'DELETE', '/bridge/api/queue')).status, 405)
})

console.log('syncing with the desktop is not implemented here')

await check('the queue is the harness inbox, not a copy of it', () => {
  // The whole reason no sync code exists. A private list in this plugin would look
  // correct until the desktop changed something the phone could not see.
  assert.match(wire, /agent\.inbox\.nextTurn/u)
  assert.match(wire, /agent\.inbox\.nextStep/u)
  assert.match(wire, /agent\.inbox\.append\(plan\.target, message\)/u)
  assert.match(wire, /agent\.inbox\.replace\(found\.message\.id, replacement\)/u)
  assert.match(wire, /agent\.inbox\.remove\(found\.message\.id\)/u)
})

await check('the plugin keeps no queue of its own', () => {
  assert.doesNotMatch(wire, /const queued = \[\]/u)
  assert.doesNotMatch(wire, /queue\.push\(/u)
})

await check('inserting appends without waking the driver', () => {
  // append, never send: an inserted message waits to be sent. If insert woke the
  // driver, "insert" and "send" would be the same button.
  const insert = wire.slice(wire.indexOf("if (plan.kind === 'insert')"), wire.indexOf('// Re-located rather than carried'))
  assert.match(insert, /agent\.inbox\.append/u)
  assert.doesNotMatch(insert, /agent\.send\(/u)
})

await check('sending now removes and re-sends, waking the driver', () => {
  const send = wire.slice(wire.indexOf('// Promote it to run now'))
  assert.match(send, /agent\.inbox\.remove\(found\.message\.id\)/u)
  assert.match(send, /agent\.send\(found\.message, 'next-turn', true\)/u)
})

await check('a conversation with no live agent is refused, not silently queued', () => {
  assert.match(wire, /这段会话没在内存里，先载入它才能排队。[\s\S]{0,40}status: 409/u)
})

console.log('the tray on the phone')

await check('both boundaries are offered', () => {
  assert.match(shell, /queueTurn = el\('button', null, '排队'\)/u)
  assert.match(shell, /queueStep = el\('button', null, '插话'\)/u)
  assert.match(shell, /queueTurn\.onclick = \(\) => insertInto\('next-turn'\);/u)
  assert.match(shell, /queueStep\.onclick = \(\) => insertInto\('next-step'\);/u)
})

await check('a queued message can be sent, edited, or undone', () => {
  assert.match(shell, /now\.onclick = \(\) => void queueAct\('send', \{ id: item\.id \}\)/u)
  assert.match(shell, /edit\.onclick = \(\) => \{/u)
  assert.match(shell, /drop\.onclick = \(\) => void queueAct\('drop', \{ id: item\.id \}\)/u)
})

await check('editing happens in place, with save and cancel', () => {
  assert.match(shell, /if \(queueEditing === item\.id\) \{/u)
  assert.match(shell, /save\.onclick = \(\) => void queueAct\('edit', \{ id: item\.id, text: queueEditText \}\)/u)
  assert.match(shell, /cancel\.onclick = \(\) => \{ queueEditing = null;/u)
})

await check('a poll cannot close the keyboard while an edit is being typed', () => {
  // Same discipline as the question card: the text being typed is NOT part of the
  // tray's key, so an unchanged poll leaves the textarea alone.
  assert.match(shell, /const key = JSON\.stringify\(\[items\.map\(\(item\) => item\.id \+ '\|' \+ item\.target \+ '\|' \+ item\.text\), queueEditing\]\);/u)
  assert.match(shell, /area\.oninput = \(\) => \{ queueEditText = area\.value; \};/u)
  assert.match(shell, /if \(key === queueKey\) return;/u)
})

await check('a fresh composer refills the tray', () => {
  assert.match(shell, /slotsKey = null;\n  queueKey = null;/u)
})

await check('the tray is visible whenever the composer is', () => {
  assert.match(shell, /if \(tray\) tray\.hidden = blocked \|\| queued === 0;/u)
  assert.match(shell, /const queued = pendingQueue\.nextTurn\.length \+ pendingQueue\.nextStep\.length;/u)
})

await check('the tray polls, so the desktop sees the same list', () => {
  assert.match(shell, /api\('api\/queue\?session=' \+ encodeURIComponent\(currentSessionId \|\| ''\)\)/u)
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
