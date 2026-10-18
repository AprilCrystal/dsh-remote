/**
 * Where a request actually came from.
 *
 * DSH can no longer bind a wildcard host — since `@deepseek-ai/dsh-host-webserver`
 * 0.2.1-rc.2 the schema rejects `0.0.0.0` while resolving config, and because
 * `webserver` is a required plugin that rejection stops the whole boot. A LAN
 * client therefore reaches this plugin through a reverse proxy, and behind one
 * `req.socket.remoteAddress` is the PROXY's address — loopback, when the proxy
 * runs on this machine.
 *
 * Acting on that socket address is what made the pairing gate meaningless: every
 * phone looked like the local operator and was waved through before it was ever
 * approved. `trustedProxies` names the hops whose forwarded address may be
 * believed; with nothing configured the socket address is the peer, exactly as
 * before, so this module adds no behaviour an existing deployment can notice.
 *
 * The rule that matters when it IS configured: a trusted proxy that forwards
 * nothing is not the local operator. It is an unidentifiable client, and the
 * gate must fail closed rather than inherit the proxy's own standing.
 */

/** Split a forwarded-for header into its hops. */
export function parseForwardedFor(header) {
  const raw = Array.isArray(header) ? header.join(',') : header
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop !== '')
}

/**
 * Drop a `:port` suffix, keeping IPv6 literals intact.
 *
 * Proxies vary on whether they append the source port. An IPv6 address contains
 * colons of its own, so only the single-colon (IPv4) shape is rewritten.
 */
function stripPort(value) {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(1, end)
  }
  return value.split(':').length === 2 ? value.slice(0, value.indexOf(':')) : value
}

/**
 * Collapse a socket peer address to one stable key.
 *
 * A dual-stack socket reports an IPv4 peer in IPv4-mapped form, and a link-local
 * IPv6 address can carry a zone. Without this, the same phone is a new device
 * every time it reconnects — which is exactly the bug that makes an allowlist
 * useless in practice.
 *
 * @param address - `req.socket.remoteAddress`, or anything else.
 * @returns the normalised key, or `''` when there was no address at all.
 */
export function normalizePeer(address) {
  let value = String(address ?? '').trim().toLowerCase()
  if (value === '') return ''
  const zone = value.indexOf('%')
  if (zone !== -1) value = value.slice(0, zone)
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length)
  return value
}

/** Whether a normalised address is this machine, which never needs pairing. */
export function isLoopbackAddress(address) {
  return address === '::1' || address.startsWith('127.')
}

/** Turn one dotted quad into an unsigned 32-bit number, or `undefined`. */
function ipv4ToNumber(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    result = result * 256 + octet
  }
  return result
}

/**
 * Read the `trustedProxies` config into matchers.
 *
 * One entry is an exact address (`127.0.0.1`) or an IPv4 CIDR block
 * (`10.0.0.0/8`). Anything unparseable is dropped rather than widened: a typo in
 * a security boundary must not become "trust everything".
 *
 * @param list - the config value: a string, an array of strings, or nothing.
 * @returns an array of `{ kind: 'exact' | 'cidr', ... }` matchers.
 */
export function parseTrustedProxies(list) {
  const entries = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : []
  const matchers = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    const text = stripPort(entry.trim().toLowerCase())
    if (text === '') continue
    const slash = text.indexOf('/')
    if (slash === -1) {
      matchers.push({ kind: 'exact', address: normalizePeer(text) })
      continue
    }
    const base = normalizePeer(text.slice(0, slash))
    const bits = Number(text.slice(slash + 1))
    const number = ipv4ToNumber(base)
    if (number === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) continue
    matchers.push({ kind: 'cidr', base: number, bits })
  }
  return matchers
}

/** Whether a normalised address matches one of the trusted-proxy matchers. */
export function isTrustedProxy(address, matchers) {
  const peer = normalizePeer(address)
  if (peer === '') return false
  for (const matcher of matchers) {
    if (matcher.kind === 'exact') {
      if (matcher.address === peer) return true
      continue
    }
    const number = ipv4ToNumber(peer)
    if (number === undefined) continue
    const shift = 32 - matcher.bits
    if (matcher.bits === 0) return true
    if (number >>> shift === matcher.base >>> shift) return true
  }
  return false
}

/**
 * Resolve the peer a request should be judged by.
 *
 * @param req - the incoming request.
 * @param trustedProxies - the configured hops, in any shape `parseTrustedProxies` takes.
 * @returns `{ address, viaProxy, unforwarded }`:
 *   `address` is `''` when there is nothing to judge,
 *   `viaProxy` says a trusted hop forwarded this request,
 *   `unforwarded` says a trusted hop forwarded NOTHING — the caller must refuse.
 */
export function resolvePeer(req, trustedProxies) {
  const socketPeer = normalizePeer(req?.socket?.remoteAddress)
  const matchers = parseTrustedProxies(trustedProxies)
  if (matchers.length === 0 || !isTrustedProxy(socketPeer, matchers)) {
    return { address: socketPeer, viaProxy: false, unforwarded: false }
  }

  const hops = parseForwardedFor(req?.headers?.['x-forwarded-for'])
  // Walk from the right: the last hop is the one our trusted proxy appended, and
  // anything it did not itself add is either an earlier proxy or the client.
  for (let index = hops.length - 1; index >= 0; index -= 1) {
    const hop = normalizePeer(stripPort(hops[index]))
    if (hop === '') continue
    if (isTrustedProxy(hop, matchers)) continue
    return { address: hop, viaProxy: true, unforwarded: false }
  }
  return { address: '', viaProxy: true, unforwarded: true }
}
