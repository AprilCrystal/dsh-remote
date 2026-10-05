import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readJsonBody, sendJson } from './http-util.js'

/**
 * Permission changes triggered from the phone, gated by a code the desktop shows.
 *
 * WHY NOT `ctx.approval.request`?
 * Approval requests must be raised from inside an open turn — the
 * `approval/asked` / `approval/decided` audit pair has to be enclosed by the
 * session log's commit boundary, so an idle ask is rejected before anything is
 * appended. A permission change tapped on the panel is an idle, turn-less
 * action, so the approval waterfall is simply not available here. This module
 * therefore implements its own, deliberately small, handshake:
 *
 *   1. the phone asks for a preset change — nothing is applied yet;
 *   2. the desktop gets a popup carrying a one-time 6-digit code;
 *   3. the phone must send that code back before anything is applied.
 *
 * The point of step 3 is that the code is only ever displayed on the machine
 * being protected. Someone who merely holds the panel token — a phone left
 * unlocked, a URL pasted into the wrong chat — still cannot loosen the sandbox.
 *
 * `danger-full-access` is kept out of the default allow-list on purpose: a phone
 * is the easiest surface to lose, and that preset cannot be walked back from the
 * phone if it is granted by mistake.
 *
 * HONEST SCOPE: the `view` key below keeps the code out of the phone's reach,
 * but it is NOT a cryptographic boundary — one bearer token authenticates both
 * surfaces, and the whole LAN link is cleartext. It stops the code from being
 * readable at the phone's own URL; it does not stop a LAN eavesdropper who
 * already has the token.
 */

const DEFAULT_PRESETS = ['read-only', 'workspace-write']
const DEFAULT_TTL_MS = 3 * 60 * 1000
const MAX_ATTEMPTS = 5
const MAX_PENDING = 32

/**
 * Build the gate. Returns `{ handle }`, where `handle` answers every route under
 * the panel prefix that this feature owns:
 *
 *   GET  /permission-ui.js      the panel-side dialog (served verbatim from disk)
 *   GET  /desktop/              the desktop popup that displays the code
 *   GET  /desktop/state         popup polling — the ONLY route that reveals a code
 *   POST /desktop/reject        the desktop refusing the request outright
 *   GET  /api/perm?action=options   presets the phone may ask for
 *   POST /api/perm?action=request   open a request (no effect yet)
 *   POST /api/perm?action=confirm   send the code back — this applies the change
 *   POST /api/perm?action=cancel    the phone withdrawing its own request
 *   GET  /api/perm?action=state     phone polling; never carries a code
 */
export function createPermissionGate(ctx, options) {
  const {
    basePath,
    token,
    runtime,
    desktopPopup = true,
    fixedCode = '',
    ttlMs = DEFAULT_TTL_MS,
    allowedPresets = DEFAULT_PRESETS,
    enabled = true,
  } = options

  const requests = new Map()
  let seq = 0
  let uiScript = null

  // 'fixed' means the operator configured the code themselves; 'display' means
  // the server mints one per request and the desktop is the only place it shows.
  const mode = fixedCode === '' ? 'display' : 'fixed'

  const service = () => ctx.get('permissionPresets')
  const nowMs = () => Date.now()
  const randomCode = () => String(Math.floor(100000 + Math.random() * 900000))

  const expireIfStale = (rec) => {
    if (rec.status === 'pending' && nowMs() > rec.expiresAt) rec.status = 'expired'
    return rec
  }

  /** Drop settled records so a long-lived process cannot grow this map forever. */
  const sweep = () => {
    for (const [id, rec] of requests) {
      expireIfStale(rec)
      if (rec.status !== 'pending') requests.delete(id)
    }
    while (requests.size > MAX_PENDING) requests.delete(requests.keys().next().value)
  }

  // ── the actual privilege change ────────────────────────────────────────────
  //
  // Serialized against the session's turns: flipping the sandbox while a turn is
  // mid-flight would change the rules underneath running tool calls.
  const applyPreset = async (rec) => {
    const svc = service()
    await runtime.serialize(rec.sessionId, async () => {
      const agent = await runtime.ensureAgent(rec.sessionId)
      svc.set(agent.session, rec.preset)
      // Read it back. A preset can be accepted and still not stick (an unknown
      // name throws, a projection can lag); reporting the observed value keeps
      // the phone from claiming a change that did not happen.
      rec.applied = svc.current(agent.session)
    })
    if (rec.applied !== rec.preset) {
      throw Object.assign(
        new Error(`授权已通过，但档位没有生效（期望 ${rec.preset}，实际 ${String(rec.applied)}）`),
        { status: 500, applied: rec.applied },
      )
    }
  }

  // ── desktop popup presentation ─────────────────────────────────────────────

  /** Swap the request's own host for loopback so the popup opens on this PC. */
  const popupUrl = (req, rec) => {
    const host = typeof req.headers?.host === 'string' ? req.headers.host : ''
    const colon = host.lastIndexOf(':')
    const port = colon === -1 ? '' : host.slice(colon + 1)
    const origin = `http://127.0.0.1${port === '' ? '' : `:${port}`}`
    // The token rides along because the popup is opened cold, with no panel
    // cookie yet. The bootstrap route trades it for a cookie and then drops it
    // from the URL, so it does not survive in the address bar.
    const query = `id=${encodeURIComponent(rec.id)}&view=${rec.view}&token=${encodeURIComponent(token)}`
    return `${origin}${basePath}/desktop/?${query}`
  }

  // Best-effort, and deliberately isolated: if opening a browser fails the
  // handshake still works (the URL is logged), so it must never throw upward.
  const openPopup = (req, rec) => {
    const url = popupUrl(req, rec)
    ctx.logger.info(`openai-bridge: permission request ${rec.id} — desktop popup ${url}`)
    if (!desktopPopup) return
    void (async () => {
      try {
        const { spawn } = await import('node:child_process')
        // `url.dll,FileProtocolHandler` hands the URL to the default browser
        // without a shell, so `&` in the query needs no quoting at all.
        const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        })
        child.on('error', () => {})
        child.unref()
      } catch (error) {
        ctx.logger.warn(`openai-bridge: could not open the desktop popup: ${String(error)}`)
      }
    })()
  }

  const popupHtml = (rec) => String.raw`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 权限授权</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:16px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#0d1117; color:#e6edf3; }
  .card { width:min(560px,92vw); background:#161b22; border:1px solid #30363d;
          border-radius:14px; padding:22px 24px; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8b949e; font-size:13px; margin:0 0 18px; }
  .code { font:700 46px/1 ui-monospace,Consolas,"Courier New",monospace;
          letter-spacing:.14em; color:#4493f8; margin:4px 0 6px; }
  .hint { color:#8b949e; font-size:13px; margin:0 0 16px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:0 0 16px; font-size:14px; }
  dt { color:#8b949e; }
  dd { margin:0; overflow-wrap:anywhere; }
  .status { margin-top:14px; padding:10px 12px; border-radius:8px; font-size:14px;
            background:#0d1117; border:1px solid #30363d; }
  .status.ok { border-color:#238636; color:#7ee787; }
  .status.bad { border-color:#f85149; color:#ff7b72; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid #30363d;
           background:#21262d; color:#e6edf3; cursor:pointer; }
  button:hover:enabled { border-color:#8b949e; }
  button:disabled { opacity:.45; cursor:default; }
</style>
</head>
<body>
<div class="card">
  <h1>手机端请求变更权限</h1>
  <p class="sub" id="sub">正在读取这次请求…</p>
  <div id="coded" style="display:none">
    <div class="code" id="code">------</div>
    <p class="hint">请在手机上输入上面的验证码来完成授权。</p>
  </div>
  <dl>
    <dt>会话</dt><dd id="sess">—</dd>
    <dt>目标档位</dt><dd id="preset">—</dd>
  </dl>
  <p style="margin:0"><button id="reject">拒绝这次请求</button></p>
  <div class="status" id="status">连接中…</div>
</div>
<script>
var q = new URLSearchParams(location.search);
var reqId = q.get('id') || '';
var viewKey = q.get('view') || '';
var timer = null;

function setText(id, text) {
  var node = document.getElementById(id);
  if (node) node.textContent = text;
}

function render(state) {
  setText('sess', state.sessionId || '—');
  setText('preset', state.preset || '—');
  if (state.mode === 'display' && state.code) {
    document.getElementById('coded').style.display = '';
    setText('code', state.code);
    setText('sub', '这个验证码只会显示在这台电脑上。');
  } else if (state.mode === 'fixed') {
    setText('sub', '请让手机端输入你配置好的固定验证码。');
  }
  var words = {
    pending: '等待手机端输入验证码…',
    approved: '已授权 —— 档位已生效，可以关闭本页。',
    rejected: '这次请求已被拒绝。',
    expired: '已过期，请在手机上重新发起。',
    cancelled: '手机端已撤回这次请求。'
  };
  var box = document.getElementById('status');
  setText('status', words[state.status] || state.status);
  box.className = 'status' + (state.status === 'approved' ? ' ok'
    : (state.status === 'pending' ? '' : ' bad'));
  if (state.status !== 'pending' && timer !== null) {
    clearInterval(timer);
    timer = null;
    document.getElementById('reject').disabled = true;
  }
}

function tick() {
  fetch('state?id=' + encodeURIComponent(reqId) + '&view=' + encodeURIComponent(viewKey))
    .then(function (res) { return res.json(); })
    .then(render)
    .catch(function () { setText('status', '无法连接到 Harness（它可能已经退出）。'); });
}

document.getElementById('reject').onclick = function () {
  fetch('reject?id=' + encodeURIComponent(reqId) + '&view=' + encodeURIComponent(viewKey), { method: 'POST' })
    .then(tick);
};

timer = setInterval(tick, 1500);
tick();
</script>
</body>
</html>`

  /** Load the panel-side dialog once, lazily, so a missing file cannot break mount. */
  const panelScript = () => {
    if (uiScript === null) uiScript = readFileSync(new URL('./permission-ui.js', import.meta.url), 'utf8')
    return uiScript
  }

  const lookupPopup = (url) => {
    const seen = url.searchParams.get('view') ?? ''
    const rec = requests.get(url.searchParams.get('id') ?? '')
    if (rec === undefined) return undefined
    // The view key is what separates "the popup on the PC" from "the phone's
    // poll". Without it the code would be one guessable URL away.
    if (seen === '' || seen !== rec.view) return undefined
    return expireIfStale(rec)
  }

  /**
   * @returns {Promise<boolean>} true when this module owned the route.
   */
  const handle = async (req, res, url, rest) => {
    // A disabled gate owns nothing: every route falls through to the panel's own
    // 404, so the dialog script is never served and the chip never appears.
    if (!enabled) return false
    try {
      if (rest === '/permission-ui.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(panelScript())
        return true
      }

      // Canonicalize: the popup's own fetches are relative, so it must be served
      // with a trailing slash or `state?...` would climb out of `/desktop/`.
      if (rest === '/desktop') {
        const qs = url.searchParams.toString()
        res.writeHead(308, {
          location: `${basePath}/desktop/${qs === '' ? '' : `?${qs}`}`,
          'cache-control': 'no-store',
        })
        res.end()
        return true
      }

      if (rest === '/desktop/') {
        const rec = lookupPopup(url)
        if (rec === undefined) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end('<!doctype html><meta charset="utf-8"><title>授权请求已失效</title>'
            + '<body style="font:16px/1.7 system-ui;background:#0d1117;color:#e6edf3;padding:28px">'
            + '<h3 style="margin:0 0 10px">这个授权请求已经失效</h3>'
            + '<p style="color:#8b949e">它可能已被处理、已过期，或链接不完整。</p>')
          return true
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(popupHtml(rec))
        return true
      }

      if (rest === '/desktop/state') {
        const rec = lookupPopup(url)
        if (rec === undefined) {
          sendJson(res, 404, { error: 'this authorization request is gone' })
          return true
        }
        sendJson(res, 200, {
          id: rec.id,
          status: rec.status,
          preset: rec.preset,
          mode: rec.mode,
          sessionId: rec.sessionId,
          expiresAt: rec.expiresAt,
          code: rec.mode === 'display' ? rec.code : '',
          applied: rec.applied,
        })
        return true
      }

      if (rest === '/desktop/reject') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return true }
        const rec = lookupPopup(url)
        if (rec === undefined) { sendJson(res, 404, { error: 'this authorization request is gone' }); return true }
        if (rec.status === 'pending') rec.status = 'rejected'
        sendJson(res, 200, { ok: true, status: rec.status })
        return true
      }

      if (rest !== '/api/perm') return false

      const action = url.searchParams.get('action') ?? ''

      if (action === 'options') {
        sweep()
        const svc = service()
        if (svc === undefined) { sendJson(res, 503, { error: 'permission presets are unavailable' }); return true }
        const options = allowedPresets
          .filter((name) => svc.names.includes(name))
          .map((name) => svc.optionOf(name))
        const sessionId = url.searchParams.get('session') ?? ''
        const fresh = url.searchParams.get('fresh') === '1'
        let current = null
        // A brand-new conversation has no session yet. Resuming one just to read
        // its preset would materialize an empty session in the desktop list, so
        // the caller tells us to skip that and show the default instead.
        if (!fresh && sessionId !== '') {
          try {
            const agent = await runtime.ensureAgent(sessionId)
            current = svc.current(agent.session)
          } catch (error) {
            ctx.logger.warn(`openai-bridge: could not read the preset for ${sessionId}: ${String(error)}`)
          }
        }
        sendJson(res, 200, {
          options,
          allowed: allowedPresets,
          current,
          defaultPreset: svc.defaultPreset,
          mode,
          ttlMs,
        })
        return true
      }

      if (action === 'state') {
        const rec = requests.get(url.searchParams.get('id') ?? '')
        if (rec === undefined) { sendJson(res, 404, { error: 'this request is gone' }); return true }
        expireIfStale(rec)
        // Deliberately NO code here: the phone polls this route.
        sendJson(res, 200, {
          id: rec.id,
          status: rec.status,
          preset: rec.preset,
          mode: rec.mode,
          applied: rec.applied,
          expiresAt: rec.expiresAt,
          attemptsLeft: Math.max(0, MAX_ATTEMPTS - rec.attempts),
        })
        return true
      }

      if (req.method !== 'POST') { sendJson(res, 405, { error: 'POST required' }); return true }

      const svc = service()
      if (svc === undefined) { sendJson(res, 503, { error: 'permission presets are unavailable' }); return true }
      const body = await readJsonBody(req)

      if (action === 'request') {
        sweep()
        const sessionId = typeof body?.session === 'string' ? body.session.trim() : ''
        const preset = typeof body?.preset === 'string' ? body.preset.trim() : ''
        if (sessionId === '') throw Object.assign(new Error('session is required'), { status: 400 })
        if (!allowedPresets.includes(preset)) {
          throw Object.assign(
            new Error(`档位 ${preset} 不允许从手机端变更`),
            { status: 403 },
          )
        }
        if (!svc.names.includes(preset)) {
          throw Object.assign(new Error(`未知的档位 ${preset}`), { status: 400 })
        }
        const rec = {
          id: `pg-${String(++seq)}`,
          sessionId,
          preset,
          mode,
          code: mode === 'display' ? randomCode() : String(fixedCode),
          view: randomBytes(16).toString('hex'),
          status: 'pending',
          attempts: 0,
          createdAt: nowMs(),
          expiresAt: nowMs() + ttlMs,
        }
        requests.set(rec.id, rec)
        openPopup(req, rec)
        // No code, no view key: the phone must get it from the person at the PC.
        sendJson(res, 201, { id: rec.id, mode: rec.mode, preset: rec.preset, expiresAt: rec.expiresAt })
        return true
      }

      if (action === 'confirm') {
        const rec = requests.get(String(body?.id ?? ''))
        if (rec === undefined) { sendJson(res, 404, { error: '这次请求已经不存在了，请重新发起' }); return true }
        expireIfStale(rec)
        if (rec.status !== 'pending') {
          sendJson(res, 409, { error: `这次请求已经 ${rec.status}`, status: rec.status })
          return true
        }
        if (String(body?.code ?? '').trim() !== rec.code) {
          rec.attempts += 1
          const left = Math.max(0, MAX_ATTEMPTS - rec.attempts)
          if (left === 0) rec.status = 'rejected'
          sendJson(res, 403, {
            error: left === 0 ? '验证码错误次数过多，这次请求已被作废' : `验证码不正确，还可以再试 ${left} 次`,
            status: rec.status,
            attemptsLeft: left,
          })
          return true
        }
        await applyPreset(rec)
        rec.status = 'approved'
        sendJson(res, 200, { ok: true, status: rec.status, preset: rec.preset, applied: rec.applied })
        return true
      }

      if (action === 'cancel') {
        const rec = requests.get(String(body?.id ?? ''))
        if (rec === undefined) { sendJson(res, 404, { error: '这次请求已经不存在了' }); return true }
        expireIfStale(rec)
        if (rec.status === 'pending') rec.status = 'cancelled'
        sendJson(res, 200, { ok: true, status: rec.status })
        return true
      }

      sendJson(res, 400, { error: `unknown permission action ${action}` })
      return true
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      ctx.logger.warn(`openai-bridge: permission gate ${rest} failed: ${String(error)}`)
      if (res.headersSent) { res.destroy(); return true }
      sendJson(res, status, {
        error: String(error?.message ?? error),
        ...(error?.applied === undefined ? {} : { applied: error.applied }),
      })
      return true
    }
  }

  return { handle, enabled, pendingCount: () => requests.size }
}
