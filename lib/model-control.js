/**
 * Per-session model and reasoning-effort switching from the phone.
 *
 * The harness couples a mutable `ModelSelectionRef` (`{ current, assembled }`) to
 * two waterfalls so that prompt assembly and request routing cannot disagree
 * within one step. `@deepseek-ai/dsh-agent` exports `installModelSelection` for
 * exactly that, but this package never imports harness packages: it reaches
 * every service through `ctx`, so a change to the harness cannot break it at
 * import time. The installer therefore lives in `index.js`, where the agents are
 * created, and this module is reduced to HTTP and catalog shaping.
 *
 * The catalog mirrors `dsh-api-session-controller`'s `buildModelCatalog`: real
 * provider groups from the live LLM registry, with per-provider failures
 * isolated rather than failing the whole listing.
 *
 * @module dsh-openai-bridge/model-control
 */

import { readFileSync } from 'node:fs'
import { readJsonBody, sendJson } from './http-util.js'

/** Placeholder catalogue shape used when the host exposes no LLM registry. */
const EMPTY_CATALOG = { routableProviders: [], groups: [], failures: [] }

/**
 * @param ctx - host plugin context.
 * @param options.basePath - panel prefix, used to build the popup-free asset path.
 * @param options.selectionState - `(sessionId, fresh) => { current, default, live, manageable }`.
 * @param options.applySelection - `(sessionId, selection) => Promise<{ current }>`, throws with `.status` on refusal.
 * @returns `{ handle }`, where `handle` answers the routes below and returns
 *   `false` for anything else so the panel's 404 stays the single fallthrough.
 *
 *   GET  /model-ui.js     the panel-side picker (served verbatim from disk)
 *   GET  /api/model       catalogue + this session's current selection
 *   POST /api/model       apply a selection to one session
 */
export function createModelControl(ctx, options) {
  const { selectionState, applySelection } = options

  let uiScript = null
  const panelScript = () => {
    if (uiScript === null) uiScript = readFileSync(new URL('./model-ui.js', import.meta.url), 'utf8')
    return uiScript
  }

  const llm = () => ctx.get('llm')

  /** Build provider groups, isolating a provider that cannot enumerate. */
  const buildCatalog = async () => {
    const service = llm()
    if (service === undefined || typeof service.listProviders !== 'function') return EMPTY_CATALOG
    const providers = service.listProviders()
    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        const models = await service.listModels(provider.id)
        const entries = await Promise.all(models.map(async (model) => {
          const info = await service.resolveModelInfo(provider.id, model.id)
          const reasoning = info?.reasoning === undefined
            ? undefined
            : {
              efforts: (info.reasoning.efforts ?? []).map((effort) => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(info.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: info.reasoning.defaultEffort }),
            }
          return {
            id: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
            ...(reasoning === undefined ? {} : { reasoning }),
          }
        }))
        return { kind: 'group', group: { id: provider.id, name: provider.name, models: entries } }
      } catch (error) {
        // One misconfigured provider must not blank the whole picker — the
        // harness's own catalog behaves the same way.
        return {
          kind: 'failure',
          failure: {
            id: provider.id,
            name: provider.name,
            message: String(error?.message ?? error),
          },
        }
      }
    }))
    return {
      routableProviders: providers.map((provider) => provider.id),
      groups: settled.flatMap((item) => (item.kind === 'group' ? [item.group] : []))
        .filter((group) => group.models.length > 0),
      failures: settled.flatMap((item) => (item.kind === 'failure' ? [item.failure] : [])),
    }
  }

  const handle = async (req, res, url, rest) => {
    try {
      if (rest === '/model-ui.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(panelScript())
        return true
      }

      if (rest !== '/api/model') return false

      if (req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const fresh = url.searchParams.get('fresh') === '1'
        const [catalog, state] = await Promise.all([
          buildCatalog(),
          Promise.resolve(selectionState(sessionId, fresh)),
        ])
        sendJson(res, 200, { ...catalog, ...state })
        return true
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'GET or POST required' })
        return true
      }

      const body = await readJsonBody(req)
      const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
      const provider = typeof body?.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body?.model === 'string' ? body.model.trim() : ''
      const reasoningEffort = typeof body?.reasoningEffort === 'string' && body.reasoningEffort !== ''
        ? body.reasoningEffort
        : undefined
      if (sessionId === '') throw Object.assign(new Error('session is required'), { status: 400 })
      if (provider === '' || model === '') {
        throw Object.assign(new Error('provider and model are required'), { status: 400 })
      }

      const result = await applySelection(sessionId, {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      sendJson(res, 200, { ok: true, ...result })
      return true
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      ctx.logger.warn(`openai-bridge: model control ${rest} failed: ${String(error)}`)
      if (res.headersSent) { res.destroy(); return true }
      sendJson(res, status, { error: String(error?.message ?? error) })
      return true
    }
  }

  return { handle }
}
