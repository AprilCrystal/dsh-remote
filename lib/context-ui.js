/*
 * The phone-side context meter.
 *
 * Served verbatim from disk by lib/context-control.js, never inlined into the
 * panel's shell template, so this is an ordinary script.
 *
 * This is the phone's copy of the ring that sits beside the desktop's send
 * button: the same `contextPressure` reading and the same `contextBreakdown`
 * split, so the two surfaces cannot disagree. Compaction is the same
 * `ctx.compaction.compactNow` the desktop's /compact runs, so it produces a
 * normal compaction — a summary node the desktop renders as a checkpoint — and
 * not some panel-only state.
 *
 * Unlike the model picker this one has a fallback: the cluster it normally
 * registers into is a separate script, and a cluster that fails to load must not
 * take the meter down with it, so a standalone button is rendered if the cluster
 * never appears.
 */
(function () {
  'use strict'

  var view = { sessionId: null, fresh: true }
  var sheet = null
  var entry = null
  var standalone = null
  var lastSeen = null
  var state = {
    phase: 'loading',
    data: null,
    error: '',
    note: '',
    confirm: false,
    busy: false
  }

  function currentSession() {
    var s = window.__bridgeSession
    if (s && typeof s.id === 'string' && s.id !== '') return { id: s.id, fresh: s.fresh === true }
    return { id: '', fresh: true }
  }

  function api(query, body) {
    var init = { method: body === undefined ? 'GET' : 'POST', cache: 'no-store' }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    return fetch('api/context?' + query, init).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : ('HTTP ' + res.status))
          err.status = res.status
          throw err
        }
        return data
      })
    })
  }

  /**
   * Mirror the desktop's `formatTokens`, so 372000 reads as `372K` on both
   * surfaces rather than `372k` here and `372K` there.
   */
  function formatTokens(value) {
    var scaled = function (candidate) {
      return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
    }
    if (value < 1000) return String(value)
    if (value < 1000000) return scaled(value / 1000) + 'K'
    return scaled(value / 1000000) + 'M'
  }

  var ROWS = [
    { key: 'systemTokens', label: '系统提示词', color: '#8b949e' },
    { key: 'toolsTokens', label: '工具定义', color: '#a371f7' },
    { key: 'messageTokens', label: '对话消息', color: '#4493f8' }
  ]

  /* ---- the cluster entry -------------------------------------------------- */

  function paintChip() {
    var data = state.data
    var label = ''
    var title = '上下文占用'
    if (data && data.available === true) {
      label = data.percent + '%'
      title = '上下文已用 ' + data.percent + '% · ~' + formatTokens(data.usedTokens)
        + ' / ' + formatTokens(data.contextWindow)
    } else if (data && data.compact && data.compact.busy === true) {
      title = '上下文占用（这段会话正在回复）'
    } else if (data && typeof data.message === 'string' && data.message !== '') {
      title = data.message
    }
    if (entry !== null) {
      entry.setLabel(label)
      entry.setTitle(title)
    }
    if (standalone !== null) {
      standalone.querySelector('.ctxpct').textContent = label === '' ? '\u2013' : label
      standalone.title = title
    }
  }

  function refresh(load) {
    var s = currentSession()
    var query = 'session=' + encodeURIComponent(s.id) + (s.fresh ? '&fresh=1' : '')
    if (load === true) query += '&load=1'
    return api(query).then(function (data) {
      view.sessionId = s.id
      view.fresh = s.fresh
      state.phase = 'ready'
      state.data = data
      if (typeof data.message === 'string' && data.available !== true) state.note = data.message
      paintChip()
      return data
    }).catch(function (error) {
      state.phase = 'ready'
      state.data = null
      state.error = error.message
      paintChip()
      throw error
    })
  }

  /* ---- the bottom sheet --------------------------------------------------- */

  function injectStyles() {
    if (document.getElementById('ctxstyles') !== null) return
    var css = [
      '#ctxback{position:fixed;inset:0;background:rgba(1,4,9,.66);z-index:64}',
      '#ctxsheet{position:fixed;left:0;right:0;bottom:0;z-index:65;background:var(--panel,#161b22);',
      'border-top:1px solid var(--line,#30363d);border-radius:16px 16px 0 0;padding:16px 16px 22px;',
      'max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '#ctxsheet h3{margin:0 0 4px;font-size:16px}',
      '#ctxsheet .csub{color:var(--dim,#8b949e);font-size:12.5px;margin:0 0 14px}',
      '#ctxsheet .cbar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:#0d1117;margin:12px 0}',
      '#ctxsheet .cbar div{min-width:2px}',
      '#ctxsheet .crow{display:flex;justify-content:space-between;gap:10px;font-size:13.5px;padding:5px 0}',
      '#ctxsheet .crow i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:8px}',
      '#ctxsheet .crow span{color:var(--dim,#8b949e)}',
      '#ctxsheet .cnote{color:var(--dim,#8b949e);font-size:12px;margin:12px 0 0}',
      '#ctxsheet .crowbtns{display:flex;gap:9px;margin-top:16px;flex-wrap:wrap}',
      '#ctxsheet .crowbtns button{flex:1;min-width:104px;padding:11px;border-radius:9px;',
      'border:1px solid var(--line,#30363d);background:#21262d;color:var(--fg,#e6edf3);font:inherit;cursor:pointer}',
      '#ctxsheet .crowbtns button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}',
      '#ctxsheet .crowbtns button.danger{background:#8b2c22;border-color:#b62324;color:#fff}',
      '#ctxsheet .crowbtns button:disabled{opacity:.5}',
      '#ctxsheet .cerr{color:#ff7b72;font-size:13px;margin-top:10px;min-height:1.2em}',
      '#ctxsheet .cok{color:#3fb950;font-size:13px;margin-top:10px;min-height:1.2em}',
      '#ctxstandalone{position:fixed;right:12px;bottom:74px;z-index:44;display:flex;align-items:center;',
      'gap:6px;height:42px;padding:0 13px;border:1px solid var(--line,#30363d);border-radius:21px;',
      'background:rgba(22,27,34,.96);color:var(--fg,#e6edf3);font:inherit;font-size:13px;cursor:pointer;',
      'box-shadow:0 6px 18px rgba(1,4,9,.5)}',
      '#ctxstandalone .ctxpct{font-weight:600}'
    ].join('')
    var style = document.createElement('style')
    style.id = 'ctxstyles'
    style.textContent = css
    document.head.appendChild(style)
  }

  function build() {
    injectStyles()
    var back = document.createElement('div')
    back.id = 'ctxback'
    back.onclick = function () { closeSheet() }
    sheet = document.createElement('div')
    sheet.id = 'ctxsheet'
    document.body.append(back, sheet)
  }

  function closeSheet() {
    var back = document.getElementById('ctxback')
    if (back !== null) back.remove()
    if (sheet !== null) sheet.remove()
    sheet = null
    state.confirm = false
  }

  function heading(text, sub) {
    var h = document.createElement('h3')
    h.textContent = text
    var p = document.createElement('p')
    p.className = 'csub'
    p.textContent = sub
    return [h, p]
  }

  function row(label, color, value) {
    var line = document.createElement('div')
    line.className = 'crow'
    var left = document.createElement('div')
    var swatch = document.createElement('i')
    swatch.style.background = color
    left.append(swatch, document.createTextNode(label))
    var right = document.createElement('span')
    right.textContent = '~' + formatTokens(value)
    line.append(left, right)
    return line
  }

  function button(text, className, onClick) {
    var b = document.createElement('button')
    b.type = 'button'
    if (className) b.className = className
    b.textContent = text
    b.onclick = onClick
    return b
  }

  function render() {
    var nodes = []
    var data = state.data

    if (state.phase === 'loading') {
      var loading = heading('上下文占用', '正在读取…')
      nodes.push(loading[0], loading[1])
    } else if (data && data.available === true) {
      var head = heading(
        '上下文已用 ' + data.percent + '%',
        '~' + formatTokens(data.usedTokens) + ' / ' + formatTokens(data.contextWindow)
      )
      nodes.push(head[0], head[1])

      var total = 0
      var breakdown = data.breakdown
      if (breakdown) total = breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens

      // The bar's overall length is the provider-exact percent; the heuristic
      // breakdown only proportions its coloured parts. Same rule as the desktop,
      // including dropping zero-width parts rather than drawing a hairline over
      // an empty context.
      var bar = document.createElement('div')
      bar.className = 'cbar'
      if (!breakdown || total === 0) {
        var whole = document.createElement('div')
        whole.style.width = data.percent + '%'
        whole.style.background = '#4493f8'
        bar.appendChild(whole)
      } else {
        ROWS.forEach(function (r) {
          var width = data.percent * breakdown[r.key] / total
          if (width <= 0) return
          var part = document.createElement('div')
          part.style.width = width + '%'
          part.style.background = r.color
          bar.appendChild(part)
        })
      }
      nodes.push(bar)

      if (breakdown) {
        ROWS.forEach(function (r) { nodes.push(row(r.label, r.color, breakdown[r.key])) })
      }

      var note = document.createElement('p')
      note.className = 'cnote'
      note.textContent = '占用来自最近一次请求的实测值，按这段会话之后的增减推算；明细是按 token 估算的拆分，'
        + '三项之和可以与上面的占用不同。'
      nodes.push(note)

      if (data.compact && data.compact.available === false) {
        var off = document.createElement('p')
        off.className = 'cnote'
        off.textContent = data.compact.message || '这个进程没有加载压缩服务。'
        nodes.push(off)
      }
    } else {
      var empty = heading('上下文占用', (data && data.message) || '这段会话还没有可读的上下文占用。')
      nodes.push(empty[0], empty[1])
      if (data && data.reason === 'cold') {
        var cold = document.createElement('p')
        cold.className = 'cnote'
        cold.textContent = '把这段会话载入内存才能读到占用。载入本身不会让它开始回复。'
        nodes.push(cold)
      }
    }

    var buttons = document.createElement('div')
    buttons.className = 'crowbtns'

    if (data && data.reason === 'cold') {
      buttons.appendChild(button('读取占用', 'primary', function () { void loadAndRender() }))
    } else if (data && data.available === true && data.compact && data.compact.available === true) {
      if (data.compact.busy === true) {
        var busyBtn = button('会话正在回复', '', function () {})
        busyBtn.disabled = true
        buttons.appendChild(busyBtn)
      } else if (state.confirm) {
        buttons.appendChild(button('确认压缩', 'danger', function () { void compact() }))
      } else {
        buttons.appendChild(button('压缩上下文', 'primary', function () {
          state.confirm = true
          state.error = ''
          state.note = ''
          render()
        }))
      }
    }
    buttons.appendChild(button('刷新', '', function () { void loadAndRender() }))
    buttons.appendChild(button('关闭', '', function () { closeSheet() }))
    nodes.push(buttons)

    if (state.confirm) {
      var warn = document.createElement('p')
      warn.className = 'cnote'
      warn.textContent = '压缩会把较早的历史换成一段摘要，桌面上会显示成一条检查点。'
        + '原始记录仍留在会话日志里，但这段对话的可见历史会变短。再点一次「确认压缩」执行。'
      nodes.push(warn)
    }

    var ok = document.createElement('div')
    ok.className = 'cok'
    ok.textContent = state.busy ? '正在压缩…' : (state.confirm ? '' : state.note)
    nodes.push(ok)

    var err = document.createElement('div')
    err.className = 'cerr'
    err.textContent = state.error
    nodes.push(err)

    sheet.replaceChildren.apply(sheet, nodes)
    paintChip()
  }

  /** Attach the conversation, then render what came back. */
  function loadAndRender() {
    state.confirm = false
    state.error = ''
    state.note = ''
    return refresh(true).then(function () {
      if (sheet !== null) render()
    }).catch(function () {
      if (sheet !== null) render()
    })
  }

  function compact() {
    var s = currentSession()
    state.confirm = false
    state.busy = true
    state.error = ''
    state.note = ''
    render()
    api('', { session: s.id, action: 'compact' }).then(function (data) {
      state.busy = false
      state.data = data.state || state.data
      state.note = data.message || '已压缩。'
      render()
    }).catch(function (error) {
      state.busy = false
      state.error = error.message
      render()
    })
  }

  function openSheet() {
    if (sheet === null) build()
    state.phase = 'loading'
    state.error = ''
    state.note = ''
    state.confirm = false
    state.busy = false
    render()
    // The first read is cold on purpose: opening the meter must not attach a
    // conversation the reader has only tapped the button for. `读取占用` does.
    return refresh(false).then(function () {
      if (sheet !== null) render()
    }).catch(function () {
      if (sheet !== null) render()
    })
  }

  /* ---- boot --------------------------------------------------------------- */

  /** Register into the cluster, or stand alone if the cluster never arrives. */
  function mount() {
    if (entry !== null || standalone !== null) return true
    if (window.__bridgeFab) {
      entry = window.__bridgeFab.add({
        id: 'context',
        icon: '\uD83D\uDCCA',
        label: '',
        title: '上下文占用',
        order: 15,
        onClick: function () { void openSheet() }
      })
      return true
    }
    return false
  }

  function mountStandalone() {
    if (entry !== null || standalone !== null) return
    injectStyles()
    var node = document.createElement('button')
    node.type = 'button'
    node.id = 'ctxstandalone'
    node.title = '上下文占用'
    var icon = document.createElement('span')
    icon.textContent = '\uD83D\uDCCA'
    var pct = document.createElement('span')
    pct.className = 'ctxpct'
    pct.textContent = '\u2013'
    node.append(icon, pct)
    node.onclick = function () { void openSheet() }
    document.body.appendChild(node)
    standalone = node
  }

  function boot() {
    lastSeen = currentSession()
    // panel-fab.js is a deferred script ordered before this one, so the cluster
    // is normally already up; retry briefly rather than losing the button to a
    // load-order race, then fall back to standing alone.
    var tries = 0
    function attach() {
      if (mount()) { void refresh(false).catch(function () {}); return }
      tries += 1
      if (tries <= 40) { setTimeout(attach, 50); return }
      mountStandalone()
      void refresh(false).catch(function () {})
    }
    attach()
    setInterval(function () {
      var now = currentSession()
      if (now.id !== lastSeen.id || now.fresh !== lastSeen.fresh) {
        lastSeen = now
        if (sheet === null) void refresh(false).catch(function () {})
      }
    }, 1500)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
