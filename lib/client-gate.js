/**
 * The per-client allowlist, and the one-time code that gets a device onto it.
 *
 * WHY THIS EXISTS. The token is the only secret between the LAN and this
 * machine, and a token that travels in a URL (a bookmark, a screenshot, a chat
 * message, a shared clipboard) leaks silently. This gate makes that leak
 * insufficient on its own: a peer that has never been approved is refused
 * *everything* until somebody at the machine reads a code off the loopback-only
 * setup page and types it on the device. So a leaked token buys an attacker
 * nothing until a human is standing at the computer.
 *
 * WHAT IT IS NOT. It is not a boundary against someone already on the LAN. ARP
 * spoofing can impersonate an approved address, DHCP hands a phone a new address
 * without asking, and a dual-stack or multi-homed device arrives under a
 * different spelling each time. Approving an address approves whoever can claim
 * it. Its real value is that a leaked token is no longer enough by itself.
 *
 * WHAT IS PERSISTED, AND WHAT IS NOT. The allowlist is on disk, so an approval
 * survives a restart. The pending codes are NOT: a code lives in memory for its
 * TTL, and a restart clears every un-approved device. That asymmetry is
 * deliberate — a code is a short-lived secret shown on the machine, and nothing
 * that short-lived belongs in a file.
 *
 * @module dsh-openai-bridge/client-gate
 */

import { randomInt } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sendJson, readJsonBody } from './http-util.js'

/** File name under `$DSH_HOME`. Also what the README tells operators to look for. */
export const CLIENTS_FILE_NAME = 'openai-bridge-clients.json'

/** Where a not-yet-approved device posts its code. */
export const DEFAULT_PAIR_PATH = '/pair'

/** Digits in a pairing code. */
const CODE_DIGITS = 6

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

/**
 * Read an allowlist out of whatever is on disk, tolerating anything.
 *
 * A file this module cannot understand must degrade to "nobody is approved"
 * rather than to "everybody is": the gate's whole job is to fail closed for
 * remote peers, and a corrupt file is not a reason to stop doing it.
 *
 * @param text - the file's contents, or `null` when there is no file.
 * @returns `{ version, clients }` with every entry normalised and de-duplicated.
 */
export function parseClients(text) {
  const empty = { version: 1, clients: [] }
  if (typeof text !== 'string' || text.trim() === '') return empty
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  // A bare array is accepted because it is the obvious thing to hand-write.
  const rows = Array.isArray(parsed) ? parsed : parsed?.clients
  if (!Array.isArray(rows)) return empty
  const seen = new Set()
  const clients = []
  for (const row of rows) {
    const ip = normalizePeer(row?.ip)
    if (ip === '' || seen.has(ip)) continue
    seen.add(ip)
    clients.push({
      ip,
      label: typeof row?.label === 'string' ? row.label.slice(0, 120) : '',
      firstSeen: Number.isFinite(row?.firstSeen) ? row.firstSeen : 0,
      lastSeen: Number.isFinite(row?.lastSeen) ? row.lastSeen : 0,
    })
  }
  return { version: 1, clients }
}

/** The allowlist's on-disk form. */
export function serializeClients(state) {
  return `${JSON.stringify({ version: 1, clients: state.clients }, null, 2)}\n`
}

/** A short human label for a device, taken from what it says about itself. */
function deviceLabel(req) {
  const agent = String(req.headers?.['user-agent'] ?? '')
  return agent.replace(/\s+/gu, ' ').trim().slice(0, 120)
}

/**
 * Build the gate.
 *
 * @param ctx - host plugin context, for logging.
 * @param options.enabled - `false` approves everyone, for an operator who has
 *   decided the LAN is trusted. Defaults to true.
 * @param options.file - allowlist path. Required when `enabled`.
 * @param options.pairPath - route a pending device posts its code to.
 * @param options.codeTtlMs - how long a minted code stays valid.
 * @param options.maxAttempts - wrong codes tolerated before the pending entry locks.
 * @param options.maxPending - how many waiting devices are kept. The oldest is
 *   dropped past this, so a sweep across the LAN cannot grow the map without
 *   bound, nor fill the operator's page with entries nobody will ever pair.
 * @param options.setupPath - the loopback page an automatic popup opens.
 * @param options.desktopPopup - whether a device starting to wait opens that page
 *   on this machine by itself. Defaults to true.
 * @param options.popupCooldownMs - shortest gap between two automatic popups, so a
 *   burst of unknown peers cannot spray browser windows across the desktop.
 * @param options.openPopup - opener, injected so the popup is testable with no browser.
 * @param options.now - clock, injected so the TTL is testable.
 * @param options.randomInt - code source, injected so a test can know the code.
 * @returns the gate. `check` answers `true` when it has fully handled a request,
 *   which means the caller must not continue. Every other member is for the
 *   loopback-only setup page, and none of them is ever surfaced to a phone.
 */
export function createClientGate(ctx, options = {}) {
  const enabled = options.enabled !== false
  const file = typeof options.file === 'string' ? options.file : ''
  const pairPath = typeof options.pairPath === 'string' && options.pairPath.startsWith('/')
    ? options.pairPath
    : DEFAULT_PAIR_PATH
  const codeTtlMs = Number.isFinite(options.codeTtlMs) && options.codeTtlMs > 0
    ? options.codeTtlMs
    : 10 * 60 * 1000
  const maxAttempts = Number.isFinite(options.maxAttempts) && options.maxAttempts > 0
    ? Math.floor(options.maxAttempts)
    : 5
  /** Kept small on purpose: this bounds what a LAN sweep can put on the screen. */
  const maxPending = Number.isFinite(options.maxPending) && options.maxPending > 0
    ? Math.floor(options.maxPending)
    : 16
  const setupPath = typeof options.setupPath === 'string' && options.setupPath.startsWith('/')
    ? options.setupPath
    : '/setup'
  const desktopPopup = options.desktopPopup !== false
  const popupCooldownMs = Number.isFinite(options.popupCooldownMs) && options.popupCooldownMs >= 0
    ? options.popupCooldownMs
    : 15 * 1000
  const openPopup = typeof options.openPopup === 'function'
    ? options.openPopup
    : (url) => { launchBrowser(ctx, url) }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const mint = typeof options.randomInt === 'function'
    ? () => String(options.randomInt()).padStart(CODE_DIGITS, '0').slice(-CODE_DIGITS)
    : () => String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0')

  /** Approved devices, in memory, mirrored to `file` whenever it changes. */
  let approved = new Map()
  /** Un-approved peers awaiting a code: `ip -> { code, expiresAt, attempts, locked, label }`. */
  const pending = new Map()

  if (enabled && file !== '') {
    try {
      const state = parseClients(readFileSync(file, 'utf8'))
      approved = new Map(state.clients.map((entry) => [entry.ip, entry]))
      if (approved.size > 0) {
        ctx.logger.info(`openai-bridge: ${approved.size} approved client(s) loaded from ${file}`)
      }
    } catch {
      // No file yet, or unreadable: nobody is approved, which is the safe answer.
    }
  }

  const flush = () => {
    if (file === '') return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, serializeClients({ clients: [...approved.values()] }), { mode: 0o600 })
    } catch (error) {
      // The approval still holds for this process; only its persistence failed.
      ctx.logger.warn(`openai-bridge: could not write the client allowlist to ${file}: ${String(error)}`)
    }
  }

  /**
   * Open the setup page on this machine, at most once per cooldown.
   *
   * The popup is the whole reason this feature is usable: an operator can see
   * that a device is waiting without going looking. It is also the only part
   * that a stranger can trigger, which is why the cooldown exists — a sweep
   * across the LAN would otherwise open a window per address.
   */
  let lastPopupAt = Number.NEGATIVE_INFINITY
  const maybePopup = (req, ip) => {
    if (!desktopPopup) return
    const at = now()
    if (at - lastPopupAt < popupCooldownMs) return
    lastPopupAt = at
    // Loopback, keeping the port the request arrived on: the operator is at this
    // machine, and the address the phone used may not even resolve from here.
    const host = typeof req.headers?.host === 'string' ? req.headers.host : ''
    const colon = host.lastIndexOf(':')
    const port = colon === -1 ? '' : host.slice(colon + 1)
    const url = `http://127.0.0.1${port === '' ? '' : `:${port}`}${setupPath}`
    ctx.logger.info(`openai-bridge: ${ip} is waiting to pair — opening ${url} on this machine`)
    try {
      openPopup(url)
    } catch (error) {
      ctx.logger.warn(`openai-bridge: could not open the pairing popup: ${String(error)}`)
    }
  }

  /** Find or mint the pending entry for one peer. */
  const pendingFor = (ip, req) => {
    let entry = pending.get(ip)
    // An expired entry is replaced whatever its state, including a locked one:
    // a lock that outlived its TTL would be a permanent lockout with nothing on
    // the setup page to explain it.
    if (entry === undefined || entry.expiresAt <= now()) {
      // Drop the oldest rather than refusing: every caller expects an entry, and
      // the operator only ever acts on the most recent one anyway.
      if (entry === undefined && pending.size >= maxPending) {
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, candidate] of pending) {
          if (candidate.firstSeen < oldestAt) {
            oldestAt = candidate.firstSeen
            oldestKey = key
          }
        }
        if (oldestKey !== undefined) {
          pending.delete(oldestKey)
          ctx.logger.warn(`openai-bridge: too many devices waiting to pair; dropped ${oldestKey}`)
        }
      }
      entry = {
        code: mint(),
        expiresAt: now() + codeTtlMs,
        attempts: 0,
        locked: false,
        label: deviceLabel(req),
        firstSeen: now(),
      }
      pending.set(ip, entry)
      ctx.logger.info(`openai-bridge: pairing code for ${ip} is shown on the setup page only`)
      maybePopup(req, ip)
    }
    return entry
  }

  /**
   * Mint a replacement code for a device that is already waiting.
   *
   * The operator needs this whenever a code has run out of attempts, or has been
   * read aloud to the wrong person: without it the only cure is waiting out the
   * TTL. The replacement clears the lock and restarts the clock, so a refresh is
   * always a way back in.
   *
   * @param ip - the waiting device.
   * @returns the new code, or `null` when that device is not waiting.
   */
  const refreshCode = (ip) => {
    const key = normalizePeer(ip)
    const entry = pending.get(key)
    if (entry === undefined) return null
    const fresh = {
      code: mint(),
      expiresAt: now() + codeTtlMs,
      attempts: 0,
      locked: false,
      label: entry.label,
      firstSeen: entry.firstSeen,
    }
    pending.set(key, fresh)
    ctx.logger.info(`openai-bridge: pairing code for ${key} was replaced from the setup page`)
    return fresh.code
  }

  const approve = (ip, req) => {
    const at = now()
    const existing = approved.get(ip)
    approved.set(ip, {
      ip,
      label: existing?.label || deviceLabel(req),
      firstSeen: existing?.firstSeen || at,
      lastSeen: at,
    })
    pending.delete(ip)
    flush()
    ctx.logger.info(`openai-bridge: approved ${ip}${existing === undefined ? '' : ' (already known)'}`)
  }

  const jsonRefusal = (res, ip) => sendJson(res, 403, {
    error: {
      message: '这个设备还没有被允许。请在电脑上打开设置页面读取验证码，然后在这台设备上填写。',
      type: 'client_not_allowed',
      client: ip,
      pairPath,
    },
  })

  const handlePairPost = async (req, res, ip) => {
    const entry = pendingFor(ip, req)
    let body
    try {
      body = await readJsonBody(req, 4096)
    } catch (error) {
      sendJson(res, typeof error?.status === 'number' ? error.status : 400, { ok: false, error: '请求格式不对。' })
      return
    }
    const supplied = String(body?.code ?? '').replace(/\D/gu, '')
    if (entry.locked) {
      sendJson(res, 429, { ok: false, error: '错误次数太多，这个验证码已作废。请在电脑上重新读取一个。' })
      return
    }
    if (entry.expiresAt <= now()) {
      // Expiry is handled by minting a fresh entry on the next request, so this
      // only happens for a submission that raced the boundary.
      sendJson(res, 410, { ok: false, error: '验证码过期了，请在电脑上重新读取一个。' })
      return
    }
    if (supplied === '' || supplied !== entry.code) {
      entry.attempts += 1
      if (entry.attempts >= maxAttempts) entry.locked = true
      sendJson(res, 403, {
        ok: false,
        error: entry.locked
          ? '错误次数太多，这个验证码已作废。请在电脑上重新读取一个。'
          : `验证码不对，还剩 ${maxAttempts - entry.attempts} 次。`,
        remaining: Math.max(0, maxAttempts - entry.attempts),
      })
      return
    }
    approve(ip, req)
    sendJson(res, 200, { ok: true, client: ip })
  }

  /**
   * Decide one request.
   * @returns `true` when the gate answered it, so the caller must stop.
   */
  const check = (req, res, url) => {
    if (!enabled) return false
    const ip = normalizePeer(req.socket?.remoteAddress)
    if (isLoopbackAddress(ip)) return false

    const known = approved.get(ip)
    if (known !== undefined) {
      known.lastSeen = now()
      return false
    }

    // A pending device may reach exactly one thing: the pair endpoint.
    if (url.pathname === pairPath && req.method === 'POST') {
      void handlePairPost(req, res, ip).catch((error) => {
        ctx.logger.warn(`openai-bridge: pairing failed for ${ip}: ${String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: '配对失败。' })
      })
      return true
    }

    const entry = pendingFor(ip, req)
    // An API client cannot render a page, so it gets the machine-readable
    // refusal; a browser gets the form that fixes it.
    if (url.pathname.startsWith('/v1')) {
      jsonRefusal(res, ip)
      return true
    }
    res.writeHead(403, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    })
    res.end(pairPage({ ip, pairPath, locked: entry.locked }))
    return true
  }

  const handler = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://bridge.invalid')
      const ip = normalizePeer(req.socket?.remoteAddress)
      if (isLoopbackAddress(ip) || approved.has(ip)) {
        sendJson(res, 404, { error: `unknown route ${req.method} ${url.pathname}` })
        return
      }
      if (req.method === 'POST') {
        await handlePairPost(req, res, ip)
        return
      }
      const entry = pendingFor(ip, req)
      res.writeHead(403, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      })
      res.end(pairPage({ ip, pairPath, locked: entry.locked }))
    })()
  }

  return {
    enabled,
    pairPath,
    file,
    /** The allowlist, for the loopback-only setup page. */
    clients: () => [...approved.values()].sort((a, b) => b.lastSeen - a.lastSeen),
    /**
     * Devices waiting for a code — WITH their codes. This is the loopback read
     * face, and the reason the phone's own API never exposes it.
     */
    pending: () => [...pending.entries()]
      .filter(([, entry]) => entry.expiresAt > now())
      .map(([ip, entry]) => ({
        ip,
        code: entry.code,
        label: entry.label,
        locked: entry.locked,
        attempts: entry.attempts,
        expiresAt: entry.expiresAt,
      })),
    /** Loopback-only: mint a replacement code for a device already waiting. */
    refreshCode,
    /** Loopback-only: forget a device, so it must pair again. */
    forget: (ip) => {
      const key = normalizePeer(ip)
      if (!approved.has(key)) return false
      approved.delete(key)
      flush()
      ctx.logger.info(`openai-bridge: forgot client ${key}`)
      return true
    },
    check,
    handler,
  }
}

/**
 * The page an un-approved device sees. It is deliberately a plain form with no
 * native dialog: this is the one page a device reaches before it is trusted, and
 * it has to work in whatever browser that device has.
 */
export function pairPage({ ip, pairPath, locked }) {
  const note = locked
    ? '这个设备的验证码已经作废（错误次数太多）。请让电脑上的人重新打开设置页面读取一个新的。'
    : '验证码只显示在运行 DSH 的那台电脑上：打开设置页面，在「待配对设备」里读取。'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>这台设备还没被允许</title>
<style>
:root{color-scheme:dark}
body{margin:0;padding:22px;background:#0d1117;color:#e6edf3;
font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:19px;margin:0 0 6px}
p{margin:0 0 14px;color:#8b949e;font-size:14px}
.me{font-family:ui-monospace,Consolas,monospace;color:#e6edf3}
input{width:100%;box-sizing:border-box;padding:14px;font:600 22px/1 ui-monospace,Consolas,monospace;
letter-spacing:.22em;text-align:center;background:#010409;color:#e6edf3;
border:1px solid #30363d;border-radius:10px;margin:8px 0 14px}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#1f6feb;color:#fff;
font:600 16px/1 system-ui,sans-serif;cursor:pointer}
button:disabled{opacity:.5}
.err{color:#ff7b72;font-size:14px;min-height:1.4em;margin:10px 0 0}
.ok{color:#3fb950;font-size:14px;min-height:1.4em;margin:10px 0 0}
.card{max-width:520px;margin:0 auto}
</style></head>
<body><div class="card">
<h1>这台设备还没被允许</h1>
<p>请求来自 <span class="me">${ip === '' ? '未知地址' : ip}</span>。</p>
<p>${note}</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="＿＿＿＿＿＿">
<button id="go" type="button">确认</button>
<div class="ok" id="ok"></div>
<div class="err" id="err"></div>
</div>
<script>
(function(){
  var input=document.getElementById('code'),go=document.getElementById('go'),
      ok=document.getElementById('ok'),err=document.getElementById('err');
  input.focus();
  function submit(){
    var code=(input.value||'').replace(/[^0-9]/g,'');
    if(code.length===0){err.textContent='先填验证码。';return}
    go.disabled=true;err.textContent='';ok.textContent='';
    fetch(${JSON.stringify(pairPath)},{method:'POST',cache:'no-store',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({code:code})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(d){return{ok:r.ok,status:r.status,d:d}})})
      .then(function(res){
        if(res.ok&&res.d.ok){ok.textContent='已允许，正在刷新…';location.reload();return}
        err.textContent=(res.d&&res.d.error)||('HTTP '+res.status);
        go.disabled=false;input.select();
      })
      .catch(function(e){err.textContent='连不上：'+e.message;go.disabled=false});
  }
  go.onclick=submit;
  input.addEventListener('keydown',function(e){if(e.key==='Enter')submit()});
})();
</script>
</body></html>`
}
