/**
 * Small HTTP helpers shared by the panel's feature modules.
 *
 * Kept separate so `permission-gate.js` and `model-control.js` do not each carry
 * their own copy. Deliberately dependency-free, like the rest of this package.
 *
 * @module dsh-openai-bridge/http-util
 */

/** Send a JSON response with caching disabled. */
export function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Read a small JSON request body, rejecting an oversized or malformed one. */
export async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/** Escape a string for interpolation into HTML text or a double-quoted attribute. */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Read a file sitting next to a module, caching the result for the process lifetime. */
export function lazyAsset(loader, url) {
  let cached = null
  return () => {
    if (cached === null) cached = loader(url)
    return cached
  }
}
