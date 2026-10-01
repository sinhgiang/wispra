import type { MindMapTreeNode } from './mindMapData'

/*
 * Mind map renderer for the Meeting tab. Dependency-free on purpose (see "No new
 * runtime npm dependencies" in CLAUDE.md): plain SVG + a small tidy-tree layout, drawn
 * imperatively because every frame of an expand/collapse or zoom animation moves most
 * of the nodes. MindMapView.tsx owns the surrounding React UI and talks to this module
 * through the returned controller.
 *
 * Root children with side === -1 are laid out to the left, the rest to the right.
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const FONT = "-apple-system, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif"
const ACCENT = '#6366f1'

interface NodeStyle {
  size: number
  weight: number
  padX: number
  padY: number
  radius: number
  maxW: number
  lh: number
}

// Per-depth node style. Strength falls from the centre outward.
const STYLE: NodeStyle[] = [
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

interface Pos {
  x: number
  y: number
  o: number
}

interface View {
  x: number
  y: number
  k: number
}

interface NodeDom {
  g: SVGGElement
  ring: SVGElement
  box: SVGElement
  texts: SVGElement[]
  sub: SVGElement | null
  toggle: { stub: SVGElement; circle: SVGElement; count: SVGElement; minus: SVGElement } | null
  edge: SVGElement | null
}

export interface MindMapLayoutNode {
  id: string
  data: MindMapTreeNode
  depth: number
  parent: MindMapLayoutNode | null
  /** The main branch this node belongs to (itself at depth 1; null for the centre). */
  branch: MindMapLayoutNode | null
  side: number
  children: MindMapLayoutNode[]
  lines: string[]
  w: number
  h: number
  /** Layout target. */
  tx: number
  ty: number
  visible: boolean
  /** Where the node is drawn right now (null while it is not in the DOM). */
  cur: Pos | null
  animFrom: Pos | null
  animTo: Pos | null
  dom: NodeDom | null
}

export interface MindMapOptions {
  tree: MindMapTreeNode
  dark: boolean
  onSelect?: (node: MindMapLayoutNode | null) => void
  onViewChange?: (zoom: number) => void
  /** A branch was opened or closed by hand (as opposed to a "Levels" preset). */
  onManualToggle?: () => void
}

export interface MindMapController {
  /** First paint: everything flies out from the centre, already fitted to the canvas. */
  intro(level: number): void
  /** Show `level` levels counting the centre as level 1 (2 = centre + main branches). */
  setLevel(level: number): void
  toggle(id: string): void
  select(id: string | null): void
  isExpanded(id: string): boolean
  fit(): void
  zoomBy(factor: number): void
  resetZoom(): void
  /** Width covered by the detail card, kept clear when fitting and revealing. */
  setInsetRight(px: number): void
  /** Pan (without zooming) so a node is clear of the detail card. */
  ensureVisible(id: string): void
  setDark(dark: boolean): void
  /** Standalone SVG of the map as currently expanded (all colours are inline, so it rasterises as-is). */
  exportSvg(pad?: number): { svg: string; width: number; height: number }
  destroy(): void
}

const styleOf = (depth: number): NodeStyle => STYLE[Math.min(depth, STYLE.length - 1)]

function branchPalette(hue: number, dark: boolean): Record<string, string> {
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

function themeColors(dark: boolean): { canvas: string; text: string; text2: string; dot: string } {
  return dark
    ? { canvas: '#0f1117', text: '#eef0f5', text2: '#c3c9d6', dot: 'rgba(255,255,255,0.07)' }
    : { canvas: '#ffffff', text: '#111827', text2: '#374151', dot: 'rgba(0,0,0,0.075)' }
}

/** Colour used for a node outside the SVG (detail card, "From mind map" bar). */
export function mindMapNodeColor(node: MindMapLayoutNode, dark: boolean): string {
  return node.branch ? `oklch(${dark ? 0.72 : 0.62} 0.14 ${node.branch.data.hue ?? 262})` : ACCENT
}

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, size: number, weight: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * size * 0.55
  measureCtx.font = `${weight} ${size}px ${FONT}`
  return measureCtx.measureText(text).width
}

function wrap(text: string, size: number, weight: number, maxW: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? line + ' ' + word : word
    if (textWidth(next, size, weight) <= maxW) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = word
    // A word wider than the node on its own (a URL, or a language written without
    // spaces) is broken by characters.
    while (textWidth(line, size, weight) > maxW && line.length > 1) {
      let cut = line.length - 1
      while (cut > 1 && textWidth(line.slice(0, cut), size, weight) > maxW) cut--
      lines.push(line.slice(0, cut))
      line = line.slice(cut)
    }
  }
  if (line) lines.push(line)
  return lines.length > 0 ? lines : ['']
}

function el(name: string, attrs: Record<string, string | number> | null, parent: Element | null): SVGElement {
  const node = document.createElementNS(SVG_NS, name)
  if (attrs) for (const k in attrs) node.setAttribute(k, String(attrs[k]))
  if (parent) parent.appendChild(node)
  return node
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function createMindMap(container: HTMLElement, options: MindMapOptions): MindMapController {
  const { onSelect, onViewChange, onManualToggle } = options
  let dark = options.dark
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ── Tree preparation ────────────────────────────────────────────────
  const nodes: MindMapLayoutNode[] = []
  const byId = new Map<string, MindMapLayoutNode>()
  const prepare = (
    data: MindMapTreeNode,
    depth: number,
    parent: MindMapLayoutNode | null,
    branch: MindMapLayoutNode | null,
    side: number
  ): MindMapLayoutNode => {
    const st = styleOf(depth)
    const lines = wrap(data.label, st.size, st.weight, st.maxW)
    const labelW = Math.max(...lines.map((l) => textWidth(l, st.size, st.weight)))
    const subW = data.sub ? textWidth(data.sub, SUB.size, 500) : 0
    const node: MindMapLayoutNode = {
      id: 'n' + nodes.length,
      data,
      depth,
      parent,
      branch,
      side: depth === 0 ? 0 : depth === 1 ? (data.side === -1 ? -1 : 1) : side,
      children: [],
      lines,
      w: Math.ceil(Math.max(labelW, subW) + st.padX * 2),
      h: Math.ceil(lines.length * st.lh + (data.sub ? SUB.lh : 0) + st.padY * 2),
      tx: 0,
      ty: 0,
      visible: false,
      cur: null,
      animFrom: null,
      animTo: null,
      dom: null
    }
    if (depth === 1) node.branch = node
    nodes.push(node)
    byId.set(node.id, node)
    node.children = data.children.map((child) => prepare(child, depth + 1, node, node.branch, node.side))
    return node
  }
  const root = prepare(options.tree, 0, null, null, 0)

  // ── State ───────────────────────────────────────────────────────────
  const expanded = new Set<string>()
  let selectedId: string | null = null
  const view: View = { x: 0, y: 0, k: 1 }
  let viewFrom: View | null = null
  let viewTo: View | null = null
  let anim: { t0: number; dur: number } | null = null
  let raf = 0
  let insetRight = 0
  const live = new Set<MindMapLayoutNode>() // nodes currently in the DOM (visible or animating out)

  // ── DOM ─────────────────────────────────────────────────────────────
  const svg = el('svg', { class: 'mm-svg', role: 'tree', 'aria-label': 'Mind map' }, null) as SVGSVGElement
  svg.style.width = '100%'
  svg.style.height = '100%'
  svg.style.display = 'block'
  const viewport = el('g', null, svg)
  const edgeLayer = el('g', { fill: 'none', 'stroke-linecap': 'round' }, viewport)
  const nodeLayer = el('g', null, viewport)
  container.appendChild(svg)

  const visibleChildren = (n: MindMapLayoutNode): MindMapLayoutNode[] =>
    n.depth === 0 || expanded.has(n.id) ? n.children : []
  const hueOf = (n: MindMapLayoutNode): number => n.branch?.data.hue ?? 262

  // ── Layout (targets: n.tx, n.ty) ────────────────────────────────────
  function span(n: MindMapLayoutNode): number {
    const ch = visibleChildren(n)
    if (!ch.length) return n.h
    const gap = VGAP[Math.min(n.depth, VGAP.length - 1)]
    const total = ch.reduce((sum, c) => sum + span(c), 0) + gap * (ch.length - 1)
    return Math.max(n.h, total)
  }

  function placeChildren(children: MindMapLayoutNode[], depth: number, edgeX: number, cy: number, side: number): void {
    const gap = VGAP[Math.min(depth, VGAP.length - 1)]
    const spans = children.map(span)
    const total = spans.reduce((a, b) => a + b, 0) + gap * (children.length - 1)
    let y = cy - total / 2
    children.forEach((c, i) => {
      place(c, edgeX, y + spans[i] / 2, side)
      y += spans[i] + gap
    })
  }

  function place(n: MindMapLayoutNode, edgeX: number, cy: number, side: number): void {
    n.tx = side > 0 ? edgeX : edgeX - n.w
    n.ty = cy - n.h / 2
    n.visible = true
    const ch = visibleChildren(n)
    if (!ch.length) return
    const hgap = HGAP[Math.min(n.depth, HGAP.length - 1)]
    placeChildren(ch, n.depth, side > 0 ? n.tx + n.w + hgap : n.tx - hgap, cy, side)
  }

  function layout(): void {
    for (const n of nodes) n.visible = false
    root.tx = -root.w / 2
    root.ty = -root.h / 2
    root.visible = true
    const right = root.children.filter((c) => c.side > 0)
    const left = root.children.filter((c) => c.side < 0)
    if (right.length) placeChildren(right, 0, root.w / 2 + HGAP[0], 0, 1)
    if (left.length) placeChildren(left, 0, -root.w / 2 - HGAP[0], 0, -1)
  }

  function bounds(list: MindMapLayoutNode[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
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
  function buildNode(n: MindMapLayoutNode): void {
    const st = styleOf(n.depth)
    const g = el(
      'g',
      { class: 'mm-node', 'data-id': n.id, role: 'treeitem', tabindex: '0', 'aria-label': n.data.label },
      nodeLayer
    ) as SVGGElement
    const ring = el(
      'rect',
      { class: 'mm-ring', x: -4, y: -4, width: n.w + 8, height: n.h + 8, rx: st.radius + 4, fill: 'none', 'stroke-width': 2 },
      g
    )
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
    let sub: SVGElement | null = null
    if (n.data.sub) {
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
      sub.textContent = n.data.sub
    }
    let toggleDom: NodeDom['toggle'] = null
    if (n.children.length && n.depth > 0) {
      const cx = n.side > 0 ? n.w + TOGGLE_OFFSET : -TOGGLE_OFFSET
      const cy = n.h / 2
      const tg = el('g', { class: 'mm-toggle', 'data-toggle': n.id }, g)
      const stub = el('line', { x1: n.side > 0 ? n.w : 0, y1: cy, x2: cx, y2: cy, 'stroke-linecap': 'round' }, tg)
      const circle = el('circle', { cx, cy, r: TOGGLE_R, 'stroke-width': 1.4 }, tg)
      const count = el(
        'text',
        { x: cx, y: cy + 3.5, 'font-size': 10, 'font-weight': 600, 'font-family': FONT, 'text-anchor': 'middle' },
        tg
      )
      count.textContent = String(n.children.length)
      const minus = el('line', { x1: cx - 3.5, y1: cy, x2: cx + 3.5, y2: cy, 'stroke-width': 1.6, 'stroke-linecap': 'round' }, tg)
      toggleDom = { stub, circle, count, minus }
    }
    const edge = n.parent
      ? el('path', { 'data-edge': n.id, 'stroke-width': EDGE_W[Math.min(n.depth, EDGE_W.length - 1)] }, edgeLayer)
      : null
    n.dom = { g, ring, box, texts, sub, toggle: toggleDom, edge }
    paintNode(n)
  }

  function paintNode(n: MindMapLayoutNode): void {
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
    const p = branchPalette(hueOf(n), dark)
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
      if (d.sub) d.sub.style.fill = p.sub
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

  function removeNode(n: MindMapLayoutNode): void {
    if (!n.dom) return
    n.dom.g.remove()
    if (n.dom.edge) n.dom.edge.remove()
    n.dom = null
    n.cur = null
    live.delete(n)
  }

  function edgePath(n: MindMapLayoutNode): string {
    const p = n.parent
    if (!p || !p.cur || !n.cur) return ''
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
  function drawView(): void {
    viewport.setAttribute('transform', `translate(${view.x.toFixed(2)} ${view.y.toFixed(2)}) scale(${view.k.toFixed(4)})`)
    const grid = 26 * view.k
    container.style.backgroundSize = `${grid}px ${grid}px`
    container.style.backgroundPosition = `${view.x}px ${view.y}px`
    onViewChange?.(view.k)
  }

  function drawNodes(): void {
    for (const n of live) {
      if (!n.dom || !n.cur) continue
      n.dom.g.setAttribute('transform', `translate(${n.cur.x.toFixed(1)} ${n.cur.y.toFixed(1)})`)
      n.dom.g.style.opacity = n.cur.o.toFixed(3)
      if (n.dom.edge) {
        n.dom.edge.setAttribute('d', edgePath(n))
        n.dom.edge.style.opacity = n.cur.o.toFixed(3)
      }
    }
  }

  function tick(now: number): void {
    if (!anim) {
      raf = 0
      return
    }
    const t = anim.dur <= 0 ? 1 : Math.min(1, (now - anim.t0) / anim.dur)
    const e = 1 - Math.pow(1 - t, 3)
    for (const n of live) {
      if (!n.cur || !n.animFrom || !n.animTo) continue
      n.cur.x = lerp(n.animFrom.x, n.animTo.x, e)
      n.cur.y = lerp(n.animFrom.y, n.animTo.y, e)
      n.cur.o = lerp(n.animFrom.o, n.animTo.o, e)
    }
    if (viewTo && viewFrom) {
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

  function startAnim(dur: number): void {
    anim = { t0: performance.now(), dur: reducedMotion ? 0 : dur }
    if (!raf) raf = requestAnimationFrame(tick)
  }

  /** Nearest ancestor that stays visible — where a collapsing node flies back to. */
  function visibleAncestor(n: MindMapLayoutNode): MindMapLayoutNode {
    let p = n.parent
    while (p && !p.visible) p = p.parent
    return p ?? root
  }

  /** Recompute the layout and animate every node (and optionally the view) to its new place. */
  function update(opts?: { dur?: number; nextView?: View | null; origin?: MindMapLayoutNode | null }): void {
    const { dur = 320, nextView = null, origin = null } = opts ?? {}
    layout()
    for (const n of nodes) {
      if (n.visible) {
        if (!n.dom) {
          buildNode(n)
          live.add(n)
          // Enter from the parent's current position (or a given origin for the intro).
          const src = origin ?? (n.parent && n.parent.cur ? n.parent : null)
          n.cur =
            src && src.cur
              ? { x: src.cur.x + src.w / 2 - n.w / 2, y: src.cur.y + src.h / 2 - n.h / 2, o: 0 }
              : { x: n.tx, y: n.ty, o: 0 }
        }
        n.animFrom = { ...n.cur! }
        n.animTo = { x: n.tx, y: n.ty, o: 1 }
      } else if (n.dom && n.cur) {
        const a = visibleAncestor(n)
        n.animFrom = { ...n.cur }
        n.animTo = { x: a.tx + a.w / 2 - n.w / 2, y: a.ty + a.h / 2 - n.h / 2, o: 0 }
      }
    }
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
  const insets = (): { top: number; right: number; bottom: number; left: number } => ({
    top: 60,
    right: 20 + insetRight,
    bottom: 60,
    left: 20
  })

  function fitView(): View {
    const b = bounds(nodes.filter((n) => n.visible))
    const W = container.clientWidth
    const H = container.clientHeight
    const ins = insets()
    // In a narrow panel the detail card takes most of the width; fitting the map into
    // what is left would shrink it to a thumbnail, so there it fits the whole panel
    // and the card simply lies over part of it.
    if (insetRight > W * 0.4) ins.right = 20
    const availW = Math.max(80, W - ins.left - ins.right)
    const availH = Math.max(80, H - ins.top - ins.bottom)
    const k = clamp(Math.min(availW / b.w, availH / b.h), MIN_K, 1.15)
    return {
      k,
      x: ins.left + availW / 2 - (b.minX + b.w / 2) * k,
      y: ins.top + availH / 2 - (b.minY + b.h / 2) * k
    }
  }

  function animateView(next: View, dur = 280): void {
    for (const n of live) {
      if (!n.cur) continue
      n.animFrom = { ...n.cur }
      if (!n.animTo) n.animTo = { ...n.cur }
    }
    viewFrom = { ...view }
    viewTo = next
    startAnim(dur)
  }

  function zoomAt(k: number, px: number, py: number, animate: boolean): void {
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

  /** Shift a view just enough that the given nodes are on screen (when they fit); `own` is always kept visible. */
  function revealing(own: MindMapLayoutNode, list: MindMapLayoutNode[], v: View): View {
    const b = bounds(list)
    const W = container.clientWidth
    const H = container.clientHeight
    const ins = insets()
    const out = { ...v }
    // lo/hi: the nodes' extent on screen; own0/own1: the clicked node itself.
    const fix = (lo: number, hi: number, min: number, max: number, own0: number, own1: number): number => {
      let d = 0
      if (hi - lo <= max - min) {
        if (lo < min) d = min - lo
        else if (hi > max) d = max - hi
      } else if (own0 < min) d = min - own0
      else if (own1 > max) d = max - own1
      return d
    }
    out.x += fix(b.minX * v.k + v.x, b.maxX * v.k + v.x, ins.left, W - ins.right, own.tx * v.k + v.x, (own.tx + own.w) * v.k + v.x)
    out.y += fix(b.minY * v.k + v.y, b.maxY * v.k + v.y, ins.top - 30, H - ins.bottom + 30, own.ty * v.k + v.y, (own.ty + own.h) * v.k + v.y)
    return out
  }

  function subtree(n: MindMapLayoutNode): MindMapLayoutNode[] {
    const list: MindMapLayoutNode[] = []
    const collect = (x: MindMapLayoutNode): void => {
      list.push(x)
      visibleChildren(x).forEach(collect)
    }
    collect(n)
    return list
  }

  // ── Actions ─────────────────────────────────────────────────────────
  function toggle(id: string): void {
    const n = byId.get(id)
    if (!n || !n.children.length || n.depth === 0) return
    const before = { x: n.tx, y: n.ty }
    if (expanded.has(id)) expanded.delete(id)
    else expanded.add(id)
    layout()
    // Keep the clicked node where it is on screen, then nudge so its children are visible.
    const base = viewTo ?? view
    let next: View = { k: base.k, x: base.x + (before.x - n.tx) * base.k, y: base.y + (before.y - n.ty) * base.k }
    if (expanded.has(id)) next = revealing(n, subtree(n), next)
    update({ nextView: next })
    onManualToggle?.()
  }

  function select(id: string | null): void {
    selectedId = id
    for (const n of live) if (n.dom) n.dom.ring.style.display = n.id === selectedId ? '' : 'none'
    onSelect?.(id ? (byId.get(id) ?? null) : null)
  }

  function expandToLevel(level: number): void {
    expanded.clear()
    for (const n of nodes) if (n.depth >= 1 && n.depth < level - 1 && n.children.length) expanded.add(n.id)
  }

  function setLevel(level: number): void {
    expandToLevel(level)
    layout()
    update({ nextView: fitView(), dur: 380 })
  }

  // ── Input ───────────────────────────────────────────────────────────
  let down: { x: number; y: number; vx: number; vy: number; target: Element | null; moved: boolean } | null = null
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    down = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, target: e.target as Element | null, moved: false }
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
  const endPointer = (e: PointerEvent): void => {
    if (!down) return
    const d = down
    down = null
    container.classList.remove('mm-grabbing')
    if (d.moved || e.type === 'pointercancel') return
    const tg = d.target?.closest('[data-toggle]')
    if (tg) return toggle(tg.getAttribute('data-toggle')!)
    const nd = d.target?.closest('[data-id]')
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
    const nd = (e.target as Element | null)?.closest('[data-id]')
    if (!nd) return
    const id = nd.getAttribute('data-id')!
    if (e.key === 'Enter') {
      e.preventDefault()
      select(id)
    } else if (e.key === ' ') {
      e.preventDefault()
      toggle(id)
    }
  })

  // ── Export ──────────────────────────────────────────────────────────
  function exportSvg(pad = 40): { svg: string; width: number; height: number } {
    const b = bounds(nodes.filter((n) => n.visible))
    const w = Math.ceil(b.w + pad * 2)
    const h = Math.ceil(b.h + pad * 2)
    const clone = viewport.cloneNode(true) as SVGElement
    clone.removeAttribute('transform')
    clone.querySelectorAll('.mm-ring').forEach((r) => r.remove())
    clone.querySelectorAll('[tabindex]').forEach((g) => g.removeAttribute('tabindex'))
    const out = document.createElementNS(SVG_NS, 'svg')
    out.setAttribute('xmlns', SVG_NS)
    out.setAttribute('width', String(w))
    out.setAttribute('height', String(h))
    out.setAttribute('viewBox', `${b.minX - pad} ${b.minY - pad} ${w} ${h}`)
    const bg = el('rect', { x: b.minX - pad, y: b.minY - pad, width: w, height: h }, out)
    bg.style.fill = themeColors(dark).canvas
    out.appendChild(clone)
    return { svg: new XMLSerializer().serializeToString(out), width: w, height: h }
  }

  // ── Init ────────────────────────────────────────────────────────────
  function paintCanvas(): void {
    const theme = themeColors(dark)
    container.style.backgroundColor = theme.canvas
    container.style.backgroundImage = `radial-gradient(${theme.dot} 1px, transparent 1.2px)`
  }

  function intro(level: number): void {
    for (const n of [...live]) removeNode(n)
    selectedId = null
    expandToLevel(level)
    layout()
    Object.assign(view, fitView())
    drawView()
    buildNode(root)
    live.add(root)
    root.cur = { x: root.tx, y: root.ty, o: 1 }
    update({ dur: 620, origin: root })
  }

  paintCanvas()

  // When the canvas changes size (window resized or maximized), keep whatever is at its
  // centre at the centre. A hidden tab reports 0 × 0 and is ignored, so coming back to
  // the tab finds the view untouched.
  let lastSize = { w: container.clientWidth, h: container.clientHeight }
  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth
    const h = container.clientHeight
    if (w === 0 || h === 0) return
    if (lastSize.w > 0 && lastSize.h > 0 && (w !== lastSize.w || h !== lastSize.h)) {
      const dx = (w - lastSize.w) / 2
      const dy = (h - lastSize.h) / 2
      view.x += dx
      view.y += dy
      if (viewFrom && viewTo) {
        viewFrom = { ...viewFrom, x: viewFrom.x + dx, y: viewFrom.y + dy }
        viewTo = { ...viewTo, x: viewTo.x + dx, y: viewTo.y + dy }
      }
      drawView()
    }
    lastSize = { w, h }
  })
  resizeObserver.observe(container)

  return {
    intro,
    setLevel,
    toggle,
    select,
    exportSvg,
    isExpanded: (id) => expanded.has(id),
    fit: () => animateView(fitView(), 320),
    zoomBy: (factor) => zoomAt(view.k * factor, container.clientWidth / 2, container.clientHeight / 2, true),
    resetZoom: () => zoomAt(1, container.clientWidth / 2, container.clientHeight / 2, true),
    setInsetRight: (px) => {
      insetRight = px
    },
    ensureVisible: (id) => {
      const n = byId.get(id)
      if (!n || !n.visible) return
      const base = viewTo ?? view
      const next = revealing(n, [n], { ...base })
      if (next.x !== base.x || next.y !== base.y) animateView(next, 260)
    },
    setDark: (value) => {
      dark = value
      paintCanvas()
      for (const n of live) paintNode(n)
    },
    destroy: () => {
      resizeObserver.disconnect()
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      anim = null
      svg.remove()
      container.style.backgroundImage = ''
    }
  }
}
