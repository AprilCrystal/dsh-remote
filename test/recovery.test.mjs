/**
 * Tests for recovering a conversation's agent.
 *
 * Both properties here come from the same incident: a phone asked for one cold
 * conversation and was answered `session "..." already exists`. That message is
 * true and useless — it describes the store, not the thing that went wrong — and
 * two separate defects can produce it:
 *
 *  1. Two paths ask for the same cold session at the same moment. Both see "not
 *     live", both reach `create`, and the loser is told the id is taken. The
 *     harness's own session controller keeps a per-id in-flight map for exactly
 *     this; the bridge had none.
 *
 *  2. A resume fails for a real reason, the fallthrough swallows it, and `create`
 *     then reports the id as taken — naming the symptom and hiding the cause.
 */

import { readFileSync } from 'node:fs'
import { oncePerKey, sessionRecoveryFailure } from '../lib/index.js'

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

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/* ── tests ────────────────────────────────────────────────────────────────── */

group('one acquisition per key at a time')

{
  const pending = new Map()
  let runs = 0
  const operation = async () => {
    runs += 1
    await tick()
    return { agent: 'a1' }
  }
  const first = oncePerKey(pending, 's1', operation)
  const second = oncePerKey(pending, 's1', operation)
  const [a, b] = await Promise.all([first, second])
  ok('the operation ran once for two concurrent callers', runs === 1, String(runs))
  ok('both callers receive the same result', a === b && a.agent === 'a1')
  ok('the two calls are the same promise, not two that agree', first === second)
}

{
  const pending = new Map()
  let runs = 0
  const operation = async () => { runs += 1; return runs }
  await oncePerKey(pending, 's1', operation)
  await oncePerKey(pending, 's1', operation)
  ok('a settled key is freed and runs again', runs === 2, String(runs))
  ok('and the map is empty afterwards', pending.size === 0, String(pending.size))
}

{
  const pending = new Map()
  let runs = 0
  const operation = async () => { runs += 1; await tick(); throw new Error('resume failed') }
  const first = oncePerKey(pending, 's1', operation)
  const second = oncePerKey(pending, 's1', operation)
  const results = await Promise.allSettled([first, second])
  ok('a failure runs the operation once, not twice', runs === 1, String(runs))
  ok('both callers see it rejected', results.every((r) => r.status === 'rejected'))
  ok('with the same reason', results[0].reason === results[1].reason)
  ok('a failed key is freed too', pending.size === 0, String(pending.size))
  const retry = await oncePerKey(pending, 's1', async () => 'ok')
  ok('so a later caller can try again', retry === 'ok')
}

{
  const pending = new Map()
  const operation = () => { throw new Error('synchronous explosion') }
  let escaped = false
  let rejection
  try {
    rejection = await oncePerKey(pending, 's1', operation)
  } catch (error) {
    escaped = true
    rejection = error
  }
  ok('a synchronous throw becomes a rejection rather than escaping', escaped === true)
  ok('and keeps its message', String(rejection.message) === 'synchronous explosion')
  ok('and frees the key', pending.size === 0)
}

{
  const pending = new Map()
  const started = []
  const operationFor = (id) => async () => { started.push(id); await tick(); return id }
  const [a, b] = await Promise.all([
    oncePerKey(pending, 'a', operationFor('a')),
    oncePerKey(pending, 'b', operationFor('b')),
  ])
  ok('different keys do not serialise against each other', a === 'a' && b === 'b')
  ok('both ran', started.length === 2, JSON.stringify(started))
}

{
  // The property that makes the map worth having: the operation cannot observe a
  // missing key, so a reentrant acquisition joins the same work instead of
  // starting a second one.
  const pending = new Map()
  let runs = 0
  let reentrant
  const outer = oncePerKey(pending, 's1', async () => {
    runs += 1
    reentrant = oncePerKey(pending, 's1', async () => { runs += 100; return 'inner' })
    return 'outer'
  })
  const value = await outer
  ok('the operation runs after the key is recorded', value === 'outer')
  ok('a reentrant call joins the in-flight work', runs === 1, String(runs))
  ok('and is handed the very same promise', reentrant === outer)
}

group('explaining a create that lost to a resume')

{
  ok('no resume attempt means no special case',
    sessionRecoveryFailure('s1', undefined, new Error('session "s1" already exists')) === null)
  ok('a create failure for another reason is left alone',
    sessionRecoveryFailure('s1', new Error('boom'), new Error('disk full')) === null)
  ok('a create success would never ask', sessionRecoveryFailure('s1', new Error('boom'), undefined) === null)
}

{
  const detail = sessionRecoveryFailure(
    'session-5619c146-2a84-4f0d-92b8-5e275eeece14',
    new Error('preset "standard" is not resolvable'),
    new Error('session "session-5619c146-2a84-4f0d-92b8-5e275eeece14" already exists'),
  )
  ok('the case is recognised', typeof detail === 'string' && detail.length > 0)
  ok('the session is named', detail.includes('session-5619c146-2a84-4f0d-92b8-5e275eeece14'))
  ok('the real cause is the headline', detail.includes('preset "standard" is not resolvable'))
  ok('and the misleading store error is not the message', !detail.includes('already exists'))
}

{
  // The two wordings the harness can produce: the sessions facade and the
  // persistence backend. Both must be recognised, from either shape of error.
  const facade = 'session "s1" already exists'
  const backend = 'session "s1" already exists'
  ok('the sessions facade wording is recognised',
    sessionRecoveryFailure('s1', new Error('x'), new Error(facade)) !== null)
  ok('the persistence wording is recognised',
    sessionRecoveryFailure('s1', new Error('x'), new Error(backend)) !== null)
  ok('a string rejection is handled too',
    sessionRecoveryFailure('s1', new Error('x'), facade) !== null)
}

{
  const detail = sessionRecoveryFailure('s1', 'a bare string reason', 'session "s1" already exists')
  ok('a non-Error resume failure still reaches the message',
    detail.includes('a bare string reason'), detail)
}

group('the wiring that makes this reachable')

{
  const wire = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the resume failure is captured instead of discarded', wire.includes('resumeFailure = error'))
  ok('the old silent catch is gone',
    !wire.includes('unresumable: fall through to a fresh create.'))
  ok('the create fallback consults it', wire.includes('sessionRecoveryFailure(sessionId, resumeFailure, error)'))
  ok('every caller acquires through the in-flight map',
    wire.includes('const ensureAgent = (sessionId) => oncePerKey(acquisitions, sessionId, () => openAgent(sessionId))'))
  const calls = (wire.match(/await acquireAgent\(ctx,/gu) ?? []).length
  ok('and there is exactly one place that bypasses the cache', calls === 1, String(calls))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
