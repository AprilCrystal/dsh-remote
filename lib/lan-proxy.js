/**
 * The LAN listener, in-process.
 *
 * WHY IT LIVES HERE. DSH binds loopback only — a wildcard `host` is rejected
 * while resolving config, and because `webserver` is required that rejection
 * stops the whole boot. A phone therefore needs a second listener on the LAN that
 * forwards to the loopback one, and running that as a separate command meant the
 * operator had to remember to start it, and had no way to see whether it worked.
 * Started from inside the plugin it comes up with DSH and reports itself on the
 * setup console.
 *
 * WHY IT IS NOT A SECURITY BOUNDARY. It authenticates nothing: the token and the
 * pairing gate still decide who gets in. What it must do correctly is NAME the
 * client, because that is what the gate judges — hence `X-Forwarded-For` on every
 * hop, and the plugin's `trustedProxies` listing this listener's own address.
 *
 * @module dsh-openai-bridge/lan-proxy
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'

/** Hop-by-hop headers belong to one connection and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Non-internal IPv4 addresses, which are the ones a phone could reach. */
function lanAddresses() {
  const found = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      found.push(entry.address)
    }
  }
  return found
}

const normalize = (address) => String(address ?? '').replace(/^::ffff:/u, '')

/**
 * Start the LAN listener.
 *
 * @param ctx - host plugin context, for logging.
 * @param options.origin - the loopback origin DSH is listening on.
 * @param options.port - the LAN port to bind.
 * @param options.listen - the interface to bind; `0.0.0.0` is every interface.
 * @returns `{ status, close }` — `status` is what the setup console renders.
 */
export function startLanProxy(ctx, options) {
  const port = options.port
  const listen = options.listen ?? '0.0.0.0'
  const origin = new URL(options.origin)
  const state = {
    port,
    listen,
    origin: origin.href,
    lan: true,
    running: false,
    addresses: [],
    requests: 0,
    lastError: '',
    startedAt: Date.now(),
  }

  const forwarded = (req) => {
    const headers = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (HOP_BY_HOP.has(name.toLowerCase())) continue
      headers[name] = value
    }
    const client = normalize(req.socket?.remoteAddress)
    headers['x-forwarded-for'] = headers['x-forwarded-for']
      ? `${headers['x-forwarded-for']}, ${client}`
      : client
    headers['x-forwarded-proto'] = 'http'
    headers['x-forwarded-host'] = req.headers.host ?? ''
    headers['x-forwarded-port'] = String(origin.port)
    return headers
  }

  const server = createServer((req, res) => {
    state.requests += 1
    const upstream = httpRequest(
      {
        host: origin.hostname,
        port: Number(origin.port),
        method: req.method,
        path: req.url,
        headers: forwarded(req),
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers)
        // Piped, not buffered: the panel streams and a buffered proxy would hold
        // every event until the connection closed.
        answer.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      state.lastError = String(error?.message ?? error)
      if (!res.headersSent) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('lan proxy: DSH is not answering on its loopback origin\n')
      } else {
        res.destroy()
      }
    })
    req.pipe(upstream)
  })

  // An upgrade cannot be replayed through http.request; it needs the raw socket.
  server.on('upgrade', (req, socket, head) => {
    const target = netConnect(Number(origin.port), origin.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(forwarded(req))) {
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push('', '')
      target.write(lines.join('\r\n'))
      if (head !== undefined && head.length > 0) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
  })

  server.on('error', (error) => {
    state.running = false
    state.lastError = String(error?.message ?? error)
    ctx.logger.warn(`openai-bridge: LAN listener on ${listen}:${port} failed: ${state.lastError}`)
  })

  server.listen(port, listen, () => {
    state.running = true
    state.addresses = lanAddresses()
    ctx.logger.info(`openai-bridge: LAN listener on ${listen}:${port} -> ${origin.href}`)
  })

  return {
    status: () => ({ ...state, addresses: [...state.addresses] }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        state.running = false
      }),
  }
}
