/**
 * Tests for the panel's model picker.
 *
 * The catalogue is a projection of the live LLM registry, so the two properties
 * that matter are: one misconfigured provider must not blank the whole list, and
 * a selection must be validated against that same registry before it is pinned —
 * a typo that reaches the agent surfaces later as a confusing turn failure
 * instead of a rejected request.
 */

import { readFileSync } from 'node:fs'
import { createModelControl } from '../lib/model-control.js'
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

function fakeLlm() {
  return {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'broken-provider', name: 'Broken Provider' },
    ],
    listModels: async (id) => {
      if (id === 'broken-provider') throw new Error('provider unreachable')
      return [
        { id: 'deepseek-v4-flash', name: 'V4 Flash' },
        { id: 'deepseek-reasoner', name: 'Reasoner', description: 'thinks harder' },
      ]
    },
    resolveModelInfo: async (_provider, model) => (model === 'deepseek-reasoner'
      ? { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High', description: 'deeper' }], defaultEffort: 'high' } }
      : {}),
  }
}

function makeHarness(overrides = {}) {
  const applied = []
  // `in` rather than `??`: one case deliberately passes `llm: undefined` to
  // exercise a host with no LLM registry, and `??` would substitute the fake.
  const llm = 'llm' in overrides ? overrides.llm : fakeLlm()
  const ctx = {
    get: (name) => (name === 'llm' ? llm : undefined),
    logger: { info: () => {}, warn: () => {} },
  }
  const control = createModelControl(ctx, {
    basePath: '/bridge',
    selectionState: overrides.selectionState ?? ((sessionId, fresh) => ({
      current: fresh ? null : { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      live: false,
      manageable: true,
      note: '',
      seen: { sessionId, fresh },
    })),
    applySelection: overrides.applySelection ?? (async (sessionId, selection) => {
      applied.push({ sessionId, selection })
      return { current: selection }
    }),
  })
  return { control, applied, ctx }
}

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

group('the catalogue')

{
  const { control } = makeHarness()
  const res = await call(control, 'GET', '/api/model', 'session=s1')
  ok('the catalogue loads', res.status === 200, `status ${res.status}`)
  ok('it lists both providers as routable', res.json?.routableProviders?.length === 2,
    JSON.stringify(res.json?.routableProviders))
  ok('a provider that cannot enumerate is isolated, not fatal',
    res.json?.groups?.length === 1, JSON.stringify(res.json?.groups?.map((g) => g.id)))
  ok('the failing provider is reported', res.json?.failures?.[0]?.id === 'broken-provider',
    JSON.stringify(res.json?.failures))
  ok('the failure carries the provider message',
    String(res.json?.failures?.[0]?.message).includes('unreachable'))
  ok('models carry their display name', res.json?.groups?.[0]?.models?.[0]?.name === 'V4 Flash')
}

{
  const { control } = makeHarness()
  const res = await call(control, 'GET', '/api/model', 'session=s1')
  const reasoner = res.json.groups[0].models.find((m) => m.id === 'deepseek-reasoner')
  const flash = res.json.groups[0].models.find((m) => m.id === 'deepseek-v4-flash')
  ok('reasoning efforts are surfaced', reasoner?.reasoning?.efforts?.length === 2,
    JSON.stringify(reasoner?.reasoning))
  ok('the default effort is surfaced', reasoner?.reasoning?.defaultEffort === 'high')
  ok('effort descriptions survive', reasoner?.reasoning?.efforts?.[1]?.description === 'deeper')
  ok('a model without reasoning carries none', flash?.reasoning === undefined)
}

{
  const { control } = makeHarness()
  const res = await call(control, 'GET', '/api/model', 'session=s1&fresh=1')
  ok('the caller can tell this is a fresh conversation', res.json?.seen?.fresh === true)
  ok('a fresh conversation reports no current selection', res.json?.current === null)
  ok('the deployment default is still reported', res.json?.default?.model === 'deepseek-v4-flash')
}

{
  const { control } = makeHarness({
    selectionState: () => ({
      current: null, default: null, live: true, manageable: false, note: 'held by the desktop',
    }),
  })
  const res = await call(control, 'GET', '/api/model', 'session=s1')
  ok('a desktop-held session is reported as unmanageable', res.json?.manageable === false)
  ok('and explains itself', res.json?.note === 'held by the desktop')
}

group('applying a selection')

{
  const { control, applied } = makeHarness()
  const res = await call(control, 'POST', '/api/model', '', {
    session: 's1',
    provider: 'deepseek-official',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  ok('the switch is accepted', res.status === 200, `status ${res.status} ${res.body}`)
  ok('it reaches the session', applied[0]?.sessionId === 's1')
  ok('provider, model and effort all survive', applied[0]?.selection.model === 'deepseek-reasoner'
    && applied[0]?.selection.reasoningEffort === 'high', JSON.stringify(applied[0]?.selection))
  ok('the new selection is echoed back', res.json?.current?.reasoningEffort === 'high')
}

{
  const { control, applied } = makeHarness()
  await call(control, 'POST', '/api/model', '', {
    session: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash',
  })
  ok('an omitted effort is not invented', applied[0]?.selection.reasoningEffort === undefined)
  ok('the key is absent rather than undefined-valued',
    !Object.prototype.hasOwnProperty.call(applied[0].selection, 'reasoningEffort'))
}

{
  const { control } = makeHarness()
  const empty = await call(control, 'POST', '/api/model', '', {})
  ok('a missing session is a 400', empty.status === 400, `status ${empty.status}`)
  const partial = await call(control, 'POST', '/api/model', '', { session: 's1', provider: 'p' })
  ok('a missing model is a 400', partial.status === 400, `status ${partial.status}`)
  const literal = await call(control, 'POST', '/api/model', '', { session: 's1', provider: '', model: '' })
  ok('an empty provider is a 400', literal.status === 400, `status ${literal.status}`)
}

{
  const { control } = makeHarness({
    applySelection: async () => {
      throw Object.assign(new Error('这段会话正由电脑端持有'), { status: 409 })
    },
  })
  const res = await call(control, 'POST', '/api/model', '', {
    session: 's1', provider: 'deepseek-official', model: 'deepseek-v4-flash',
  })
  ok('a refusal keeps its status code', res.status === 409, `status ${res.status}`)
  ok('a refusal explains itself', String(res.json?.error).includes('电脑端'))
}

{
  const { control } = makeHarness({
    applySelection: async () => { throw new Error('boom') },
  })
  const res = await call(control, 'POST', '/api/model', '', {
    session: 's1', provider: 'p', model: 'm',
  })
  ok('an unexpected failure becomes a 500, not a crash', res.status === 500, `status ${res.status}`)
}

group('routing and the asset')

{
  const { control } = makeHarness()
  const other = await call(control, 'GET', '/api/sessions')
  ok('an unrelated route is not claimed', other.owned === false)

  const wrongMethod = await call(control, 'DELETE', '/api/model')
  ok('an unsupported method is a 405', wrongMethod.status === 405, `status ${wrongMethod.status}`)

  const asset = await call(control, 'GET', '/model-ui.js')
  ok('the picker is served', asset.status === 200, `status ${asset.status}`)
  ok('it is typed as JavaScript', String(asset.headers['content-type']).startsWith('text/javascript'))
  let parseError = null
  try {
    new vm.Script(asset.body)
  } catch (error) {
    parseError = error
  }
  ok('the picker script parses as JavaScript', parseError === null, String(parseError))
  ok('the picker calls the model API', asset.body.includes('api/model'))

  // The shipping DeepSeek adapters declare exactly off/low/high/max. An unlabelled
  // id is not fatal — it falls back to the raw string — but it reads as a bug on a
  // phone, so the four that actually occur are pinned here.
  const labels = /var EFFORT_LABELS = \{([\s\S]*?)\}/u.exec(asset.body)?.[1] ?? ''
  ok('effort labels cover the ids the shipping adapters declare',
    ['off', 'low', 'high', 'max'].every((id) => labels.includes(id + ':')),
    labels.slice(0, 140))
}

group('a host with no LLM registry')

{
  const { control } = makeHarness({ llm: undefined })
  const res = await call(control, 'GET', '/api/model', 'session=s1')
  ok('the catalogue degrades to empty rather than throwing', res.status === 200, `status ${res.status}`)
  ok('it reports no groups', Array.isArray(res.json?.groups) && res.json.groups.length === 0)
}

group('where the selection is installed')

{
  // This one cost a real session. Installing from inside `setup` looks natural —
  // that is where the preset is mounted — but the only way to name the agent
  // there is `agentCtx.agent`, and a scoped context exposes only what it declared
  // it needs, so that read throws `cannot get property "agent" without inject`.
  // The throw escaped `setup`, which failed the whole acquisition; the bridge then
  // fell through to `create`, which answered "session already exists" — a message
  // about the store, for a bug in a listener.
  const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // Assert against the code, not the prose: the comment explaining this bug has
  // to be able to name the very expression it warns against.
  const code = wire.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  ok('the guarded read is gone', !code.includes('agentCtx.agent'),
    'agentCtx.agent is back in the code; the scoped context cannot name its agent')
  ok('nothing installs from inside setup', !code.includes('installSelection(agentCtx)'))
  ok('the installer gets the documented context',
    code.includes('installModelSelection(agent.ctx, selectionFor(sessionId))'))
  ok('and the agent is handed over after it exists',
    code.includes('installSelection(handle.agent)'))
  ok('a failure to install cannot fail the acquisition',
    code.includes('could not install the model selection for'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
