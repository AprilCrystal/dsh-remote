/*
 * The bottom-right action cluster.
 *
 * Served verbatim from disk by lib/panel.js (never inlined into the panel's
 * shell template), so this is an ordinary script.
 *
 * Why this exists: the permission and model indicators started life as header
 * chips, and two of them squeezed the conversation title down to an ellipsis.
 * Everything secondary now lives behind ONE button in the corner instead, and
 * the cluster measures the composer so it never sits underneath it — the
 * composer is sticky at the bottom of the viewport, so its height is exactly the
 * space the cluster has to clear.
 *
 * Other modules register through `window.__bridgeFab.add(...)`.
 */
(function () {
  'use strict'

  var GAP = 10
  var items = []
  var root = null
  var toggle = null
  var stack = null
  var open = false

  /* ---- layout ------------------------------------------------------------- */

  var lastGoodHeight = 0

  function composerHeight() {
    var composer = document.querySelector('.composer')
    if (composer === null) return lastGoodHeight
    var height = composer.getBoundingClientRect().height
    // A re-render can momentarily report zero; the last good height keeps the
    // cluster from dropping onto top of the input for a frame.
    if (height <= 0) return lastGoodHeight
    lastGoodHeight = height
    return height
  }

  function measure() {
    if (root === null) return
    var next = String(Math.max(0, Math.round(composerHeight() + GAP)))
    if (root.dataset.bottom === next) return
    root.dataset.bottom = next
    root.style.bottom = next + 'px'
  }

  /* ---- rendering ---------------------------------------------------------- */

  function styles() {
    var css = [
      '#bridgefab{position:fixed;right:12px;z-index:45;display:flex;flex-direction:column;',
      'align-items:flex-end;gap:8px;pointer-events:none}',
      '#bridgefab > *{pointer-events:auto}',
      '#bridgefab .fabit{display:flex;align-items:center;gap:8px;max-width:74vw;height:42px;',
      'padding:0 14px;border:1px solid var(--line,#30363d);border-radius:21px;',
      'background:rgba(22,27,34,.96);color:var(--fg,#e6edf3);font:inherit;font-size:14px;',
      'cursor:pointer;box-shadow:0 6px 18px rgba(1,4,9,.5);white-space:nowrap}',
      '#bridgefab .fabit:active{background:#30363d}',
      '#bridgefab .fabit .fico{font-size:16px;line-height:1}',
      '#bridgefab .fabit .flab{overflow:hidden;text-overflow:ellipsis}',
      '#bridgefab .fabit[hidden]{display:none}',
      '#bridgefab #fabtoggle{width:46px;height:46px;padding:0;justify-content:center;',
      'font-size:20px;background:#1f6feb;border-color:#1f6feb;color:#fff}',
      '#bridgefab #fabtoggle:active{background:#1a5fd0}',
      '#bridgefab .fabstack{display:flex;flex-direction:column;align-items:flex-end;gap:8px}',
      '#bridgefab .fabstack[hidden]{display:none}'
    ].join('')
    var style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
  }

  function paintItem(item) {
    if (item.node === null) return
    item.node.hidden = item.visible === false
    item.node.title = item.title
    var icon = item.node.querySelector('.fico')
    var label = item.node.querySelector('.flab')
    if (icon !== null) icon.textContent = item.icon
    if (label !== null) {
      label.textContent = item.label
      label.hidden = item.label === ''
    }
  }

  function buildItem(item) {
    var node = document.createElement('button')
    node.type = 'button'
    node.className = 'fabit'
    node.id = 'fab-' + item.id
    var icon = document.createElement('span')
    icon.className = 'fico'
    var label = document.createElement('span')
    label.className = 'flab'
    node.append(icon, label)
    node.onclick = function () {
      collapse()
      if (typeof item.onClick === 'function') item.onClick()
    }
    item.node = node
    paintItem(item)
    return node
  }

  function render() {
    if (root === null) return
    var nodes = []
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].node === null) buildItem(items[i])
      nodes.push(items[i].node)
    }
    stack.replaceChildren.apply(stack, nodes)
  }

  function expand() {
    open = true
    stack.hidden = false
    toggle.textContent = '\u00D7'
    toggle.setAttribute('aria-label', '收起操作')
    measure()
  }

  function collapse() {
    open = false
    stack.hidden = true
    toggle.textContent = '\u22EF'
    toggle.setAttribute('aria-label', '更多操作')
  }

  function build() {
    styles()
    root = document.createElement('div')
    root.id = 'bridgefab'
    root.dataset.bottom = ''
    stack = document.createElement('div')
    stack.className = 'fabstack'
    stack.hidden = true
    toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.id = 'fabtoggle'
    toggle.className = 'fabit'
    toggle.setAttribute('aria-label', '更多操作')
    toggle.textContent = '\u22EF'
    toggle.onclick = function () { if (open) collapse(); else expand() }
    root.append(stack, toggle)
    document.body.appendChild(root)
    measure()
  }

  /* ---- the public surface ------------------------------------------------- */

  function add(config) {
    var item = {
      id: String(config.id),
      icon: config.icon || '',
      label: config.label || '',
      title: config.title || '',
      order: typeof config.order === 'number' ? config.order : 100,
      onClick: config.onClick,
      visible: config.visible !== false,
      node: null
    }
    items.push(item)
    items.sort(function (left, right) { return left.order - right.order })
    if (root !== null) render()
    return {
      setLabel: function (text) { item.label = text; paintItem(item) },
      setTitle: function (text) { item.title = text; paintItem(item) },
      setVisible: function (flag) { item.visible = flag; paintItem(item) },
      remove: function () {
        items = items.filter(function (entry) { return entry !== item })
        if (item.node !== null) item.node.remove()
      }
    }
  }

  /** Collapse when the reader starts scrolling: the menu has served its purpose. */
  window.addEventListener('scroll', function () { if (open) collapse() }, { passive: true })
  window.addEventListener('resize', measure, { passive: true })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }

  function boot() {
    build()
    window.__bridgeFab = { add: add, measure: measure, collapse: collapse }

    // The file-reference button is panel-native rather than owned by one of the
    // feature modules, so it is registered here.
    add({
      id: 'file',
      icon: '\uD83D\uDCC4',
      label: '引用文件',
      title: '把一个电脑上的文件路径插进输入框',
      order: 30,
      onClick: function () {
        if (typeof window.__bridgePickFile !== 'function') return
        window.__bridgePickFile(function (path) {
          if (typeof window.__bridgeInsertText === 'function') window.__bridgeInsertText(path)
        })
      }
    })

    // The two scroll affordances, folded in with everything else. Each stays
    // hidden at the end it already sits at, so neither is dead weight.
    var toTop = add({
      id: 'totop', icon: '\u2191', label: '回顶端', title: '回到顶端', order: 900,
      visible: false,
      onClick: function () { if (window.__bridgeScroll) window.__bridgeScroll.toTop() }
    })
    var toBottom = add({
      id: 'tobottom', icon: '\u2193', label: '到底端', title: '跳到最新', order: 901,
      visible: false,
      onClick: function () { if (window.__bridgeScroll) window.__bridgeScroll.toBottom() }
    })
    function syncScroll() {
      var scroll = window.__bridgeScroll
      if (!scroll || typeof scroll.state !== 'function') return
      var state = scroll.state()
      toTop.setVisible(!state.atTop)
      toBottom.setVisible(!state.atBottom)
    }
    window.addEventListener('scroll', syncScroll, { passive: true })
    window.addEventListener('resize', syncScroll, { passive: true })
    setInterval(syncScroll, 800)
    syncScroll()
    // The composer is rebuilt on every conversation switch, so watch it rather
    // than measuring once. ResizeObserver is not guaranteed here, hence the
    // interval fallback.
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(measure)
      var target = null
      // A later conversation swaps the composer element, so re-observe whenever
      // the current one changes rather than measuring once at boot.
      setInterval(function () {
        var current = document.querySelector('.composer')
        if (current === null || current === target) return
        if (target !== null) observer.unobserve(target)
        target = current
        observer.observe(current)
        measure()
      }, 500)
    } else {
      setInterval(measure, 500)
    }
  }
})()
