/**
 * Tests for watching and controlling a turn from the phone: the folded thinking,
 * copying what came out, and stopping it.
 *
 * Two properties here are worth more than the rest:
 *
 *  1. **Reasoning must never reach an OpenAI client.** It goes to a separate
 *     callback, so a caller that does not ask for it gets it dropped — the panel
 *     asks, the `/v1` face does not. Forwarding a model's private reasoning as
 *     chat content would be a leak, and a shared callback with a "kind" flag
 *     makes that leak a one-line mistake.
 *  2. **Stop keeps queued input.** Stopping the output is not the same decision
 *     as throwing away what you already typed, so clearing the queue is a
 *     separate request rather than something the button does silently.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPanel } from '../lib/panel.js'

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

const TOKEN = 'output-token'
const root = await mkdtemp(join(tmpdir(), 'output-test-'))
const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')

/* ── harness ──────────────────────────────────────────────────────────────── */

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

/** A runtime whose stopTurn records what it was asked to do. */
function runtimeWithStop(overrides = {}) {
  const calls = []
  return {
    calls,
    runtime: {
      serialize: (_id, operation) => operation(),
      ensureAgent: async () => ({ session: { key: 's' } }),
      driveTurn: async () => '',
      stopTurn: (sessionId, options) => {
        calls.push({ sessionId, options })
        return { cancelled: true, kept: options.clearQueue !== true, queued: 2 }
      },
      ...overrides,
    },
  }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

console.log('reasoning goes only where it is asked for')

await check('the panel asks for reasoning on its own callback', () => {
  // A separate callback, not a kind flag: the two callers want opposite things.
  assert.match(wire, /const driveTurn = async \(agent, text, onDelta, onReasoning\)/u)
  assert.match(wire, /chunk\.type === 'reasoning-delta'/u)
  assert.match(wire, /if \(thinking !== '' && onReasoning !== undefined\) onReasoning\(thinking\)/u)
})

await check('exactly one call site takes reasoning, and it is the panel', () => {
  // The OpenAI face must not: a chat client showing the model's private thinking
  // as its answer would be a leak, not a feature. The panel's streaming route is
  // the only place that asks for it.
  const withReasoning = shell.match(/\(reasoning\) => \{ event\(\{ reasoning \}\) \}/gu) ?? []
  assert.equal(withReasoning.length, 1, `${withReasoning.length} call sites take reasoning`)
  assert.match(shell, /runtime\.driveTurn\(\n\s+agent,\n\s+text,\n\s+\(delta\) => \{ event\(\{ delta \}\) \},\n\s+\(reasoning\) => \{ event\(\{ reasoning \}\) \},/u)
})

await check('the OpenAI face passes no reasoning callback', () => {
  const chat = wire.slice(wire.indexOf('const handleCompletions'), wire.indexOf('const handler = (req, res)'))
  assert.match(chat, /driveTurn\(agent, text, \(delta\) => \{/u)
  assert.doesNotMatch(chat, /reasoning/u)
})

console.log('the thinking fold')

await check('it is built on the first delta, folded, above the reply', () => {
  assert.match(shell, /summary\.textContent = '思考（正在输出）';/u)
  assert.match(shell, /thinkingFold\.className = 'fold';/u)
  assert.match(shell, /bubble\.insertBefore\(thinkingFold, body\);/u)
})

await check('a stream that never reasons gets no empty fold', () => {
  // Built lazily, or every turn would claim to have thought when it did not.
  assert.match(shell, /if \(thinkingFold === null\) \{/u)
  assert.match(shell, /let thinkingFold = null;/u)
})

await check('the summary stops claiming to be live when the turn ends', () => {
  assert.match(shell, /thinkingFold\.querySelector\('summary'\)\.textContent = '思考';/u)
})

await check('the reasoning frame is handled in the stream reader', () => {
  assert.match(shell, /else if \(payload\.reasoning !== undefined\) \{ thinking \+= payload\.reasoning; paintThinking\(\); \}/u)
})

console.log('stopping a turn')

await check('the route answers', async () => {
  const { runtime, calls } = runtimeWithStop()
  const res = await post(mount(runtime), '/bridge/api/stop', { session: 'session-1' })
  assert.equal(res.status, 200, res.body)
  assert.equal(res.json.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-1')
})

await check('queued input is kept by default', async () => {
  const { runtime, calls } = runtimeWithStop()
  const res = await post(mount(runtime), '/bridge/api/stop', { session: 's' })
  // The route states it explicitly rather than omitting it: "keep the queue" is a
  // decision this endpoint makes, not a default it happens to fall into.
  assert.equal(calls[0].options.clearQueue, false)
  assert.equal(res.json.kept, true, res.body)
})

await check('clearing the queue is an explicit request', async () => {
  const { runtime, calls } = runtimeWithStop()
  const res = await post(mount(runtime), '/bridge/api/stop', { session: 's', clearQueue: true })
  assert.equal(calls[0].options.clearQueue, true)
  assert.equal(res.json.kept, false)
})

await check('a missing session is a 400', async () => {
  const { runtime } = runtimeWithStop()
  assert.equal((await post(mount(runtime), '/bridge/api/stop', {})).status, 400)
})

await check('the route needs POST', async () => {
  const { runtime } = runtimeWithStop()
  const res = fakeResponse()
  mount(runtime).handler(fakeRequest({ method: 'GET', url: '/bridge/api/stop' }), res)
  await settle()
  assert.equal(res.status, 405)
})

await check('a runtime without stopTurn is a 503, not a crash', async () => {
  const res = await post(mount({ serialize: (_i, o) => o(), ensureAgent: async () => ({}), driveTurn: async () => '' }),
    '/bridge/api/stop', { session: 's' })
  assert.equal(res.status, 503)
})

await check('the host reports what actually happened', () => {
  // cancel() is a no-op when nothing is running, so claiming a stop that did
  // nothing would be a lie the reader cannot check.
  assert.match(wire, /const wasRunning = agent\.status === 'running'/u)
  assert.match(wire, /const keepInbox = options\.clearQueue !== true/u)
  assert.match(wire, /queued: agent\.inbox\.nextTurn\.length \+ agent\.inbox\.nextStep\.length/u)
})

await check('an agent that is not live is a 409', () => {
  assert.match(wire, /这段会话现在没在跑（可能已经结束了）。/u)
  assert.match(wire, /\{ status: 409 \}/u)
})

console.log('the stop button')

await check('it exists, starts hidden, and is wired to the route', () => {
  assert.match(shell, /const stop = el\('button','stop','停止'\);/u)
  assert.match(shell, /stop\.hidden = true;/u)
  assert.match(shell, /fetch\('api\/stop'/u)
})

await check('it is only live while something is streaming', () => {
  assert.match(shell, /if \(stop\) stop\.hidden = blocked \|\| !streaming;/u)
  assert.match(shell, /streaming = true;\n  renderSlots\(\);/u)
})

await check('a card replacing the composer takes the stop button with it', () => {
  assert.match(shell, /if \(stop\) stop\.hidden = blocked/u)
})

console.log('copying what came out')

await check('every message can be copied whole', () => {
  assert.match(shell, /head\.append\(copyButton\(/u)
  assert.match(shell, /\.filter\(\(part\) => part !== ''\)\n\s+\.join\('\\n\\n'\)\)\)/u)
})

await check('every code block has its own button', () => {
  assert.match(shell, /const wrap = el\('div','codeblock'\);/u)
  assert.match(shell, /wrap\.append\(pre, copyButton\(\(\) => source\)\);/u)
})

await check('a failed copy says so instead of claiming success', () => {
  // Claiming "copied" when nothing reached the clipboard means the reader pastes
  // the previous contents and blames the model.
  assert.match(shell, /button\.textContent = ok \? '已复制' : '长按选择';/u)
})

await check('it falls back for a plain-http page', () => {
  // navigator.clipboard needs a secure context and this panel is served over http
  // on a LAN address, so on a phone the modern API is usually absent.
  assert.match(shell, /navigator\.clipboard && window\.isSecureContext/u)
  assert.match(shell, /function legacyCopy\(text\)/u)
  assert.match(shell, /document\.execCommand\('copy'\)/u)
})

await check('the fallback runs inside the click, not after a promise', () => {
  // A programmatic copy needs the user gesture that started it, so the legacy path
  // must be evaluated synchronously rather than in a .then().
  assert.match(shell, /return Promise\.resolve\(legacyCopy\(text\)\);/u)
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
