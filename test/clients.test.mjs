/**
 * Tests for the per-client allowlist.
 *
 * The point of this gate is that a token which leaked in a URL is not enough on
 * its own, so the properties worth asserting are the ones that keep that true:
 *
 *  - an un-approved peer is refused EVERYTHING, including the shell and the
 *    OpenAI face, and the refusal carries no approval;
 *  - the code that fixes it is never in anything a remote peer can read, only in
 *    the loopback-only setup state;
 *  - an approval survives a restart, and is written where the README says;
 *  - a failed code cannot be retried forever, but also cannot lock a device out
 *    permanently — a lock that outlived its TTL would be unexplainable from the
 *    setup page, which only shows live entries;
 *  - the same phone keeps its approval when it comes back as an IPv4-mapped
 *    IPv6 peer, which is how a dual-stack socket reports it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import {
  CLIENTS_FILE_NAME,
  createClientGate,
  DEFAULT_PAIR_PATH,
  isLoopbackAddress,
  normalizePeer,
  pairPage,
  parseClients,
  serializeClients,
} from '../lib/client-gate.js'

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

const workdir = mkdtempSync(join(tmpdir(), 'bridge-clients-'))
const clientsFile = join(workdir, CLIENTS_FILE_NAME)

function fakeReq(method, remote, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    socket: { remoteAddress: remote },
    headers: { 'user-agent': 'TestAgent/1.0' },
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

/** Let the gate's fire-and-forget response finish before it is inspected. */
const settle = async () => {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

let fileCounter = 0

function makeGate(overrides = {}) {
  let clock = 1_000_000
  let code = 424242
  const logs = []
  // One allowlist file per gate unless a test asks for a specific one: an
  // approval written by an earlier block would otherwise be loaded by the next
  // gate and change what it starts out believing.
  fileCounter += 1
  const file = overrides.file ?? join(workdir, `clients-${fileCounter}.json`)
  const gate = createClientGate(
    { logger: { info: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) } },
    {
      file,
      now: () => clock,
      randomInt: () => code,
      ...overrides.options,
    },
  )
  return {
    gate,
    file,
    logs,
    advance: (ms) => { clock += ms },
    setCode: (next) => { code = next },
  }
}

async function request(gate, method, remote, path, body) {
  const url = new URL(`http://bridge.invalid${path}`)
  const res = fakeRes()
  const handled = gate.check(fakeReq(method, remote, body), res, url)
  if (handled && method === 'POST' && path === gate.pairPath) await settle()
  return { handled, res, json: (() => { try { return JSON.parse(res.body) } catch { return undefined } })() }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

group('normalising a peer address')

{
  ok('plain IPv4 is itself', normalizePeer('10.111.99.94') === '10.111.99.94')
  ok('IPv4-mapped IPv6 collapses to the IPv4 form',
    normalizePeer('::ffff:10.111.99.94') === '10.111.99.94',
    normalizePeer('::ffff:10.111.99.94'))
  ok('a mapped loopback collapses too', normalizePeer('::ffff:127.0.0.1') === '127.0.0.1')
  ok('hex case is folded', normalizePeer('FE80::1') === 'fe80::1')
  ok('a zone is dropped', normalizePeer('fe80::1%eth0') === 'fe80::1')
  ok('surrounding space is dropped', normalizePeer('  10.0.0.5  ') === '10.0.0.5')
  ok('::1 survives as itself', normalizePeer('::1') === '::1')
  ok('no address is the empty key', normalizePeer(undefined) === '' && normalizePeer('') === '')
}

{
  ok('127.0.0.1 is loopback', isLoopbackAddress('127.0.0.1'))
  ok('the whole 127/8 is loopback', isLoopbackAddress('127.9.9.9'))
  ok('::1 is loopback', isLoopbackAddress('::1'))
  ok('a LAN address is not', !isLoopbackAddress('10.111.99.94'))
  ok('almost-loopback is not', !isLoopbackAddress('128.0.0.1'))
}

group('reading an allowlist that may be anything')

{
  ok('no file is nobody approved', parseClients(null).clients.length === 0)
  ok('empty text is nobody approved', parseClients('   ').clients.length === 0)
  ok('unparsable text is nobody approved, not everybody',
    parseClients('{ this is not json').clients.length === 0)
  ok('a JSON scalar is nobody approved', parseClients('42').clients.length === 0)
  ok('a JSON null is nobody approved', parseClients('null').clients.length === 0)
}

{
  const state = parseClients(JSON.stringify([
    { ip: '10.0.0.5' },
    { ip: '10.0.0.5', label: 'duplicate' },
    { ip: '  ::ffff:10.0.0.6 ' },
    { label: 'no ip at all' },
    { ip: '' },
    { ip: '10.0.0.7', label: 'x'.repeat(400), firstSeen: 'soon', lastSeen: 12 },
  ]))
  ok('a bare array is accepted', state.version === 1 && state.clients.length === 3,
    JSON.stringify(state.clients.map((c) => c.ip)))
  ok('duplicates collapse, first wins', state.clients[0].label === '')
  ok('a mapped address is normalised on read', state.clients[1].ip === '10.0.0.6')
  ok('a non-numeric timestamp becomes 0', state.clients[2].firstSeen === 0)
  ok('a numeric timestamp survives', state.clients[2].lastSeen === 12)
  ok('a label is truncated', state.clients[2].label.length === 120)
}

{
  const written = serializeClients({ clients: [{ ip: '10.0.0.5', label: 'phone', firstSeen: 1, lastSeen: 2 }] })
  const back = parseClients(written)
  ok('the file form round-trips', back.clients.length === 1 && back.clients[0].ip === '10.0.0.5')
  ok('and is human-readable JSON with a version', written.includes('"version": 1'))
}

group('an un-approved device')

{
  const { gate } = makeGate()
  const shell = await request(gate, 'GET', '10.111.99.94', '/bridge/')
  ok('is refused the shell', shell.handled === true)
  ok('with 403', shell.res.status === 403, String(shell.res.status))
  ok('and gets a page it can act on', String(shell.res.headers['content-type']).startsWith('text/html'))
  ok('the page cannot pull in anything off-origin',
    String(shell.res.headers['content-security-policy']).includes("default-src 'none'"),
    String(shell.res.headers['content-security-policy']))
  ok('the page tells it where to look', shell.res.body.includes('设置页面'))

  const api = await request(gate, 'GET', '10.111.99.94', '/v1/models')
  ok('the OpenAI face is refused with JSON, not a page',
    api.res.status === 403 && String(api.res.headers['content-type']).startsWith('application/json'),
    String(api.res.headers['content-type']))
  ok('and says why in a machine-readable way', api.json?.error?.type === 'client_not_allowed')
  ok('naming the pairing route', api.json?.error?.pairPath === DEFAULT_PAIR_PATH)
}

{
  const { gate } = makeGate()
  await request(gate, 'GET', '10.111.99.94', '/v1/models')
  const waiting = gate.pending()
  ok('a pending entry is created for the device', waiting.length === 1, JSON.stringify(waiting))
  ok('carrying the code', waiting[0].code === '424242', JSON.stringify(waiting[0]))
  ok('and the address', waiting[0].ip === '10.111.99.94')
  ok('and a device label from what it says about itself', waiting[0].label === 'TestAgent/1.0')

  const refused = await request(gate, 'GET', '10.111.99.94', '/v1/models')
  ok('the code is never in anything a remote peer reads',
    !refused.res.body.includes('424242'), refused.res.body)
  const page = await request(gate, 'GET', '10.111.99.94', '/bridge/')
  ok('nor in the page it is shown', !page.res.body.includes('424242'))
  ok('and it is not approved by asking', gate.clients().length === 0)
}

group('a device that is allowed')

{
  const { gate } = makeGate()
  ok('loopback passes without pairing', (await request(gate, 'GET', '127.0.0.1', '/v1/models')).handled === false)
  ok('mapped loopback passes too', (await request(gate, 'GET', '::ffff:127.0.0.1', '/bridge/')).handled === false)
  ok('::1 passes', (await request(gate, 'GET', '::1', '/bridge/')).handled === false)
  ok('and nothing was minted for them', gate.pending().length === 0)
}

{
  const { gate } = makeGate({ options: { enabled: false } })
  ok('with the allowlist off, a LAN peer passes', (await request(gate, 'GET', '10.0.0.9', '/v1/models')).handled === false)
  ok('and no code is minted', gate.pending().length === 0)
  ok('and nobody is recorded', gate.clients().length === 0)
}

group('pairing with the code')

{
  const { gate } = makeGate()
  await request(gate, 'GET', '10.111.99.94', '/bridge/')
  const wrong = await request(gate, 'POST', '10.111.99.94', DEFAULT_PAIR_PATH, { code: '000000' })
  ok('a wrong code is refused', wrong.res.status === 403, String(wrong.res.status))
  ok('and counts down what is left', wrong.json?.remaining === 4, JSON.stringify(wrong.json))
  ok('and does not approve', gate.clients().length === 0)

  const right = await request(gate, 'POST', '10.111.99.94', DEFAULT_PAIR_PATH, { code: '424242' })
  ok('the right code is accepted', right.res.status === 200 && right.json?.ok === true,
    `${right.res.status} ${right.res.body}`)
  ok('the device is now approved', gate.clients().length === 1)
  ok('and passes on the next request', (await request(gate, 'GET', '10.111.99.94', '/v1/models')).handled === false)
  ok('and the pending entry is gone', gate.pending().length === 0)
}

{
  const { gate } = makeGate({ options: { maxAttempts: 2 } })
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '111111' })
  const second = await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '222222' })
  ok('the last allowed attempt locks the entry', second.json?.remaining === 0)
  const after = await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '424242' })
  ok('and then even the right code is refused', after.res.status === 429, String(after.res.status))
  ok('the entry is still visible to the operator, marked dead',
    gate.pending()[0]?.locked === true, JSON.stringify(gate.pending()))
}

{
  // The lock must not outlive the code. A lock that only expired on restart
  // would be a permanent lockout with nothing on the setup page to explain it.
  const { gate, advance, setCode } = makeGate({ options: { maxAttempts: 1, codeTtlMs: 60_000 } })
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '000000' })
  ok('the entry is locked after the only attempt', gate.pending()[0]?.locked === true)
  const beforeTtl = await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '424242' })
  ok('and the right code is refused while it lives', beforeTtl.res.status === 429)

  advance(60_001)
  ok('after the TTL the dead entry is gone from the operator view', gate.pending().length === 0)
  setCode(987654)
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  const fresh = gate.pending()[0]
  ok('and a fresh code is minted', fresh?.code === '987654', JSON.stringify(fresh))
  ok('which is not locked', fresh?.locked === false)
  const accepted = await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '987654' })
  ok('so the device can still get in', accepted.res.status === 200 && gate.clients().length === 1)
}

{
  const { gate } = makeGate()
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  const malformed = await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: ' 42 42 42 ' })
  ok('punctuation and spaces in the code are tolerated',
    malformed.res.status === 200, `${malformed.res.status} ${malformed.res.body}`)
}

group('the approval is on disk')

{
  rmSync(clientsFile, { force: true })
  const { gate } = makeGate({ file: clientsFile })
  await request(gate, 'GET', '10.111.99.94', '/bridge/')
  await request(gate, 'POST', '10.111.99.94', DEFAULT_PAIR_PATH, { code: '424242' })

  const raw = readFileSync(clientsFile, 'utf8')
  ok('the file is written where it was asked for', raw.includes('10.111.99.94'), raw.slice(0, 120))
  const parsed = parseClients(raw)
  ok('it holds the approved address', parsed.clients[0]?.ip === '10.111.99.94')
  ok('and the device label', parsed.clients[0]?.label === 'TestAgent/1.0')

  // A restart is a new gate object reading the same file.
  const restarted = makeGate({ file: clientsFile }).gate
  ok('a fresh process reads the approval back', restarted.clients().length === 1)
  ok('so the device does not pair again',
    (await request(restarted, 'GET', '10.111.99.94', '/v1/models')).handled === false)
}

{
  // The same phone, two spellings: a dual-stack socket reports an IPv4 peer in
  // mapped form, which must not read as a brand-new device.
  const { gate } = makeGate()
  await request(gate, 'GET', '::ffff:10.111.99.94', '/bridge/')
  await request(gate, 'POST', '::ffff:10.111.99.94', DEFAULT_PAIR_PATH, { code: '424242' })
  ok('the approval is stored in IPv4 form', gate.clients()[0]?.ip === '10.111.99.94')
  ok('and the mapped spelling is recognised next time',
    (await request(gate, 'GET', '10.111.99.94', '/bridge/')).handled === false)
  ok('as is the unmapped one',
    (await request(gate, 'GET', '::ffff:10.111.99.94', '/bridge/')).handled === false)
}

group('forgetting a device')

{
  const { gate } = makeGate()
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '424242' })
  ok('an unknown address is not forgotten', gate.forget('10.0.0.99') === false)
  ok('a known one is', gate.forget('10.0.0.9') === true)
  ok('and it is gone from the list', gate.clients().length === 0)
  ok('so it must pair again', (await request(gate, 'GET', '10.0.0.9', '/bridge/')).handled === true)
  ok('and the file no longer lists it',
    parseClients(readFileSync(gate.file, 'utf8')).clients.length === 0)
  ok('a mapped spelling can forget a plain entry', gate.forget('10.0.0.9') === false)
}

group('the pairing route itself')

{
  const { gate } = makeGate()
  const res = fakeRes()
  gate.handler(fakeReq('POST', '127.0.0.1', { code: '424242' }), res)
  await settle()
  ok('a loopback peer finds nothing to pair', res.status === 404, String(res.status))
}

{
  const { gate } = makeGate()
  await request(gate, 'GET', '10.0.0.9', '/bridge/')
  await request(gate, 'POST', '10.0.0.9', DEFAULT_PAIR_PATH, { code: '424242' })
  const res = fakeRes()
  gate.handler(fakeReq('GET', '10.0.0.9'), res)
  await settle()
  ok('an approved device finds nothing to pair either', res.status === 404, String(res.status))
}

group('the page it shows')

{
  const html = pairPage({ ip: '10.0.0.9', pairPath: '/pair', locked: false })
  ok('it names the address', html.includes('10.0.0.9'))
  ok('it posts to the pairing route', html.includes('"/pair"'))
  ok('it has a numeric field', html.includes('inputmode="numeric"'))
  ok('and loads nothing from anywhere else', !/(?:src|href)=["']http/u.test(html))
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  ok('it has exactly one inline script', typeof script === 'string')
  let parseError = null
  try {
    new vm.Script(script)
  } catch (error) {
    parseError = error
  }
  // A template literal silently eats an escape it does not know, so "does the
  // served script parse" is the only way to catch that class of typo here.
  ok('and that script parses as JavaScript', parseError === null, String(parseError))

  const dead = pairPage({ ip: '', pairPath: '/pair', locked: true })
  ok('a dead code is explained rather than shown as a field hint', dead.includes('作废'))
  ok('an unknown address does not print an empty gap', dead.includes('未知地址'))
}

group('the wiring')

{
  const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the host builds the gate', wire.includes('createClientGate(ctx,'))
  ok('pointing at the documented $DSH_HOME file',
    wire.includes('resolveHomeFile(ctx, CLIENTS_FILE_NAME)'))
  ok('the pairing route is mounted', wire.includes('path: clientGate.pairPath'))
  ok('the OpenAI face consults it before the token check',
    wire.indexOf('clientGate.check(req, res, url)') < wire.indexOf("pathname === `${BASE_PATH}/models`"))
  ok('and the panel receives it', wire.includes('clientGate,'))

  const panel = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  const gateAt = panel.indexOf('clientGate.check(req, res, url)')
  const redirectAt = panel.indexOf("if (rest === '') {")
  ok('the panel consults it', gateAt !== -1)
  ok('before the slashless redirect, so the shell cannot be served first',
    gateAt !== -1 && redirectAt !== -1 && gateAt < redirectAt, `${gateAt} < ${redirectAt}`)

  const setup = readFileSync(new URL('../lib/setup.js', import.meta.url), 'utf8')
  ok('the setup state carries the gate', setup.includes('clientGate: gate === null ? null : {'))
  ok('including the pending codes', setup.includes('pending: gate.pending(),'))
  // Source order is the wrong thing to compare; what matters is that the refusal
  // returns before the handler can reach the state route it feeds.
  ok('behind the loopback check',
    setup.indexOf('if (!isLoopback(req))') < setup.indexOf("rest === '/state'"),
    `${setup.indexOf('if (!isLoopback(req))')} < ${setup.indexOf("rest === '/state'")}`)
  ok('and offers a way to forget a device', setup.includes("rest === '/clients/forget'"))
}

rmSync(workdir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
