/*
 * The phone-side half of the permission gate.
 *
 * Served verbatim from disk by lib/permission-gate.js (never inlined into the
 * panel's shell template), so this file is a normal script: no escaping rules
 * apply to it, and a syntax error here cannot take the whole panel down.
 *
 * The flow it drives:
 *   tap the header chip -> pick a preset -> POST action=request
 *   -> a code appears on the desktop -> type it -> POST action=confirm
 *
 * The code is never returned to this page. `action=state` deliberately omits it.
 */
(function () {
  'use strict'

  var LABELS = {
    'read-only': '只读',
    'workspace-write': '工作区可写',
    'danger-full-access': '完全访问'
  }
  var ICONS = {
    'read-only': '\uD83D\uDD12',
    'workspace-write': '\u270E',
    'danger-full-access': '\u26A0'
  }

  var view = { sessionId: null, fresh: true, preset: null, options: [], mode: 'display' }
  var sheet = null
  var poll = null
  var lastSeenSession = null
  var dialog = { step: 'pick', requestId: '', preset: '', error: '' }

  function currentSession() {
    var s = window.__bridgeSession
    if (s && typeof s.id === 'string' && s.id !== '') return { id: s.id, fresh: s.fresh === true }
    return { id: '', fresh: true }
  }

  function label(name) {
    if (typeof name !== 'string' || name === '') return '未知'
    return LABELS[name] || name
  }

  function api(query, body) {
    var init = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    return fetch('api/perm?' + query, init).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : ('HTTP ' + res.status))
          err.status = res.status
          err.data = data
          throw err
        }
        return data
      })
    })
  }

  /* ---- the header chip ---------------------------------------------------- */

  var chip = null

  function mountChip() {
    var header = document.querySelector('header')
    if (header === null || chip !== null) return
    chip = document.createElement('button')
    chip.type = 'button'
    chip.id = 'permchip'
    chip.className = 'hbtn permchip'
    chip.style.width = 'auto'
    chip.style.padding = '0 11px'
    chip.style.fontSize = '13px'
    chip.style.whiteSpace = 'nowrap'
    chip.title = '会话权限档位'
    chip.textContent = '\uD83D\uDD12 权限'
    chip.onclick = function () { void openSheet() }
    header.appendChild(chip)
  }

  function paintChip() {
    if (chip === null) return
    if (view.fresh && view.preset === null) {
      chip.textContent = (ICONS[view.defaultPreset] || '\uD83D\uDD12') + ' ' + label(view.defaultPreset)
      chip.title = '新对话将使用默认档位 ' + label(view.defaultPreset)
      return
    }
    var name = view.preset === null ? view.defaultPreset : view.preset
    chip.textContent = (ICONS[name] || '\uD83D\uDD12') + ' ' + label(name)
    chip.title = '当前档位 ' + label(name)
  }

  function refresh() {
    var s = currentSession()
    var query = 'action=options&session=' + encodeURIComponent(s.id) + (s.fresh ? '&fresh=1' : '')
    return api(query).then(function (data) {
      view.sessionId = s.id
      view.fresh = s.fresh
      view.options = Array.isArray(data.options) ? data.options : []
      view.preset = typeof data.current === 'string' ? data.current : null
      view.defaultPreset = typeof data.defaultPreset === 'string' ? data.defaultPreset : 'read-only'
      view.mode = data.mode === 'fixed' ? 'fixed' : 'display'
      paintChip()
    }).catch(function () {
      if (chip !== null) chip.textContent = '\u26A0 权限'
    })
  }

  /* ---- the bottom sheet --------------------------------------------------- */

  function injectStyles() {
    var css = [
      '#permback{position:fixed;inset:0;background:rgba(1,4,9,.66);z-index:60}',
      '#permsheet{position:fixed;left:0;right:0;bottom:0;z-index:61;background:var(--panel,#161b22);',
      'border-top:1px solid var(--line,#30363d);border-radius:16px 16px 0 0;padding:16px 16px 22px;',
      'max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '#permsheet h3{margin:0 0 4px;font-size:16px}',
      '#permsheet .psub{color:var(--dim,#8b949e);font-size:12.5px;margin:0 0 14px}',
      '#permsheet .popt{display:block;width:100%;text-align:left;padding:11px 12px;margin-bottom:9px;',
      'border:1px solid var(--line,#30363d);border-radius:10px;background:#0d1117;color:var(--fg,#e6edf3);',
      'font:inherit;cursor:pointer}',
      '#permsheet .popt[data-on="1"]{border-color:var(--accent,#4493f8)}',
      '#permsheet .popt b{display:block;font-size:14.5px;font-weight:600}',
      '#permsheet .popt span{display:block;color:var(--dim,#8b949e);font-size:12.5px;margin-top:2px}',
      '#permsheet .pcode{font:700 30px/1 ui-monospace,Consolas,monospace;letter-spacing:.18em;',
      'text-align:center;color:var(--accent,#4493f8);margin:10px 0 12px}',
      '#permsheet input.pin{display:block;width:100%;padding:12px;font:600 20px/1.2 ui-monospace,Consolas,monospace;',
      'letter-spacing:.32em;text-align:center;background:#0d1117;color:var(--fg,#e6edf3);',
      'border:1px solid var(--line,#30363d);border-radius:10px}',
      '#permsheet .prow{display:flex;gap:9px;margin-top:12px}',
      '#permsheet .prow button{flex:1;padding:11px;border-radius:9px;border:1px solid var(--line,#30363d);',
      'background:#21262d;color:var(--fg,#e6edf3);font:inherit;cursor:pointer}',
      '#permsheet .prow button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}',
      '#permsheet .prow button:disabled{opacity:.5}',
      '#permsheet .perr{color:#ff7b72;font-size:13px;margin-top:10px;min-height:1.2em}',
      '#permsheet .pstat{color:var(--dim,#8b949e);font-size:13px;margin-top:10px;min-height:1.2em}'
    ].join('')
    var style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  }

  function build() {
    injectStyles()
    var back = document.createElement('div')
    back.id = 'permback'
    back.onclick = function () { closeSheet() }
    sheet = document.createElement('div')
    sheet.id = 'permsheet'
    document.body.append(back, sheet)
  }

  function closeSheet() {
    if (poll !== null) { clearInterval(poll); poll = null }
    if (sheet !== null && sheet.parentNode !== null) {
      document.getElementById('permback').remove()
      sheet.remove()
    }
    sheet = null
  }

  function render() {
    var nodes = []
    var h = document.createElement('h3')

    if (dialog.step === 'pick') {
      h.textContent = '会话权限档位'
      nodes.push(h)
      var sub = document.createElement('p')
      sub.className = 'psub'
      sub.textContent = view.fresh
        ? '新对话。默认档位 ' + label(view.defaultPreset) + '；变更会立即写入这段会话。'
        : '当前 ' + label(view.preset) + '。变更需要电脑上显示的验证码。'
      nodes.push(sub)

      view.options.forEach(function (option) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'popt'
        b.setAttribute('data-on', option.value === view.preset ? '1' : '0')
        var strong = document.createElement('b')
        strong.textContent = (ICONS[option.value] || '') + ' ' + label(option.value)
        var small = document.createElement('span')
        small.textContent = (option.description || '') + (option.value === view.preset ? ' · 当前' : '')
        b.append(strong, small)
        b.onclick = function () { void ask(option.value) }
        nodes.push(b)
      })

      var note = document.createElement('p')
      note.className = 'psub'
      note.style.margin = '10px 0 0'
      note.textContent = '完全访问（danger-full-access）不允许从手机端变更，请到电脑上操作。'
      nodes.push(note)
    } else if (dialog.step === 'wait') {
      h.textContent = '等待电脑授权'
      nodes.push(h)
      var s2 = document.createElement('p')
      s2.className = 'psub'
      s2.textContent = '把 ' + label(dialog.preset) + ' 的请求已发到电脑。'
      nodes.push(s2)

      if (view.mode === 'display') {
        var codeBox = document.createElement('div')
        codeBox.className = 'pcode'
        codeBox.textContent = '· · · · · ·'
        nodes.push(codeBox)
        var hint = document.createElement('p')
        hint.className = 'psub'
        hint.textContent = '电脑上会弹出一个窗口显示 6 位验证码，把它填到下面。'
        nodes.push(hint)
      } else {
        var hint2 = document.createElement('p')
        hint2.className = 'psub'
        hint2.textContent = '电脑上会弹出确认窗口。请输入你配置好的固定验证码。'
        nodes.push(hint2)
      }

      var input = document.createElement('input')
      input.className = 'pin'
      input.type = 'text'
      input.inputMode = 'numeric'
      input.autocomplete = 'off'
      input.maxLength = 12
      input.placeholder = '验证码'
      input.id = 'pincode'
      input.oninput = function () { if (dialog.error !== '') { dialog.error = ''; paintError() } }
      nodes.push(input)

      var err = document.createElement('div')
      err.className = 'perr'
      err.id = 'pinerr'
      err.textContent = dialog.error
      nodes.push(err)

      var row = document.createElement('div')
      row.className = 'prow'
      var ok = document.createElement('button')
      ok.className = 'primary'
      ok.id = 'pinok'
      ok.textContent = '确认授权'
      ok.onclick = function () { void submitCode(input.value, ok) }
      var no = document.createElement('button')
      no.textContent = '取消'
      no.onclick = function () { void abandon() }
      row.append(ok, no)
      nodes.push(row)

      var stat = document.createElement('div')
      stat.className = 'pstat'
      stat.id = 'pinstat'
      stat.textContent = '正在等待电脑端显示验证码…'
      nodes.push(stat)
    } else {
      h.textContent = dialog.step === 'done' ? '已生效' : '未变更'
      nodes.push(h)
      var s3 = document.createElement('p')
      s3.className = 'psub'
      s3.textContent = dialog.error
      nodes.push(s3)
      var row3 = document.createElement('div')
      row3.className = 'prow'
      var close = document.createElement('button')
      close.className = 'primary'
      close.textContent = '关闭'
      close.onclick = function () { closeSheet() }
      row3.appendChild(close)
      nodes.push(row3)
    }

    sheet.replaceChildren.apply(sheet, nodes)
    if (dialog.step === 'wait') {
      var pin = document.getElementById('pincode')
      if (pin !== null) pin.focus()
    }
  }

  function paintError() {
    var err = document.getElementById('pinerr')
    if (err !== null) err.textContent = dialog.error
  }

  function setStatus(text) {
    var stat = document.getElementById('pinstat')
    if (stat !== null) stat.textContent = text
  }

  function openSheet() {
    if (sheet === null) build()
    dialog.step = 'pick'
    dialog.requestId = ''
    dialog.preset = ''
    dialog.error = ''
    render()
    return refresh().then(function () {
      if (sheet !== null && dialog.step === 'pick') render()
    })
  }

  function ask(preset) {
    if (preset === view.preset && !view.fresh) {
      dialog.step = 'done'
      dialog.error = '这段会话已经是「' + label(preset) + '」，无需变更。'
      render()
      return Promise.resolve()
    }
    var s = currentSession()
    return api('action=request', { session: s.id, preset: preset }).then(function (data) {
      dialog.step = 'wait'
      dialog.requestId = data.id
      dialog.preset = preset
      dialog.error = ''
      render()
      startPolling()
    }).catch(function (error) {
      dialog.step = 'done'
      dialog.error = '无法发起变更：' + error.message
      render()
    })
  }

  function startPolling() {
    if (poll !== null) clearInterval(poll)
    poll = setInterval(function () {
      if (dialog.requestId === '') return
      api('action=state&id=' + encodeURIComponent(dialog.requestId)).then(function (state) {
        if (state.status === 'approved') {
          settle('done', '已授权：权限现在是「' + label(state.applied || state.preset) + '」。')
          void refresh()
        } else if (state.status === 'rejected') {
          settle('done', '这次请求已被拒绝（电脑端拒绝，或验证码错误次数过多）。')
        } else if (state.status === 'expired') {
          settle('done', '这次请求已过期，请重新发起。')
        } else if (state.status === 'cancelled') {
          settle('done', '这次请求已取消。')
        } else {
          setStatus('等待电脑端输入确认…（剩余 ' + Math.round(Math.max(0, state.expiresAt - Date.now()) / 1000) + ' 秒）')
        }
      }).catch(function (error) {
        if (error.status === 404) settle('done', '这次请求已经不存在了。')
      })
    }, 1500)
  }

  function settle(step, message) {
    if (poll !== null) { clearInterval(poll); poll = null }
    dialog.step = step
    dialog.error = message
    render()
  }

  function submitCode(value, button) {
    var code = String(value || '').trim()
    if (code === '') { dialog.error = '请先输入验证码'; paintError(); return Promise.resolve() }
    button.disabled = true
    return api('action=confirm', { id: dialog.requestId, code: code }).then(function (data) {
      settle('done', '已授权：权限现在是「' + label(data.applied || data.preset) + '」。')
      return refresh()
    }).catch(function (error) {
      button.disabled = false
      dialog.error = error.message
      paintError()
      if (error.status === 409) settle('done', error.message)
      var input = document.getElementById('pincode')
      if (input !== null) { input.value = ''; input.focus() }
    })
  }

  function abandon() {
    var id = dialog.requestId
    dialog.requestId = ''
    closeSheet()
    if (id !== '') void api('action=cancel', { id: id }).catch(function () {})
    return Promise.resolve()
  }

  /* ---- boot --------------------------------------------------------------- */

  function boot() {
    mountChip()
    // The session changes when the user opens another conversation from the
    // drawer; that is a local assignment, so poll the cheap pointer rather than
    // hitting the server on a timer.
    lastSeenSession = currentSession()
    void refresh()
    setInterval(function () {
      var now = currentSession()
      if (now.id !== lastSeenSession.id || now.fresh !== lastSeenSession.fresh) {
        lastSeenSession = now
        if (sheet === null) void refresh()
      }
    }, 1500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
