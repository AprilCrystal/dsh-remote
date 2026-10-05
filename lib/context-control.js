/**
 * Context occupancy and compaction from the phone.
 *
 * Two harness services back this, and neither is imported — they are reached
 * through `ctx`, like every other service this package uses, so a harness
 * change cannot break the bridge at import time:
 *
 *   - `ctx.sessionProjections.snapshot(session, keys)` is what feeds the
 *     desktop's ring: the `contextPressure` projection carries the provider's
 *     own occupancy sample plus the routed route's capacity, and
 *     `contextBreakdown` the heuristic split into system prompt, tool schemas,
 *     and conversation. The panel renders exactly those, so the phone and the
 *     desktop can never disagree about how full a context is.
 *
 *   - `ctx.compaction.compactNow(agent, signal)` is the same call the desktop's
 *     `/compact` command makes. It claims the agent's idle phase itself and
 *     throws `ManualCompactionError` with a stable `code`, which is what lets
 *     this module say "this conversation is mid-turn" instead of "error".
 *
 * Both depend on an ATTACHED session, and that is the one interesting fact about
 * reading a meter here: there is no cold read. `snapshot()` takes a `Session`
 * object, and `ctx.sessions.get(id)` only returns attached ones. So a
 * conversation the process is not holding has no numbers until something
 * attaches it — which is why this module distinguishes "cold" from "empty" and
 * lets the caller decide whether to attach (the loader lives in `index.js`,
 * where `ensureAgent` is, so a panel-driven attach still runs the bridge's
 * `setup` and keeps the session model-manageable).
 *
 * @module dsh-openai-bridge/context-control
 */

import { readFileSync } from 'node:fs'
import { readJsonBody, sendJson } from './http-util.js'

/**
 * Shape one `sessionProjections.snapshot()` value pair into what the panel
 * renders, or `null` when there is nothing to show yet.
 *
 * The two projections are deliberately independent last-wins slots: the
 * provider's usage sample supplies the numerator and the newest
 * `request/context` record the denominator, and they are explicitly not one
 * atomic observation of a request. `projectedTokens` is the part that makes the
 * figure useful — the sample plus the surface's signed movement since it was
 * taken — so occupancy answers for the NEXT request rather than the last one.
 * A brand-new session has neither field, which is why a missing pair is a
 * `null` rather than a zero: "0% of 1M" would be a lie about an unmeasured
 * context.
 *
 * @param values - `snapshot(session, ['contextPressure', 'contextBreakdown']).values`.
 * @returns the occupancy, or `null` when the numerator or capacity is unknown.
 */
export function contextOccupancy(values) {
  const pressure = values?.contextPressure ?? {}
  const usedTokens = pressure.projectedTokens ?? pressure.pressureTokens
  const contextWindow = pressure.contextWindow
  if (usedTokens === undefined || contextWindow === undefined) return null
  const breakdown = values?.contextBreakdown
  return {
    percent: Math.min(100, Math.round(usedTokens / contextWindow * 100)),
    usedTokens,
    contextWindow,
    breakdown: breakdown === undefined ? null : {
      systemTokens: breakdown.systemTokens,
      toolsTokens: breakdown.toolsTokens,
      messageTokens: breakdown.messageTokens,
    },
  }
}

/**
 * Choose the compaction service for one conversation.
 *
 * `compaction-basic` appears twice in a default composition: the base bundle
 * inserts it as a host-plane row, and each shipped agent preset mounts its own
 * instance inside an isolated realm. The realm instance is the one that preset's
 * own `/compact` would use, so it wins. The host row is the fallback, because a
 * realm lookup finding nothing must not become a dead button.
 *
 * @param scoped - `agent.ctx.get('compaction')`, the agent's own realm.
 * @param host - `ctx.get('compaction')` from the plugin's context.
 * @returns whichever actually implements `compactNow`, or `undefined`.
 */
export function pickCompaction(scoped, host) {
  if (scoped !== undefined && typeof scoped.compactNow === 'function') return scoped
  if (host !== undefined && typeof host.compactNow === 'function') return host
  return undefined
}

/**
 * Expected manual-compaction failures, keyed by `ManualCompactionError.code`.
 * The wording mirrors the desktop's `/compact` command, because two surfaces
 * reporting the same failure differently is how a reader concludes the phone is
 * broken.
 */
export const COMPACTION_MESSAGES = {
  busy: '这段会话正在回复（或者进程里有别的压缩在跑），等它结束再试。',
  cancelled: '压缩已取消。',
  changed: '要压缩的那段历史在压缩前变了，会话没有被改动。',
  summary: '没能生成有用的摘要，会话没有被改动。',
  commit: '压缩没有干净地结束，部分历史可能已经变了 —— 先在电脑上确认会话状态再重试。',
  persistence: '压缩完成了，但会话没能保存。',
}

/**
 * Fold a `compactNow` rejection into an HTTP outcome.
 * @param error - the rejection, expected to carry a `code` for known failures.
 * @returns the sentence to show and the status to answer with. Anything without
 *   a recognised code keeps its own message: an unexpected failure is a bug, and
 *   disguising it as one of the known ones would hide that.
 */
export function compactionFailure(error) {
  const code = error?.code
  if (typeof code === 'string' && Object.hasOwn(COMPACTION_MESSAGES, code)) {
    // `busy` is the one failure the reader can fix by waiting, so it is the one
    // that gets a status distinguishing it from "this went wrong".
    return { message: COMPACTION_MESSAGES[code], status: code === 'busy' ? 409 : 500 }
  }
  return { message: String(error?.message ?? error), status: 500 }
}

/**
 * Describe a completed manual compaction.
 * @param result - the `CompactionResult`, or `null` when no safe range existed.
 * @returns the payload the panel reports as its success message.
 */
export function compactionSummary(result) {
  if (result === null || result === undefined) {
    return { compacted: false, message: '没有可以安全压缩的历史。' }
  }
  return {
    compacted: true,
    shadowed: result.shadowedSeqs.length,
    shadowedTokens: result.shadowedTokenCount,
    message: `已把 ${result.shadowedSeqs.length} 条历史压缩成一段摘要（约 ${result.shadowedTokenCount} tokens）。`,
  }
}

/**
 * @param ctx - host plugin context.
 * @param options.contextState - `(sessionId, fresh, load) => Promise<state>`, where
 *   `load` asks for a cold session to be attached so it can be read.
 * @param options.compactSession - `(sessionId) => Promise<result>`, throws with
 *   `.status` on refusal.
 * @returns `{ handle }`, where `handle` answers the routes below and returns
 *   `false` for anything else so the panel's 404 stays the single fallthrough.
 *
 *   GET  /context-ui.js   the panel-side meter (served verbatim from disk)
 *   GET  /api/context     this session's occupancy, breakdown, and compactability
 *   POST /api/context     `{ session, action: 'compact' }`
 */
export function createContextControl(ctx, options) {
  const { contextState, compactSession } = options

  let uiScript = null
  const panelScript = () => {
    if (uiScript === null) uiScript = readFileSync(new URL('./context-ui.js', import.meta.url), 'utf8')
    return uiScript
  }

  const handle = async (req, res, url, rest) => {
    try {
      if (rest === '/context-ui.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(panelScript())
        return true
      }

      if (rest !== '/api/context') return false

      if (req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const fresh = url.searchParams.get('fresh') === '1'
        // Attaching is a side effect, so it is never implicit: the page's first
        // read is cold-only, and the sheet asks for `load=1` when the reader has
        // actually asked to see the numbers.
        const load = url.searchParams.get('load') === '1'
        sendJson(res, 200, await contextState(sessionId, fresh, load))
        return true
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'GET or POST required' })
        return true
      }

      const body = await readJsonBody(req)
      const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
      const action = typeof body?.action === 'string' ? body.action : ''
      if (sessionId === '') throw Object.assign(new Error('session is required'), { status: 400 })
      if (action !== 'compact') {
        throw Object.assign(new Error(`unknown context action "${action}"`), { status: 400 })
      }

      const result = await compactSession(sessionId)
      // The meter is re-read in the same reply: the point of compacting is to
      // watch the number move, and a second round trip can race the write.
      sendJson(res, 200, { ok: true, ...result, state: await contextState(sessionId, false, true) })
      return true
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      ctx.logger.warn(`openai-bridge: context control ${rest} failed: ${String(error)}`)
      if (res.headersSent) { res.destroy(); return true }
      sendJson(res, status, { error: String(error?.message ?? error) })
      return true
    }
  }

  return { handle }
}
