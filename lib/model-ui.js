/*
 * The phone-side model picker.
 *
 * Served verbatim from disk by lib/model-control.js, never inlined into the
 * panel's shell template, so this is an ordinary script.
 *
 * Switching a model is not a privilege change — it cannot widen the sandbox — so
 * unlike the permission dialog this one applies immediately and needs no code
 * from the desktop.
 */
(function () {
  'use strict'

  var view = { sessionId: null, fresh: true }
  var sheet = null
  var entry = null
  var lastSeen = null
  var state = {
    step: 'list',
    groups: [],
    failures: [],
    current: null,
    defaultSelection: null,
    manageable: true,
    live: false,
    note: '',
    pendingModel: null
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
    return fetch('api/model?' + query, init).then(function (res) {
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

  /** Find the catalogue entry for a selection, so the chip shows a real name. */
  function describe(selection) {
    if (selection == null) return '默认'
    for (var i = 0; i < state.groups.length; i += 1) {
      var group = state.groups[i]
      if (group.id !== selection.provider) continue
      for (var j = 0; j < group.models.length; j += 1) {
        if (group.models[j].id === selection.model) {
          return group.models[j].name || selection.model
        }
      }
    }
    return selection.model
  }

  function active() {
    return state.current || state.defaultSelection
  }

  /* ---- the cluster entry -------------------------------------------------- */

  /** Effort ids are adapter-owned; these are the ones the shipped adapters use. */
  var EFFORT_LABELS = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }

  function effortLabel(id) {
    if (id == null || id === '') return ''
    return EFFORT_LABELS[id] || String(id)
  }

  /**
   * Register into the bottom-right cluster rather than the header: two chips up
   * there squeezed the conversation title down to an ellipsis.
   * @returns whether the cluster was ready.
   */
  function mountEntry() {
    if (entry !== null) return true
    if (!window.__bridgeFab) return false
    entry = window.__bridgeFab.add({
      id: 'model',
      icon: '\uD83E\uDDE0',
      label: '模型',
      title: '本会话使用的模型',
      order: 20,
      onClick: function () { void openSheet() }
    })
    return true
  }

  function paintChip() {
    if (entry === null) return
    var selection = active()
    var effort = selection == null ? '' : effortLabel(selection.reasoningEffort)
    entry.setLabel(describe(selection) + (effort === '' ? '' : ' · ' + effort))
    entry.setTitle(selection == null
      ? '本会话使用部署默认模型'
      : selection.provider + ' / ' + selection.model
        + (effort === '' ? '' : '  (思考强度 ' + effort + ')'))
  }

  function refresh() {
    var s = currentSession()
    var query = 'session=' + encodeURIComponent(s.id) + (s.fresh ? '&fresh=1' : '')
    return api(query).then(function (data) {
      view.sessionId = s.id
      view.fresh = s.fresh
      state.groups = Array.isArray(data.groups) ? data.groups : []
      state.failures = Array.isArray(data.failures) ? data.failures : []
      state.current = data.current || null
      state.defaultSelection = data.default || null
      state.manageable = data.manageable !== false
      state.live = data.live === true
      state.note = typeof data.note === 'string' ? data.note : ''
      paintChip()
    }).catch(function () {
      if (entry !== null) entry.setLabel('模型不可用')
    })
  }

  /* ---- the bottom sheet --------------------------------------------------- */

  function injectStyles() {
    var css = [
      '#modelback{position:fixed;inset:0;background:rgba(1,4,9,.66);z-index:60}',
      '#modelsheet{position:fixed;left:0;right:0;bottom:0;z-index:61;background:var(--panel,#161b22);',
      'border-top:1px solid var(--line,#30363d);border-radius:16px 16px 0 0;padding:16px 16px 22px;',
      'max-height:88vh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '#modelsheet h3{margin:0 0 4px;font-size:16px}',
      '#modelsheet .msub{color:var(--dim,#8b949e);font-size:12.5px;margin:0 0 14px}',
      '#modelsheet .mgroup{color:var(--dim,#8b949e);font-size:12px;text-transform:uppercase;',
      'letter-spacing:.06em;margin:14px 0 6px}',
      '#modelsheet .mopt{display:block;width:100%;text-align:left;padding:10px 12px;margin-bottom:8px;',
      'border:1px solid var(--line,#30363d);border-radius:10px;background:#0d1117;color:var(--fg,#e6edf3);',
      'font:inherit;cursor:pointer}',
      '#modelsheet .mopt[data-on="1"]{border-color:var(--accent,#4493f8)}',
      '#modelsheet .mopt b{display:block;font-size:14.5px;font-weight:600}',
      '#modelsheet .mopt span{display:block;color:var(--dim,#8b949e);font-size:12.5px;margin-top:2px}',
      '#modelsheet .mnote{color:#d29922;font-size:13px;margin:0 0 12px}',
      '#modelsheet .mrow{display:flex;gap:9px;margin-top:12px;flex-wrap:wrap}',
      '#modelsheet .mrow button{flex:1;min-width:110px;padding:11px;border-radius:9px;',
      'border:1px solid var(--line,#30363d);background:#21262d;color:var(--fg,#e6edf3);font:inherit;cursor:pointer}',
      '#modelsheet .mrow button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}',
      '#modelsheet .mrow button:disabled{opacity:.5}',
      '#modelsheet .merr{color:#ff7b72;font-size:13px;margin-top:10px;min-height:1.2em}'
    ].join('')
    var style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  }

  function build() {
    injectStyles()
    var back = document.createElement('div')
    back.id = 'modelback'
    back.onclick = function () { closeSheet() }
    sheet = document.createElement('div')
    sheet.id = 'modelsheet'
    document.body.append(back, sheet)
  }

  function closeSheet() {
    if (sheet !== null && sheet.parentNode !== null) {
      document.getElementById('modelback').remove()
      sheet.remove()
    }
    sheet = null
  }

  function heading(text, sub) {
    var h = document.createElement('h3')
    h.textContent = text
    var p = document.createElement('p')
    p.className = 'msub'
    p.textContent = sub
    return [h, p]
  }

  function render() {
    var nodes = []

    if (state.step === 'list') {
      var head = heading('会话模型', state.current == null
        ? '本会话还没选过模型，当前跟随部署默认。'
        : '当前：' + describe(state.current)
          + (state.current.reasoningEffort == null ? '' : ' · 思考 ' + state.current.reasoningEffort))
      nodes.push(head[0], head[1])

      if (!state.manageable) {
        var warn = document.createElement('p')
        warn.className = 'mnote'
        warn.textContent = state.note === ''
          ? '这段会话的模型暂时不能从手机端改。'
          : state.note
        nodes.push(warn)
      }

      state.groups.forEach(function (group) {
        var label = document.createElement('div')
        label.className = 'mgroup'
        label.textContent = group.name || group.id
        nodes.push(label)
        group.models.forEach(function (model) {
          var on = state.current != null
            && state.current.provider === group.id
            && state.current.model === model.id
          var b = document.createElement('button')
          b.type = 'button'
          b.className = 'mopt'
          b.setAttribute('data-on', on ? '1' : '0')
          b.disabled = !state.manageable
          var strong = document.createElement('b')
          strong.textContent = model.name || model.id
          var small = document.createElement('span')
          var bits = [group.id + ' / ' + model.id]
          if (model.description) bits.push(model.description)
          if (model.reasoning && model.reasoning.efforts && model.reasoning.efforts.length > 0) {
            bits.push('可调思考强度')
          }
          if (on) bits.push('当前')
          small.textContent = bits.join(' · ')
          b.append(strong, small)
          b.onclick = function () { choose(group.id, model) }
          nodes.push(b)
        })
      })

      state.failures.forEach(function (failure) {
        var warn = document.createElement('p')
        warn.className = 'mnote'
        warn.textContent = '供应商 ' + (failure.name || failure.id) + ' 读取失败：' + failure.message
        nodes.push(warn)
      })

      if (state.groups.length === 0) {
        var empty = document.createElement('p')
        empty.className = 'msub'
        empty.textContent = '没有读到任何可用的模型。'
        nodes.push(empty)
      }
    } else if (state.step === 'effort') {
      var efforts = state.pendingModel.reasoning.efforts || []
      var head2 = heading('思考强度', efforts.length === 0
        ? '模型 ' + state.pendingModel.name + ' 没有列出可选强度，只能用适配器默认。'
        : '模型 ' + state.pendingModel.name + ' 支持这些强度。选一个，或者用适配器默认。')
      nodes.push(head2[0], head2[1])
      var defaultId = state.pendingModel.reasoning.defaultEffort
      var options = [{ id: undefined, name: '适配器默认', description: '不显式指定强度' }].concat(efforts)
      options.forEach(function (effort) {
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'mopt'
        var on = effort.id === undefined
          ? state.current != null && state.current.model === state.pendingModel.id
            && state.current.reasoningEffort == null
          : state.current != null && state.current.reasoningEffort === effort.id
        b.setAttribute('data-on', on ? '1' : '0')
        var strong = document.createElement('b')
        strong.textContent = effort.name || effort.id
        var small = document.createElement('span')
        var bits = []
        if (effort.description) bits.push(effort.description)
        if (defaultId !== undefined && effort.id === defaultId) bits.push('模型默认')
        small.textContent = bits.join(' · ')
        b.append(strong, small)
        b.onclick = function () { void apply(state.pendingModel.provider, state.pendingModel.id, effort.id) }
        nodes.push(b)
      })

      var row = document.createElement('div')
      row.className = 'mrow'
      var back = document.createElement('button')
      back.textContent = '返回'
      back.onclick = function () { state.step = 'list'; render() }
      row.appendChild(back)
      nodes.push(row)
    } else {
      var head3 = heading(state.step === 'done' ? '已切换' : '未切换', state.note)
      nodes.push(head3[0], head3[1])
      var row3 = document.createElement('div')
      row3.className = 'mrow'
      var close = document.createElement('button')
      close.className = 'primary'
      close.textContent = '关闭'
      close.onclick = function () { closeSheet() }
      row3.appendChild(close)
      if (state.step === 'done') {
        var again = document.createElement('button')
        again.textContent = '继续改'
        again.onclick = function () { void openSheet() }
        row3.appendChild(again)
      }
      nodes.push(row3)
    }

    var err = document.createElement('div')
    err.className = 'merr'
    err.id = 'modelerr'
    err.textContent = state.step === 'done' ? '' : (state.error || '')
    nodes.push(err)

    sheet.replaceChildren.apply(sheet, nodes)
  }

  function choose(provider, model) {
    var reasoning = model.reasoning
    var inherited = state.current !== null && state.current.reasoningEffort != null
    // Offer the effort step whenever the adapter declares reasoning at all — not
    // only when it enumerates efforts. A model with a default effort but no list
    // still needs a way to show what it is doing, and to clear an inherited one.
    if (reasoning !== undefined || inherited) {
      state.pendingModel = {
        provider: provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: reasoning || {}
      }
      state.step = 'effort'
      state.error = ''
      render()
      return
    }
    void apply(provider, model.id, undefined)
  }

  function apply(provider, model, reasoningEffort) {
    var s = currentSession()
    var body = { session: s.id, provider: provider, model: model }
    if (reasoningEffort !== undefined) body.reasoningEffort = reasoningEffort
    return api('', body).then(function (data) {
      state.current = data.current || { provider: provider, model: model, reasoningEffort: reasoningEffort }
      state.step = 'done'
      state.note = '接下来这一步就会用 ' + describe(state.current)
        + (state.current.reasoningEffort == null ? '' : ' · 思考 ' + state.current.reasoningEffort)
        + '。已经发出的一步不受影响。'
      state.error = ''
      render()
      paintChip()
    }).catch(function (error) {
      state.error = error.message
      render()
    })
  }

  function openSheet() {
    if (sheet === null) build()
    state.step = 'list'
    state.error = ''
    state.pendingModel = null
    render()
    return refresh().then(function () {
      if (sheet !== null && state.step === 'list') render()
    })
  }

  /* ---- boot --------------------------------------------------------------- */

  function boot() {
    lastSeen = currentSession()
    // panel-fab.js is a deferred script ordered before this one, so the cluster
    // is normally already up; retry briefly rather than losing the button to a
    // load-order race.
    var tries = 0
    function attach() {
      if (mountEntry()) { void refresh(); return }
      tries += 1
      if (tries <= 40) setTimeout(attach, 50)
    }
    attach()
    setInterval(function () {
      var now = currentSession()
      if (now.id !== lastSeen.id || now.fresh !== lastSeen.fresh) {
        lastSeen = now
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
