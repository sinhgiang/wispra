/*
 * Mind map renderer for the design prototype (ticket T-0004).
 *
 * Dependency-free on purpose: plain SVG + a small tidy-tree layout. This is the same
 * approach proposed for the real build (as a React component), so what you see here is
 * what the library-free renderer can do: two-sided layout, curved connectors,
 * animated expand/collapse, zoom/pan/fit, and PNG export straight from the SVG.
 *
 * Input tree node: { label, sub?, hue? (depth 1), children: [], ...anything else }.
 * Root children with side === -1 are laid out to the left, the rest to the right.
 */
;(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const FONT = "-apple-system, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
  const ACCENT = '#6366f1'

  // Per-depth node style. Strength falls from the centre outward.
  const STYLE = [
    { size: 15, weight: 700, padX: 20, padY: 13, radius: 18, maxW: 210, lh: 20 },
    { size: 13.5, weight: 600, padX: 14, padY: 9, radius: 13, maxW: 190, lh: 18 },
    { size: 12.5, weight: 500, padX: 12, padY: 7, radius: 10, maxW: 210, lh: 16.5 },
    { size: 12, weight: 400, padX: 10, padY: 5, radius: 8, maxW: 220, lh: 16 }
  ]
  const SUB = { size: 10.5, lh: 14 }
  const VGAP = [18, 9, 6, 5]
  const HGAP = [72, 54, 46, 42]
  const TOGGLE_R = 8.5
  const TOGGLE_OFFSET = 14
  const EDGE_W = [0, 2.4, 1.8, 1.4]
  const MIN_K = 0.15
  const MAX_K = 2.5

  const styleOf = (depth) => STYLE[Math.min(depth, STYLE.length - 1)]

  function branchPalette(hue, dark) {
    return dark
      ? {
          mainFill: `oklch(0.34 0.07 ${hue})`,
          mainStroke: `oklch(0.52 0.11 ${hue})`,
          mainText: `oklch(0.95 0.03 ${hue})`,
          sub: `oklch(0.8 0.06 ${hue})`,
          subFill: `oklch(0.26 0.035 ${hue})`,
          subStroke: `oklch(0.4 0.065 ${hue})`,
          leafFill: `oklch(0.215 0.02 ${hue})`,
          edge: `oklch(0.58 0.1 ${hue})`
        }
      : {
          mainFill: `oklch(0.915 0.055 ${hue})`,
          mainStroke: `oklch(0.77 0.1 ${hue})`,
          mainText: `oklch(0.31 0.09 ${hue})`,
          sub: `oklch(0.47 0.08 ${hue})`,
          subFill: `oklch(0.972 0.02 ${hue})`,
          subStroke: `oklch(0.88 0.05 ${hue})`,
          leafFill: `oklch(0.983 0.009 ${hue})`,
          edge: `oklch(0.78 0.09 ${hue})`
        }
  }

  function themeColors(dark) {
    return dark
      ? { canvas: '#0f1117', text: '#eef0f5', text2: '#c3c9d6', dot: 'rgba(255,255,255,0.07)' }
      : { canvas: '#ffffff', text: '#111827', text2: '#374151', dot: 'rgba(0,0,0,0.075)' }
  }

  const measureCtx = document.createElement('canvas').getContext('2d')
  function textWidth(text, size, weight) {
    measureCtx.font = `${weight} ${size}px ${FONT}`
    return measureCtx.measureText(text).width
  }

  function wrap(text, size, weight, maxW) {
    const words = text.split(/\s+/)
    const lines = []
    let line = ''
    for (const word of words) {
      const next = line ? line + ' ' + word : word
      if (line && textWidth(next, size, weight) > maxW) {
        lines.push(line)
        line = word
      } else {
        line = next
      }
    }
    if (line) lines.push(line)
    return lines
  }

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name)
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(node)
    return node
  }

  const lerp = (a, b, t) => a + (b - a) * t
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

  function createMindMap(container, options) {
    const { tree, onSelect, onViewChange, onManualToggle } = options
    let dark = !!options.dark
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // ── Tree preparation ────────────────────────────────────────────────
    const nodes = []
    const byId = new Map()
    ;(function prepare(node, depth, parent, branch, side) {
      node.id = 'n' + nodes.length
      node.depth = depth
      node.parent = parent
      node.branch = depth === 1 ? node : branch
      node.side = depth === 0 ? 0 : depth === 1 ? (node.side === -1 ? -1 : 1) : side
      nodes.push(node)
      byId.set(node.id, node)
      const st = styleOf(depth)
      node.lines = wrap(node.label, st.size, st.weight, st.maxW)
      const labelW = Math.max(...node.lines.map((l) => textWidth(l, st.size, st.weight)))
      const subW = node.sub ? textWidth(node.sub, SUB.size, 500) : 0
      node.w = Math.ceil(Math.max(labelW, subW) + st.padX * 2)
      node.h = Math.ceil(node.lines.length * st.lh + (node.sub ? SUB.lh : 0) + st.padY * 2)
      node.cur = null
      node.dom = null
      for (const child of node.children) prepare(child, depth + 1, node, node.branch, node.side)
    })(tree, 0, null, null, 0)
    const root = tree

    // ── State ───────────────────────────────────────────────────────────
    const expanded = new Set()
    let selectedId = null
    const view = { x: 0, y: 0, k: 1 }
    let viewFrom = null
    let viewTo = null
    let anim = null
    let raf = 0
    let insetRight = 0
    const live = new Set() // nodes currently in the DOM (visible or animating out)

    // ── DOM ─────────────────────────────────────────────────────────────
    const svg = el('svg', { class: 'mm-svg', role: 'tree', 'aria-label': 'Mind map' }, null)
    svg.style.width = '100%'
    svg.style.height = '100%'
    svg.style.display = 'block'
    const viewport = el('g', {}, svg)
    const edgeLayer = el('g', { fill: 'none', 'stroke-linecap': 'round' }, viewport)
    const nodeLayer = el('g', {}, viewport)
    container.appendChild(svg)

    const visibleChildren = (n) => (n.depth === 0 || expanded.has(n.id) ? n.children : [])

    // ── Layout (targets: n.tx, n.ty) ────────────────────────────────────
    function span(n) {
      const ch = visibleChildren(n)
      if (!ch.length) return n.h
      const gap = VGAP[Math.min(n.depth, VGAP.length - 1)]
      const total = ch.reduce((sum, c) => sum + span(c), 0) + gap * (ch.length - 1)
      return Math.max(n.h, total)
    }

    function placeChildren(children, depth, edgeX, cy, side) {
      const gap = VGAP[Math.min(depth, VGAP.length - 1)]
      const spans = children.map(span)
      const total = spans.reduce((a, b) => a + b, 0) + gap * (children.length - 1)
      let y = cy - total / 2
      children.forEach((c, i) => {
        place(c, edgeX, y + spans[i] / 2, side)
        y += spans[i] + gap
      })
    }

    function place(n, edgeX, cy, side) {
      n.tx = side > 0 ? edgeX : edgeX - n.w
      n.ty = cy - n.h / 2
      n.visible = true
      const ch = visibleChildren(n)
      if (!ch.length) return
      const hgap = HGAP[Math.min(n.depth, HGAP.length - 1)]
      placeChildren(ch, n.depth, side > 0 ? n.tx + n.w + hgap : n.tx - hgap, cy, side)
    }

    function layout() {
      for (const n of nodes) n.visible = false
      root.tx = -root.w / 2
      root.ty = -root.h / 2
      root.visible = true
      const right = root.children.filter((c) => c.side > 0)
      const left = root.children.filter((c) => c.side < 0)
      if (right.length) placeChildren(right, 0, root.w / 2 + HGAP[0], 0, 1)
      if (left.length) placeChildren(left, 0, -root.w / 2 - HGAP[0], 0, -1)
    }

    function bounds(list) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of list) {
        const pad = n.children.length && n.depth > 0 ? TOGGLE_OFFSET + TOGGLE_R + 2 : 0
        minX = Math.min(minX, n.tx - (n.side < 0 ? pad : 0))
        maxX = Math.max(maxX, n.tx + n.w + (n.side > 0 ? pad : 0))
        minY = Math.min(minY, n.ty)
        maxY = Math.max(maxY, n.ty + n.h)
      }
      return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
    }

    // ── Node / edge DOM ─────────────────────────────────────────────────
    function buildNode(n) {
      const st = styleOf(n.depth)
      const g = el('g', { class: 'mm-node', 'data-id': n.id, role: 'treeitem', tabindex: '0', 'aria-label': n.label }, nodeLayer)
      const ring = el('rect', { class: 'mm-ring', x: -4, y: -4, width: n.w + 8, height: n.h + 8, rx: st.radius + 4, fill: 'none', 'stroke-width': 2 }, g)
      const box = el('rect', { class: 'mm-box', width: n.w, height: n.h, rx: st.radius }, g)
      const texts = n.lines.map((line, i) => {
        const t = el(
          'text',
          {
            x: n.depth === 0 ? n.w / 2 : st.padX,
            y: st.padY + i * st.lh + st.lh / 2 + st.size * 0.35,
            'font-size': st.size,
            'font-weight': st.weight,
            'font-family': FONT,
            'text-anchor': n.depth === 0 ? 'middle' : 'start'
          },
          g
        )
        t.textContent = line
        return t
      })
      let sub = null
      if (n.sub) {
        sub = el(
          'text',
          {
            x: n.depth === 0 ? n.w / 2 : st.padX,
            y: st.padY + n.lines.length * st.lh + SUB.lh / 2 + SUB.size * 0.35 + 1,
            'font-size': SUB.size,
            'font-weight': 500,
            'font-family': FONT,
            'text-anchor': n.depth === 0 ? 'middle' : 'start'
          },
          g
        )
        sub.textContent = n.sub
      }
      let toggle = null
      if (n.children.length && n.depth > 0) {
        const cx = n.side > 0 ? n.w + TOGGLE_OFFSET : -TOGGLE_OFFSET
        const cy = n.h / 2
        const tg = el('g', { class: 'mm-toggle', 'data-toggle': n.id }, g)
        const stub = el('line', { x1: n.side > 0 ? n.w : 0, y1: cy, x2: cx, y2: cy, 'stroke-linecap': 'round' }, tg)
        const circle = el('circle', { cx, cy, r: TOGGLE_R, 'stroke-width': 1.4 }, tg)
        const count = el('text', { x: cx, y: cy + 3.5, 'font-size': 10, 'font-weight': 600, 'font-family': FONT, 'text-anchor': 'middle' }, tg)
        count.textContent = String(n.children.length)
        const minus = el('line', { x1: cx - 3.5, y1: cy, x2: cx + 3.5, y2: cy, 'stroke-width': 1.6, 'stroke-linecap': 'round' }, tg)
        toggle = { stub, circle, count, minus }
      }
      const edge = n.parent ? el('path', { 'data-edge': n.id, 'stroke-width': EDGE_W[Math.min(n.depth, EDGE_W.length - 1)] }, edgeLayer) : null
      n.dom = { g, ring, box, texts, sub, toggle, edge }
      paintNode(n)
    }

    function paintNode(n) {
      const d = n.dom
      if (!d) return
      const theme = themeColors(dark)
      d.ring.style.stroke = ACCENT
      d.ring.style.display = n.id === selectedId ? '' : 'none'
      if (n.depth === 0) {
        d.box.style.fill = ACCENT
        d.box.style.stroke = 'none'
        d.texts.forEach((t) => (t.style.fill = '#ffffff'))
        if (d.sub) d.sub.style.fill = 'rgba(255,255,255,0.8)'
        return
      }
      const p = branchPalette(n.branch.hue, dark)
      if (n.depth === 1) {
        d.box.style.fill = p.mainFill
        d.box.style.stroke = p.mainStroke
        d.box.style.strokeWidth = '1.25'
        d.texts.forEach((t) => (t.style.fill = p.mainText))
        if (d.sub) d.sub.style.fill = p.sub
      } else if (n.depth === 2) {
        d.box.style.fill = p.subFill
        d.box.style.stroke = p.subStroke
        d.box.style.strokeWidth = '1'
        d.texts.forEach((t) => (t.style.fill = theme.text))
        if (d.sub) d.sub.style.fill = p.sub
      } else {
        d.box.style.fill = p.leafFill
        d.box.style.stroke = 'none'
        d.texts.forEach((t) => (t.style.fill = theme.text2))
      }
      if (d.edge) d.edge.style.stroke = p.edge
      if (d.toggle) {
        const open = expanded.has(n.id)
        d.toggle.stub.style.stroke = p.edge
        d.toggle.stub.style.strokeWidth = String(EDGE_W[Math.min(n.depth + 1, EDGE_W.length - 1)])
        d.toggle.circle.style.fill = open ? theme.canvas : p.mainFill
        d.toggle.circle.style.stroke = p.edge
        d.toggle.count.style.fill = p.mainText
        d.toggle.count.style.display = open ? 'none' : ''
        d.toggle.minus.style.stroke = p.edge
        d.toggle.minus.style.display = open ? '' : 'none'
        d.g.setAttribute('aria-expanded', String(open))
      }
    }

    function removeNode(n) {
      if (!n.dom) return
      n.dom.g.remove()
      if (n.dom.edge) n.dom.edge.remove()
      n.dom = null
      n.cur = null
      live.delete(n)
    }

    function edgePath(n) {
      const p = n.parent
      const pc = p.cur
      const c = n.cur
      const side = n.side
      const sy = pc.y + p.h / 2
      const ey = c.y + n.h / 2
      const sx = p.depth === 0 ? pc.x + (side > 0 ? p.w : 0) : side > 0 ? pc.x + p.w + TOGGLE_OFFSET : pc.x - TOGGLE_OFFSET
      const ex = side > 0 ? c.x : c.x + n.w
      const dx = (ex - sx) * 0.5
      return `M${sx.toFixed(1)} ${sy.toFixed(1)}C${(sx + dx).toFixed(1)} ${sy.toFixed(1)} ${(ex - dx).toFixed(1)} ${ey.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
    }

    // ── Drawing / animation ─────────────────────────────────────────────
    function drawView() {
      viewport.setAttribute('transform', `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`)
      const grid = 26 * view.k
      container.style.backgroundSize = `${grid}px ${grid}px`
      container.style.backgroundPosition = `${view.x}px ${view.y}px`
      if (onViewChange) onViewChange(view.k)
    }

    function drawNodes() {
      for (const n of live) {
        n.dom.g.setAttribute('transform', `translate(${n.cur.x.toFixed(1)} ${n.cur.y.toFixed(1)})`)
        n.dom.g.style.opacity = n.cur.o.toFixed(3)
        if (n.dom.edge) {
          n.dom.edge.setAttribute('d', edgePath(n))
          n.dom.edge.style.opacity = n.cur.o.toFixed(3)
        }
      }
    }

    function tick(now) {
      const t = anim.dur <= 0 ? 1 : Math.min(1, (now - anim.t0) / anim.dur)
      const e = 1 - Math.pow(1 - t, 3)
      for (const n of live) {
        n.cur.x = lerp(n.animFrom.x, n.animTo.x, e)
        n.cur.y = lerp(n.animFrom.y, n.animTo.y, e)
        n.cur.o = lerp(n.animFrom.o, n.animTo.o, e)
      }
      if (viewTo) {
        view.x = lerp(viewFrom.x, viewTo.x, e)
        view.y = lerp(viewFrom.y, viewTo.y, e)
        view.k = lerp(viewFrom.k, viewTo.k, e)
        drawView()
      }
      drawNodes()
      if (t < 1) {
        raf = requestAnimationFrame(tick)
        return
      }
      raf = 0
      anim = null
      viewTo = null
      for (const n of [...live]) if (!n.visible) removeNode(n)
    }

    function startAnim(dur) {
      anim = { t0: performance.now(), dur: reducedMotion ? 0 : dur }
      if (!raf) raf = requestAnimationFrame(tick)
    }

    /** Nearest ancestor that stays visible — where a collapsing node flies back to. */
    function visibleAncestor(n) {
      let p = n.parent
      while (p && !p.visible) p = p.parent
      return p || root
    }

    /** Recompute the layout and animate every node (and optionally the view) to its new place. */
    function update(opts) {
      const { dur = 320, nextView = null, origin = null } = opts || {}
      layout()
      for (const n of nodes) {
        if (n.visible) {
          if (!n.dom) {
            buildNode(n)
            live.add(n)
            // Enter from the parent's current position (or a given origin for the intro).
            const src = origin || (n.parent && n.parent.cur ? n.parent : null)
            n.cur = src
              ? { x: src.cur.x + src.w / 2 - n.w / 2, y: src.cur.y + src.h / 2 - n.h / 2, o: 0 }
              : { x: n.tx, y: n.ty, o: 0 }
          }
          n.animFrom = { ...n.cur }
          n.animTo = { x: n.tx, y: n.ty, o: 1 }
        } else if (n.dom) {
          const a = visibleAncestor(n)
          n.animFrom = { ...n.cur }
          n.animTo = { x: a.tx + a.w / 2 - n.w / 2, y: a.ty + a.h / 2 - n.h / 2, o: 0 }
        }
      }
      // Entering nodes are stacked under existing ones while they fly out.
      for (const n of live) paintNode(n)
      if (nextView) {
        viewFrom = { ...view }
        viewTo = nextView
      } else {
        viewTo = null
      }
      startAnim(dur)
    }

    // ── View helpers ────────────────────────────────────────────────────
    function insets() {
      return { top: 60, right: 20 + insetRight, bottom: 60, left: 20 }
    }

    function fitView() {
      const b = bounds(nodes.filter((n) => n.visible))
      const W = container.clientWidth
      const H = container.clientHeight
      const ins = insets()
      const availW = Math.max(80, W - ins.left - ins.right)
      const availH = Math.max(80, H - ins.top - ins.bottom)
      const k = clamp(Math.min(availW / b.w, availH / b.h), MIN_K, 1.15)
      return {
        k,
        x: ins.left + availW / 2 - (b.minX + b.w / 2) * k,
        y: ins.top + availH / 2 - (b.minY + b.h / 2) * k
      }
    }

    function animateView(next, dur) {
      for (const n of live) {
        n.animFrom = { ...n.cur }
        if (!n.animTo) n.animTo = { ...n.cur }
      }
      viewFrom = { ...view }
      viewTo = next
      startAnim(dur == null ? 280 : dur)
    }

    function zoomAt(k, px, py, animate) {
      k = clamp(k, MIN_K, MAX_K)
      const next = { k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k }
      if (animate) {
        animateView(next, 180)
      } else {
        viewTo = null
        Object.assign(view, next)
        drawView()
      }
    }

    /** Shift a view just enough that the given node's subtree is on screen (when it fits). */
    function revealing(n, v) {
      const list = []
      ;(function collect(x) {
        list.push(x)
        visibleChildren(x).forEach(collect)
      })(n)
      const b = bounds(list)
      const W = container.clientWidth
      const H = container.clientHeight
      const ins = insets()
      const out = { ...v }
      const fix = (lo, hi, min, max, own0, own1) => {
        // lo/hi: subtree extent on screen; own0/own1: the clicked node itself (always kept visible).
        let d = 0
        if (hi - lo <= max - min) {
          if (lo < min) d = min - lo
          else if (hi > max) d = max - hi
        } else if (own0 < min) d = min - own0
        else if (own1 > max) d = max - own1
        return d
      }
      out.x += fix(b.minX * v.k + v.x, b.maxX * v.k + v.x, ins.left, W - ins.right, n.tx * v.k + v.x, (n.tx + n.w) * v.k + v.x)
      out.y += fix(b.minY * v.k + v.y, b.maxY * v.k + v.y, ins.top - 30, H - ins.bottom + 30, n.ty * v.k + v.y, (n.ty + n.h) * v.k + v.y)
      return out
    }

    // ── Actions ─────────────────────────────────────────────────────────
    function toggle(id) {
      const n = byId.get(id)
      if (!n || !n.children.length || n.depth === 0) return
      const before = { x: n.tx, y: n.ty }
      if (expanded.has(id)) expanded.delete(id)
      else expanded.add(id)
      layout()
      // Keep the clicked node where it is on screen, then nudge so its children are visible.
      const base = viewTo || view
      let next = { k: base.k, x: base.x + (before.x - n.tx) * base.k, y: base.y + (before.y - n.ty) * base.k }
      if (expanded.has(id)) next = revealing(n, next)
      update({ nextView: next })
      if (onManualToggle) onManualToggle()
    }

    function select(id) {
      selectedId = id
      for (const n of live) n.dom.ring.style.display = n.id === selectedId ? '' : 'none'
      if (onSelect) onSelect(id ? byId.get(id) : null)
    }

    /** Show `level` levels counting the centre as level 1 (2 = centre + main branches). */
    function setLevel(level) {
      expanded.clear()
      for (const n of nodes) if (n.depth >= 1 && n.depth < level - 1 && n.children.length) expanded.add(n.id)
      layout()
      update({ nextView: fitView(), dur: 380 })
    }

    // ── Input ───────────────────────────────────────────────────────────
    let down = null
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      down = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, target: e.target, moved: false }
      svg.setPointerCapture(e.pointerId)
    })
    svg.addEventListener('pointermove', (e) => {
      if (!down) return
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (!down.moved && Math.hypot(dx, dy) < 4) return
      down.moved = true
      container.classList.add('mm-grabbing')
      viewTo = null
      view.x = down.vx + dx
      view.y = down.vy + dy
      drawView()
    })
    const endPointer = (e) => {
      if (!down) return
      const d = down
      down = null
      container.classList.remove('mm-grabbing')
      if (d.moved || e.type === 'pointercancel') return
      const tg = d.target.closest && d.target.closest('[data-toggle]')
      if (tg) return toggle(tg.getAttribute('data-toggle'))
      const nd = d.target.closest && d.target.closest('[data-id]')
      select(nd ? nd.getAttribute('data-id') : null)
    }
    svg.addEventListener('pointerup', endPointer)
    svg.addEventListener('pointercancel', endPointer)
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = container.getBoundingClientRect()
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))
        zoomAt(view.k * factor, e.clientX - rect.left, e.clientY - rect.top, false)
      },
      { passive: false }
    )
    svg.addEventListener('keydown', (e) => {
      const nd = e.target.closest && e.target.closest('[data-id]')
      if (!nd) return
      const id = nd.getAttribute('data-id')
      if (e.key === 'Enter') {
        e.preventDefault()
        select(id)
      } else if (e.key === ' ') {
        e.preventDefault()
        toggle(id)
      }
    })

    // ── Export ──────────────────────────────────────────────────────────
    /** Standalone SVG of the map as currently expanded (all colours are inline, so it rasterises as-is). */
    function exportSvg(pad) {
      pad = pad == null ? 40 : pad
      const b = bounds(nodes.filter((n) => n.visible))
      const w = Math.ceil(b.w + pad * 2)
      const h = Math.ceil(b.h + pad * 2)
      const clone = viewport.cloneNode(true)
      clone.removeAttribute('transform')
      clone.querySelectorAll('.mm-ring').forEach((r) => r.remove())
      clone.querySelectorAll('[tabindex]').forEach((g) => g.removeAttribute('tabindex'))
      const out = document.createElementNS(SVG_NS, 'svg')
      out.setAttribute('xmlns', SVG_NS)
      out.setAttribute('width', w)
      out.setAttribute('height', h)
      out.setAttribute('viewBox', `${b.minX - pad} ${b.minY - pad} ${w} ${h}`)
      const bg = el('rect', { x: b.minX - pad, y: b.minY - pad, width: w, height: h }, out)
      bg.style.fill = themeColors(dark).canvas
      out.appendChild(clone)
      return { svg: new XMLSerializer().serializeToString(out), width: w, height: h }
    }

    // ── Init ────────────────────────────────────────────────────────────
    function paintCanvas() {
      const theme = themeColors(dark)
      container.style.backgroundColor = theme.canvas
      container.style.backgroundImage = `radial-gradient(${theme.dot} 1px, transparent 1.2px)`
    }

    /** First paint: everything flies out from the centre, already fitted to the canvas. */
    function intro(level) {
      for (const n of [...live]) removeNode(n)
      expanded.clear()
      selectedId = null
      for (const n of nodes) if (n.depth >= 1 && n.depth < level - 1 && n.children.length) expanded.add(n.id)
      layout()
      Object.assign(view, fitView())
      drawView()
      buildNode(root)
      live.add(root)
      root.cur = { x: root.tx, y: root.ty, o: 1 }
      update({ dur: 620, origin: root })
    }

    paintCanvas()

    return {
      intro,
      setLevel,
      toggle,
      select,
      exportSvg,
      nodes,
      root,
      isExpanded: (id) => expanded.has(id),
      fit: () => animateView(fitView(), 320),
      zoomBy: (factor) => zoomAt(view.k * factor, container.clientWidth / 2, container.clientHeight / 2, true),
      resetZoom: () => zoomAt(1, container.clientWidth / 2, container.clientHeight / 2, true),
      setInsetRight: (px) => {
        insetRight = px
      },
      /** Pan (without zooming) so a node is clear of the detail card. */
      ensureVisible: (id) => {
        const n = byId.get(id)
        if (!n || !n.visible) return
        const base = viewTo || view
        const next = revealing({ ...n, children: [] }, { ...base })
        if (next.x !== base.x || next.y !== base.y) animateView(next, 260)
      },
      setDark: (value) => {
        dark = value
        paintCanvas()
        for (const n of live) paintNode(n)
      }
    }
  }

  window.createMindMap = createMindMap
})()
