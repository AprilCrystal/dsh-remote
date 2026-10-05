/**
 * Tests for the panel's context meter and compaction button.
 *
 * Three things here are worth more than the rest:
 *
 *  - `contextOccupancy` must return `null` rather than 0 when there is no
 *    reading. "0% of 1M" is a claim about an unmeasured context, and a reader
 *    who trusts it will not compact a conversation that needs it.
 *
 *  - `compactionFailure` must not resolve a prototype key as a known code. The
 *    messages are a plain object literal, so `code: 'constructor'` would
 *    otherwise hand back a function as the failure sentence.
 *
 *  - Compaction must reach the same `ctx.compaction.compactNow` the desktop's
 *    /compact command calls, and the panel must not attach a conversation the
 *    reader has only opened the meter for.
 */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import {
  COMPACTION_MESSAGES,
  compactionFailure,
  compactionSummary,
  contextOccupancy,
  createContextControl,
  pickCompaction,
} from '../lib/context-control.js'

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

function fakeReq(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    headers: {},
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

function makeHarness(overrides = {}) {
  const seen = { contextState: [], compact: [] }
  const control = createContextControl(
    { logger: { info: () => {}, warn: () => {} } },
    {
      contextState: overrides.contextState ?? (async (sessionId, fresh, load) => {
        seen.contextState.push({ sessionId, fresh, load })
        return { available: true, percent: 37, usedTokens: 372000, contextWindow: 1000000 }
      }),
      compactSession: overrides.compactSession ?? (async (sessionId) => {
        seen.compact.push(sessionId)
        return { compacted: true, shadowed: 12, message: 'compacted' }
      }),
    },
  )
  return { control, seen }
}

async function call(control, method, rest, query = '', body) {
  const url = new URL(`http://127.0.0.1:19387/bridge${rest}${query === '' ? '' : `?${query}`}`)
  const res = fakeRes()
  const owned = await control.handle(fakeReq(method, body), res, url, rest)
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { owned, status: res.status, headers: res.headers, body: res.body, json }
}

/* ── tests ────────────────────────────────────────────────────────────────── */

group('reading occupancy')

{
  ok('nothing recorded is nothing to show', contextOccupancy({}) === null)
  ok('an empty window with no sample is not zero percent',
    contextOccupancy({ contextPressure: { contextWindow: 1000000 } }) === null)
  ok('a sample with no capacity is not shown either',
    contextOccupancy({ contextPressure: { pressureTokens: 372000 } }) === null)
  ok('a missing values object is handled', contextOccupancy(undefined) === null)
}

{
  const occupancy = contextOccupancy({
    contextPressure: { pressureTokens: 372000, contextWindow: 1000000 },
  })
  ok('a sample and a capacity produce a reading', occupancy !== null)
  ok('the percentage rounds', occupancy.percent === 37, String(occupancy.percent))
  ok('the raw pair is carried through',
    occupancy.usedTokens === 372000 && occupancy.contextWindow === 1000000)
  ok('an absent breakdown is null rather than an empty object', occupancy.breakdown === null)
}

{
  const occupancy = contextOccupancy({
    contextPressure: { pressureTokens: 300000, projectedTokens: 372000, contextWindow: 1000000 },
  })
  ok('the projected figure wins over the raw sample', occupancy.usedTokens === 372000,
    String(occupancy.usedTokens))
  ok('it is the projected figure that sets the percentage', occupancy.percent === 37)
}

{
  const occupancy = contextOccupancy({
    contextPressure: { pressureTokens: 100, projectedTokens: 0, contextWindow: 1000000 },
  })
  ok('a projected zero is a real reading, not a missing one', occupancy !== null)
  ok('and it reads as zero percent', occupancy.percent === 0, String(occupancy?.percent))
}

{
  const occupancy = contextOccupancy({
    contextPressure: { pressureTokens: 4000000, contextWindow: 1000000 },
  })
  ok('an overfull context clamps at 100', occupancy.percent === 100, String(occupancy.percent))
}

{
  const occupancy = contextOccupancy({
    contextPressure: { pressureTokens: 372000, contextWindow: 1000000 },
    contextBreakdown: { systemTokens: 1500, toolsTokens: 5600, messageTokens: 322000, extra: 9 },
  })
  ok('the breakdown is split into the three shown figures',
    occupancy.breakdown.systemTokens === 1500
    && occupancy.breakdown.toolsTokens === 5600
    && occupancy.breakdown.messageTokens === 322000,
    JSON.stringify(occupancy.breakdown))
  ok('nothing else is copied out of the projection',
    Object.keys(occupancy.breakdown).length === 3, JSON.stringify(Object.keys(occupancy.breakdown)))
}

group('folding a compaction failure')

{
  ok('every known code has a sentence',
    Object.values(COMPACTION_MESSAGES).every((text) => typeof text === 'string' && text.length > 4))
  ok('busy is one of them', Object.hasOwn(COMPACTION_MESSAGES, 'busy'))
}

{
  const busy = compactionFailure(Object.assign(new Error('x'), { code: 'busy' }))
  ok('busy is a 409', busy.status === 409, String(busy.status))
  ok('busy explains that waiting fixes it', busy.message === COMPACTION_MESSAGES.busy)
}

{
  for (const code of ['cancelled', 'changed', 'summary', 'commit', 'persistence']) {
    const failure = compactionFailure(Object.assign(new Error('x'), { code }))
    ok(`${code} reports its own sentence`,
      failure.message === COMPACTION_MESSAGES[code] && failure.status === 500,
      `${failure.status} ${failure.message}`)
  }
}

{
  const failure = compactionFailure(Object.assign(new Error('disk on fire'), { code: 'unheard-of' }))
  ok('an unrecognised code keeps the backend message', failure.message === 'disk on fire')
  ok('and is a 500', failure.status === 500)
}

{
  // The messages are a plain object literal, so an inherited key would otherwise
  // be handed back as the failure text.
  const ctor = compactionFailure(Object.assign(new Error('real reason'), { code: 'constructor' }))
  ok('a prototype key is not treated as a known code', ctor.message === 'real reason',
    JSON.stringify(ctor.message))
  const tostring = compactionFailure(Object.assign(new Error('real reason'), { code: 'toString' }))
  ok('nor is toString', tostring.message === 'real reason', JSON.stringify(tostring.message))
}

{
  const plain = compactionFailure(new Error('something else broke'))
  ok('an error with no code keeps its message', plain.message === 'something else broke')
  ok('and is a 500', plain.status === 500)
  ok('a non-error is stringified', compactionFailure('nope').message === 'nope')
}

group('choosing a compaction service')

{
  const realm = { compactNow: () => {} }
  const host = { compactNow: () => {} }
  ok('the agent preset realm wins over the host row', pickCompaction(realm, host) === realm)
  ok('the host row is used when the realm has none', pickCompaction(undefined, host) === host)
  ok('a realm object without compactNow falls through', pickCompaction({}, host) === host)
  ok('a non-function compactNow is not accepted',
    pickCompaction({ compactNow: 'yes' }, { compactNow: 'also' }) === undefined)
  ok('neither service is undefined, not a guess', pickCompaction(undefined, undefined) === undefined)
}

group('describing a compaction')

{
  const none = compactionSummary(null)
  ok('no safe range is not a success', none.compacted === false)
  ok('and says so', typeof none.message === 'string' && none.message.includes('没有'))
  ok('undefined behaves the same', compactionSummary(undefined).compacted === false)
}

{
  const result = compactionSummary({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 41000 })
  ok('a result reports success', result.compacted === true)
  ok('it counts what was shadowed', result.shadowed === 3, String(result.shadowed))
  ok('it carries the shadow price', result.shadowedTokens === 41000)
  ok('the sentence mentions both figures',
    result.message.includes('3') && result.message.includes('41000'), result.message)
}

group('the HTTP face')

{
  const { control, seen } = makeHarness()
  const res = await call(control, 'GET', '/api/context', 'session=s1')
  ok('the state is served', res.status === 200, `status ${res.status}`)
  ok('the session is passed through', seen.contextState[0]?.sessionId === 's1')
  ok('a stale conversation is not flagged fresh', seen.contextState[0]?.fresh === false)
  ok('the state is sent verbatim', res.json?.percent === 37, JSON.stringify(res.json))
}

{
  const { control, seen } = makeHarness()
  await call(control, 'GET', '/api/context', 'session=s1')
  ok('a plain read never attaches the conversation', seen.contextState[0]?.load === false,
    JSON.stringify(seen.contextState[0]))
  await call(control, 'GET', '/api/context', 'session=s1&load=1')
  ok('and an explicit load does', seen.contextState[1]?.load === true)
}

{
  const { control, seen } = makeHarness()
  await call(control, 'GET', '/api/context', 'session=s1&fresh=1')
  ok('a fresh conversation is flagged', seen.contextState[0]?.fresh === true)
  await call(control, 'GET', '/api/context', '')
  ok('a missing session reads as empty, not as an error', seen.contextState[1]?.sessionId === '')
}

{
  const { control } = makeHarness()
  const other = await call(control, 'GET', '/api/sessions')
  ok('an unrelated route is not claimed', other.owned === false)
  const wrong = await call(control, 'PUT', '/api/context')
  ok('an unsupported method is a 405', wrong.status === 405, `status ${wrong.status}`)
}

{
  const { control } = makeHarness({
    contextState: async () => { throw Object.assign(new Error('no projections here'), { status: 503 }) },
  })
  const res = await call(control, 'GET', '/api/context', 'session=s1')
  ok('a refusal keeps its status', res.status === 503, `status ${res.status}`)
  ok('and its reason', res.json?.error === 'no projections here')
}

{
  const { control } = makeHarness({
    contextState: async () => { throw new Error('boom') },
  })
  const res = await call(control, 'GET', '/api/context', 'session=s1')
  ok('an unclassified failure is a 500', res.status === 500, `status ${res.status}`)
}

group('compacting from the phone')

{
  const { control, seen } = makeHarness()
  const res = await call(control, 'POST', '/api/context', '', { session: 's1', action: 'compact' })
  ok('the request is accepted', res.status === 200, `status ${res.status} ${res.body}`)
  ok('it reaches the session', seen.compact[0] === 's1', JSON.stringify(seen.compact))
  ok('the result is reported', res.json?.ok === true && res.json?.shadowed === 12,
    JSON.stringify(res.json))
}

{
  const { control, seen } = makeHarness()
  await call(control, 'POST', '/api/context', '', { session: 's1', action: 'compact' })
  ok('the meter is re-read after the write', seen.contextState.length === 1)
  ok('and re-read after attaching, not cold', seen.contextState[0]?.load === true)
}

{
  const { control } = makeHarness()
  await call(control, 'POST', '/api/context', '', { session: 's1', action: 'compact' })
  const noSession = await call(control, 'POST', '/api/context', '', { action: 'compact' })
  ok('a missing session is a 400', noSession.status === 400, `status ${noSession.status}`)
  const unknown = await call(control, 'POST', '/api/context', '', { session: 's1', action: 'purge' })
  ok('an unknown action is a 400', unknown.status === 400, `status ${unknown.status}`)
  ok('and names the action', String(unknown.json?.error).includes('purge'), unknown.json?.error)
  const none = await call(control, 'POST', '/api/context', '', { session: 's1' })
  ok('a missing action is a 400 too', none.status === 400, `status ${none.status}`)
}

{
  const { control } = makeHarness({
    compactSession: async () => {
      throw Object.assign(new Error('这段会话正在回复（或者进程里有别的压缩在跑），等它结束再试。'), { status: 409 })
    },
  })
  const res = await call(control, 'POST', '/api/context', '', { session: 's1', action: 'compact' })
  ok('a busy conversation answers 409', res.status === 409, `status ${res.status}`)
  ok('with the sentence the reader needs', String(res.json?.error).includes('正在回复'), res.json?.error)
}

group('the served meter script')

{
  const { control } = makeHarness()
  const asset = await call(control, 'GET', '/context-ui.js')
  ok('the meter script is served', asset.status === 200, `status ${asset.status}`)
  ok('it is typed as JavaScript', String(asset.headers['content-type']).startsWith('text/javascript'))
  ok('it is never cached', asset.headers['cache-control'] === 'no-store')
  let parseError = null
  try {
    new vm.Script(asset.body)
  } catch (error) {
    parseError = error
  }
  ok('it parses as JavaScript', parseError === null, String(parseError))
  ok('it calls the context API', asset.body.includes('api/context'))
  ok('it asks for an attach only when the reader asks',
    asset.body.includes("'&load=1'") && asset.body.includes('读取占用'))
  ok('it posts the compact action', asset.body.includes("action: 'compact'"))
  ok('it labels the three breakdown rows',
    ['系统提示词', '工具定义', '对话消息'].every((label) => asset.body.includes(label)))
  ok('it can stand alone when the cluster never loads',
    asset.body.includes('ctxstandalone') && asset.body.includes('mountStandalone'))
}

{
  // A native confirm()/alert() in an in-app webview is the classic silent
  // no-op, and this panel deliberately owns its own dialogs instead.
  const { control } = makeHarness()
  const asset = await call(control, 'GET', '/context-ui.js')
  ok('it opens no native dialog',
    !/\b(window\.)?(confirm|alert|prompt)\s*\(/u.test(asset.body.replace(/\/\*[\s\S]*?\*\//gu, '')))
}

group('the panel wiring')

{
  const panel = readFileSync(new URL('../lib/panel.js', import.meta.url), 'utf8')
  ok('the panel imports the context module', panel.includes("from './context-control.js'"))
  ok('it builds the control from options.context',
    panel.includes('createContextControl(ctx, { basePath, runtime, ...options.context })'))
  ok('it delegates the route', panel.includes('contexts.handle(req, res, url, rest)'))
  ok('the meter script is in the shell',
    panel.includes('<script src="context-ui.js" defer></script>'))
  ok('and is dropped when the module is absent',
    panel.includes("if (contexts === null) droppedTags.push('<script src=\"context-ui.js\" defer></script>')"))

  const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the host passes both callbacks through',
    wire.includes('context: { contextState, compactSession }'))
  ok('compaction goes through the harness service, not a reimplementation',
    wire.includes('service.compactNow(agent, controller.signal)'))
  ok('the meter reads the same two projections the desktop ring does',
    wire.includes("['contextPressure', 'contextBreakdown']"))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
