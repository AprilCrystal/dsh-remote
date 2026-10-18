/**
 * Tests for peer resolution behind a reverse proxy.
 *
 * The property worth asserting is not "the parser works" — it is that the
 * pairing gate keeps meaning what it says once the bridge sits behind a proxy:
 *
 *  - with nothing configured, the socket address is the peer, unchanged, so an
 *    existing deployment cannot notice this feature exists;
 *  - with a trusted hop configured, the peer is the CLIENT the hop names, not
 *    the hop — otherwise every phone inherits the proxy's loopback standing and
 *    is waved through without ever being approved;
 *  - a trusted hop that forwards nothing is an unidentified client, never the
 *    local operator;
 *  - a typo in the trust list must narrow the trust, never widen it.
 */

import { readNormalized } from './source.mjs'
import {
  isLoopbackAddress,
  isTrustedProxy,
  normalizePeer,
  parseForwardedFor,
  parseTrustedProxies,
  resolvePeer,
} from '../lib/peer.js'
import { isLoopback } from '../lib/setup.js'

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

/** A request as Node hands it to a route. */
const req = (remoteAddress, forwarded) => ({
  socket: { remoteAddress },
  headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
})

// ── the unchanged path ──────────────────────────────────────────────────────
{
  const direct = resolvePeer(req('10.0.0.5', '203.0.113.9'), [])
  ok('with no trust list the socket address is the peer', direct.address === '10.0.0.5')
  ok('and it is not marked as proxied', direct.viaProxy === false)
  ok('so a forwarded header is ignored entirely', direct.address !== '203.0.113.9')

  const mapped = resolvePeer(req('::ffff:127.0.0.1'), [])
  ok('an IPv4-mapped peer is normalised', mapped.address === '127.0.0.1')
  ok('which still reads as loopback', isLoopbackAddress(mapped.address))
}

// ── the trusted path ────────────────────────────────────────────────────────
{
  const proxied = resolvePeer(req('127.0.0.1', '10.0.0.5'), ['127.0.0.1'])
  ok('a trusted hop hands over the client address', proxied.address === '10.0.0.5')
  ok('the result is marked as proxied', proxied.viaProxy === true)
  ok('and is not a loopback client', !isLoopbackAddress(proxied.address))

  const chained = resolvePeer(req('127.0.0.1', '203.0.113.9, 10.0.0.5, 127.0.0.1'), ['127.0.0.1'])
  ok('the rightmost non-trusted hop wins', chained.address === '10.0.0.5')

  const cidr = resolvePeer(req('10.1.2.3', '198.51.100.7, 10.1.2.3'), ['10.0.0.0/8'])
  ok('a CIDR block can name the hop', cidr.address === '198.51.100.7')

  const withPort = resolvePeer(req('127.0.0.1', '10.0.0.5:51234'), ['127.0.0.1'])
  ok('a forwarded port suffix is stripped', withPort.address === '10.0.0.5')
}

// ── fail closed ─────────────────────────────────────────────────────────────
{
  // A bare request from a trusted address is this machine's own browser, not a
  // proxy that lost the header. Refusing it locked the operator out of the very
  // console the pairing flow depends on, which is how this was found.
  const direct = resolvePeer(req('127.0.0.1'), ['127.0.0.1'])
  ok('a trusted address with no forwarding markers is a direct client', direct.viaProxy === false)
  ok('and keeps its own address', direct.address === '127.0.0.1')
  ok('so the local console still opens', isLoopback(req('127.0.0.1'), ['127.0.0.1']))

  // A request that IS marked as forwarded, with no client address, still fails.
  const marked = (headers) => ({ socket: { remoteAddress: '127.0.0.1' }, headers })
  const silent = resolvePeer(marked({ 'x-forwarded-proto': 'http' }), ['127.0.0.1'])
  ok('a forwarded request with no client address is flagged', silent.unforwarded === true)
  ok('and has no address to judge', silent.address === '')
  ok('so it is refused rather than inherited',
    !isLoopback(marked({ 'x-forwarded-proto': 'http' }), ['127.0.0.1']))

  const blank = resolvePeer(
    marked({ 'x-forwarded-for': '   ', 'x-forwarded-proto': 'http' }),
    ['127.0.0.1'],
  )
  ok('a blank forwarded list still counts as forwarded', blank.unforwarded === true)

  const selfOnly = resolvePeer(req('127.0.0.1', '127.0.0.1'), ['127.0.0.1'])
  ok('a chain of only trusted hops leaves no client', selfOnly.unforwarded === true)
}

// ── a local client through the proxy is still local ─────────────────────────
{
  const local = resolvePeer(req('127.0.0.1', '127.0.0.1, 10.0.0.5'), ['127.0.0.1'])
  ok('the forwarded client is what decides', local.address === '10.0.0.5')
  ok('so a forwarded LAN client is not loopback', !isLoopback(req('127.0.0.1', '10.0.0.5'), ['127.0.0.1']))
  ok('while a forwarded loopback client is', isLoopback(req('127.0.0.1', '127.0.0.1'), ['10.9.9.9', '127.0.0.1']) === false)
}

// ── trust parsing cannot widen itself ───────────────────────────────────────
{
  ok('an empty list trusts nothing', parseTrustedProxies([]).length === 0)
  ok('a missing value trusts nothing', parseTrustedProxies(undefined).length === 0)
  ok('a bad CIDR digit count is dropped', parseTrustedProxies(['10.0.0.0/33']).length === 0)
  ok('a non-numeric CIDR is dropped', parseTrustedProxies(['10.0.0.0/eight']).length === 0)
  ok('a malformed exact address still gets a matcher', parseTrustedProxies(['not-an-address']).length === 1)
  ok('but it matches no real peer',
    !isTrustedProxy('10.0.0.5', parseTrustedProxies(['not-an-address'])))
  ok('a single string works like a one-entry list',
    isTrustedProxy('127.0.0.1', parseTrustedProxies('127.0.0.1')))
  ok('/0 would trust everything only if written',
    isTrustedProxy('8.8.8.8', parseTrustedProxies(['0.0.0.0/0'])) === true)
}

// ── the primitives themselves ───────────────────────────────────────────────
{
  ok('a mapped address normalises', normalizePeer('::FFFF:10.0.0.5') === '10.0.0.5')
  ok('a zone is dropped', normalizePeer('fe80::1%eth0') === 'fe80::1')
  ok('nothing stays nothing', normalizePeer(undefined) === '')
  ok('a comma header splits', parseForwardedFor('a, b ,c').join('|') === 'a|b|c')
  ok('an array header joins', parseForwardedFor(['a', 'b']).join('|') === 'a|b')
  ok('an absent header is empty', parseForwardedFor(undefined).length === 0)
}

// ── the wiring is real, not just the helper ─────────────────────────────────
{
  const gateSource = readNormalized(new URL('../lib/client-gate.js', import.meta.url))
  ok('the gate resolves the peer through the helper',
    gateSource.includes('resolvePeer(req, trustedProxies)'))
  ok('and no longer trusts the raw socket address', !gateSource.includes('req.socket?.remoteAddress'))
  ok('it refuses an unforwarded request', gateSource.includes('peer.unforwarded'))

  const setupSource = readNormalized(new URL('../lib/setup.js', import.meta.url))
  ok('the setup page asks the same question', setupSource.includes('isLoopback(req, trustedProxies)'))
  ok('and does not read the socket address itself',
    !setupSource.includes('req.socket?.remoteAddress'))

  const indexSource = readNormalized(new URL('../lib/index.js', import.meta.url))
  ok('the plugin reads the config key', indexSource.includes('config?.trustedProxies'))
  ok('and passes it to the gate', /createClientGate\(ctx, \{[\s\S]*?trustedProxies,/.test(indexSource))
  ok('and to the setup page', /installSetup\(ctx, \{[\s\S]*?trustedProxies,/.test(indexSource))
  ok('the LAN listener is started from the plugin, not by hand',
    indexSource.includes('startLanProxy(ctx, { origin, port, listen })'))
  ok('and its handle reaches the console',
    /installSetup\(ctx, \{[\s\S]*?lanProxy,/.test(indexSource))
  const setupPage = readNormalized(new URL('../lib/setup-page.html', import.meta.url))
  ok('which renders it', setupPage.includes("el('lanpill')"))

  // The LAN proxy has no way to guess a port the launcher picks at random, so the
  // plugin publishes it. Losing this file turns the proxy into a 503, so it is
  // worth pinning at the source level too.
  ok('the setup module publishes the listen origin',
    setupSource.includes('export function publishOrigin'))
  ok('named where the proxy looks for it', setupSource.includes("'openai-bridge-origin.txt'"))
  ok('and the plugin calls it before it can return early',
    indexSource.includes('publishOrigin(ctx,') &&
      indexSource.indexOf('publishOrigin(ctx,') < indexSource.indexOf("if (token === '')"))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
