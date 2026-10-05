/**
 * dsh-openai-bridge — an OpenAI-compatible HTTP face for the DeepSeek Harness.
 *
 * Purpose: let a phone running the Chatbox app (Settings → Model Provider →
 * Add Custom Provider → "OpenAI API Compatible") drive a DSH session.
 *
 * Design decisions, and why:
 *
 *  - The route mounts on the EXISTING webserver, so it inherits that server's
 *    bind. Loopback-only until a deployment deliberately patches the webserver
 *    row to `0.0.0.0`; this plugin never widens the bind itself.
 *
 *  - Authentication is unconditional and fails closed. An empty configured
 *    token disables the bridge entirely rather than serving unauthenticated.
 *
 *  - Every session this bridge drives is pinned to a `read-only` permission
 *    preset (`sandbox: read-only` + `approval: ask` in the shipped base
 *    bundle). A write attempt is therefore refused by the sandbox and turns
 *    into an approval request, which lands in the local desktop GUI — a plain
 *    OpenAI chat client has no way to answer one. Route integrity is enforced
 *    by the sandbox; confidentiality is NOT (read-only also permits reads,
 *    process execution and network egress), so the token is the only secret
 *    standing between the LAN and this machine's data.
 *
 *  - Import failures and setup failures are caught and degrade to "bridge
 *    disabled". A plugin that throws during load can take the whole
 *    composition down with it, which would lock the operator out of the GUI
 *    they need in order to remove it.
 *
 * @module dsh-openai-bridge
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { escapeHtml, installPanel } from './panel.js'
import { installSetup, readTokenFile, resolveHomeFile } from './setup.js'
import { CLIENTS_FILE_NAME, createClientGate } from './client-gate.js'
import {
  compactionFailure,
  compactionSummary,
  contextOccupancy,
  pickCompaction,
} from './context-control.js'

/** Stable Cordis plugin name. */
export const name = 'openai-bridge'

/**
 * Services required before the routes can mount. Deliberately conservative:
 * `sessionQuery` and `workspaceRegistry` are optional and read with `ctx.get`
 * so their absence degrades instead of blocking activation.
 */
export const inject = ['webServer', 'agents', 'sessions', 'agentDefaultModel', 'permissionPresets']

/** Route prefix serving the OpenAI-shaped surface. */
const BASE_PATH = '/v1'

/** Advertised model id; Chatbox requires at least one entry to select. */
const ADVERTISED_MODEL = 'dsh-agent'

/** Reply to an unauthenticated request without confirming the route exists. */
function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'www-authenticate': 'Bearer' })
  res.end('unauthorized\n')
}

/** Constant-time Bearer check against the configured token. */
function authorized(req, token) {
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
  if (match === null) return false
  const offered = Buffer.from(match[1], 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return offered.byteLength === expected.byteLength && timingSafeEqual(offered, expected)
}

/** Read and JSON-parse a bounded request body. */
async function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** Flatten an OpenAI message `content`, which may be a string or content parts. */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
}

/**
 * Derive a stable DSH session id from the conversation's first user message.
 *
 * OpenAI's wire protocol is stateless — the client resends the whole history on
 * every turn — so the conversation's identity has to be inferred. The first
 * user message is stable across a conversation's turns and distinct between
 * conversations, which makes it a usable key. The hash is formatted as a UUID
 * so the resulting id matches the shape DSH already uses for session ids.
 */
function sessionIdFor(messages) {
  const first = messages.find((message) => message !== null && typeof message === 'object' && message.role === 'user')
  const seed = first === undefined ? '' : contentText(first.content)
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex')
  return `session-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}`
    + `-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

/** How long an advertised model list is reused before the sessions are re-read. */
const MODELS_CACHE_MS = 5000

/** How many sessions `/v1/models` advertises before truncating the tail. */
const MODEL_LIST_LIMIT = 40

/** Matches the DSH session id embedded in an advertised model id. */
const SESSION_IN_MODEL = /(session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u

/**
 * Recover a DSH session id from a model id the client sent back.
 *
 * OpenAI's model object has no display-name field, so the picker a client shows
 * IS the id. Advertised ids are therefore built as `<title> · <sessionId>` to
 * stay readable in Chatbox. Only the trailing session id is authoritative, and
 * because the whole string round-trips, a client that truncates it for display
 * cannot break routing.
 */
function sessionIdFromModel(model) {
  if (typeof model !== 'string') return undefined
  const match = SESSION_IN_MODEL.exec(model)
  return match === null ? undefined : match[1]
}

/** The newest user message, which is the only turn the harness has not already seen. */
function lastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== null && typeof message === 'object' && message.role === 'user') {
      return contentText(message.content)
    }
  }
  return ''
}

/** Prior turns, rendered as plain text, for the cold-start case where DSH has no log yet. */
function transcriptPreamble(messages) {
  const turns = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const text = contentText(message.content)
    if (text === '') continue
    if (message.role === 'user' || message.role === 'assistant') {
      turns.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`)
    }
  }
  // The final entry is the newest user message, which is sent on its own.
  return turns.slice(0, -1).join('\n\n')
}

/** One OpenAI streaming chunk. */
function chunkFrame(id, created, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** Write one SSE event. */
function writeEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Couple one mutable model selection to an agent's prompt assembly and request
 * routing.
 *
 * This mirrors `installModelSelection` from `@deepseek-ai/dsh-agent` rather than
 * importing it. The bridge reaches harness services only through `ctx`, so a
 * harness package changing shape cannot break it at import time — and an import
 * that failed inside `setup` would take agent creation down with it, a far worse
 * failure than a stale model. The contract being mirrored is small and stable:
 * prompt assembly snapshots the selection BEFORE delegating, and request routing
 * applies that snapshot, so a switch that lands mid-step takes effect on the
 * next step instead of splitting the two surfaces.
 *
 * @param agentCtx - the selected agent's scoped context (`agent.ctx`; NOT the
 *   context `setup` receives, which cannot name its own agent).
 * @param selection - mutable `{ current, assembled }` owned by the caller.
 * @returns disposer for both scoped listeners.
 */
function installModelSelection(agentCtx, selection) {
  const stopAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const stopRequest = agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    // An absent effort clears any inherited one, which restores the selected
    // model's adapter default rather than leaking the previous model's effort.
    const { reasoningEffort: _inherited, ...rest } = resolved
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    }
  })
  return () => {
    stopAssembly()
    stopRequest()
  }
}

/**
 * Run one operation per key at a time, sharing the in-flight promise with every
 * concurrent caller.
 *
 * This exists for one failure. `acquireAgent` decides between `resume` and
 * `create` by looking at whether the session is live, so two callers asking for
 * the same COLD session in the same moment both see "not live", both reach
 * `create`, and the loser is answered with `session "..." already exists` — an
 * error about the store that says nothing about the concurrency that produced
 * it. Three paths can ask at once (a turn, the model picker, and the context
 * meter), and only the turn is serialized. The harness's own session controller
 * keeps the same map for the same reason.
 *
 * @param pending - caller-owned `Map` recording in-flight work per key.
 * @param key - the identity being acquired.
 * @param operation - started only when nothing is in flight for `key`.
 * @returns the shared result; a rejection is shared too, and frees the key.
 */
export function oncePerKey(pending, key, operation) {
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return inFlight
  // Deferred by one microtask so the map is already set before the operation can
  // run: an operation that throws synchronously must still leave a promise here.
  const started = Promise.resolve().then(operation).finally(() => { pending.delete(key) })
  pending.set(key, started)
  return started
}

/**
 * Explain a create that failed after a resume already had.
 *
 * `agents.create` rejects with `session "<id>" already exists` when the identity
 * is on disk, which is exactly the case where the resume failure — the thing that
 * actually went wrong — was swallowed by the fallthrough. Returns `null` whenever
 * the fallback was legitimate, so the caller can rethrow the original error.
 *
 * @param sessionId - the conversation identity.
 * @param resumeError - why the resume attempt failed, or `undefined` if none ran.
 * @param createError - the rejection from `agents.create`.
 * @returns a message naming both failures, or `null` when this is not that case.
 */
export function sessionRecoveryFailure(sessionId, resumeError, createError) {
  if (resumeError === undefined) return null
  const message = String(createError?.message ?? createError)
  if (!message.includes('already exists')) return null
  return `会话 ${sessionId} 在磁盘上存在，但无法恢复到内存里，新建又因为同名被拒绝。`
    + `真正的原因是恢复失败：${String(resumeError?.message ?? resumeError)}`
}

/**
 * Where a fork may cut one conversation's log.
 *
 * Only a COMPLETED TURN is a safe cut: seeding a child with half an exchange gives
 * it a request with no reply, or a tool call with no result. This mirrors the
 * harness session controller's rule, including the second half of it — the cut
 * lands on the next `turn/start`, so anything logged after the last `turn/end`
 * (seed markers, a title, a delivery notification) stays with the source instead
 * of trailing the child.
 *
 * Pure and exported because the cut is the part of a fork that is easy to get
 * subtly wrong and impossible to notice in a smoke test: a child seeded one event
 * short still looks like a conversation.
 *
 * @param events - the source session's events, in log order.
 * @returns the boundary's seq and the exclusive slice index.
 * @throws an Error carrying `.status` when there is nothing safe to cut.
 */
export function planForkCut(events) {
  const boundary = events.findLast((event) => event?.type === 'turn/end')
  if (boundary === undefined) {
    throw Object.assign(new Error('这段会话还没有跑完过一轮，没有可以分支的位置。'), { status: 409 })
  }
  // Clamped: a `turn/end` can carry a seq HIGHER than its array position, because
  // a compaction replacement lands a fresh high-seq node at an older position. The
  // controller documents that, and an exclusive index past the end would make this
  // function's contract a lie even though `slice` would quietly forgive it.
  let cut = Math.min(boundary.seq + 1, events.length)
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut += 1
  return { boundarySeq: boundary.seq, cut }
}

/**
 * Decide what one queue action means, without touching an inbox.
 *
 * Pure and exported so the whole decision surface is testable: the real
 * `queueAction` needs `@deepseek-ai/dsh-llm` to build a message, and that import
 * only resolves inside a running DSH, so anything left inside it is untestable
 * from a plain process. Keeping the refusals and the target default here means
 * they are covered by tests rather than by inspection.
 *
 * @param action - `insert | edit | drop | send`.
 * @param payload - `text` for insert/edit, `id` for edit/drop/send, `target` for insert.
 * @param locate - `(id) => { target, message } | undefined` for the existing queue.
 * @returns the plan the caller should carry out.
 * @throws an Error carrying `.status` for every expected refusal.
 */
export function planQueueAction(action, payload, locate) {
  if (action === 'insert') {
    const text = String(payload?.text ?? '').trim()
    if (text === '') throw Object.assign(new Error('要插入的内容是空的。'), { status: 400 })
    // Default to the polite boundary: waiting a turn is what "insert" most often
    // means, and steering a running turn is the deliberate choice.
    return { kind: 'insert', target: payload?.target === 'next-step' ? 'next-step' : 'next-turn', text }
  }
  const id = String(payload?.id ?? '')
  const found = locate(id)
  if (found === undefined) {
    throw Object.assign(new Error('这条排队消息已经不在了。'), { status: 404 })
  }
  if (action === 'edit') {
    const text = String(payload?.text ?? '').trim()
    if (text === '') throw Object.assign(new Error('内容不能是空的。'), { status: 400 })
    return { kind: 'edit', id, target: found.target, text }
  }
  if (action === 'drop') return { kind: 'drop', id, target: found.target }
  if (action === 'send') return { kind: 'send', id, target: found.target }
  throw Object.assign(new Error(`unknown queue action "${action}"`), { status: 400 })
}

/**
 * Resolve an agent for one conversation, composing the preset the way
 * `dsh-api-session-controller` does: resolve the preset id first, then mount it
 * from inside `setup`, and record `meta.agentPreset` so a later resume rebuilds
 * the same composition.
 */
async function acquireAgent(ctx, options) {
  const { sessionId, cwd, presetId, agentOptions } = options
  const agents = ctx.get('agents')

  const live = agents.get(sessionId)
  if (live !== undefined) return { agent: live, created: false }

  const presets = ctx.get('agentPresets')
  const installSelection = options.installSelection
  const compose = async () => {
    const resolved = presets === undefined ? undefined : await presets.resolve(presetId)
    return {
      agentPreset: resolved?.id,
      setup: async (agentCtx) => {
        if (resolved !== undefined) await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  /**
   * Hand a freshly resolved agent to the selection installer.
   *
   * AFTER the call that composed the preset, so the operator's model choice is
   * the last word on routing rather than something a preset can overwrite — and
   * deliberately not from inside `setup`, where the only way to name the agent is
   * `agentCtx.agent`, which throws `cannot get property "agent" without inject`
   * because a scoped context exposes only what it declared it needs. That throw
   * used to escape `setup` and fail the whole acquisition.
   *
   * It is caught here rather than left to escape, because losing the model picker
   * for one conversation is a far smaller failure than being unable to open that
   * conversation at all. `selectionState` already reports the consequence:
   * `manageable: false`, with a note saying to switch on the desktop instead.
   */
  const adopt = (handle, created) => {
    if (installSelection !== undefined) {
      try {
        installSelection(handle.agent)
      } catch (error) {
        ctx.logger.warn(`openai-bridge: could not install the model selection for ${sessionId}: ${String(error)}`)
      }
    }
    return { agent: handle.agent, created }
  }

  // A persisted session for this conversation resumes; a fresh one is created.
  // `sessionQuery` is the canonical existence probe but is optional here, so its
  // absence falls through to attempting the resume and handling the rejection.
  let persisted = false
  const query = ctx.get('sessionQuery')
  if (query !== undefined && typeof query.observeSession === 'function') {
    try {
      const observation = await query.observeSession(sessionId)
      persisted = observation?.header?.id === sessionId
      observation?.[Symbol.dispose]?.()
    } catch {
      persisted = false
    }
  } else {
    persisted = true
  }

  // Why a resume attempt failed, when one was made. Kept so the create fallback
  // below can tell "not actually persisted" apart from "on disk but unresumable".
  let resumeFailure

  if (persisted) {
    try {
      const composition = await compose()
      const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: composition.setup })
      return adopt(handle, false)
    } catch (error) {
      // Not actually persisted, or unresumable: fall through to a fresh create —
      // but remember why, because those two cases read very differently below.
      resumeFailure = error
    }
  }

  const composition = await compose()
  let handle
  try {
    handle = await agents.create({
      sessionId,
      agentOptions,
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: composition.setup,
    })
  } catch (error) {
    // `create` answering "already exists" means the session IS on disk, so the
    // resume above is the real failure and this message names the symptom while
    // hiding the cause. Report both rather than the misleading one.
    const detail = sessionRecoveryFailure(sessionId, resumeFailure, error)
    if (detail !== null) throw new Error(detail)
    throw error
  }

  // Register the session under its workspace. Without this the session exists
  // but the desktop GUI's sidebar never groups it, so an approval raised for a
  // phone-driven write would have no session to surface in — the operator could
  // not answer it. Best-effort: a workspace failure must not fail the turn.
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && typeof registry.create === 'function') {
    try {
      const workspace = await registry.create(cwd)
      await workspace.attachSession(sessionId)
    } catch (error) {
      ctx.logger.warn(`openai-bridge: could not attach ${sessionId} to workspace ${cwd}: ${String(error)}`)
    }
  }

  return adopt(handle, true)
}

/**
 * Mount the OpenAI-compatible surface.
 * @param ctx - host plugin context carrying the webserver and agent services.
 * @param config - validated bridge config.
 */
export function apply(ctx, config) {
  const panelPath = typeof config?.panelPath === 'string' && config.panelPath.startsWith('/')
    ? config.panelPath
    : '/bridge'
  const setupPath = typeof config?.setupPath === 'string' && config.setupPath.startsWith('/')
    ? config.setupPath
    : '/setup'

  // Two ways to supply the token. An explicitly configured one always wins; the
  // file under `$DSH_HOME` is the fallback that makes a one-click setup page
  // possible at all, because a plugin cannot know which profile it belongs to and
  // therefore must not go editing a `cordis.patch.yml` it had to guess at.
  const configuredToken = typeof config?.token === 'string' ? config.token.trim() : ''
  const fileToken = configuredToken === '' ? readTokenFile(ctx) : ''
  const token = configuredToken !== '' ? configuredToken : fileToken
  const tokenSource = configuredToken !== '' ? 'config' : (fileToken !== '' ? 'file' : 'none')

  if (token === '') {
    // Nothing but the loopback-only setup page mounts. Keeping everything else
    // unmounted is what makes "no token" mean "not installed here" rather than
    // "installed but locked" — and it is why an unconfigured plugin still cannot
    // touch the approval flow.
    ctx.logger.info(`openai-bridge: no token (config empty, no token file); mounting only the loopback setup page at ${setupPath}`)
    try {
      installSetup(ctx, { setupPath, panelPath, tokenSource, token: '' })
    } catch (error) {
      ctx.logger.warn(`openai-bridge: setup page failed to mount: ${String(error)}`)
    }
    return
  }

  const cwd = typeof config?.cwd === 'string' && config.cwd !== '' ? config.cwd : process.cwd()
  const permissionPreset = typeof config?.permissionPreset === 'string' ? config.permissionPreset : 'read-only'
  const agentPreset = typeof config?.agentPreset === 'string' ? config.agentPreset : 'standard'
  // The panel's browse roots. Defaults to the workspace the bridge drives. A
  // string is one root; a list is several; the literal `'*'` is every fixed
  // drive, which is what "browse the whole machine, including other drives"
  // needs. Reads are unrestricted for the agent either way — this only bounds
  // what the panel exposes through one token.
  const fileRoot = Array.isArray(config?.fileRoot) && config.fileRoot.length > 0
    ? config.fileRoot.filter((entry) => typeof entry === 'string' && entry !== '')
    : (typeof config?.fileRoot === 'string' && config.fileRoot !== '' ? config.fileRoot : cwd)
  // Which sessions the panel may answer approvals for. 'bridge' (the default)
  // keeps a desktop session's prompt off a phone that merely has the panel
  // open; 'all' turns the panel into an approval console for every session.
  const approvalScope = config?.approvalScope === 'all' ? 'all' : 'bridge'

  // Phone-triggered permission switching. The allow-list deliberately omits
  // `danger-full-access`: widening the sandbox to the whole machine is the one
  // change that cannot be walked back from a phone if it is granted by mistake.
  // Setting `authorizationCode` turns the handshake into "type the fixed code you
  // configured"; leaving it empty makes the server mint a one-time code that is
  // displayed on the desktop only. Either way the desktop gets a popup.
  const permissionSwitch = config?.permissionSwitch !== false
  const allowedPresets = Array.isArray(config?.permissionPresets) && config.permissionPresets.length > 0
    ? config.permissionPresets.filter((name) => typeof name === 'string' && name !== '')
    : ['read-only', 'workspace-write']
  const authorizationCode = typeof config?.authorizationCode === 'string' ? config.authorizationCode.trim() : ''
  const authorizationTtlMs = Number.isFinite(config?.authorizationTtlMs) && config.authorizationTtlMs > 0
    ? config.authorizationTtlMs
    : 3 * 60 * 1000
  const desktopPopup = config?.desktopPopup !== false

  // ── the per-client allowlist ──────────────────────────────────────────────
  //
  // A token that travels in a URL can leak without anyone noticing, so a leaked
  // token must not be sufficient by itself: a peer that has never been approved
  // is refused everything until somebody at this machine reads a code off the
  // loopback-only setup page and types it on the device. See `client-gate.js`
  // for what this does and does not defend against.
  //
  // Loopback is always allowed, so the machine that runs DSH never has to pair
  // with itself. `ipAllowlist: false` turns the whole thing off.
  const clientGate = createClientGate(ctx, {
    enabled: config?.ipAllowlist !== false,
    file: resolveHomeFile(ctx, CLIENTS_FILE_NAME),
    setupPath,
    ...(typeof config?.pairingPath === 'string' ? { pairPath: config.pairingPath } : {}),
    ...(Number.isFinite(config?.pairingTtlMs) ? { codeTtlMs: config.pairingTtlMs } : {}),
    ...(Number.isFinite(config?.pairingAttempts) ? { maxAttempts: config.pairingAttempts } : {}),
    ...(Number.isFinite(config?.pairingMaxPending) ? { maxPending: config.pairingMaxPending } : {}),
    ...(Number.isFinite(config?.pairingPopupCooldownMs)
      ? { popupCooldownMs: config.pairingPopupCooldownMs }
      : {}),
    // A device starting to wait opens the setup page here by itself, so an
    // operator does not have to be watching for it to find the code.
    desktopPopup: config?.pairingPopup !== false,
  })

  // Serialize per-conversation turns: one session runs one turn at a time.
  const chains = new Map()

  const serialize = (sessionId, operation) => {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    chains.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  /** Cached `/v1/models` payload; clients poll it and it re-reads every session log. */
  let modelsCache = { at: 0, value: [] }

  /**
   * Advertise one model per DSH session, plus the synthetic "new conversation"
   * entry. OpenAI clients have no conversation-list concept, so the model
   * picker is the only surface through which a session can be chosen — this is
   * what lets a conversation started in the desktop GUI be continued from the
   * phone, and what removes the ambiguity of inferring a session from its
   * opening message.
   */
  const availableModels = async () => {
    if (Date.now() - modelsCache.at < MODELS_CACHE_MS) return modelsCache.value
    const models = [{ id: ADVERTISED_MODEL, object: 'model', owned_by: 'deepseek-harness' }]
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const records = await query.listSessions()
        const rows = []
        for (const record of records) {
          const header = record?.header
          if (header === undefined || header.cwd === undefined) continue
          let title
          let updatedAt = header.createdAt ?? 0
          try {
            const snapshot = await query.readTitle(header.id)
            title = snapshot?.title
            updatedAt = snapshot?.updatedAt ?? updatedAt
          } catch { /* an untitled session is still selectable by id */ }
          rows.push({ id: String(header.id), title, updatedAt, live: record.live === true })
        }
        rows.sort((left, right) => right.updatedAt - left.updatedAt)
        for (const row of rows.slice(0, MODEL_LIST_LIMIT)) {
          const label = typeof row.title === 'string' && row.title !== ''
            ? row.title.replace(/\s+/gu, ' ').trim().slice(0, 60)
            : row.id
          models.push({
            id: `${label} · ${row.id}`,
            object: 'model',
            created: Math.floor(row.updatedAt / 1000),
            owned_by: row.live ? 'deepseek-harness · live' : 'deepseek-harness',
          })
        }
      } catch (error) {
        ctx.logger.warn(`openai-bridge: could not enumerate sessions for /v1/models: ${String(error)}`)
      }
    }
    modelsCache = { at: Date.now(), value: models }
    return models
  }

  const handleModels = async (req, res) => {
    if (!authorized(req, token)) return unauthorized(res)
    const body = JSON.stringify({ object: 'list', data: await availableModels() })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /**
   * Ensure an agent for a session and pin the configured permission preset.
   *
   * Shared by the OpenAI face and the panel: the sandbox boundary must not
   * depend on which entry point drove the session.
   *
   * Every caller goes through here rather than through `acquireAgent`, so the
   * in-flight map covers all of them and a cold session cannot be created twice
   * by two paths that raced. See `oncePerKey` for the error that produced.
   */
  const acquisitions = new Map()

  const openAgent = async (sessionId) => {
    const selection = ctx.get('agentDefaultModel').currentSelection()
    const { agent, created } = await acquireAgent(ctx, {
      sessionId,
      cwd,
      presetId: agentPreset,
      agentOptions: { provider: selection.provider, model: selection.model },
      installSelection,
    })
    // Pin the preset ONLY on a session this bridge just created, so the sandbox
    // boundary is in force before the first tool call. Pinning unconditionally
    // meant every message sent from the panel rewrote the session's permission
    // preset — including on a conversation the operator was working in on the
    // desktop, which silently flipped their session to read-only mid-use. A
    // resumed session already carries whatever preset it was created with, and
    // that choice belongs to whoever made it.
    if (created) {
      try {
        ctx.get('permissionPresets').set(agent.session, permissionPreset)
      } catch (error) {
        ctx.logger.warn(`openai-bridge: could not pin permission preset "${permissionPreset}": ${String(error)}`)
      }
    }
    return agent
  }

  const ensureAgent = (sessionId) => oncePerKey(acquisitions, sessionId, () => openAgent(sessionId))

  // ── per-session model selection ───────────────────────────────────────────
  //
  // One mutable ref per session, handed to the agent through `setup`. That ref
  // is what makes a switch land on the NEXT step rather than mid-step: prompt
  // assembly snapshots `current` before delegating, and request routing then
  // applies that snapshot, so the prompt and the request can never disagree
  // about which model is in play.
  const selections = new Map()
  const selectionInstalled = new WeakSet()

  const defaultSelection = () => {
    const service = ctx.get('agentDefaultModel')
    const base = service === undefined ? undefined : service.currentSelection()
    return base === undefined ? null : { ...base }
  }

  const selectionFor = (sessionId) => {
    let ref = selections.get(sessionId)
    if (ref === undefined) {
      const base = defaultSelection()
      ref = { current: base === null ? undefined : base, assembled: undefined }
      selections.set(sessionId, ref)
    }
    return ref
  }

  /**
   * Couple one session's selection to an agent this bridge just acquired.
   *
   * Takes the AGENT, not a context. The context `setup` receives cannot name its
   * agent — a scoped context exposes only what it declared it needs, so reading
   * `agentCtx.agent` throws `cannot get property "agent" without inject`. That is
   * why this runs after the agent exists, on `agent.ctx`, which is what the
   * harness's own installer documents and what its session controller passes.
   */
  const installSelection = (agent) => {
    const sessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id)
    if (sessionId === undefined) {
      ctx.logger.warn('openai-bridge: agent exposed no session; model switching is off for it')
      return
    }
    installModelSelection(agent.ctx, selectionFor(sessionId))
    selectionInstalled.add(agent)
  }

  const selectionState = (sessionId, fresh) => {
    const ref = fresh || sessionId === '' ? undefined : selections.get(sessionId)
    const agents = ctx.get('agents')
    const liveAgent = fresh || sessionId === '' || agents === undefined ? undefined : agents.get(sessionId)
    // An agent the desktop already holds live never ran this bridge's setup, so
    // no ref of ours is coupled to it — flipping one would silently do nothing.
    // The same is true when the install itself failed, which is caught rather
    // than thrown so one lost feature cannot make a conversation unopenable.
    const manageable = liveAgent === undefined || selectionInstalled.has(liveAgent)
    return {
      current: ref?.current ?? null,
      default: defaultSelection(),
      live: liveAgent !== undefined,
      manageable,
      note: manageable
        ? ''
        : '这段会话的模型不能从手机端改 —— 它可能正由电脑端持有，或者本插件的 setup 没能挂上去。请在电脑上切换，或新开一段对话。',
    }
  }

  const applySelection = async (sessionId, selection) => {
    const agents = ctx.get('agents')
    const liveAgent = agents === undefined ? undefined : agents.get(sessionId)
    if (liveAgent !== undefined && !selectionInstalled.has(liveAgent)) {
      throw Object.assign(
        new Error('这段会话正由电脑端持有，模型不能从手机端改。请在电脑上切换，或新开一段对话。'),
        { status: 409 },
      )
    }
    // Validate against the live registry: a typo must not silently pin a model
    // nothing serves, which would only surface later as a confusing turn error.
    const llm = ctx.get('llm')
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      const providers = llm.listProviders().map((provider) => provider.id)
      if (!providers.includes(selection.provider)) {
        throw Object.assign(new Error(`未知的供应商 ${selection.provider}`), { status: 400 })
      }
      const models = await llm.listModels(selection.provider)
      if (!models.some((model) => model.id === selection.model)) {
        throw Object.assign(
          new Error(`供应商 ${selection.provider} 没有名为 ${selection.model} 的模型`),
          { status: 400 },
        )
      }
    }
    const ref = selectionFor(sessionId)
    ref.current = { ...selection }
    // Materialize the agent now, so the switch is in force before the next turn
    // and any failure surfaces here rather than halfway through one.
    await ensureAgent(sessionId)
    return { current: { ...ref.current } }
  }

  // ── context occupancy and compaction ──────────────────────────────────────
  //
  // The desktop's ring is fed by the `contextPressure` and `contextBreakdown`
  // session projections, and BOTH require an attached Session: there is no cold
  // read, because `snapshot()` takes the object and `sessions.get()` only returns
  // what the process holds. That is the whole reason `load` exists here.
  //
  // Attaching runs this bridge's `setup`, so a conversation the panel loaded
  // this way stays model-manageable — the opposite of a session the desktop had
  // already opened, which never saw our setup and therefore refuses a phone-side
  // model change. It deliberately does NOT start a turn.
  const CONTEXT_KEYS = ['contextPressure', 'contextBreakdown']

  /**
   * Resolve the compaction service for one conversation: the agent's own preset
   * realm first, then the host-plane row. See `pickCompaction` for why.
   */
  const compactionFor = (agent) => pickCompaction(agent?.ctx?.get?.('compaction'), ctx.get('compaction'))

  /** Whether a phone-driven compaction of this session could run right now. */
  const compactability = (agent) => {
    if (compactionFor(agent) === undefined) {
      return { available: false, busy: false, message: '这个进程没有加载压缩服务。' }
    }
    // `compactNow` claims the agent's idle phase and throws `busy` when a turn
    // holds it, so this only decides whether the button looks pressable.
    return { available: true, busy: agent !== undefined && agent.status !== 'idle', message: '' }
  }

  /**
   * Read one conversation's context occupancy.
   * @param sessionId - the conversation's session id.
   * @param fresh - true when the conversation is new and has no session yet.
   * @param load - true to attach a cold session so it can be read.
   * @returns a state the panel renders directly; `available` is false with a
   *   `reason` for every case where there is nothing to show.
   */
  const contextState = async (sessionId, fresh, load) => {
    if (fresh || sessionId === '') {
      return { available: false, reason: 'new', message: '新会话还没有上下文占用。' }
    }
    const projections = ctx.get('sessionProjections')
    if (projections === undefined || typeof projections.snapshot !== 'function') {
      return { available: false, reason: 'unavailable', message: '这个进程没有加载上下文计量服务。' }
    }
    const registry = ctx.get('sessions')
    let agent = ctx.get('agents')?.get(sessionId)
    let session = registry === undefined ? undefined : registry.get(sessionId)
    if (session === undefined && load === true) {
      agent = await ensureAgent(sessionId)
      session = agent?.session
      if (registry !== undefined) session = registry.get(sessionId) ?? session
    }
    if (session === undefined) {
      return { available: false, reason: 'cold', message: '这段会话还没载入内存，读到占用需要先载入它。' }
    }

    const values = projections.snapshot(session, CONTEXT_KEYS).values ?? {}
    const occupancy = contextOccupancy(values)
    const compact = compactability(agent)
    if (occupancy === null) {
      return {
        available: false,
        reason: 'empty',
        session: sessionId,
        compact,
        message: '这段会话还没发出过请求，还没有可读的占用。',
      }
    }
    return { available: true, session: sessionId, ...occupancy, compact }
  }

  /**
   * Compact one conversation's history, the way the desktop's `/compact` does.
   * @param sessionId - the conversation to compact.
   * @returns a summary of what was shadowed, for the panel to report.
   * @throws an Error carrying `.status` and, for the expected failures, the
   *   backend's own `code` folded into a sentence a reader can act on.
   */
  const compactSession = async (sessionId) => {
    if (sessionId === '') throw Object.assign(new Error('session is required'), { status: 400 })
    const agent = await ensureAgent(sessionId)
    const service = compactionFor(agent)
    if (service === undefined) {
      throw Object.assign(new Error('这个进程没有加载压缩服务。'), { status: 503 })
    }
    const controller = new AbortController()
    try {
      return compactionSummary(await service.compactNow(agent, controller.signal))
    } catch (error) {
      // `ManualCompactionError` is a closed union of expected failures; anything
      // else is a real bug and keeps its own message.
      const failure = compactionFailure(error)
      throw Object.assign(new Error(failure.message), { status: failure.status })
    }
  }

  /**
   * Run one user turn, reporting text deltas through `onDelta` and reasoning
   * deltas through `onReasoning`.
   *
   * Reasoning is a SEPARATE callback rather than a kind flag on one, because the
   * two callers want opposite things and a flag makes the wrong thing easy: the
   * panel renders reasoning in a folded block, while the OpenAI face must drop it
   * entirely — forwarding a model's private reasoning as chat content would be a
   * leak, not a feature. A caller that passes nothing for it gets it dropped.
   *
   * @returns the accumulated assistant text.
   */
  const driveTurn = async (agent, text, onDelta, onReasoning) => {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    let streamed = ''
    // Subscribe before waking the agent: the stream is live, so a delta emitted
    // between `followup` and the subscription would be lost.
    const stop = ctx.on('agent/assistant-stream', (payload) => {
      if (payload.agent !== agent) return
      const frame = payload.frame
      if (frame === undefined || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk === undefined) return
      if (chunk.type === 'reasoning-delta') {
        const thinking = typeof chunk.text === 'string' ? chunk.text : ''
        if (thinking !== '' && onReasoning !== undefined) onReasoning(thinking)
        return
      }
      if (chunk.type !== 'text-delta') return
      const delta = typeof chunk.text === 'string' ? chunk.text : ''
      if (delta === '') return
      streamed += delta
      onDelta(delta)
    })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    } finally {
      stop()
    }
    return streamed
  }

  /**
   * Stop whatever this conversation is currently running.
   *
   * Keeps queued input by default. Stopping the OUTPUT is not the same decision as
   * throwing away what you already typed, so clearing the queue is a separate,
   * explicit request rather than something a stop button does silently.
   *
   * @param sessionId - the conversation to stop.
   * @param options.clearQueue - true also discards pending inbox input.
   * @returns what actually happened, so the panel can report it honestly.
   * @throws an Error carrying `.status` when the conversation is not live at all.
   */
  const stopTurn = (sessionId, options = {}) => {
    const agents = ctx.get('agents')
    const agent = agents === undefined ? undefined : agents.get(sessionId)
    if (agent === undefined) {
      throw Object.assign(new Error('这段会话现在没在跑（可能已经结束了）。'), { status: 409 })
    }
    // `cancel` is a documented no-op with no active activity, so report the state
    // observed BEFORE the call rather than claiming a stop that did nothing.
    const wasRunning = agent.status === 'running'
    const keepInbox = options.clearQueue !== true
    agent.cancel({ kind: 'user' }, { keepInbox })
    return {
      cancelled: wasRunning,
      kept: keepInbox,
      queued: agent.inbox.nextTurn.length + agent.inbox.nextStep.length,
    }
  }

  // ── the pending queue: insert, edit, undo, send now ───────────────────────
  //
  // `agent.inbox` is the SAME projection the desktop GUI reads, and every mutation
  // it exposes is a durable `agent/inbox/spliced` session event. That is the whole
  // reason "syncs with the PC" needs no sync code here: both surfaces read and
  // write one list, and the session log is what they agree through. A private
  // queue living only in this plugin would have to be mirrored by hand, and would
  // drift the first time the desktop changed something.
  //
  // The two targets are the harness's own distinction, not an invention:
  // 'next-turn' waits its turn, 'next-step' steers the turn already running.

  const textOfMessage = (message) => (Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
    : '')

  /** Which pending list holds one message identity, and the message itself. */
  const locateQueued = (agent, messageId) => {
    const queuedTurn = agent.inbox.nextTurn.find((message) => String(message.id) === messageId)
    if (queuedTurn !== undefined) return { target: 'next-turn', message: queuedTurn }
    const queuedStep = agent.inbox.nextStep.find((message) => String(message.id) === messageId)
    if (queuedStep !== undefined) return { target: 'next-step', message: queuedStep }
    return undefined
  }

  /**
   * The live agent for one conversation, or a refusal.
   * @throws an Error carrying `.status` when the conversation is not in memory.
   */
  const liveAgentFor = (sessionId) => {
    const agents = ctx.get('agents')
    const agent = agents === undefined ? undefined : agents.get(sessionId)
    if (agent === undefined) {
      throw Object.assign(new Error('这段会话没在内存里，先载入它才能排队。'), { status: 409 })
    }
    return agent
  }

  /**
   * The pending queue for one conversation, as displayable rows.
   * @param sessionId - the conversation to read.
   * @returns its two pending lists, each row carrying a stable id and its text.
   */
  const listQueue = (sessionId) => {
    const agent = liveAgentFor(sessionId)
    const rows = (target, list) => list.map((message) => ({
      id: String(message.id),
      target,
      text: textOfMessage(message),
    }))
    return {
      // Whether a turn is running decides what "queued" MEANS to the reader, and
      // it is not readable from the items themselves: while the agent runs, a
      // queued message is waiting its turn, and while it is idle nothing will
      // consume it until somebody sends it. Without this the phone cannot tell
      // those apart, and a deliberately staged message looks like a hung one.
      running: agent.status === 'running',
      nextTurn: rows('next-turn', agent.inbox.nextTurn),
      nextStep: rows('next-step', agent.inbox.nextStep),
    }
  }

  /**
   * Fork one conversation at its last completed turn.
   *
   * The harness's session controller owns the canonical version of this and this
   * plugin cannot import it, so the recipe is mirrored — the same shape it takes:
   * cut at a completed turn boundary, create the child seeded with the prefix, and
   * attach it to a workspace so the desktop sidebar groups it at all.
   *
   * @param sessionId - the conversation to fork.
   * @returns the child's id and how much history it was seeded with.
   * @throws an Error carrying `.status` for every expected refusal.
   */
  const forkSession = async (sessionId) => {
    const agents = ctx.get('agents')
    const query = ctx.get('sessionQuery')
    if (agents === undefined) {
      throw Object.assign(new Error('这个进程没有加载会话服务。'), { status: 503 })
    }
    if (query === undefined || typeof query.observeSession !== 'function') {
      throw Object.assign(new Error('这个进程读不了会话日志，没法分支。'), { status: 503 })
    }

    const observation = await query.observeSession(sessionId)
    if (observation?.header?.id !== sessionId) {
      observation?.[Symbol.dispose]?.()
      throw Object.assign(new Error('找不到这段会话。'), { status: 404 })
    }

    let header
    let seed
    let childCwd
    const childId = `session-${randomUUID()}`
    try {
      header = observation.header
      childCwd = header.cwd ?? cwd
      const events = Array.isArray(observation.events) ? observation.events : []
      seed = events.slice(0, planForkCut(events).cut)
    } finally {
      // The observation holds a retained read; releasing it on the throwing path
      // matters as much as on the happy one.
      observation[Symbol.dispose]?.()
    }

    // The child follows the source's preset when it declares one, so a forked
    // conversation keeps the composition it was already having.
    const presets = ctx.get('agentPresets')
    const presetId = typeof header.agentPreset === 'string' ? header.agentPreset : agentPreset
    const resolved = presets === undefined ? undefined : await presets.resolve(presetId)
    const selection = ctx.get('agentDefaultModel')?.currentSelection()

    const handle = await agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: seed.length,
      ...(selection === undefined
        ? {}
        : { agentOptions: { provider: selection.provider, model: selection.model } }),
      meta: {
        cwd: childCwd,
        // What makes it a fork rather than a copy, and what the desktop reads to
        // show the lineage.
        parentSession: sessionId,
        isSeeded: true,
        ...(resolved?.agentPreset === undefined ? {} : { agentPreset: resolved.agentPreset }),
      },
      setup: async (agentCtx) => {
        if (resolved !== undefined) await presets.mount(agentCtx, resolved.id)
      },
    })

    // A fork is a NEW session this bridge created, so the bridge's rule for new
    // sessions applies and the configured preset is pinned before the first tool
    // call. Deliberately NOT inherited from the source: inheriting would let a
    // wider sandbox propagate by duplication, and the phone can request a change
    // on the child explicitly if it needs one.
    try {
      ctx.get('permissionPresets').set(handle.agent.session, permissionPreset)
    } catch (error) {
      ctx.logger.warn(`openai-bridge: could not pin the preset on forked ${childId}: ${String(error)}`)
    }
    try {
      installSelection(handle.agent)
    } catch (error) {
      ctx.logger.warn(`openai-bridge: could not install the model selection on forked ${childId}: ${String(error)}`)
    }

    // Without this the child exists but the desktop sidebar never groups it.
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.create === 'function') {
      try {
        const workspace = await registry.create(childCwd)
        await workspace.attachSession(childId)
      } catch (error) {
        ctx.logger.warn(`openai-bridge: could not attach forked ${childId} to ${childCwd}: ${String(error)}`)
      }
    }

    ctx.logger.info(`openai-bridge: forked ${sessionId} into ${childId} (${String(seed.length)} seeded events)`)
    return { sessionId: childId, seeded: seed.length }
  }

  /**
   * Insert, edit, drop, or send one queued message.
   * @param sessionId - the conversation whose queue to change.
   * @param action - `insert | edit | drop | send`.
   * @param payload - `text` for insert/edit, `id` for edit/drop/send, and `target`
   *   for insert.
   * @returns a description of what changed.
   * @throws an Error carrying `.status` for every expected refusal.
   */
  const queueAction = async (sessionId, action, payload) => {
    const agent = liveAgentFor(sessionId)
    const plan = planQueueAction(action, payload, (id) => locateQueued(agent, id))
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    const build = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

    if (plan.kind === 'insert') {
      const message = build(plan.text)
      // `append`, not `send`: nothing wakes the driver, so it sits in the queue
      // visible on both surfaces until somebody sends it.
      agent.inbox.append(plan.target, message)
      return { id: String(message.id), target: plan.target, text: plan.text }
    }

    // Re-located rather than carried through the plan, so the plan stays pure.
    const found = locateQueued(agent, plan.id)
    if (found === undefined) {
      throw Object.assign(new Error('这条排队消息已经不在了。'), { status: 404 })
    }

    if (plan.kind === 'edit') {
      const replacement = build(plan.text)
      // `replace` swaps in place, keeping the queue position the reader chose.
      agent.inbox.replace(found.message.id, replacement)
      return { id: String(replacement.id), target: found.target, text: plan.text }
    }

    if (plan.kind === 'drop') {
      agent.inbox.remove(found.message.id)
      return { dropped: true, id: plan.id }
    }

    // Promote it to run now. The inbox refuses a duplicate identity, and the
    // harness exposes no bare "wake", so it is removed and re-sent waking the
    // driver — which is exactly what "send this now" means.
    agent.inbox.remove(found.message.id)
    agent.send(found.message, 'next-turn', true)
    return { sent: true, id: plan.id, text: textOfMessage(found.message) }
  }

  const handleCompletions = async (req, res) => {
    if (!authorized(req, token)) return unauthorized(res)

    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }))
      return
    }

    const messages = Array.isArray(body?.messages) ? body.messages : []
    const prompt = lastUserText(messages)
    if (prompt === '') {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: 'no user message', type: 'invalid_request_error' } }))
      return
    }

    const model = typeof body?.model === 'string' && body.model !== '' ? body.model : ADVERTISED_MODEL
    const stream = body?.stream === true
    // An explicitly selected session wins. Falling back to the opening-message
    // hash keeps the synthetic `dsh-agent` entry working, but that inference is
    // ambiguous — two conversations sharing an opening line would otherwise
    // merge into one session and interleave their turns.
    const sessionId = sessionIdFromModel(model) ?? sessionIdFor(messages)
    const completionId = `chatcmpl-${randomUUID().replaceAll('-', '')}`
    const created = Math.floor(Date.now() / 1000)

    try {
      await serialize(sessionId, async () => {
        const agent = await ensureAgent(sessionId)
        const session = agent.session

        // Chatbox resends the whole history every turn; the harness already
        // holds the prior turns, so only the newest message is forwarded — with
        // the earlier ones as a preamble when this session is brand new.
        const preamble = transcriptPreamble(messages)
        const text = preamble === '' ? prompt : `${preamble}\n\nUser: ${prompt}`
        const streamed = await driveTurn(agent, text, (delta) => {
          if (stream) writeEvent(res, chunkFrame(completionId, created, model, { content: delta }, null))
        })

        if (stream) {
          writeEvent(res, chunkFrame(completionId, created, model, {}, 'stop'))
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // Non-streaming: fall back to the durable log when no delta was observed.
        let answer = streamed
        if (answer === '') answer = lastAssistantText(session, ctx)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        }))
      })
    } catch (error) {
      ctx.logger.warn(`openai-bridge: turn failed: ${String(error)}`)
      if (res.headersSent) {
        writeEvent(res, chunkFrame(completionId, created, model, { content: `\n[bridge error: ${String(error)}]` }, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: { message: String(error), type: 'internal_error' } }))
    }
  }

  const handler = (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://bridge.invalid')
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    // Before the token check, because a device that has never been approved
    // cannot pass it anyway: it gets the refusal, or the form that fixes it.
    if (clientGate.check(req, res, url)) return
    const pathname = url.pathname
    if (pathname === `${BASE_PATH}/models` && (req.method === 'GET' || req.method === 'HEAD')) {
      void handleModels(req, res).catch((error) => {
        ctx.logger.warn(`openai-bridge: /v1/models failed: ${String(error)}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: String(error), type: 'internal_error' } }))
        }
      })
      return
    }
    if (pathname === `${BASE_PATH}/chat/completions` && req.method === 'POST') {
      void handleCompletions(req, res)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: { message: `unknown route ${req.method} ${pathname}`, type: 'invalid_request_error' } }))
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE_PATH, handler }), 'openai-bridge: /v1 route')
  // The one route a not-yet-approved device can reach. It is mounted whenever
  // the bridge is, because whether a device is approved is not known until it
  // asks — and it answers only `{code}` against a code shown on this machine.
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: clientGate.pairPath, handler: clientGate.handler }),
    'openai-bridge: pairing route',
  )
  ctx.logger.info(`openai-bridge: client allowlist ${clientGate.enabled
    ? `on (${clientGate.clients().length} approved; pairing at ${clientGate.pairPath})`
    : 'OFF — every peer that has the token is served'}`)
  ctx.logger.info(`openai-bridge: mounted ${BASE_PATH} (permission preset "${permissionPreset}", agent preset "${agentPreset}")`)

  // The read-only mobile panel. Isolated in its own module and wrapped so a
  // panel failure cannot take the OpenAI endpoint (or the whole tree) down.
  try {
    installPanel(ctx, {
      token,
      fileRoot,
      // Uploads stay anchored to the workspace, never to a browse root: with
      // `fileRoot: '*'` the first root is a drive letter.
      inboxRoot: cwd,
      basePath: panelPath,
      // Undefined means "answer approvals for every session"; a cwd string
      // scopes the panel to the sessions created in that workspace.
      approvalCwd: approvalScope === 'all' ? undefined : cwd,
      runtime: { ensureAgent, driveTurn, stopTurn, listQueue, queueAction, forkSession, serialize },
      permission: {
        enabled: permissionSwitch,
        allowedPresets,
        fixedCode: authorizationCode,
        ttlMs: authorizationTtlMs,
        desktopPopup,
      },
      model: { selectionState, applySelection },
      context: { contextState, compactSession },
      clientGate,
    })
    ctx.logger.info('openai-bridge: permission switch ' + (permissionSwitch
      ? `on (${authorizationCode === '' ? 'code shown on the desktop' : 'fixed code'}; presets ${allowedPresets.join(', ')})`
      : 'off'))
    ctx.logger.info('openai-bridge: model switching on (catalogue read from the live llm registry)')
    ctx.logger.info('openai-bridge: context meter on; compaction '
      + (ctx.get('compaction') === undefined
        ? 'has no host-plane service (agent realms will be tried per session)'
        : 'available from the host plane, agent realms preferred'))
  } catch (error) {
    ctx.logger.warn(`openai-bridge: panel failed to mount: ${String(error)}`)
    // Swallowing the failure leaves the path answered by the static fallback,
    // which replies with an untyped 404 — the browser then sniffs that response
    // and downloads it as a file instead of showing anything. A typed
    // diagnostic route keeps the failure legible on the device that hit it.
    try {
      const detail = escapeHtml(String(error && error.message ? error.message : error))
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: panelPath,
        handler: (_req, res) => {
          res.writeHead(500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end('<!doctype html><meta charset="utf-8"><title>bridge panel unavailable</title>'
            + '<body style="font:15px/1.6 system-ui;background:#0d1117;color:#e6edf3;padding:24px">'
            + '<h3 style="color:#ff7b72;margin:0 0 10px">面板加载失败</h3>'
            + `<pre style="white-space:pre-wrap;background:#010409;padding:12px;border-radius:8px">${detail}</pre>`
            + '<p>OpenAI 兼容端点（/v1）不受影响。主机日志中带 openai-bridge: 前缀的行有更多信息。</p>')
        },
      }), 'openai-bridge: panel diagnostic')
    } catch { /* the tree is coming down anyway */ }
  }

  // The setup page mounts even when everything above succeeded: it is where an
  // operator reads the address a phone should use, and where a token that came
  // from the file can be rotated. It stays loopback-only either way.
  try {
    installSetup(ctx, { setupPath, panelPath, tokenSource, token, clientGate })
  } catch (error) {
    ctx.logger.warn(`openai-bridge: setup page failed to mount: ${String(error)}`)
  }
}

/** Read the last assistant text off the durable log, for non-streaming replies. */
function lastAssistantText(session, ctx) {
  try {
    const length = session.seq
    for (let seq = length - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq)
      if (event === undefined || event.type !== 'assistant/message') continue
      return event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    }
  } catch (error) {
    ctx.logger.warn(`openai-bridge: could not read assistant text: ${String(error)}`)
  }
  return ''
}

// Exported for the test suite: the conversation-to-session mapping is pure and
// is where a routing mistake would silently merge two conversations, and the two
// acquisition helpers below are where a race turns into a misleading error.
export {
  sessionIdFor,
  sessionIdFromModel,
  contentText,
  lastUserText,
}
