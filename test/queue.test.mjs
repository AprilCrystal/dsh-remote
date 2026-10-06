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
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPanel } from '../lib/panel.js'
import { createLocalUserMessage, planQueueAction } from '../lib/index.js'

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
const fab = readFileSync(new URL('../lib/panel-fab.js', import.meta.url), 'utf8')

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
  // Edit, remove and steer go through the session controller's own queue
  // mutation, which takes CONTENT for an edit rather than a message — so those
  // three need no message builder at all, and an edit keeps its identity.
  assert.match(wire, /controllerFor\(\)\.updateQueue\(\{ sessionId, itemId: found\.message\.id, action: mutation \}\)/u)
  assert.match(wire, /\{ kind: 'edit', content: \[\{ type: 'text', text: plan\.text \}\] \}/u)
  assert.match(wire, /: plan\.kind === 'drop' \? \{ kind: 'remove' \} : \{ kind: 'steer' \}/u)
  assert.match(wire, /agent\.inbox\.remove\(found\.message\.id\)/u)
})

await check('nothing in the plugin imports a harness package', () => {
  // THE bug this fixes: `await import('@deepseek-ai/dsh-llm')` resolved only
  // because DSH happened to have put the package in a node_modules directory above
  // the plugin's own. On a second machine it did not, and the entire send path
  // died with "Cannot find package". A bare harness specifier must never come
  // back, in ANY file — so this scans the whole directory rather than a list that
  // would go stale the moment a file is added.
  const files = readdirSync(new URL('../lib/', import.meta.url)).filter((name) => name.endsWith('.js'))
  assert.ok(files.length > 5, `only found ${String(files.length)} lib files to scan`)
  for (const name of files) {
    const source = readFileSync(new URL('../lib/' + name, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /import\(\s*['"]@deepseek-ai\//u, `${name} dynamically imports a harness package`)
    assert.doesNotMatch(source, /from\s+['"]@deepseek-ai\//u, `${name} statically imports a harness package`)
    assert.doesNotMatch(source, /require\(\s*['"]@deepseek-ai\//u, `${name} requires a harness package`)
  }
})

await check('what replaced it is mirrored exactly, and frozen', () => {
  // `createMessage` is freezeMessage({...input, id}); Message has exactly four
  // fields. The freeze is not decoration: a message the harness could still mutate
  // would behave differently from every other message in the same log.
  const message = createLocalUserMessage('hello', () => 'fixed-id')
  assert.deepEqual(message, {
    id: 'fixed-id',
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  })
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.ok(Object.isFrozen(message.content[0]))
  assert.ok(Object.isFrozen(message.source))
})

await check('every mirrored message gets its own identity', () => {
  assert.notEqual(createLocalUserMessage('a').id, createLocalUserMessage('a').id)
})

await check('a DSH without the controller is a diagnosable 503, not a crash', () => {
  // Read through ctx.get and deliberately NOT injected: a build without it must
  // still load this plugin and answer with something actionable.
  assert.match(wire, /这个 DSH 版本没有提供 sessionController，本插件提交不了消息。升级 DSH 即可。/u)
  assert.match(wire, /typeof controller\.prompt !== 'function'/u)
})

await check('a turn is submitted as text, through the same path the desktop uses', () => {
  assert.match(wire, /await controllerFor\(\)\.prompt\(\{\n\s+requestId: randomUUID\(\),/u)
  assert.match(wire, /sessionId: String\(agent\.session\.id\),\n\s+mode: 'queue',/u)
})

await check('a queued message can be turned into steering', () => {
  // The controller owns this mutation, so the phone offers it rather than
  // reimplementing it — and only in the one direction that means anything.
  assert.match(shell, /if \(item\.target === 'next-turn'\) \{\n\s+const steer = el\('button', null, '转插话'\);/u)
  assert.match(shell, /steer\.onclick = \(\) => void queueAct\('steer', \{ id: item\.id \}\);/u)
})

await check('turning a queued message into steering is offered, once', () => {
  assert.match(wire, /if \(found\.target === 'next-step'\) \{\n\s+throw Object\.assign\(new Error\('这条已经是「插话」了。'\), \{ status: 409 \}\)/u)
  assert.equal(planQueueAction('steer', { id: 's1' }, locateOver(one)).kind, 'steer')
  assert.throws(
    () => planQueueAction('steer', { id: 's1' }, () => ({ target: 'next-step' })),
    (error) => error.status === 409,
  )
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
  assert.match(shell, /if \(key !== queueKey\) \{/u)
})

await check('the tray says whether anything will actually happen', () => {
  // The count alone was misleading: staged while the agent is IDLE, a queued
  // message sits there forever because nothing wakes the driver to consume it,
  // which reads as a hang rather than as a decision. That is what "it just froze"
  // turned out to be.
  assert.match(shell, /pendingQueue\.running\n\s+\? '正在跑，这一轮结束后轮到它们'\n\s+: '空闲中 —— 点「立即发送」才会发出去'/u)
})

await check('the running state is not part of the rebuild key', () => {
  // It flips on its own, and a rebuild on that flip would close the keyboard of an
  // edit in progress — the exact bug the key exists to prevent.
  assert.match(shell, /if \(queueHead !== null\) queueHead\.textContent = queueHeadText\(items\.length\);/u)
})

await check('the inbox has its own view, reached from the button cluster', () => {
  // The tray only exists while composing, so without this there is nowhere to look
  // at what is staged once the reader has scrolled away or switched views.
  assert.match(shell, /async function showInbox\(\) \{/u)
  assert.match(shell, /window\.__bridgeInbox = \(\) => \{ void showInbox\(\); \};/u)
  assert.match(fab, /id: 'inbox',/u)
  assert.match(fab, /if \(typeof window\.__bridgeInbox === 'function'\) window\.__bridgeInbox\(\)/u)
})

await check('the view and the tray are one behaviour, two surfaces', () => {
  // A queue action taken in the view repaints the VIEW; from the composer it
  // repaints the tray. That choice is the only thing that differs.
  assert.match(shell, /function refreshQueueViews\(\) \{/u)
  assert.match(shell, /if \(inboxRefresh !== null\) \{ refreshQueueViews\(\); return; \}/u)
  assert.match(shell, /cancel\.onclick = \(\) => \{ queueEditing = null; queueEditText = ''; refreshQueueViews\(\); \};/u)
  assert.match(shell, /queueEditText = item\.text;\n\s+refreshQueueViews\(\);/u)
})

await check('leaving the view drops its repaint hook', () => {
  // Otherwise a stale hook fires at a view that is gone.
  assert.match(shell, /function restoreConversation\(\) \{\n\s+inboxRefresh = null;/u)
  assert.match(shell, /setHeader\('待发送', \(\) => \{ inboxRefresh = null; void restoreConversation\(\); \}\);/u)
})

await check('the host reports whether a turn is running', () => {
  assert.match(wire, /running: agent\.status === 'running',/u)
})

await check('a queue failure is reported, never swallowed', () => {
  // The first version caught every failure with an empty handler, which made a
  // refusal indistinguishable from a button that does not work: tap 排队, nothing
  // appears, and there is no way to tell whether the request failed, the server
  // refused it, or the tap never landed.
  assert.match(shell, /async function queueRequest\(payload\)/u)
  assert.match(shell, /failure = data\.error \|\| \('HTTP ' \+ String\(res\.status\)\);/u)
  assert.match(shell, /queueError = '排队失败：' \+ failure;/u)
  assert.match(shell, /note\.textContent = queueError;/u)
})

await check('an empty box says so instead of doing nothing', () => {
  // "点了好几遍没反应": a tap with an empty box and a broken button look identical.
  assert.match(shell, /function notice\(text\) \{/u)
  assert.match(shell, /notice\('先在输入框里打字，再点「排队」或「插话」。'\);/u)
  assert.match(shell, /notice\('先在输入框里打字，再发送。'\);/u)
})

await check('a failed insert gives the typed text back', () => {
  assert.match(shell, /currentComposer\.input\.value = payload\.text;/u)
})

await check('both the composer and the tray go through it', () => {
  assert.match(shell, /void queueRequest\(\{ session: sessionId, action: 'insert', target, text \}\)/u)
  assert.match(shell, /await queueRequest\(\{ session: currentSessionId, action, \.\.\.payload \}\);/u)
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
