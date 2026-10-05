/**
 * The setup page — the only thing this plugin serves before it has a token.
 *
 * WHY THIS IS THE ONE UNAUTHENTICATED ROUTE.
 * Every other route here is fail-closed: no token means nothing is mounted at
 * all. But the whole point of a setup page is to run *before* a token exists, so
 * it necessarily breaks that rule. The break is kept as small as it can be:
 *
 *   - the page and its two endpoints answer ONLY to a loopback peer, checked on
 *     `req.socket.remoteAddress`, and refuse everyone else with 403. The server
 *     binds 0.0.0.0, so the LAN can reach the PORT — this check is the actual
 *     gate, not the bind;
 *   - it is the only route registered in that state. `/v1`, `/bridge`, and the
 *     `approval/request` listener are not mounted, so an unconfigured plugin
 *     still cannot touch the approval flow;
 *   - the only write it can perform is the token file, at a path this module
 *     computes itself. No path is ever taken from the request.
 *
 * The token lives in a file under `$DSH_HOME` rather than in the profile's
 * `cordis.patch.yml`, because a plugin cannot know which profile it belongs to
 * and guessing at a YAML file is a far worse thing to automate.
 *
 * @module dsh-openai-bridge/setup
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { sendJson, readJsonBody } from './http-util.js'

/** File name under `$DSH_HOME`. Also the name the README tells operators to look for. */
export const TOKEN_FILE_NAME = 'openai-bridge.token'

/**
 * Whether a request came from this machine.
 *
 * `127.0.0.0/8` is loopback in its entirety, and Node reports an IPv4 peer on a
 * dual-stack socket in IPv4-mapped form, so both spellings have to be accepted.
 */
export function isLoopback(req) {
  const remote = String(req.socket?.remoteAddress ?? '')
  return remote === '::1' || /^127\./u.test(remote) || /^::ffff:127\./u.test(remote)
}

/**
 * Resolve one of this plugin's files under the host's own DSH home.
 *
 * The path is computed, never taken from a request: the setup page is the one
 * route served before a token exists, so nothing it can reach may be steerable
 * by whoever called it.
 *
 * @param ctx - host plugin context.
 * @param name - file name to resolve under `$DSH_HOME`.
 * @returns the absolute path.
 */
export function resolveHomeFile(ctx, name) {
  const service = ctx.get('dshHomePath')
  if (typeof service === 'function') {
    try {
      const resolved = service(name)
      if (typeof resolved === 'string' && resolved !== '') return resolved
    } catch {
      // Fall through to the environment/home default below.
    }
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, name)
}

/** The token file's absolute path, resolved from the host's own home service. */
export function resolveTokenFile(ctx) {
  return resolveHomeFile(ctx, TOKEN_FILE_NAME)
}

/** Read the token file, or `''` when it is missing or unreadable. */
export function readTokenFile(ctx) {
  try {
    return readFileSync(resolveTokenFile(ctx), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Non-internal IPv4 addresses, which are the ones a phone could reach. */
function localAddresses() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address })
    }
  }
  return found
}

/** The port this request arrived on, which is the one a phone must use. */
function portOf(req) {
  const host = String(req.headers?.host ?? '')
  const colon = host.lastIndexOf(':')
  return colon === -1 ? '' : host.slice(colon + 1)
}

/**
 * Mount the loopback-only setup surface.
 *
 * @param ctx - host plugin context.
 * @param options.setupPath - prefix to mount at; defaults to `/setup`.
 * @param options.panelPath - the panel prefix, echoed so the page can build URLs.
 * @param options.tokenSource - `'config' | 'file' | 'none'`, which decides whether
 *   the page may rotate the token.
 * @param options.token - the token in force, or `''`. Only ever sent to a loopback peer.
 */
export function installSetup(ctx, options = {}) {
  const setupPath = typeof options.setupPath === 'string' && options.setupPath.startsWith('/')
    ? options.setupPath
    : '/setup'
  const panelPath = typeof options.panelPath === 'string' && options.panelPath.startsWith('/')
    ? options.panelPath
    : '/bridge'
  const tokenFile = resolveTokenFile(ctx)
  // The gate is optional: the no-token state mounts this page alone, and there
  // is nothing to pair a device *for* until the bridge itself is mounted.
  const gate = options.clientGate ?? null

  let pageSource = null
  const page = () => {
    if (pageSource === null) pageSource = readFileSync(new URL('./setup-page.html', import.meta.url), 'utf8')
    return pageSource
  }

  const state = (req) => ({
    configured: options.tokenSource !== 'none',
    tokenSource: options.tokenSource ?? 'none',
    token: options.token ?? '',
    tokenFile,
    // A token that came from the config cannot be rotated here: the config is
    // restated on every boot and would win again anyway.
    canRotate: options.tokenSource === 'file' || options.tokenSource === 'none',
    addresses: localAddresses(),
    port: portOf(req),
    panelPath,
    setupPath,
    // The one place a pairing code is ever rendered. Every member here is
    // loopback-only by the check at the top of the handler, which is what makes
    // "the code is shown on the machine" true rather than aspirational.
    clientGate: gate === null ? null : {
      enabled: gate.enabled,
      file: gate.file,
      pairPath: gate.pairPath,
      clients: gate.clients(),
      pending: gate.pending(),
    },
  })

  const handler = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://bridge.invalid')
      const rest = url.pathname.slice(setupPath.length)

      // The single security control on this whole module. The server binds every
      // interface, so without it the LAN could reach an endpoint that hands out
      // (and rewrites) the credential.
      if (!isLoopback(req)) {
        const remote = String(req.socket?.remoteAddress ?? 'unknown')
        ctx.logger.warn(`openai-bridge: refused setup access from ${remote}`)
        sendJson(res, 403, { error: 'setup is available from this machine only' })
        return
      }

      try {
        if (rest === '' || rest === '/') {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // The page is a local tool; nothing here should be reachable from a
            // document it did not come from.
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          })
          res.end(page())
          return
        }
        if (rest === '/state') {
          sendJson(res, 200, state(req))
          return
        }
        if (rest === '/token') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST required' })
            return
          }
          if (options.tokenSource === 'config') {
            sendJson(res, 409, {
              error: '这个令牌来自 profile 的 cordis.patch.yml，不能在这里轮换 —— 请改那里并重启。',
            })
            return
          }
          const token = randomBytes(32).toString('base64url')
          writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
          ctx.logger.info(`openai-bridge: wrote a new token to ${tokenFile}; restart DSH for it to take effect`)
          sendJson(res, 200, { ok: true, token, tokenFile, addresses: localAddresses(), port: portOf(req) })
          return
        }
        if (rest === '/clients/forget') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST required' })
            return
          }
          if (gate === null) {
            sendJson(res, 409, { error: '这个进程没有启用设备白名单。' })
            return
          }
          const body = await readJsonBody(req, 4096)
          const ip = typeof body?.ip === 'string' ? body.ip.trim() : ''
          if (ip === '') throw Object.assign(new Error('ip is required'), { status: 400 })
          // Forgetting is the only way back: an approved device is trusted until
          // somebody at this machine says otherwise.
          const forgotten = gate.forget(ip)
          sendJson(res, 200, { ok: true, forgotten, clients: gate.clients(), file: gate.file })
          return
        }
        sendJson(res, 404, { error: `unknown setup route ${rest}` })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 500
        ctx.logger.warn(`openai-bridge: setup ${rest} failed: ${String(error)}`)
        if (res.headersSent) { res.destroy(); return }
        sendJson(res, status, { error: String(error?.message ?? error) })
      }
    })()
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: setupPath, handler }),
    'openai-bridge: setup page',
  )
  ctx.logger.info(`openai-bridge: setup page at ${setupPath} (loopback only)`)
}
