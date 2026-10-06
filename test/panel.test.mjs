/**
 * Self-test for the panel's load-bearing security property: a client-supplied
 * path can never resolve outside the browse root, not via `..` and not via a
 * symlink pointing outward.
 *
 * Run: node test/panel.test.mjs
 */

import { readNormalized } from './source.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPanel, looksBinary, messageBlocks, messageText, resolveInsideRoot } from '../lib/panel.js'
import { sessionIdFor, sessionIdFromModel } from '../lib/index.js'

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

const sandbox = await mkdtemp(join(tmpdir(), 'panel-test-'))
const root = join(sandbox, 'root')
const outside = join(sandbox, 'outside')
await mkdir(join(root, 'sub'), { recursive: true })
await mkdir(outside, { recursive: true })
await writeFile(join(root, 'sub', 'inside.txt'), 'inside')
await writeFile(join(outside, 'secret.txt'), 'secret')

console.log('resolveInsideRoot — containment')

await check('resolves a normal nested path', async () => {
  const resolved = await resolveInsideRoot(root, 'sub/inside.txt')
  assert.equal(resolved, join(root, 'sub', 'inside.txt'))
})

await check('allows the root itself', async () => {
  assert.equal(await resolveInsideRoot(root, ''), root)
})

await check('rejects a ../ escape', async () => {
  await assert.rejects(() => resolveInsideRoot(root, '../outside/secret.txt'), /escapes the browse root/u)
})

await check('rejects a deep ../../ escape', async () => {
  await assert.rejects(() => resolveInsideRoot(root, 'sub/../../outside/secret.txt'), /escapes the browse root/u)
})

await check('rejects an absolute path outside the root', async () => {
  await assert.rejects(() => resolveInsideRoot(root, join(outside, 'secret.txt')), /absolute paths|escapes the browse root/u)
})

await check('rejects a POSIX-rooted path', async () => {
  await assert.rejects(() => resolveInsideRoot(root, '/etc/passwd'), /absolute paths/u)
})

// Creating a symlink on Windows needs Administrator or Developer Mode. Report
// the environment limit honestly instead of dressing it up as a failure.
let symlinksAvailable = true
await check('(probe) symlink support', async () => {
  try {
    await symlink(outside, join(root, 'link'), 'dir')
    await symlink(join(root, 'sub'), join(root, 'inner-link'), 'dir')
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
    symlinksAvailable = false
  }
})

if (symlinksAvailable) {
  await check('rejects a symlink pointing outside the root', async () => {
    // The link itself sits INSIDE the root, so only the post-realpath re-check
    // can catch this — which is exactly what the second fence exists for.
    await assert.rejects(() => resolveInsideRoot(root, 'link/secret.txt'), /escapes the browse root/u)
  })

  await check('still allows a symlink pointing inside the root', async () => {
    const resolved = await resolveInsideRoot(root, 'inner-link/inside.txt')
    assert.equal(resolved, join(root, 'sub', 'inside.txt'))
  })
} else {
  console.log('  skip symlink cases — this host cannot create symlinks without elevation')
}

console.log('looksBinary')

await check('treats plain text as text', () => {
  assert.equal(looksBinary(Buffer.from('hello world\n')), false)
})

await check('treats UTF-8 CJK as text', () => {
  assert.equal(looksBinary(Buffer.from('阅读笔记', 'utf8')), false)
})

await check('detects a NUL byte as binary', () => {
  assert.equal(looksBinary(Buffer.from([0x68, 0x00, 0x69])), true)
})

await check('detects a PNG header as binary', () => {
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true)
})

console.log('messageText — both event shapes')

await check('reads the assistant/message wrapper', () => {
  const event = { data: { message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool' }] } } }
  assert.equal(messageText(event), 'hi')
})

await check('reads a bare user/message payload', () => {
  const event = { data: { content: [{ type: 'text', text: 'yo' }] } }
  assert.equal(messageText(event), 'yo')
})

await check('joins multiple text blocks', () => {
  const event = { data: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }
  assert.equal(messageText(event), 'ab')
})

await check('survives a malformed event', () => {
  assert.equal(messageText({}), '')
  assert.equal(messageText({ data: null }), '')
  assert.equal(messageText(undefined), '')
})

console.log('messageBlocks — typed blocks the panel folds')

await check('separates the reply from the reasoning', () => {
  const event = {
    data: {
      message: {
        content: [
          { type: 'reasoning', text: 'let me think' },
          { type: 'text', text: '# Answer\nbody' },
        ],
      },
    },
  }
  assert.deepEqual(messageBlocks(event), [
    { kind: 'reasoning', text: 'let me think' },
    { kind: 'text', text: '# Answer\nbody' },
  ])
})

await check('carries a tool call name and arguments', () => {
  const event = { data: { message: { content: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{"p":"a"}' }] } } }
  assert.deepEqual(messageBlocks(event), [{ kind: 'tool-call', name: 'read_file', text: '{"p":"a"}' }])
})

await check('flattens a tool result and keeps its error flag', () => {
  const event = {
    data: {
      message: {
        content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }] }],
      },
    },
  }
  assert.deepEqual(messageBlocks(event), [{ kind: 'tool-result', error: true, text: 'boom' }])
})

await check('drops empty text and reasoning blocks', () => {
  const event = { data: { message: { content: [{ type: 'text', text: '' }, { type: 'reasoning', text: '' }] } } }
  assert.deepEqual(messageBlocks(event), [])
})

await check('passes an unknown block type through rather than dropping it', () => {
  const event = { data: { message: { content: [{ type: 'audio', data: 'x' }] } } }
  assert.deepEqual(messageBlocks(event), [{ kind: 'other', text: '[audio]' }])
})

await check('survives a malformed block list', () => {
  assert.deepEqual(messageBlocks({}), [])
  assert.deepEqual(messageBlocks({ data: { message: { content: 'nope' } } }), [])
  assert.deepEqual(messageBlocks({ data: { message: { content: [null, 7] } } }), [])
})

console.log('installPanel — mounts against a mock host')

/** Minimal ServerResponse stand-in that records what the panel wrote. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers },
    write(chunk) { this.body += String(chunk) },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk) },
    destroy() {},
  }
}

/** Mount the panel against a stub context and hand back the captured route. */
function mountPanel(options = {}) {
  return mountPanelWithApprovals(options).route
}

/** As {@link mountPanel}, but also exposes the registered event listeners. */
function mountPanelWithApprovals(options = {}) {
  const routes = []
  const listeners = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    get: () => undefined,
    effect: (fn) => fn(),
    on: (event, handler, opts) => { listeners.push({ event, handler, opts }); return () => {} },
  }
  installPanel(ctx, { token: 'test-token', fileRoot: root, basePath: '/bridge', ...options })
  return { route: routes[0], listeners }
}

await check('the HTML shell contains no stray backtick', () => {
  // The panel's whole page lives in ONE template literal in the host source, so
  // a backtick anywhere inside it — including in a CSS comment or a JS comment —
  // ends the literal early and produces a parse error somewhere unrelated. This
  // has now happened twice; the assertion is the guard.
  const source = readNormalized(new URL('../lib/panel.js', import.meta.url), 'utf8')
  const open = source.indexOf('html`<!doctype html>')
  assert.notEqual(open, -1, 'could not locate the shell template')
  const close = source.indexOf('</html>`', open)
  assert.notEqual(close, -1, 'could not locate the end of the shell template')
  // `html` is four characters, so +5 lands just past the opening backtick.
  const shell = source.slice(open + 5, close)
  const offenders = shell.split('\n')
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.includes('`'))
  assert.deepEqual(
    offenders.map((entry) => String(entry.index) + ': ' + entry.line.trim().slice(0, 80)),
    [],
    'a backtick inside the shell terminates the template early',
  )
})

await check('mounting the panel does not throw', () => {
  // The HTML shell is one big template literal; a stray backtick or an invalid
  // escape in it breaks the mount at runtime instead of at parse time, which is
  // exactly the class of bug this assertion exists to catch.
  assert.doesNotThrow(() => { mountPanel() })
})

await check('registers exactly one prefix route', () => {
  const route = mountPanel()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/bridge')
})

await check('serves a complete, uncorrupted HTML shell', async () => {
  const route = mountPanel()
  const res = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge/', headers: { cookie: 'dsh_bridge=test-token' } }, res)
  await new Promise((resolve) => { setTimeout(resolve, 30) })

  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['content-type']), /text\/html/u)
  assert.match(res.body, /^<!doctype html>/u)
  assert.match(res.body, /<\/html>$/u)
  // Template corruption shows up as the body being just the cooked-string hole
  // ("undefined", caught by the doctype check above) or as an unexpanded
  // interpolation marker. `undefined` itself is a legitimate JS keyword in the
  // embedded script, so it is length, not that word, that proves completeness.
  assert.ok(res.body.length > 3000, 'shell looks truncated: ' + String(res.body.length) + ' bytes')
  assert.doesNotMatch(res.body, /\$\{/u)
  // Styles added alongside the Markdown work must actually survive into it.
  assert.match(res.body, /\.md \{/u)
  assert.match(res.body, /details\.fold/u)
  // Navigation chrome: the sticky bar's back/menu button and the session drawer
  // have to be present, or the view is a dead end.
  assert.match(res.body, /id="hbtn"/u)
  assert.match(res.body, /id="drawer"/u)
  assert.match(res.body, /id="newchat"/u)
  // The secondary actions — permissions, model, file reference, and both scroll
  // ends — all live behind ONE bottom-right button now. Two header chips used to
  // squeeze the conversation title down to an ellipsis, so their absence from the
  // header is part of the contract, not an accident.
  assert.match(res.body, /panel-fab\.js/u)
  assert.match(res.body, /__bridgeScroll/u)
  assert.match(res.body, /__bridgePickFile/u)
  assert.match(res.body, /__bridgeInsertText/u)
  // A JS failure on a phone is otherwise invisible, which makes a broken button
  // look like a button that was never built. The page has to say so out loud.
  assert.match(res.body, /'jserr'/u)
  assert.match(res.body, /unhandledrejection/u)
  assert.doesNotMatch(res.body, /'scrollbtns'/u, 'the in-composer scroll row is gone')
  assert.doesNotMatch(res.body, /id="permchip"/u, 'the permission chip left the header')
  assert.doesNotMatch(res.body, /id="modelchip"/u, 'the model chip left the header')
  assert.doesNotMatch(res.body, /id="htop"/u, 'the header top button moved out of the header')
  // The composer must be pinned to the bottom even for a short transcript.
  assert.match(res.body, /margin-top:auto/u)
  assert.match(res.body, /min-height:100dvh/u)
  // Approvals REPLACE the composer. A banner at the top is invisible exactly
  // when it matters — you are at the bottom of a long transcript, having just
  // sent the message that raised the question.
  assert.match(res.body, /composer-slots/u)
  assert.match(res.body, /function approvalCard/u)
  assert.doesNotMatch(res.body, /id="approvals"/u, 'the top-banner host must not come back')
  assert.doesNotMatch(res.body, /sessionId === sessionId/u,
    'the per-conversation approval filter must not come back')
  // Tables must render as tables rather than a wall of literal pipes.
  assert.match(res.body, /createElement\('table'\)/u)
  assert.match(res.body, /\.md table \{/u)
})

await check('keeps the token out of the rendered shell', async () => {
  const route = mountPanel()
  const res = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge/', headers: { cookie: 'dsh_bridge=test-token' } }, res)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.doesNotMatch(res.body, /test-token/u)
})

await check('challenges an unauthenticated request as HTML', async () => {
  const route = mountPanel()
  const res = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge/', headers: {} }, res)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.equal(res.statusCode, 401)
  // Not text/plain: a browser handed plain text for a navigation may download
  // it instead of rendering, which is how this failure presented on iOS.
  assert.match(String(res.headers['content-type']), /^text\/html/u)
  assert.doesNotMatch(res.body, /test-token/u, 'the challenge must not echo the secret')
})

await check('explains a stale cookie differently from a missing one', async () => {
  const route = mountPanel()
  const stale = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge/', headers: { cookie: 'dsh_bridge=an-old-token' } }, stale)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.match(stale.body, /不匹配/u)

  const missing = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge/', headers: {} }, missing)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.match(missing.body, /没有携带/u)
})

await check('exchanges a URL token for a cookie and redirects', async () => {
  const route = mountPanel()
  const res = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge?token=test-token', headers: {} }, res)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.equal(res.statusCode, 303)
  assert.equal(res.headers.location, '/bridge/')
  const cookie = String(res.headers['set-cookie'])
  assert.match(cookie, /dsh_bridge=test-token/u)
  // Lax, not Strict: tapping the link in another app makes the navigation
  // cross-site, and a Strict cookie is withheld for the redirect that follows.
  assert.match(cookie, /SameSite=Lax/u)
  assert.doesNotMatch(cookie, /Strict/u)
  assert.match(cookie, /HttpOnly/u)
})

await check('canonicalizes the slashless path with a redirect', async () => {
  const route = mountPanel()
  const res = fakeResponse()
  route.handler({ method: 'GET', url: '/bridge', headers: { cookie: 'dsh_bridge=test-token' } }, res)
  await new Promise((resolve) => { setTimeout(resolve, 30) })
  assert.equal(res.statusCode, 308)
  assert.equal(res.headers.location, '/bridge/')
})

console.log('conversation routing')

const SAMPLE = 'session-e41f35ee-172d-4c77-82d2-a2e4cd6a8675'

await check('derives a UUID-shaped session id from the opening message', () => {
  const id = sessionIdFor([{ role: 'user', content: 'hello' }])
  assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
})

await check('stays stable as the conversation grows', () => {
  const first = sessionIdFor([{ role: 'user', content: 'hello' }])
  const later = sessionIdFor([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'more' },
  ])
  assert.equal(first, later)
})

await check('RECORDED LIMIT: identical openings collide under the hash', () => {
  // This is the concrete reason explicit session selection exists. Two separate
  // Chatbox conversations that both open with "hi" are indistinguishable to the
  // stateless wire protocol, so the hash maps them onto one session.
  assert.equal(
    sessionIdFor([{ role: 'user', content: 'hi' }]),
    sessionIdFor([{ role: 'user', content: 'hi' }]),
  )
})

await check('recovers the session id from an advertised model id', () => {
  assert.equal(sessionIdFromModel(SAMPLE), SAMPLE)
  assert.equal(sessionIdFromModel(`Some title · ${SAMPLE}`), SAMPLE)
  assert.equal(sessionIdFromModel(`  ${SAMPLE}  `), SAMPLE)
})

await check('leaves the synthetic new-conversation entry unclaimed', () => {
  // `dsh-agent` must NOT parse as a session, or the hash fallback never runs.
  assert.equal(sessionIdFromModel('dsh-agent'), undefined)
  assert.equal(sessionIdFromModel('gpt-4o'), undefined)
  assert.equal(sessionIdFromModel(''), undefined)
  assert.equal(sessionIdFromModel(undefined), undefined)
  assert.equal(sessionIdFromModel(null), undefined)
})

await check('survives a display-truncated label', () => {
  // Only the embedded id matters, so a client shortening the label for its
  // picker cannot misroute a selected session.
  assert.equal(sessionIdFromModel(`${'很长 '.repeat(40)}· ${SAMPLE}`), SAMPLE)
  assert.equal(sessionIdFromModel(`[${SAMPLE}]`), SAMPLE)
})

console.log('approval answering — scope and race')

/** Minimal IncomingMessage stand-in; `readJsonBody` iterates it. */
function fakeRequest({ method = 'GET', url = '/bridge/', cookie, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: cookie === undefined ? {} : { cookie },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30) })

await check('registers a prepended approval/request listener', () => {
  const { listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const entry = listeners.find((listener) => listener.event === 'approval/request')
  assert.ok(entry !== undefined, 'no approval/request listener was registered')
  assert.equal(entry.opts?.prepend, true, 'the panel must be consulted before the forwarding row')
})

await check('offers nothing to the panel for an out-of-scope session', async () => {
  const elsewhere = join(sandbox, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const { route, listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler

  let delegated = false
  const outcome = await handler(
    { agent: { session: { id: 's-out', header: { cwd: elsewhere } } }, toolName: 'write' },
    () => { delegated = true; return Promise.resolve('rejected') },
  )
  assert.equal(delegated, true)
  assert.equal(outcome, 'rejected')

  const res = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), res)
  await settle()
  assert.deepEqual(JSON.parse(res.body).approvals, [])
})

await check('with no scope configured, every listed session is offered', async () => {
  // The production setting: the panel's list shows every session, so excluding
  // some of them from approval produced the case where you could open a
  // conversation, send it a message, and then never see the prompt it raised.
  const elsewhere = join(sandbox, 'elsewhere')
  await mkdir(elsewhere, { recursive: true })
  const { route, listeners } = mountPanelWithApprovals({})
  const handler = listeners.find((l) => l.event === 'approval/request').handler

  let delegated = false
  void handler(
    { agent: { session: { id: 's-any', header: { cwd: elsewhere } } }, toolName: 'write_file', reason: 'anywhere' },
    () => { delegated = true; return new Promise(() => {}) },
  )
  assert.equal(delegated, true, 'the desktop must still be asked in parallel')

  const res = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), res)
  await settle()
  const { approvals } = JSON.parse(res.body)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].sessionId, 's-any')
})

await check('in-scope: next() runs at once so the desktop prompt is never delayed', async () => {
  const { listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler

  let delegated = false
  void handler(
    { agent: { session: { id: 's-in', header: { cwd: root } } }, toolName: 'write_file', reason: 'needs to write' },
    () => { delegated = true; return new Promise(() => {}) },
  )
  // Synchronously after the call — the panel must not go first through the
  // waterfall, or a person at the machine would wait on a phone that is asleep.
  assert.equal(delegated, true)
  await settle()
})

await check('in-scope: the panel sees the pending approval with its session', async () => {
  const { route, listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler
  void handler(
    { agent: { session: { id: 's-in', header: { cwd: root } } }, toolName: 'write_file', reason: 'needs to write' },
    () => new Promise(() => {}),
  )
  await settle()

  const res = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), res)
  await settle()
  const { approvals } = JSON.parse(res.body)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'write_file')
  assert.equal(approvals[0].reason, 'needs to write')
  assert.equal(approvals[0].sessionId, 's-in')
  assert.equal(approvals[0].decide, undefined, 'the resolver must never reach the wire')
})

await check('in-scope: answering from the panel decides the race', async () => {
  const { route, listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler
  const outcome = handler(
    { agent: { session: { id: 's-in', header: { cwd: root } } }, toolName: 'write_file' },
    () => new Promise(() => {}),
  )
  await settle()

  const listed = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), listed)
  await settle()
  const [item] = JSON.parse(listed.body).approvals

  const answered = fakeResponse()
  route.handler(
    fakeRequest({
      method: 'POST', url: '/bridge/api/approve', cookie: 'dsh_bridge=test-token',
      body: { id: item.id, decision: 'allow' },
    }),
    answered,
  )
  await settle()
  assert.equal(answered.statusCode, 200, 'approve responded: ' + answered.body)
  assert.equal(await outcome, 'allowed-once')

  const after = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), after)
  await settle()
  assert.deepEqual(JSON.parse(after.body).approvals, [], 'a decided approval must leave the queue')
})

await check('in-scope: rejecting yields rejected, not a hang', async () => {
  const { route, listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler
  const outcome = handler(
    { agent: { session: { id: 's-in', header: { cwd: root } } }, toolName: 'write_file' },
    () => new Promise(() => {}),
  )
  await settle()
  const listed = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), listed)
  await settle()
  const [item] = JSON.parse(listed.body).approvals

  const answered = fakeResponse()
  route.handler(
    fakeRequest({
      method: 'POST', url: '/bridge/api/approve', cookie: 'dsh_bridge=test-token',
      body: { id: item.id, decision: 'deny' },
    }),
    answered,
  )
  await settle()
  assert.equal(await outcome, 'rejected')
})

await check('the desktop winning the race settles the request', async () => {
  const { route, listeners } = mountPanelWithApprovals({ approvalCwd: root })
  const handler = listeners.find((l) => l.event === 'approval/request').handler
  const outcome = handler(
    { agent: { session: { id: 's-in', header: { cwd: root } } }, toolName: 'write_file' },
    () => Promise.resolve('allowed-once'),
  )
  assert.equal(await outcome, 'allowed-once')
  await settle()

  const res = fakeResponse()
  route.handler(fakeRequest({ url: '/bridge/api/approvals', cookie: 'dsh_bridge=test-token' }), res)
  await settle()
  assert.deepEqual(JSON.parse(res.body).approvals, [], 'a desktop decision must clear the panel card')
})

await check('answering an unknown approval is a 404, not a silent success', async () => {
  const { route } = mountPanelWithApprovals({ approvalCwd: root })
  const res = fakeResponse()
  route.handler(
    fakeRequest({
      method: 'POST', url: '/bridge/api/approve', cookie: 'dsh_bridge=test-token',
      body: { id: 'ap-does-not-exist', decision: 'allow' },
    }),
    res,
  )
  await settle()
  assert.equal(res.statusCode, 404)
})

await rm(sandbox, { recursive: true, force: true })

console.log(`\n${String(passed)} passed, ${String(failed)} failed`)
process.exitCode = failed === 0 ? 0 : 1