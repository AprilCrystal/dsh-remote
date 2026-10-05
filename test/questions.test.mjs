/**
 * Tests for answering `ask_user_question` from the phone.
 *
 * Why this exists at all: an agent that asks a question PARKES THE TURN until
 * something answers. The desktop GUI is one answerer, but a phone holding the
 * panel is not — so before this, a conversation driven from the phone would stop
 * dead at the first question with no indication anywhere that it was waiting.
 *
 * The interesting property is not "the phone can answer". It is that a question
 * is asked through a WATERFALL, and the caller treats any rejection as "nobody
 * could ask". So an answerer that refuses — no desktop GUI attached, which is the
 * normal case for a phone-only deployment — must not end the race while the phone
 * is still deciding. That is the one place this deliberately differs from the
 * approval race it otherwise mirrors.
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

const TOKEN = 'questions-token'
const root = await mkdtemp(join(tmpdir(), 'questions-test-'))

/* ── harness ──────────────────────────────────────────────────────────────── */

function mount(options = {}) {
  const routes = []
  const listeners = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler, opts) => { listeners.push({ event, handler, opts }); return () => {} },
  }
  installPanel(ctx, { token: TOKEN, fileRoot: root, basePath: '/bridge', ...options })
  return {
    route: routes[0],
    question: listeners.find((listener) => listener.event === 'user-questions/request'),
    listeners,
  }
}

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
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    destroy() {},
  }
}

/** The handler answers from an async IIFE, so replies land a tick later. */
const settle = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

async function call(route, method, path, body) {
  const res = fakeResponse()
  route.handler(fakeRequest({ method, url: path, body }), res)
  await settle()
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, body: res.body, json }
}

const get = (route, path) => call(route, 'GET', path)
const post = (route, path, body) => call(route, 'POST', path, body)

function ask(overrides = {}) {
  return {
    questions: [{
      id: 'q1',
      question: '选哪个？',
      options: [{ label: 'A', description: '第一个' }, { label: 'B' }],
    }],
    agent: { session: { id: 'session-1', header: { cwd: root } } },
    ...overrides,
  }
}

/** A downstream answerer that never answers, which is the phone-only case. */
const silent = () => new Promise(() => {})

async function idOf(route) {
  const listed = await get(route, '/bridge/api/questions')
  return listed.json.questions[0]?.id
}

/* ── tests ────────────────────────────────────────────────────────────────── */

console.log('answering from the phone')

await check('a question is offered to the panel', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const listed = await get(route, '/bridge/api/questions')
  assert.equal(listed.status, 200)
  assert.equal(listed.json.questions.length, 1)
  assert.equal(listed.json.questions[0].questions[0].id, 'q1')
  assert.equal(listed.json.questions[0].sessionId, 'session-1')
})

await check('the listed question carries no resolver', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const listed = await get(route, '/bridge/api/questions')
  const record = listed.json.questions[0]
  assert.equal(record.answer, undefined)
  assert.equal(typeof record.createdAt, 'number')
})

await check('the answer reaches the waterfall', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), silent)
  const id = await idOf(route)
  const answered = await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: ['A'] }] })
  assert.equal(answered.status, 200)
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['A'] }] })
})

await check('an answered question leaves the list', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const id = await idOf(route)
  await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: ['A'] }] })
  const after = await get(route, '/bridge/api/questions')
  assert.deepEqual(after.json.questions, [])
})

await check('answering twice is a 404, not a second answer', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const id = await idOf(route)
  const body = { id, answers: [{ id: 'q1', selected: ['A'] }] }
  assert.equal((await post(route, '/bridge/api/answer', body)).status, 200)
  assert.equal((await post(route, '/bridge/api/answer', body)).status, 404)
})

await check('custom text is trimmed and rides beside the selection', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), silent)
  const id = await idOf(route)
  await post(route, '/bridge/api/answer', {
    id,
    answers: [{ id: 'q1', selected: ['A'], custom: '  123  ' }],
  })
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['A'], custom: '123' }] })
})

await check('an empty custom answer is omitted rather than sent as a blank', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), silent)
  const id = await idOf(route)
  await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: [], custom: '   ' }] })
  const answer = await outcome
  assert.equal(Object.hasOwn(answer.answers[0], 'custom'), false)
})

await check('a custom-only answer is accepted', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), silent)
  const id = await idOf(route)
  await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: [], custom: '123' }] })
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: [], custom: '123' }] })
})

await check('a non-string selection is dropped, not passed through', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), silent)
  const id = await idOf(route)
  await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: ['A', 7, null] }] })
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['A'] }] })
})

console.log('a partial batch is refused')

await check('an unanswered question in the batch is a 400', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask({
    questions: [
      { id: 'q1', question: 'one', options: [{ label: 'A' }] },
      { id: 'q2', question: 'two', options: [{ label: 'B' }] },
    ],
  }), silent)
  const id = await idOf(route)
  const partial = await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: ['A'] }] })
  assert.equal(partial.status, 400)
  assert.match(String(partial.json.error), /every question/u)

  // The request must still be answerable — a refused batch resolves nothing.
  const complete = await post(route, '/bridge/api/answer', {
    id,
    answers: [{ id: 'q1', selected: ['A'] }, { id: 'q2', selected: ['B'] }],
  })
  assert.equal(complete.status, 200)
  assert.equal((await outcome).answers.length, 2)
})

await check('an unknown question id in the batch is a 400', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const id = await idOf(route)
  const res = await post(route, '/bridge/api/answer', { id, answers: [{ id: 'nope', selected: ['A'] }] })
  assert.equal(res.status, 400)
})

await check('an empty batch is a 400', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), silent)
  const id = await idOf(route)
  assert.equal((await post(route, '/bridge/api/answer', { id, answers: [] })).status, 400)
})

await check('an unknown request id is a 404', async () => {
  const { route } = mount({ approvalCwd: root })
  const res = await post(route, '/bridge/api/answer', { id: 'q-999', answers: [] })
  assert.equal(res.status, 404)
})

await check('the answer route requires POST', async () => {
  const { route } = mount({ approvalCwd: root })
  assert.equal((await get(route, '/bridge/api/answer')).status, 405)
})

console.log('racing the desktop')

await check('a downstream answer that lands first wins', async () => {
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), async () => ({ answers: [{ id: 'q1', selected: ['B'] }] }))
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['B'] }] })
  const listed = await get(route, '/bridge/api/questions')
  assert.deepEqual(listed.json.questions, [], 'a settled request must not stay on the list')
})

await check('downstream is asked immediately, not only after the phone gives up', async () => {
  // The desktop prompt must not wait on the phone: `next()` runs at once.
  let asked = false
  const { question } = mount({ approvalCwd: root })
  void question.handler(ask(), () => {
    asked = true
    return new Promise(() => {})
  })
  await settle()
  assert.equal(asked, true)
})

await check('a downstream refusal does not end the race', async () => {
  // The property this whole module differs from approvals for. With no desktop
  // GUI attached the downstream answerer rejects immediately; if that settled the
  // race, a phone-only deployment could never answer anything.
  const { route, question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), () => Promise.reject(new Error('no user-questions answerer accepted the request')))
  const id = await idOf(route)
  assert.notEqual(id, undefined, 'the phone must still be offered the question')
  await post(route, '/bridge/api/answer', { id, answers: [{ id: 'q1', selected: ['A'] }] })
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['A'] }] })
})

await check('an abort is surfaced even when downstream already refused', async () => {
  const { question } = mount({ approvalCwd: root })
  const controller = new AbortController()
  const outcome = question.handler(
    ask({ signal: controller.signal }),
    () => Promise.reject(new Error('downstream refused')),
  )
  controller.abort()
  // The abort is the truthful outcome, and it must win over the downstream
  // refusal: once the caller has given up, no answerer can help, so waiting for
  // the phone here would hang the turn rather than end it.
  await assert.rejects(() => outcome, /aborted/u)
})

console.log('whose question is it')

await check('a question is shown even when it belongs to another session', async () => {
  // The observed failure. The question was pending on the host for the whole time
  // the user waited, and the phone never showed it because it was filed under a
  // session the phone was not displaying. A hidden approval leaves the desktop
  // prompt doing its job; a hidden question leaves a turn parked with nothing on
  // the device to explain it, so questions are not filtered by session at all.
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /const otherQuestions = pendingQuestions\.filter/u)
  assert.match(shell, /for \(const item of otherQuestions\) slots\.append\(questionCard\(item\)\)/u)
  assert.match(shell, /const blocked = mine\.length > 0 \|\| pendingQuestions\.length > 0/u)
})

await check('the card says which session it came from', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /来自会话 ' \+ String\(item\.sessionId\)/u)
})

await check('the poll reports which session the device is showing', async () => {
  const { route } = mount({ approvalCwd: root })
  const res = await get(route, '/bridge/api/questions?session=session-abc')
  assert.equal(res.json.youAre, 'session-abc')
})

await check('a render fault cannot kill the poll loop', () => {
  // The loop is the only way a parked turn becomes visible, so a render fault
  // ending it would look exactly like "nothing is waiting".
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /try \{ renderSlots\(\); \} catch/u)
})

await check('the history still records where a question went', async () => {
  const { route, question } = mount({ approvalCwd: root })
  void question.handler(ask(), async () => ({ answers: [{ id: 'q1', selected: [] }] }))
  await settle()
  const listed = await get(route, '/bridge/api/questions')
  assert.deepEqual(listed.json.recent.map((entry) => entry.event), ['offered', 'downstream-answer'])
})

await check('a skipped question on the desktop is still an answer', async () => {
  // The desktop's skip button resolves with an all-blank batch. That is a real
  // human decision, so it must settle the request: treating it as "no human" would
  // keep a turn parked on the phone forever after someone deliberately skipped.
  const { question } = mount({ approvalCwd: root })
  const outcome = question.handler(ask(), async () => ({ answers: [{ id: 'q1', selected: [] }] }))
  assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: [] }] })
})
console.log('scope')

await check('a session the panel does not own is passed straight through', async () => {
  const { route, question } = mount({ approvalCwd: root })
  let sawRequest = false
  const outcome = question.handler(
    ask({ agent: { session: { id: 'other', header: { cwd: join(root, 'elsewhere') } } } }),
    async () => { sawRequest = true; return { answers: [] } },
  )
  await outcome
  assert.equal(sawRequest, true)
  const listed = await get(route, '/bridge/api/questions')
  assert.deepEqual(listed.json.questions, [], 'another session\u2019s question must not reach this phone')
})

await check('with no scope configured every session is offered', async () => {
  const { route, question } = mount({})
  void question.handler(ask({ agent: { session: { id: 'any', header: { cwd: 'C:\\somewhere' } } } }), silent)
  const listed = await get(route, '/bridge/api/questions')
  assert.equal(listed.json.questions.length, 1)
})

console.log('the card the phone renders')

await check('the shell renders a question card with a custom field', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /function questionCard\(/u)
  assert.match(shell, /class="qcustom"|'qcustom'/u)
  assert.match(shell, /也可以自己写/u)
  assert.match(shell, /qsubmit/u)
})

await check('it posts to the answer route and polls the question route', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /fetch\('api\/answer'/u)
  assert.match(shell, /api\/questions/u)
})

await check('the composer is replaced while a question waits', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /const blocked = mine\.length > 0 \|\| pendingQuestions\.length > 0/u)
  assert.match(shell, /input\.hidden = blocked/u)
})

await check('it opens no native dialog', () => {
  // A confirm()/alert() in an in-app webview is the classic silent no-op, and
  // this panel deliberately owns its own controls.
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  const start = shell.indexOf('html`<!doctype html>')
  const body = shell.slice(start, shell.indexOf('</html>`', start))
  assert.doesNotMatch(body, /\b(window\.)?(confirm|alert|prompt)\s*\(/u)
})

await check('a stale draft cannot re-submit an answered question', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /for \(const key of Array\.from\(questionDraft\.keys\(\)\)\) if \(!live\.has\(key\)\) questionDraft\.delete\(key\)/u)
})

console.log('typing is not interrupted')

await check('an unchanged poll does not rebuild the cards', () => {
  // The reported bug: the keyboard closed while typing in the custom field. The
  // poll runs every two seconds and replaceChildren destroys the focused input,
  // which on a phone dismisses the keyboard mid-word. The in-place update inside a
  // card is no defence, because the POLL is what rebuilds.
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /const key = JSON\.stringify\(\[/u)
  assert.match(shell, /if \(key !== slotsKey\) \{/u)
  assert.match(shell, /let slotsKey = null;/u)
})

await check('a new composer always fills itself', () => {
  // A fresh slots element with a matching key would otherwise decide there is
  // nothing to do and stay empty forever.
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /currentComposer = \{ slots, input, send, note \};[\s\S]{0,160}slotsKey = null;/u)
})

await check('a rebuild that does land carries the caret over', () => {
  const shell = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  assert.match(shell, /custom\.dataset\.q = question\.id;/u)
  assert.match(shell, /slots\.querySelector\('\[data-q="' \+ carried\.q \+ '"\]'\)/u)
})

await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
