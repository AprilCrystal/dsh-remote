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
import { installSetup, readTokenFile } from './setup.js'

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
 * @param agentCtx - the selected agent's scoped context (what `setup` receives).
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
        // Installed AFTER the preset mount, so the operator's model choice is the
        // last word on routing rather than something a preset can overwrite.
        if (installSelection !== undefined) installSelection(agentCtx)
      },
    }
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

  if (persisted) {
    try {
      const composition = await compose()
      const handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: composition.setup })
      return { agent: handle.agent, created: false }
    } catch {
      // Not actually persisted, or unresumable: fall through to a fresh create.
    }
  }

  const composition = await compose()
  const handle = await agents.create({
    sessionId,
    agentOptions,
    meta: {
      cwd,
      ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
    },
    setup: composition.setup,
  })

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

  return { agent: handle.agent, created: true }
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
   */
  const ensureAgent = async (sessionId) => {
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

  /** Invoked from inside `setup`, on the agent's own scoped context. */
  const installSelection = (agentCtx) => {
    const agent = agentCtx.agent
    const sessionId = agent?.session?.id === undefined ? undefined : String(agent.session.id)
    if (sessionId === undefined) {
      ctx.logger.warn('openai-bridge: agent setup exposed no scoped session; model switching is off for it')
      return
    }
    installModelSelection(agentCtx, selectionFor(sessionId))
    if (agent !== undefined) selectionInstalled.add(agent)
  }

  const selectionState = (sessionId, fresh) => {
    const ref = fresh || sessionId === '' ? undefined : selections.get(sessionId)
    const agents = ctx.get('agents')
    const liveAgent = fresh || sessionId === '' || agents === undefined ? undefined : agents.get(sessionId)
    // An agent the desktop already holds live never ran this bridge's `setup`, so
    // no ref of ours is coupled to it — flipping one would silently do nothing.
    // Report that instead of pretending the change landed.
    const manageable = liveAgent === undefined || selectionInstalled.has(liveAgent)
    return {
      current: ref?.current ?? null,
      default: defaultSelection(),
      live: liveAgent !== undefined,
      manageable,
      note: manageable
        ? ''
        : '这段会话正由电脑端持有（已加载、运行中），手机端改不了它的模型 —— 请在电脑上切换，或新开一段对话。',
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

  /**
   * Run one user turn, reporting text deltas through `onDelta`.
   * @returns the accumulated assistant text.
   */
  const driveTurn = async (agent, text, onDelta) => {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    let streamed = ''
    // Subscribe before waking the agent: the stream is live, so a delta emitted
    // between `followup` and the subscription would be lost.
    const stop = ctx.on('agent/assistant-stream', (payload) => {
      if (payload.agent !== agent) return
      const frame = payload.frame
      if (frame === undefined || frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk === undefined || chunk.type !== 'text-delta') return
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
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://bridge.invalid').pathname
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
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
      runtime: { ensureAgent, driveTurn, serialize },
      permission: {
        enabled: permissionSwitch,
        allowedPresets,
        fixedCode: authorizationCode,
        ttlMs: authorizationTtlMs,
        desktopPopup,
      },
      model: { selectionState, applySelection },
    })
    ctx.logger.info('openai-bridge: permission switch ' + (permissionSwitch
      ? `on (${authorizationCode === '' ? 'code shown on the desktop' : 'fixed code'}; presets ${allowedPresets.join(', ')})`
      : 'off'))
    ctx.logger.info('openai-bridge: model switching on (catalogue read from the live llm registry)')
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
    installSetup(ctx, { setupPath, panelPath, tokenSource, token })
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
// is where a routing mistake would silently merge two conversations.
export { sessionIdFor, sessionIdFromModel, contentText, lastUserText }
