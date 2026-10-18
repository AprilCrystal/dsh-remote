#!/usr/bin/env node
/**
 * A LAN reverse proxy for the bridge.
 *
 * WHY THIS EXISTS. DSH binds loopback only: since `@deepseek-ai/dsh-host-webserver`
 * 0.2.1-rc.2 a wildcard `host` is rejected while resolving config, and because
 * `webserver` is a required plugin that rejection stops the whole boot. So a
 * phone cannot reach the bridge directly, and "bind it to the LAN address
 * instead" is not an option either — the desktop host builds its own window URL
 * from `http://127.0.0.1:<port>`, so the desktop would stop connecting.
 *
 * This process is the missing hop: it listens on the LAN, forwards to the
 * loopback origin, and adds `X-Forwarded-For`. The bridge trusts that header only
 * from a configured proxy (`trustedProxies`), which is what keeps the pairing
 * gate meaningful — without it every phone would arrive as 127.0.0.1 and be
 * mistaken for the operator.
 *
 * It finds the origin by reading the file the plugin publishes on every start,
 * because the desktop launcher picks a free port each time and no configuration
 * can pin it.
 *
 * Usage:
 *   node tools/lan-proxy.mjs                 # all interfaces, port 19387
 *   node tools/lan-proxy.mjs --port 19387 --listen 0.0.0.0
 *   node tools/lan-proxy.mjs --listen 10.0.0.5   # one interface only
 *
 * Then add to the plugin's config:
 *   trustedProxies: ['127.0.0.1']     # the address THIS proxy appears as
 */

import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

const HELP = `lan-proxy — expose the DSH bridge to the LAN without rebinding DSH

  --port <n>          port to listen on (default 19387)
  --listen <addr>     interface to bind (default 0.0.0.0, every interface)
  --origin-file <p>   where the plugin publishes its origin
                      (default $DSH_HOME/openai-bridge-origin.txt)
  --check             verify the chain and exit without listening (exit 0 ok, 1 not)
  --help              this text
`

function parseArgs(argv) {
  const options = { port: 19387, listen: '0.0.0.0', originFile: '', help: false, check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--check') options.check = true
    else if (flag === '--port' && value !== undefined) {
      options.port = Number(value)
      index += 1
    } else if (flag === '--listen' && value !== undefined) {
      options.listen = value
      index += 1
    } else if (flag === '--origin-file' && value !== undefined) {
      options.originFile = value
      index += 1
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error(`--port must be a whole number from 1 to 65535 (got ${String(options.port)})`)
  }
  return options
}

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`lan-proxy: ${String(error.message ?? error)}\n`)
    console.error(HELP)
    process.exit(2)
  }
})()

if (options.help) {
  console.log(HELP)
  process.exit(0)
}

/**
 * Verify the chain without listening.
 *
 * This is the answer to "is the phone setup broken, and where": it separates the
 * three failures that look identical from a phone — the plugin not mounted (no
 * origin file), the origin file pointing somewhere wrong, and the bridge being
 * up but unreachable on the port it published.
 */
async function check() {
  const origin = currentOrigin()
  if (origin === null) {
    console.error('lan-proxy: FAIL no usable origin')
    console.error(`  file: ${ORIGIN_FILE}`)
    console.error(`  why:  ${cachedWhy || 'unknown'}`)
    console.error('  the plugin publishes this file when it mounts; if it is missing, the')
    console.error('  bridge did not mount — check the DSH host log for an openai-bridge error.')
    return 1
  }
  console.log(`lan-proxy: origin ${origin.href}`)
  let status
  try {
    const answer = await fetch(new URL('/setup', origin), { redirect: 'manual' })
    status = answer.status
    await answer.arrayBuffer()
  } catch (error) {
    console.error(`lan-proxy: FAIL cannot reach ${origin.href}: ${String(error?.message ?? error)}`)
    return 1
  }
  console.log(`lan-proxy: GET /setup -> ${status}`)
  if (status === 404) {
    console.error('lan-proxy: FAIL DSH answers, but the bridge is not mounted there.')
    console.error('  the plugin loaded without its routes; check the host log.')
    return 1
  }
  console.log('lan-proxy: OK the bridge answers through the published origin')
  return 0
}

if (options.check) {
  // Runs at the bottom: the origin cache is declared further down, and reading it
  // before its declaration is a temporal-dead-zone error, not a missing value.
}

const ORIGIN_FILE = options.originFile !== ''
  ? options.originFile
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'openai-bridge-origin.txt')

/** Collapse an IPv4-mapped peer, so the bridge sees one spelling per device. */
const normalize = (address) => String(address ?? '').replace(/^::ffff:/u, '')

/**
 * Read the current origin, at most once a second.
 *
 * The plugin rewrites this file on every start; a stat-and-cache would be nicer
 * but this is one small read per second at worst, and correctness here matters
 * more than the syscall.
 */
let cachedAt = 0
let cachedOrigin = null
let cachedWhy = ''
/** The last origin handed out, so a restart is visible in the log. */
let announced = ''

function currentOrigin() {
  const now = Date.now()
  if (now - cachedAt < 1000) return cachedOrigin
  cachedAt = now
  try {
    const text = readFileSync(ORIGIN_FILE, 'utf8').trim()
    const url = new URL(text)
    if (url.protocol !== 'http:') throw new Error(`not an http origin: ${text}`)
    if (!/^(127\.|::1$|localhost$)/u.test(url.hostname)) {
      throw new Error(`origin is not loopback: ${url.hostname}`)
    }
    cachedOrigin = url
    cachedWhy = ''
    // DSH is restarted with a new port often enough that silently following it
    // hides the one event worth seeing: the target moved under us.
    if (url.href !== announced) {
      if (announced !== '') console.log(`lan-proxy: DSH moved, now forwarding to ${url.href}`)
      announced = url.href
    }
  } catch (error) {
    cachedOrigin = null
    cachedWhy = String(error?.message ?? error)
  }
  return cachedOrigin
}

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

function forwardedHeaders(req, origin) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  const client = normalize(req.socket?.remoteAddress)
  // Append rather than replace: if something legitimate already forwarded, the
  // chain stays readable and our own hop is the rightmost entry.
  headers['x-forwarded-for'] = headers['x-forwarded-for']
    ? `${headers['x-forwarded-for']}, ${client}`
    : client
  headers['x-forwarded-proto'] = 'http'
  headers['x-forwarded-host'] = req.headers.host ?? ''
  headers['x-forwarded-port'] = String(origin.port)
  return headers
}

function unavailable(res, why) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(
    'lan-proxy: DSH is not reachable right now.\n' +
      `origin file: ${ORIGIN_FILE}\n` +
      `reason: ${why || 'unknown'}\n\n` +
      'Is the bridge plugin active? It publishes that file when it mounts.\n',
  )
}

const server = createServer((req, res) => {
  const origin = currentOrigin()
  if (origin === null) {
    unavailable(res, cachedWhy)
    return
  }
  const upstream = httpRequest(
    {
      host: origin.hostname,
      port: Number(origin.port),
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, origin),
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers)
      // piped rather than buffered: the panel streams, and a buffered proxy would
      // hold every event until the connection ended.
      answer.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (!res.headersSent) unavailable(res, `upstream: ${String(error?.message ?? error)}`)
    else res.destroy()
  })
  req.pipe(upstream)
})

// A WebSocket upgrade cannot be replayed through http.request; it needs the raw
// socket, so this writes the request line by hand and then pipes both ways.
server.on('upgrade', (req, socket, head) => {
  const origin = currentOrigin()
  if (origin === null) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n')
    return
  }
  const target = netConnect(Number(origin.port), origin.hostname, () => {
    const headers = forwardedHeaders(req, origin)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
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
  if (error?.code === 'EADDRINUSE') {
    console.error(`lan-proxy: ${options.listen}:${options.port} is already in use`)
  } else {
    console.error(`lan-proxy: ${String(error?.message ?? error)}`)
  }
  process.exit(1)
})

// Placed here, after every declaration above: `--check` reads the origin cache,
// and touching it before its `let` is a temporal-dead-zone error.
if (options.check) process.exit(await check())

server.listen(options.port, options.listen, () => {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      addresses.push(entry.address)
    }
  }
  console.log(`lan-proxy: listening on ${options.listen}:${options.port}`)
  console.log(`lan-proxy: origin file ${ORIGIN_FILE}`)
  const origin = currentOrigin()
  if (origin === null) {
    console.log(`lan-proxy: no origin yet (${cachedWhy}); will pick it up when the bridge mounts`)
  } else {
    console.log(`lan-proxy: forwarding to ${origin.href}`)
  }
  for (const address of addresses) {
    console.log(`  http://${address}:${options.port}/bridge?token=<TOKEN>`)
  }
})
