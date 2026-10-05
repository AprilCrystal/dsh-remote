/**
 * dsh-openai-bridge — the mobile read-only panel served under `/bridge`.
 *
 * Deliberately dependency-free: everything here is node: builtins plus Cordis
 * services reached through `ctx.get(...)`, so a change to a harness package
 * cannot break this module at import time.
 *
 * Two security properties are load-bearing:
 *
 *  1. File access is confined to a resolved root. Every path is resolved and
 *     re-checked against `realpath` of both the root and the target, so neither
 *     `..` nor a symlink can escape.
 *
 *  2. The ONLY write this module performs is an upload into one fixed `_inbox`
 *     directory. Everything else on this machine stays behind the DSH sandbox
 *     and its approval waterfall — the panel must never become a second,
 *     unapproved write path.
 *
 * @module dsh-openai-bridge/panel
 */

import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createPermissionGate } from './permission-gate.js'
import { createModelControl } from './model-control.js'

/** Cookie carrying the panel session. */
const COOKIE_NAME = 'dsh_bridge'

/** Only files at or below this size are previewed as text. */
const PREVIEW_MAX_BYTES = 512 * 1024

/** Hard ceiling for one upload. */
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

/** The single directory uploads may land in, relative to the browse root. */
const INBOX_DIR = '_inbox'

/**
 * The bottom-right action cluster, read once and served verbatim.
 *
 * It is its own asset rather than more inline script because the panel's whole
 * page lives in one template literal, where an ordinary backtick or regex escape
 * is a landmine. A separate file has none of those constraints.
 */
let fabSource = null
function fabAsset() {
  if (fabSource === null) fabSource = readFileSync(new URL('./panel-fab.js', import.meta.url), 'utf8')
  return fabSource
}

/**
 * Join one shell template.
 *
 * Uses the RAW strings, because this template emits HTML/CSS/JS source: the
 * escape sequences must reach the output verbatim so the browser parses them.
 * The cooked strings would be wrong twice over — a tagged template yields
 * `undefined` for any segment holding an invalid escape, so a single regex
 * `\s` in the embedded script turns the entire page into the text "undefined".
 */
function html(strings, ...values) {
  const parts = strings.raw ?? strings
  return parts.reduce((out, part, index) => out + part + (index < values.length ? String(values[index]) : ''), '')
}

/** Escape text for HTML interpolation. */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Parse a Cookie header into a plain map. */
function parseCookies(header) {
  const out = new Map()
  if (typeof header !== 'string') return out
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    out.set(segment.slice(0, at).trim(), segment.slice(at + 1).trim())
  }
  return out
}

/** Whether this request carries the panel credential, in a header or the cookie. */
function authenticated(req, token) {
  const cookies = parseCookies(req.headers['cookie'])
  if (cookies.get(COOKIE_NAME) === token) return true
  const header = req.headers['authorization']
  if (typeof header !== 'string') return false
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
  return match !== null && match[1] === token
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limitBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error(`body exceeds ${String(limitBytes)} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Read and JSON-parse a bounded request body; an empty body is `{}`. */
async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const text = (await readBody(req, limitBytes)).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

/** Reject any target that is not the root itself or genuinely beneath it. */
function assertInside(root, candidate) {
  const rootResolved = resolve(root)
  const target = resolve(candidate)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) {
    throw Object.assign(new Error('path escapes the browse root'), { status: 403 })
  }
  return target
}

/**
 * Resolve a client-supplied relative path inside the browse root, following
 * symlinks before the containment check so a link cannot point outward.
 */
async function resolveInsideRoot(root, requested) {
  const rootReal = await realpath(resolve(root))
  const asked = requested ?? ''
  // Client paths are ALWAYS relative. `path.join` folds an absolute argument
  // into the root as literal text (`join('C:\a', 'C:\b')` -> `C:\a\C:\b`), so
  // without this guard an absolute path silently becomes a nonsense in-root
  // target instead of an error. The drive-letter and separator tests cover the
  // cross-platform case, where `isAbsolute` judges only the host's own shape.
  if (isAbsolute(asked) || /^[A-Za-z]:/u.test(asked) || asked.startsWith('/') || asked.startsWith('\\')) {
    throw Object.assign(new Error('absolute paths are not accepted'), { status: 403 })
  }
  const candidate = assertInside(rootReal, join(rootReal, asked === '' ? '.' : asked))
  let target
  try {
    target = await realpath(candidate)
  } catch (error) {
    // A missing leaf is fine for a create-style target; its parent must be inside.
    if (error.code !== 'ENOENT') throw error
    const parent = await realpath(resolve(candidate, '..')).catch(() => rootReal)
    assertInside(rootReal, parent)
    return candidate
  }
  return assertInside(rootReal, target)
}

/**
 * Every fixed drive, probed live.
 *
 * A: and B: are deliberately skipped: on a machine that still loads a floppy
 * driver, probing them can block for seconds. A drive that appears after startup
 * is picked up on the next listing, so mounting one needs no restart.
 */
function fixedDrives() {
  const drives = []
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    try {
      if (statSync(`${letter}:\\`).isDirectory()) drives.push(`${letter}:\\`)
    } catch {
      // Absent, or present but not ready (an empty optical drive). Not a root.
    }
  }
  return drives
}

/** One path shape round-trips to the phone, so Windows separators become slashes. */
function slashPath(value) {
  return String(value).split(sep).join('/')
}

/** Join two browsable fragments without doubling a separator. */
function joinBrowsable(base, name) {
  if (base === '') return name
  return `${base.replace(/[\\/]+$/u, '')}/${name}`
}

/**
 * Resolve one browse path against the allow-list of roots.
 *
 * An absolute path is accepted when it lands inside SOME root; a relative path is
 * resolved against the first root, which is what keeps a single-root deployment
 * behaving exactly as it did before the list existed. Symlinks are followed
 * before the containment check, so a link cannot point outward.
 *
 * @returns `{ target, root }` — the resolved real path, and the root it matched,
 *   so callers can tell "at a root" without re-resolving anything.
 */
async function resolveWithinRoots(roots, requested) {
  if (roots.length === 0) {
    throw Object.assign(new Error('no browse root is configured'), { status: 500 })
  }
  const asked = requested ?? ''
  // Reject traversal textually first. The realpath check below is the actual
  // enforcement; this only makes the error describe the real mistake.
  if (asked.split(/[\\/]+/u).includes('..')) {
    throw Object.assign(new Error('path traversal is not allowed'), { status: 400 })
  }
  const target = isAbsolute(asked) ? resolve(asked) : resolve(roots[0], asked)
  let real
  try {
    real = await realpath(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw Object.assign(new Error('no such file or directory'), { status: 404 })
  }
  for (const root of roots) {
    try {
      const rootReal = await realpath(resolve(root))
      // `rootReal` already ends in a separator when the root IS a drive root
      // (`C:\`), so appending one unconditionally would match nothing under it.
      const base = rootReal.endsWith(sep) ? rootReal : rootReal + sep
      if (real === rootReal || real.startsWith(base)) return { target: real, root: rootReal }
    } catch {
      // An unreadable root is simply not a match — never a reason to allow.
    }
  }
  throw Object.assign(new Error('path is outside every allowed root'), { status: 403 })
}

/** Build one directory listing entry. */
async function entryOf(directory, name) {
  const full = join(directory, name)
  try {
    const info = await stat(full)
    return {
      name,
      type: info.isDirectory() ? 'dir' : 'file',
      size: info.isDirectory() ? 0 : info.size,
      mtime: info.mtimeMs,
    }
  } catch {
    return { name, type: 'other', size: 0, mtime: 0 }
  }
}

/** Heuristic binary sniff: a NUL byte in the first block means "not text". */
function looksBinary(buffer) {
  const window = buffer.subarray(0, Math.min(buffer.length, 8192))
  return window.includes(0)
}

/** Pull displayable text out of either message-event shape. */
function messageText(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return ''
  // `assistant/message` wraps its payload; `user/message` IS the message.
  const message = typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('')
}

/**
 * Split one message event into typed blocks for the panel.
 *
 * Only `text` is the visible reply; `reasoning`, tool activity and attachments
 * are the non-reply content the client folds away. The vocabulary is the
 * harness's own `ContentBlockMap` (text / reasoning / image / file / tool-call
 * / tool-result), and unknown members are passed through rather than dropped
 * because that map is merge-extensible.
 */
function messageBlocks(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return []
  const message = typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(message.content) ? message.content : []
  const blocks = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') blocks.push({ kind: 'text', text: block.text })
        break
      case 'reasoning':
        if (typeof block.text === 'string' && block.text !== '') blocks.push({ kind: 'reasoning', text: block.text })
        break
      case 'tool-call':
        blocks.push({
          kind: 'tool-call',
          name: typeof block.name === 'string' ? block.name : 'tool',
          text: typeof block.arguments === 'string' ? block.arguments : '',
        })
        break
      case 'tool-result': {
        const inner = Array.isArray(block.content) ? block.content : []
        blocks.push({
          kind: 'tool-result',
          error: block.isError === true,
          text: inner
            .filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .join(''),
        })
        break
      }
      case 'image':
      case 'file':
        blocks.push({ kind: 'attachment', text: '[' + String(block.type) + ']' })
        break
      default:
        blocks.push({ kind: 'other', text: '[' + String(block.type) + ']' })
    }
  }
  return blocks
}

/**
 * Mount the panel.
 * @param ctx - host plugin context.
 * @param options - resolved panel options.
 * @param options.token - shared panel credential.
 * @param options.fileRoot - directory the browser is confined to.
 * @param options.basePath - route prefix, e.g. `/bridge`.
 */
export function installPanel(ctx, options) {
  const { token, fileRoot, basePath, approvalCwd, runtime } = options

  // Uploads deliberately do NOT follow the browse roots. With `fileRoot: '*'`
  // the first root is a drive letter, and `C:\_inbox` is not somewhere to write;
  // the inbox stays anchored to the session workspace instead.
  const inboxAnchor = options.inboxRoot ?? (Array.isArray(fileRoot) ? fileRoot[0] : fileRoot)
  if (inboxAnchor === undefined || inboxAnchor === '' || inboxAnchor === '*') {
    throw new Error('installPanel needs inboxRoot when fileRoot is not a concrete path')
  }
  const inbox = join(resolve(inboxAnchor), INBOX_DIR)

  /**
   * The browse allow-list. `'*'` means every fixed drive, enumerated live so a
   * drive mounted after startup is reachable without a restart.
   */
  const browseRoots = () => {
    if (fileRoot === '*') return fixedDrives()
    const list = Array.isArray(fileRoot) ? fileRoot : [fileRoot]
    return list
      .filter((entry) => typeof entry === 'string' && entry !== '')
      .map((entry) => resolve(entry))
  }

  // Phone-triggered permission changes. Kept in its own module because it is the
  // only thing in this plugin that can widen the sandbox, and it is worth being
  // able to read that in one sitting.
  const gate = createPermissionGate(ctx, { basePath, token, runtime, ...(options.permission ?? {}) })

  // Per-session model switching. Absent when the host supplied no callbacks — a
  // bare panel mount, as in the tests — in which case both the API and the picker
  // are left out entirely rather than served broken.
  const models = options.model === undefined
    ? null
    : createModelControl(ctx, { basePath, runtime, ...options.model })

  // ── approvals the panel may answer ────────────────────────────────────────
  //
  // A pending record holds the resolver for one in-flight `approval/request`.
  // The panel and the desktop GUI are asked SIMULTANEOUSLY: `next()` runs
  // immediately so a person already looking at the desktop prompt sees no added
  // delay, while the panel is offered the same decision in parallel. Whichever
  // answers first claims it; the harness discards a late answer.
  //
  // Scope: only sessions in `approvalCwd` are offered here. A desktop session's
  // prompt must not start appearing on a phone that merely has the panel open.
  const pending = new Map()
  let approvalSeq = 0

  /** Whether this request belongs to a session the panel is allowed to answer. */
  const panelOwns = (req) => {
    if (approvalCwd === undefined) return true
    const cwd = req?.agent?.session?.header?.cwd
    return typeof cwd === 'string' && resolve(cwd) === resolve(approvalCwd)
  }

  ctx.on('approval/request', (req, next) => {
    if (!panelOwns(req)) return next()
    const downstream = next()
    const id = `ap-${String(++approvalSeq)}`
    const mine = new Promise((settle) => {
      pending.set(id, {
        id,
        toolName: typeof req.toolName === 'string' ? req.toolName : 'tool',
        reason: typeof req.reason === 'string' ? req.reason : undefined,
        sessionId: req.agent?.session?.id === undefined ? undefined : String(req.agent.session.id),
        createdAt: Date.now(),
        decide: (outcome) => { pending.delete(id); settle(outcome) },
      })
      req.signal?.addEventListener('abort', () => { pending.delete(id) }, { once: true })
    })
    return Promise.race([downstream, mine]).finally(() => { pending.delete(id) })
  }, { prepend: true })

  const shellTemplate = html`<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>DSH Bridge</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --accent:#4493f8; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  /* iOS inflates text in some layouts, which reads as a wrong zoom level. */
  html { -webkit-text-size-adjust:100%; }
  /* Horizontal-overflow guard. ONE wide child — a long code line, a wide table,
     an unbroken path — otherwise makes the whole page pan sideways, which is
     exactly the "over-zoomed" feel this fixes. Elements that are meant to
     scroll (code, tables) keep their own internal scroll; this only stops the
     overflow escaping to the page. Note the guard is on the main element, not
     on body: overflow on an ancestor turns it into the sticky header's
     scrollport and breaks the header pinning to the viewport. */
  html, body { max-width:100%; }
  header { overflow:hidden; }
  /* flex:1 makes main fill the viewport column; the composer's margin-top:auto
     then pins it to the bottom even when the transcript is short. */
  main { flex:1; display:flex; flex-direction:column; overflow-x:hidden; }
  .msg { min-width:0; }
  .md { overflow-wrap:anywhere; }
  pre, .md table { max-width:100%; }
  body { margin:0; background:var(--bg); color:var(--fg);
         /* Viewport-height flex column so SHORT conversations still push the
            composer to the bottom. sticky;bottom:0 alone does nothing when the
            content is shorter than the screen — there is no slack to stick
            against, so the composer sits after the content with a blank field
            below it. dvh tracks the mobile URL bar; vh is the fallback. */
         display:flex; flex-direction:column;
         min-height:100vh; min-height:100dvh;
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
  /* Sticky top bar: the only place navigation lives, so it stays reachable no
     matter how far down a long transcript you have scrolled. */
  header { position:sticky; top:0; z-index:20; display:flex; align-items:center; gap:10px;
           background:var(--panel); border-bottom:1px solid var(--line);
           padding:calc(env(safe-area-inset-top) + 8px) 10px 8px; }
  .hbtn { flex:none; width:38px; height:38px; padding:0; font:inherit; font-size:17px; line-height:1;
          color:var(--fg); background:#21262d; border:1px solid var(--line);
          border-radius:9px; cursor:pointer; }
  .hbtn:active { background:#30363d; }
  #htitle { flex:1; min-width:0; font-size:15px; font-weight:600;
            white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* Both scroll buttons float just ABOVE the composer, right-aligned, in their
     own row: they belong with the input (that is where you are looking) but must
     not sit inside it. */
  #scrollbtns { position:absolute; right:0; bottom:calc(100% + 8px); display:flex; gap:8px; }
  #scrollbtns button { width:38px; height:38px; padding:0; font:inherit; font-size:16px;
                       line-height:1; color:var(--fg); background:#21262de6;
                       border:1px solid var(--line); border-radius:50%;
                       box-shadow:0 2px 10px #0008; cursor:pointer;
                       visibility:hidden; }
  #scrollbtns button.on { visibility:visible; }
  #scrollbtns button:active { background:#30363d; }
  aside#drawer { position:fixed; top:0; bottom:0; left:0; z-index:40; width:min(86vw, 350px);
                 background:var(--bg); border-right:1px solid var(--line); overflow-y:auto;
                 padding:calc(env(safe-area-inset-top) + 10px) 10px 24px;
                 -webkit-overflow-scrolling:touch; }
  .newchat { display:block; width:100%; padding:12px; margin-bottom:8px; font:inherit; font-size:15px;
             color:#fff; background:#1f6feb; border:0; border-radius:9px; cursor:pointer; }
  .draweritem { display:block; width:100%; padding:11px 12px; margin-bottom:12px; font:inherit;
                font-size:15px; text-align:left; color:var(--fg); background:var(--panel);
                border:1px solid var(--line); border-radius:9px; cursor:pointer; }
  #scrim { position:fixed; inset:0; z-index:30; background:#000a; }
  main { padding:10px 12px calc(env(safe-area-inset-bottom) + 24px); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:11px 13px; margin-bottom:8px; cursor:pointer; }
  .card:active { background:#1c2330; }
  .card h3 { margin:0 0 3px; font-size:14.5px; font-weight:600; word-break:break-word; }
  .meta { color:var(--dim); font-size:12px; word-break:break-all; }
  .badge { display:inline-block; margin-right:6px; padding:1px 6px; border-radius:99px;
           font-size:10.5px; background:#1f6feb33; color:#79c0ff; vertical-align:1px; }
  .row { display:flex; align-items:center; gap:10px; padding:11px 2px; border-bottom:1px solid var(--line); cursor:pointer; }
  .row:last-child { border-bottom:0; }
  .row .nm { flex:1; word-break:break-all; }
  .row .sz { color:var(--dim); font-size:12px; white-space:nowrap; }
  .msg { margin:0 0 10px; padding:10px 12px; border-radius:10px; white-space:pre-wrap;
         word-break:break-word; font-size:14.5px; }
  .msg.user { background:#1f6feb26; border:1px solid #1f6feb4d; }
  .msg.assistant { background:var(--panel); border:1px solid var(--line); }
  .msg.ctx { background:#21262d; border:1px dashed var(--line); color:var(--dim); font-size:13px; }
  .who { font-size:11px; color:var(--dim); margin-bottom:4px; text-transform:uppercase; letter-spacing:.04em; }
  pre { margin:0; padding:11px; background:#010409; border:1px solid var(--line); border-radius:8px;
        overflow:auto; font-size:12.5px; line-height:1.5; white-space:pre; }
  .bar { display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap; }
  button.act { padding:7px 12px; font:inherit; font-size:13px; color:var(--fg); background:#21262d;
               border:1px solid var(--line); border-radius:7px; cursor:pointer; }
  button.act:active { background:#30363d; }
  .crumb { color:var(--dim); font-size:12.5px; word-break:break-all; flex:1; }
  .empty { color:var(--dim); text-align:center; padding:36px 12px; font-size:13.5px; }
  .err { color:#ff7b72; }
  input[type=file] { display:none; }
  /* Markdown rendering. The msg rule carries pre-wrap, which would fight
     real block markup, so the rendered subtree resets it. */
  .md { white-space:normal; }
  .md > *:first-child { margin-top:0; }
  .md > *:last-child { margin-bottom:0; }
  .md p { margin:0 0 8px; }
  .md h1,.md h2,.md h3,.md h4,.md h5,.md h6 { margin:13px 0 6px; line-height:1.3; }
  .md h1 { font-size:19px; } .md h2 { font-size:17px; } .md h3 { font-size:15.5px; }
  .md h4,.md h5,.md h6 { font-size:14.5px; }
  .md ul,.md ol { margin:0 0 8px; padding-left:22px; }
  .md li { margin:2px 0; }
  .md code { background:#010409; border:1px solid var(--line); border-radius:4px;
             padding:1px 5px; font-size:12.5px; }
  .md pre { margin:0 0 8px; }
  .md pre code { background:none; border:0; padding:0; font-size:12.5px; }
  .md blockquote { margin:0 0 8px; padding:2px 0 2px 11px; border-left:3px solid var(--line);
                   color:var(--dim); }
  .md hr { border:0; border-top:1px solid var(--line); margin:13px 0; }
  .md a { color:var(--accent); }
  .md strong { font-weight:650; }
  .md table { border-collapse:collapse; margin:0 0 9px; width:100%;
              display:block; overflow-x:auto; font-size:13.5px; }
  .md th, .md td { border:1px solid var(--line); padding:5px 8px; text-align:left;
                   vertical-align:top; }
  .md th { background:#1c2128; font-weight:600; white-space:nowrap; }
  .md td { word-break:break-word; }
  /* Folded non-reply content: reasoning, tool calls, tool results. */
  details.fold { margin:7px 0 0; border:1px solid var(--line); border-radius:7px;
                 background:#0b0f14; overflow:hidden; }
  details.fold > summary { cursor:pointer; padding:7px 10px; font-size:12px; color:var(--dim);
                           list-style:none; user-select:none; }
  details.fold > summary::-webkit-details-marker { display:none; }
  /* Literal glyphs, not CSS \25B8 escapes: this CSS lives inside a JS template
     literal, which would consume the backslash. */
  details.fold > summary::before { content:'▸  '; }
  details.fold[open] > summary::before { content:'▾  '; }
  details.fold > .foldbody { padding:0 10px 10px; }
  details.fold pre { max-height:360px; }
  details.fold.bad > summary { color:#ff7b72; }
  /* Approvals awaiting a decision, pinned above the transcript. */
  /* Approvals awaiting a decision, pinned above the transcript. */
  #approvals { padding:10px 12px 0; }
  .approvals { margin-bottom:10px; }
  .approval { background:#3d2300; border:1px solid #9e6a03; border-radius:10px;
              padding:11px 12px; margin-bottom:8px; }
  .approval h4 { margin:0 0 4px; font-size:14px; color:#e3b341; }
  .approval .where { display:block; margin:0 0 7px; padding:4px 8px; font:inherit; font-size:12px;
                     color:#e3b341; background:#00000040; border:1px solid #9e6a034d;
                     border-radius:6px; cursor:pointer; max-width:100%; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap; }
  .approval .why { font-size:12.5px; word-break:break-word; margin-bottom:9px; }
  .approval .acts { display:flex; gap:8px; }
  .approval button { flex:1; padding:9px; font:inherit; font-size:14px;
                     border-radius:8px; border:1px solid var(--line); cursor:pointer; }
  .approval .allow { background:#238636; border-color:#2ea043; color:#fff; }
  .approval .deny { background:#21262d; color:var(--fg); }
  /* Approvals render here, replacing the input: the question appears exactly
     where the reader's attention already is, at the bottom of the transcript. */
  .composer-slots:empty { display:none; }
  .composer-slots { margin-bottom:9px; }
  .composer-slots .approval:last-child { margin-bottom:0; }
  /* Message composer. margin-top:auto pushes it to the bottom of the viewport
     column, which sticky alone cannot do for a short transcript. */
  .composer { position:sticky; bottom:0; margin-top:auto;
              padding-top:10px; padding-bottom:calc(env(safe-area-inset-bottom) + 8px);
              background:linear-gradient(transparent, var(--bg) 20%); }
  .composer textarea { display:block; width:100%; min-height:54px; max-height:170px; resize:none;
                       padding:10px 12px; font:inherit; font-size:15px; line-height:1.5;
                       color:var(--fg); background:var(--panel);
                       border:1px solid var(--line); border-radius:10px; }
  .composer .send { margin-top:8px; width:100%; padding:11px; font:inherit; font-size:15px;
                    color:#fff; background:#1f6feb; border:0; border-radius:9px; cursor:pointer; }
  .composer .send:disabled { opacity:.5; }
  .pending-note { color:var(--dim); font-size:12.5px; margin-top:6px; text-align:center; }
</style>
</head>
<body>
<header>
  <button id="hbtn" class="hbtn" aria-label="会话列表">☰</button>
  <div id="htitle">DSH Bridge</div>
</header>
<aside id="drawer" hidden>
  <button id="newchat" class="newchat">＋ 新对话</button>
  <button id="filesbtn" class="draweritem">📁 文件</button>
  <div id="drawerlist"></div>
</aside>
<div id="scrim" hidden></div>
<main id="view"></main>
<input type="file" id="picker" multiple>
<script>
const view = document.getElementById('view');
const hbtn = document.getElementById('hbtn');
const htitle = document.getElementById('htitle');
const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const drawerList = document.getElementById('drawerlist');
const picker = document.getElementById('picker');

// Plain-text output only: every value goes in via textContent, never innerHTML.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---- chrome -------------------------------------------------------------
   Navigation lives ONLY in the sticky bar. Putting the back affordance in the
   scrolling content meant it slid away as soon as a transcript got long, which
   is exactly when you need it. */
let backAction = null;
function setHeader(title, back) {
  htitle.textContent = title;
  hbtn.textContent = back ? '←' : '☰';
  hbtn.setAttribute('aria-label', back ? '返回' : '会话列表');
  backAction = back || null;
}
function openDrawer(open) {
  drawer.hidden = !open;
  scrim.hidden = !open;
  if (open) void loadDrawer();
}
hbtn.onclick = () => { if (backAction) backAction(); else openDrawer(drawer.hidden); };
scrim.onclick = () => openDrawer(false);

/* The scroll buttons moved into the bottom-right action cluster, which
   subscribes to scroll itself and asks window.__bridgeScroll.state() whether
   each end is reachable. Nothing here pokes at DOM ids any more, so a view
   without those buttons cannot break the page. */

/** A fresh UUID-shaped session id, matching how DSH names sessions. */
function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'session-' + hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
    + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
}
async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}
function fmtSize(n) {
  if (!n) return '';
  const u = ['B','K','M','G']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(1)) + u[i];
}
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = Date.now(), diff = now - ms;
  if (diff < 864e5) return d.toTimeString().slice(0,5);
  return (d.getMonth()+1) + '/' + d.getDate() + ' ' + d.toTimeString().slice(0,5);
}
function clear() { view.replaceChildren(); }
function empty(text) { clear(); view.append(el('div','empty',text)); }

/** Populate the session drawer; the panel opens on a new conversation instead. */
async function loadDrawer() {
  drawerList.replaceChildren(el('div','empty','载入中…'));
  let data;
  try { data = await api('api/sessions'); }
  catch (e) { drawerList.replaceChildren(el('div','empty','读取会话失败: ' + e.message)); return; }
  drawerList.replaceChildren();
  if (!data.sessions.length) { drawerList.append(el('div','empty','还没有任何会话')); return; }
  for (const s of data.sessions) {
    const card = el('div','card');
    card.append(el('h3', null, s.title || s.id));
    const meta = el('div','meta');
    if (s.running) meta.append(el('span','badge','运行中'));
    else if (s.live) meta.append(el('span','badge','已载入'));
    meta.append(document.createTextNode(fmtTime(s.updatedAt) + '  ' + (s.cwd || '')));
    card.append(meta);
    card.onclick = () => { openDrawer(false); void showConversation(s.id, s.title); };
    drawerList.append(card);
  }
}

/* ---- Markdown -> DOM ----------------------------------------------------
   Every run of text reaches the DOM through textContent, never innerHTML, so
   no message content can become markup no matter what the model emits. An href
   is the single attribute text can reach, so it gets its own scheme check.
   Backticks are written as \u0060 because this script lives inside a template
   literal in the host source. */
function safeHref(url) {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') ? u.href : null;
  } catch { return null; }
}
/**
 * Pin the view to the newest content.
 *
 * Writing and reading both happen at the BOTTOM of a transcript, so the panel
 * follows the tail — but only while the reader is already near it. Yanking the
 * page down while someone is scrolled up reading history would be worse than
 * not following at all.
 */
function scrollToBottom(force) {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  if (!force && !nearBottom) return;
  requestAnimationFrame(() => { window.scrollTo({ top: document.body.scrollHeight }); });
}

function textWithBreaks(parent, text) {
  text.split('\n').forEach((line, i) => {
    if (i > 0) parent.append(document.createElement('br'));
    if (line !== '') parent.append(document.createTextNode(line));
  });
}
const INLINE_RE = /\[([^\]]*)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
function inlineInto(parent, text) {
  // Inline code is split out first so its contents are never re-parsed.
  for (const part of text.split(/(\u0060+[^\u0060]*\u0060+)/g)) {
    const code = /^(\u0060+)([\s\S]*?)\1$/.exec(part);
    if (code) {
      const node = document.createElement('code');
      node.textContent = code[2];
      parent.append(node);
      continue;
    }
    INLINE_RE.lastIndex = 0;
    let last = 0, m;
    while ((m = INLINE_RE.exec(part)) !== null) {
      if (m.index > last) textWithBreaks(parent, part.slice(last, m.index));
      if (m[1] !== undefined) {
        const a = document.createElement('a');
        a.textContent = m[1];
        const href = safeHref(m[2]);
        if (href !== null) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        parent.append(a);
      } else {
        const strong = m[3] !== undefined || m[4] !== undefined;
        const node = document.createElement(strong ? 'strong' : 'em');
        node.textContent = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : m[6];
        parent.append(node);
      }
      last = INLINE_RE.lastIndex;
    }
    if (last < part.length) textWithBreaks(parent, part.slice(last));
  }
}
const FENCE_OPEN_RE = /^\s*\u0060\u0060\u0060\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE_RE = /^\s*\u0060\u0060\u0060\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_RE = /^\s*([-*+]|\d+\.)\s+/;
const PIPE_ROW_RE = /^\s*\|.*\|\s*$/;
const DELIMITER_ROW_RE = /^\s*\|?[\s:|-]+\|?\s*$/;
/** Split one pipe row into trimmed cells, dropping the outer delimiters. */
function splitPipeRow(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
    .split('|').map((cell) => cell.trim());
}
const QUOTE_RE = /^\s*>\s?/;
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text).split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.className = 'lang-' + fence[1];
      code.textContent = buf.join('\n');
      pre.append(code);
      frag.append(pre);
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const h = document.createElement('h' + String(heading[1].length));
      inlineInto(h, heading[2]);
      frag.append(h); i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { frag.append(document.createElement('hr')); i++; continue; }
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { buf.push(lines[i].replace(QUOTE_RE, '')); i++; }
      const bq = document.createElement('blockquote');
      bq.append(renderMarkdown(buf.join('\n')));
      frag.append(bq); continue;
    }
    // GFM table: a pipe-delimited row followed by a delimiter row. Without this
    // branch a table renders as a wall of literal pipes, which is how it looks
    // when a model answers with one.
    if (PIPE_ROW_RE.test(line) && i + 1 < lines.length
      && DELIMITER_ROW_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const cell of splitPipeRow(line)) {
        const th = document.createElement('th');
        inlineInto(th, cell);
        headRow.append(th);
      }
      thead.append(headRow);
      table.append(thead);
      i += 2;
      const body = document.createElement('tbody');
      while (i < lines.length && PIPE_ROW_RE.test(lines[i])) {
        const tr = document.createElement('tr');
        for (const cell of splitPipeRow(lines[i])) {
          const td = document.createElement('td');
          inlineInto(td, cell);
          tr.append(td);
        }
        body.append(tr);
        i++;
      }
      table.append(body);
      frag.append(table);
      continue;
    }
    if (LIST_RE.test(line)) {
      const list = document.createElement(/^\s*\d+\.\s+/.test(line) ? 'ol' : 'ul');
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const li = document.createElement('li');
        inlineInto(li, lines[i].replace(LIST_RE, ''));
        list.append(li); i++;
      }
      frag.append(list); continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i])
      && !HEADING_RE.test(lines[i]) && !QUOTE_RE.test(lines[i])
      && !LIST_RE.test(lines[i]) && !FENCE_OPEN_RE.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    const p = document.createElement('p');
    inlineInto(p, buf.join('\n'));
    frag.append(p);
  }
  return frag;
}
function foldLabel(block) {
  switch (block.kind) {
    case 'reasoning': return '思考';
    case 'tool-call': return '工具调用 · ' + (block.name || 'tool');
    case 'tool-result': return (block.error ? '工具失败' : '工具结果') + (block.text ? ' · ' + block.text.length + ' 字符' : '');
    case 'attachment': return '附件 ' + (block.text || '');
    default: return block.text || '内容';
  }
}

/** Render one message's blocks: the reply expanded, everything else folded. */
function renderMessage(role, blocks) {
  const box = el('div','msg ' + (role === 'user' ? 'user' : 'assistant'));
  box.append(el('div','who', role === 'user' ? '你' : '助手'));
  for (const block of blocks) {
    if (block.kind === 'text') {
      const md = el('div','md');
      md.append(renderMarkdown(block.text));
      box.append(md);
      continue;
    }
    // Anything that is not the visible reply starts folded: reasoning, tool
    // calls, tool results, attachments.
    const fold = document.createElement('details');
    fold.className = 'fold' + (block.error === true ? ' bad' : '');
    const summary = document.createElement('summary');
    summary.textContent = foldLabel(block);
    fold.append(summary);
    const body = el('div','foldbody');
    if (block.kind === 'reasoning') {
      const md = el('div','md');
      md.append(renderMarkdown(block.text));
      body.append(md);
    } else {
      body.append(el('pre', null, block.text || ''));
    }
    fold.append(body);
    box.append(fold);
  }
  return box;
}

/** Send one message from the panel and stream the reply into a live bubble. */
async function sendTurn(sessionId, text, composer, onSettled) {
  const bubble = el('div','msg assistant');
  bubble.append(el('div','who','助手'));
  const body = el('div','md');
  bubble.append(body);
  view.insertBefore(bubble, composer);
  let accumulated = '';
  const paint = () => { body.replaceChildren(renderMarkdown(accumulated)); scrollToBottom(); };

  try {
    const res = await fetch('api/send?session=' + encodeURIComponent(sessionId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 200));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at;
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (!frame.startsWith('data: ')) continue;
        const payload = JSON.parse(frame.slice(6));
        if (payload.delta !== undefined) { accumulated += payload.delta; paint(); }
        else if (payload.error !== undefined) { accumulated += '\n\n[错误] ' + payload.error; paint(); }
        else if (payload.done === true && accumulated === '' && payload.text) { accumulated = payload.text; paint(); }
      }
    }
    if (accumulated === '') { body.textContent = '（本轮没有文本输出，可能只调用了工具）'; body.style.color = 'var(--dim)'; }
  } catch (e) {
    body.textContent = '发送失败: ' + e.message;
    body.style.color = '#ff7b72';
  }
  scrollToBottom(true);
  if (onSettled) onSettled();
}

/* ---- conversations ------------------------------------------------------
   The panel opens on a NEW conversation rather than on a list: asking
   something is the common case, and picking an old thread is the rarer detour
   the drawer exists for. An omitted (or null) id means a brand-new session. */
let lastConversation = null;

async function showConversation(id, title) {
  openDrawer(false);
  const fresh = id === undefined || id === null || id === '';
  const sessionId = fresh ? newSessionId() : id;
  clear();
  setHeader(fresh ? '新对话' : (title || sessionId));
  window.scrollTo({ top: 0 });

  if (fresh) {
    lastConversation = { id: sessionId, title: '新对话' };
    view.append(el('div','empty','发消息开始新对话'));
  } else {
    let data;
    try { data = await api('api/session?id=' + encodeURIComponent(sessionId)); }
    catch (e) { empty('读取失败: ' + e.message); return; }
    const shown = data.title || title || sessionId;
    setHeader(shown);
    lastConversation = { id: sessionId, title: shown };
    for (const m of data.messages) view.append(renderMessage(m.role, m.blocks));
  }

  const composer = el('div','composer');
  const slots = el('div','composer-slots');
  const input = document.createElement('textarea');
  input.rows = 2;
  input.placeholder = '发消息…（Ctrl/⌘+Enter 发送）';
  const send = el('button','send','发送');
  const note = el('div','pending-note');
  // Their own row directly above the input: with the input, but not in it.
  composer.append(slots, input, send, note);

  // The scroll affordances now live in the bottom-right cluster, which owns the
  // layout work of clearing the composer. Publish only the operations.
  window.__bridgeScroll = {
    toTop: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
    toBottom: () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
    state: () => ({
      atTop: window.scrollY < 120,
      atBottom: window.innerHeight + window.scrollY >= document.body.scrollHeight - 120,
    }),
  };
  view.append(composer);
  scrollToBottom();

  const submit = () => {
    // Guard as well as hide: the keyboard shortcut would bypass the button.
    if (send.hidden || send.disabled) return;
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    send.disabled = true;
    // Drop the "start a new conversation" hint on the first send.
    const hint = view.querySelector('.empty');
    if (hint) hint.remove();
    view.insertBefore(renderMessage('user', [{ kind: 'text', text }]), composer);
    scrollToBottom();
    void sendTurn(sessionId, text, composer, () => { send.disabled = false; input.focus(); });
  };
  send.onclick = submit;
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); }
  });

  currentSessionId = sessionId;
  // The permission dialog is its own module and cannot reach into this closure,
  // so publish just the pointer it needs.
  window.__bridgeSession = { id: sessionId, fresh };
  currentComposer = { slots, input, send, note };
  renderApprovals();
  // The cluster has to re-measure: this composer is a brand new element.
  if (window.__bridgeFab) window.__bridgeFab.measure();
}

/* ---- approvals ----------------------------------------------------------
   The card REPLACES the composer rather than sitting in a banner. A banner at
   the top of the page is invisible exactly when it matters — you are at the
   bottom of a long transcript, having just sent the message that raised it.
   The composer is where attention already is, so the question appears there.

   Polled rather than pushed: approvals are rare, a couple of seconds of latency
   is irrelevant, and polling needs no long-lived connection to survive a phone
   sleeping. It is also why Chatbox can never show one — it speaks the OpenAI
   protocol, which has no approval channel at all. */
let pendingApprovals = [];
let approvalTimer;
let currentSessionId = null;
let currentComposer = null;

/** One approval card. */
function approvalCard(item) {
  const card = el('div','approval');
  card.append(el('h4', null, '需要确认 · ' + item.toolName));
  if (item.sessionId && item.sessionId !== currentSessionId) {
    const where = el('button','where','来自会话 ' + String(item.sessionId));
    where.onclick = () => { void showConversation(item.sessionId); };
    card.append(where);
  }
  if (item.reason) card.append(el('div','why', item.reason));
  const acts = el('div','acts');
  const allow = el('button','allow','允许');
  const deny = el('button','deny','拒绝');
  const answer = async (decision) => {
    allow.disabled = true; deny.disabled = true;
    try {
      await fetch('api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, decision }),
      });
    } catch { /* the next tick re-renders the truth */ }
    void pollApprovals();
  };
  allow.onclick = () => void answer('allow');
  deny.onclick = () => void answer('deny');
  acts.append(allow, deny);
  card.append(acts);
  return card;
}

function renderApprovals() {
  if (!currentComposer) return;
  const { slots, input, send, note } = currentComposer;
  const mine = pendingApprovals.filter((item) => item.sessionId === currentSessionId);
  const others = pendingApprovals.filter((item) => item.sessionId !== currentSessionId);

  slots.replaceChildren();
  for (const item of mine) slots.append(approvalCard(item));

  // The turn is parked until this is answered, so the input has nothing to do:
  // it is replaced, not merely disabled, so the question cannot be missed.
  const blocked = mine.length > 0;
  input.hidden = blocked;
  send.hidden = blocked;
  note.textContent = blocked
    ? '这一轮已暂停，等你在上方选择'
    : others.length > 0
      ? '另有 ' + String(others.length) + ' 项待确认（来自其他会话）'
      : '';
}

async function pollApprovals() {
  clearTimeout(approvalTimer);
  try { pendingApprovals = (await api('api/approvals')).approvals; } catch { /* transient */ }
  renderApprovals();
  approvalTimer = setTimeout(() => void pollApprovals(), 2000);
}
void pollApprovals();

let cwdPath = '';
// When set, the files view is acting as a picker: tapping a file hands its path
// back to the composer instead of previewing it.
let pickTarget = null;

/** Leave the files view and re-open whatever conversation was on screen. */
function restoreConversation() {
  const target = lastConversation;
  return showConversation(target ? target.id : null, target ? target.title : undefined);
}

async function showFiles(relPath) {
  // The bar's button becomes "back" here, returning to whatever conversation
  // was open — the files view has no other way out.
  const picking = pickTarget !== null;
  setHeader(picking ? '选择文件' : '文件', () => {
    if (picking) pickTarget = null;
    void restoreConversation();
  });
  if (relPath === undefined) cwdPath = cwdPath || '';
  else cwdPath = relPath;
  empty('载入中…');
  let data;
  try { data = await api('api/files?path=' + encodeURIComponent(cwdPath)); }
  catch (e) { empty('读取目录失败: ' + e.message); return; }
  clear();
  const bar = el('div','bar');
  // The server hands the parent over explicitly: with several roots, "up" from a
  // drive root is the virtual root, which is not a string prefix of its path.
  if (data.parent !== null && data.parent !== undefined) {
    const up = el('button','act','← 上级');
    up.onclick = () => showFiles(data.parent);
    bar.append(up);
  }
  const up = el('button','act','上传到 _inbox');
  up.onclick = () => picker.click();
  bar.append(up);
  bar.append(el('div','crumb', '/' + (data.path || '')));
  view.append(bar);
  if (!data.entries.length) { view.append(el('div','empty','空目录')); return; }
  for (const entry of data.entries) {
    const row = el('div','row');
    row.append(el('span','nm', (entry.type === 'dir' ? '📁 ' : '📄 ') + entry.name));
    row.append(el('span','sz', entry.type === 'dir' ? '' : fmtSize(entry.size)));
    // The path is server-supplied, so a name containing a separator cannot
    // forge a path out of the browsable tree.
    const child = entry.path !== undefined ? entry.path : (data.path ? data.path + '/' + entry.name : entry.name);
    row.onclick = () => {
      if (entry.type === 'dir') { void showFiles(child); return; }
      if (pickTarget === null) { void showFile(child); return; }
      const handoff = pickTarget;
      pickTarget = null;
      // Re-open the conversation FIRST: the composer is rebuilt along with it, so
      // a textarea captured before the switch would already be detached.
      void restoreConversation().then(() => handoff(child));
    };
    view.append(row);
  }
}

async function showFile(relPath) {
  empty('载入中…');
  let data;
  try { data = await api('api/file?path=' + encodeURIComponent(relPath)); }
  catch (e) { empty('读取失败: ' + e.message); return; }
  clear();
  const bar = el('div','bar');
  const back = el('button','act','← 返回');
  back.onclick = () => showFiles(relPath.split('/').slice(0,-1).join('/'));
  const dl = el('a','act','下载');
  dl.href = 'api/file?download=1&path=' + encodeURIComponent(relPath);
  dl.style.cssText = 'text-decoration:none;padding:7px 12px;border:1px solid var(--line);border-radius:7px;color:var(--fg)';
  bar.append(back, dl, el('div','crumb', relPath + '  ' + fmtSize(data.size)));
  view.append(bar);
  if (data.binary) { view.append(el('div','empty','二进制文件，请下载查看')); return; }
  const pre = el('pre', null, data.text);
  view.append(pre);
  if (data.truncated) view.append(el('div','meta','（已截断显示）'));
}

picker.onchange = async () => {
  const files = [...picker.files];
  if (!files.length) return;
  for (const file of files) {
    const bar = el('div','bar', '上传中: ' + file.name);
    view.prepend(bar);
    try {
      const res = await fetch('api/upload?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
      if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0,150));
      bar.textContent = '已上传: ' + file.name + ' → _inbox/';
    } catch (e) { bar.textContent = '上传失败 ' + file.name + ': ' + e.message; bar.className = 'bar err'; }
  }
  picker.value = '';
};

document.getElementById('newchat').onclick = () => { openDrawer(false); void showConversation(); };
document.getElementById('filesbtn').onclick = () => { openDrawer(false); void showFiles(cwdPath); };

/* ---- hooks for the bottom-right cluster ----------------------------------
   That cluster is a separate script and cannot reach into this closure, so it
   gets exactly two entry points: borrow the files view as a picker, and put text
   into the composer. */
window.__bridgePickFile = (onPick) => {
  pickTarget = onPick;
  // Always start from the top: with several browse roots that is the list of
  // roots, which is where a pick is most likely to begin.
  void showFiles('');
};
window.__bridgeInsertText = (text) => {
  if (!currentComposer) return;
  const { input } = currentComposer;
  const current = input.value;
  // Append with a single separating space. Written without a regex literal on
  // purpose: this whole page is one template literal, where a stray backslash
  // escape degrades the entire document to the text "undefined".
  const needsSpace = current !== '' && current.charAt(current.length - 1) !== ' ';
  input.value = current + (needsSpace ? ' ' + text : text);
  input.focus();
  input.dispatchEvent(new Event('input'));
};
// Open on a new conversation: the drawer (☰) is for picking an old one.
void showConversation();
</script>
<script src="panel-fab.js" defer></script>
<script src="permission-ui.js" defer></script>
<script src="model-ui.js" defer></script>
</body>
</html>`

  // Only wire in the dialogs whose backing feature is actually mounted. A
  // disabled module answers 404 for its script, so leaving the tag in place would
  // make every panel load fire a request that is guaranteed to fail.
  const droppedTags = []
  if (!gate.enabled) droppedTags.push('<script src="permission-ui.js" defer></script>')
  if (models === null) droppedTags.push('<script src="model-ui.js" defer></script>')
  const shell = droppedTags.reduce((markup, tag) => markup.replace(tag, ''), shellTemplate)

  /** Resolve session rows for the list endpoint. */
  async function listSessions() {
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.listSessions !== 'function') {
      throw Object.assign(new Error('session listing is unavailable in this composition'), { status: 503 })
    }
    const records = await query.listSessions()
    const rows = []
    for (const record of records) {
      const header = record?.header
      if (header === undefined || header.cwd === undefined) continue
      let titleSnapshot
      try {
        // `readTitleSnapshot` returns the `{ session, title }` observation
        // wrapper; `readTitle` is the method that yields the snapshot itself.
        titleSnapshot = await query.readTitle(header.id)
      } catch {
        titleSnapshot = undefined
      }
      rows.push({
        id: String(header.id),
        title: titleSnapshot?.title ?? undefined,
        cwd: header.cwd,
        // The title event's timestamp tracks last activity; `header.createdAt`
        // never moves, so sorting on it would freeze an ongoing conversation in
        // place. One read serves both fields.
        updatedAt: titleSnapshot?.updatedAt ?? header.createdAt ?? 0,
        live: record.live === true,
        running: ctx.get('agents')?.get(header.id)?.status === 'running',
      })
    }
    rows.sort((left, right) => right.updatedAt - left.updatedAt)
    return rows
  }

  /** Flatten one session's current model surface into displayable messages. */
  async function readTranscript(id) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) throw Object.assign(new Error('session reading is unavailable'), { status: 503 })
    const surface = await query.readSurface(id)
    let title
    try {
      title = (await query.readTitle(id))?.title
    } catch {
      title = undefined
    }
    const messages = []
    for (const event of surface.events ?? []) {
      if (event.type === 'assistant/message') {
        const blocks = messageBlocks(event)
        if (blocks.length > 0) messages.push({ role: 'assistant', blocks, time: event.time })
        continue
      }
      if (event.type !== 'user/message') continue
      // Injected context (runtime snapshots, tool notices) would drown the
      // conversation, so only genuine human prompts render as user turns.
      if (event.data?.source?.kind !== 'user') continue
      const blocks = messageBlocks(event)
      if (blocks.length > 0) messages.push({ role: 'user', blocks, time: event.time })
    }
    return { id: String(id), title, messages }
  }

  async function listFiles(requested) {
    const roots = browseRoots()
    const asked = requested ?? ''
    const multiple = roots.length > 1

    // The virtual root lists the roots themselves. With a single root there is
    // nothing to choose between, so it keeps listing that root's contents —
    // exactly what this endpoint returned before the list existed.
    if (asked === '' && multiple) {
      const entries = roots.map((root) => ({
        name: slashPath(root).replace(/\/+$/u, ''),
        type: 'dir',
        size: 0,
        mtime: 0,
        path: slashPath(root),
      }))
      return { path: '', parent: null, entries, roots: roots.map(slashPath) }
    }

    const located = await resolveWithinRoots(roots, asked)
    const directory = located.target
    const info = await stat(directory)
    if (!info.isDirectory()) throw Object.assign(new Error('not a directory'), { status: 400 })

    const atRoot = directory === located.root
    // One root keeps relative paths, so an existing single-root deployment sees a
    // byte-identical response. Several roots need absolute paths, because a
    // relative one would be ambiguous between them.
    const here = atRoot && !multiple
      ? ''
      : (multiple ? slashPath(directory) : slashPath(relative(located.root, directory)))
    const parent = multiple
      ? (atRoot ? '' : slashPath(resolve(directory, '..')))
      : (here === '' ? null : here.split('/').slice(0, -1).join('/'))

    const names = await readdir(directory)
    const entries = await Promise.all(names.map(async (name) => ({
      ...await entryOf(directory, name),
      // The server owns the navigable path, so a name containing a separator
      // cannot forge a path out of the browsable tree.
      path: joinBrowsable(here, name),
    })))
    entries.sort((left, right) => {
      if ((left.type === 'dir') !== (right.type === 'dir')) return left.type === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name)
    })
    return { path: here, parent, entries }
  }

  async function readOneFile(relPath) {
    const target = (await resolveWithinRoots(browseRoots(), relPath)).target
    const info = await stat(target)
    if (!info.isFile()) throw Object.assign(new Error('not a file'), { status: 400 })
    const buffer = await readFile(target)
    const binary = looksBinary(buffer)
    const truncated = buffer.length > PREVIEW_MAX_BYTES
    return {
      size: info.size,
      binary,
      truncated,
      text: binary || truncated ? buffer.subarray(0, PREVIEW_MAX_BYTES).toString('utf8') : buffer.toString('utf8'),
    }
  }

  /** Write one upload into the inbox. The ONLY disk write this module performs. */
  async function acceptUpload(req, res, name) {
    const safeName = basename(name ?? '').replace(/[\\/:*?"<>|]/gu, '_')
    if (safeName === '' || safeName === '.' || safeName === '..') {
      sendJson(res, 400, { error: 'a file name is required' })
      return
    }
    await mkdir(inbox, { recursive: true })
    const target = join(inbox, safeName)
    assertInside(inbox, target)
    const chunks = []
    let total = 0
    let overflow = false
    for await (const chunk of req) {
      total += chunk.length
      if (total > UPLOAD_MAX_BYTES) { overflow = true; break }
      chunks.push(chunk)
    }
    if (overflow) {
      sendJson(res, 413, { error: `upload exceeds ${String(UPLOAD_MAX_BYTES)} bytes` })
      return
    }
    await pipeline(async function* () { yield Buffer.concat(chunks) }, createWriteStream(target))
    sendJson(res, 200, { ok: true, path: `${INBOX_DIR}/${safeName}`, bytes: total })
  }

  /**
   * Stream one panel-composed user turn back as SSE.
   *
   * The panel drives sessions through exactly the same runtime the OpenAI face
   * uses, so the permission preset and the sandbox boundary cannot differ by
   * entry point.
   */
  const streamTurn = async (req, res, sessionId) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: String(error) })
      return
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '' || sessionId === '') {
      sendJson(res, 400, { error: 'a session and a non-empty message are required' })
      return
    }
    if (runtime === undefined) {
      sendJson(res, 503, { error: 'this deployment did not supply a session runtime' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    const event = (payload) => { res.write(`data: ${JSON.stringify(payload)}\n\n`) }
    try {
      await runtime.serialize(sessionId, async () => {
        const agent = await runtime.ensureAgent(sessionId)
        const answer = await runtime.driveTurn(agent, text, (delta) => { event({ delta }) })
        event({ done: true, text: answer })
      })
    } catch (error) {
      ctx.logger.warn(`openai-bridge: panel turn failed: ${String(error)}`)
      event({ error: String(error && error.message ? error.message : error) })
    }
    res.end()
  }

  /** Pending approvals, without the resolver. */
  const listApprovals = (res) => {
    const approvals = [...pending.values()].map((record) => ({
      id: record.id,
      toolName: record.toolName,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      createdAt: record.createdAt,
    }))
    sendJson(res, 200, { approvals })
  }

  /** Answer one pending approval from the panel. */
  const answerApproval = async (req, res) => {
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { error: String(error) })
      return
    }
    const record = pending.get(typeof body?.id === 'string' ? body.id : '')
    if (record === undefined) {
      sendJson(res, 404, { error: 'that approval is no longer pending' })
      return
    }
    record.decide(body?.decision === 'allow' ? 'allowed-once' : 'rejected')
    sendJson(res, 200, { ok: true })
  }

  const handler = (req, res) => {
    void (async () => {
      let url
      try {
        url = new URL(req.url ?? '/', 'http://bridge.invalid')
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const rest = url.pathname.slice(basePath.length)

      // Bootstrap: exchange the URL token for a cookie, then redirect to the
      // canonical URL so the credential stops travelling in the address bar and
      // history. This must fire for the bare `/bridge?token=…` form too, where
      // `rest` is empty — guarding on a non-empty `rest` would 401 the very URL
      // an operator is told to open.
      if (url.searchParams.get('token') === token) {
        // Preserve the path and the rest of the query. The desktop popup lives at
        // `/desktop/?id=…&view=…`, and bouncing it to the panel root would hand
        // the operator the wrong page entirely. The token itself is dropped, so
        // the credential does not survive in the address bar beyond the redirect.
        const kept = new URLSearchParams(url.searchParams)
        kept.delete('token')
        const query = kept.toString()
        const target = rest === '' || rest === '/' ? `${basePath}/` : `${basePath}${rest}`
        res.writeHead(303, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          location: query === '' ? target : `${target}?${query}`,
          // `SameSite=Lax`, NOT Strict. Tapping the sign-in link in another app
          // makes the whole navigation cross-site, and a Strict cookie is
          // withheld for the redirect that follows — the request then arrives
          // unauthenticated and 401s. Lax still refuses to attach the cookie to
          // cross-site POSTs, so the panel's state-changing endpoints stay
          // CSRF-safe.
          'set-cookie': `${COOKIE_NAME}=${token}; Path=${basePath}; HttpOnly; SameSite=Lax`,
        })
        res.end()
        return
      }

      if (!authenticated(req, token)) {
        // Served as HTML, never text/plain: a browser handed an untyped or
        // plain-text response for a navigation may download it instead of
        // rendering it, which is exactly how this failure looked before.
        const sawCookie = typeof req.headers['cookie'] === 'string' && req.headers['cookie'] !== ''
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end('<!doctype html><meta charset="utf-8"><title>bridge：需要登录</title>'
          + '<meta name="viewport" content="width=device-width,initial-scale=1">'
          + '<body style="font:16px/1.7 system-ui;background:#0d1117;color:#e6edf3;padding:28px;max-width:640px">'
          + '<h3 style="margin:0 0 12px">需要登录</h3>'
          + `<p>请用带 token 的地址打开一次：<br><code>${escapeHtml(basePath)}?token=<em>你的 token</em></code></p>`
          + '<p style="color:#8b949e;font-size:14px">'
          + (sawCookie
            ? '本次请求带了 cookie，但内容与当前 token 不匹配 —— token 可能已经轮换过，重新用新 token 打开一次即可。'
            : '本次请求没有携带登录 cookie。若你已经在别处登录过，可能是浏览器拦截了第三方 cookie，或该地址的 cookie 还没建立。')
          + '</p></body>')
        return
      }

      try {
        // Canonicalize the slashless prefix. The page uses relative `api/...`
        // fetches, which resolve against the document URL: serving the shell at
        // `/bridge` would send every request to `/api/...` on the harness
        // gateway instead of `/bridge/api/...`.
        if (rest === '') {
          res.writeHead(308, { location: `${basePath}/`, 'cache-control': 'no-store' })
          res.end()
          return
        }
        if (rest === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(shell)
          return
        }
        if (rest === '/api/sessions') {
          sendJson(res, 200, { sessions: await listSessions() })
          return
        }
        if (rest === '/api/session') {
          const id = url.searchParams.get('id') ?? ''
          sendJson(res, 200, await readTranscript(id))
          return
        }
        if (rest === '/api/files') {
          sendJson(res, 200, await listFiles(url.searchParams.get('path') ?? ''))
          return
        }
        if (rest === '/api/file') {
          const relPath = url.searchParams.get('path') ?? ''
          if (url.searchParams.get('download') === '1') {
            const target = (await resolveWithinRoots(browseRoots(), relPath)).target
            const info = await stat(target)
            res.writeHead(200, {
              'content-type': 'application/octet-stream',
              'content-length': info.size,
              'content-disposition': `attachment; filename="${basename(target)}"`,
              'cache-control': 'no-store',
            })
            await pipeline(createReadStream(target), res)
            return
          }
          sendJson(res, 200, await readOneFile(relPath))
          return
        }
        if (rest === '/api/send') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST required' })
            return
          }
          await streamTurn(req, res, url.searchParams.get('session') ?? '')
          return
        }
        if (rest === '/api/approvals') {
          listApprovals(res)
          return
        }
        if (rest === '/api/approve') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST required' })
            return
          }
          await answerApproval(req, res)
          return
        }
        if (rest === '/api/upload') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST required' })
            return
          }
          await acceptUpload(req, res, url.searchParams.get('name'))
          return
        }
        // Each feature module owns a slice of the panel's routes and answers
        // `false` for anything it does not recognise, so the 404 below stays the
        // single fallthrough. Order is irrelevant: the route sets are disjoint.
        if (rest === '/panel-fab.js') {
          res.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(fabAsset())
          return
        }

        if (await gate.handle(req, res, url, rest)) return
        if (models !== null && await models.handle(req, res, url, rest)) return
        sendJson(res, 404, { error: `unknown panel route ${rest}` })
      } catch (error) {
        const status = typeof error?.status === 'number' ? error.status : 500
        ctx.logger.warn(`openai-bridge: panel ${rest} failed: ${String(error)}`)
        if (res.headersSent) { res.destroy(); return }
        sendJson(res, status, { error: String(error?.message ?? error) })
      }
    })()
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: basePath, handler }), 'openai-bridge: /bridge panel')
  const describedRoots = fileRoot === '*'
    ? 'every fixed drive'
    : (Array.isArray(fileRoot) ? fileRoot.join(', ') : String(fileRoot))
  ctx.logger.info(`openai-bridge: panel mounted at ${basePath} (browse roots: ${describedRoots}; uploads -> ${inbox})`)
}

export { INBOX_DIR, UPLOAD_MAX_BYTES, PREVIEW_MAX_BYTES, escapeHtml, resolveInsideRoot, looksBinary, messageText, messageBlocks }
