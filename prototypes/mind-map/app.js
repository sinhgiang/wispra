/*
 * Prototype shell for the Mind map tab (ticket T-0004): a static copy of the Meeting
 * session view with the new tab wired to the sample data. Nothing here talks to the
 * real app, the AI, or the network.
 */
;(function () {
  const { SESSION, TRANSCRIPT, MAP } = window.SAMPLE
  const $ = (id) => document.getElementById(id)
  const DEFAULT_LEVEL = 2

  // Same format as formatElapsed() in src/renderer/meeting/App.tsx.
  function fmt(ms) {
    const total = Math.floor(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (v) => String(v).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }
  const fmtShort = (ms) => {
    const min = Math.floor(ms / 60000)
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`
  }
  const fmtDuration = (ms) => {
    const min = Math.max(1, Math.round(ms / 60000))
    return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`
  }

  // ── Build the tree from the sample data ───────────────────────────────
  const KIND_LABEL = { topic: 'Topic', decisions: 'Outcome', actions: 'Outcome', questions: 'Outcome' }
  const tree = {
    label: SESSION.title,
    note: SESSION.summary,
    from: 1,
    to: TRANSCRIPT.length,
    children: [...MAP.topics, ...MAP.outcomes.map((o) => ({ ...o, side: -1 }))]
  }
  ;(function decorate(node, depth) {
    node.startMs = TRANSCRIPT[node.from - 1].startMs
    node.endMs = node.to < TRANSCRIPT.length ? TRANSCRIPT[node.to].startMs : SESSION.durationMs
    if (depth === 0) node.sub = `${fmtDuration(SESSION.durationMs)} · ${node.children.length} branches`
    else if (depth === 1) node.sub = node.kind === 'topic' ? `${fmtShort(node.startMs)} – ${fmtShort(node.endMs)}` : `${node.children.length} items`
    else if (node.meta) node.sub = [node.meta.owner, node.meta.due && `due ${node.meta.due}`].filter(Boolean).join(' · ')
    node.children.forEach((c) => decorate(c, depth + 1))
  })(tree, 0)

  // ── Static content ────────────────────────────────────────────────────
  $('sessionTitle').textContent = SESSION.title
  $('sessionDate').textContent = SESSION.createdAt
  $('summaryText').textContent = SESSION.summary
  $('transcript').innerHTML = TRANSCRIPT.map(
    (b) =>
      `<div class="meeting-paragraph" data-block-id="${b.id}"><span class="meeting-paragraph-time"><span class="meeting-paragraph-elapsed">${fmt(b.startMs)}</span><span class="meeting-paragraph-clock">${b.clock}</span></span><p></p></div>`
  ).join('')
  TRANSCRIPT.forEach((b, i) => ($('transcript').children[i].querySelector('p').textContent = b.text))

  // ── Theme ─────────────────────────────────────────────────────────────
  let map = null
  let dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
    $('themeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.theme === 'dark') === dark))
    if (map) map.setDark(dark)
  }
  $('themeSeg').addEventListener('click', (e) => {
    if (!e.target.dataset.theme) return
    dark = e.target.dataset.theme === 'dark'
    applyTheme()
  })
  applyTheme()

  // ── Toast ─────────────────────────────────────────────────────────────
  let toastTimer = 0
  function toast(text) {
    $('toast').textContent = text
    $('toast').classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2200)
  }

  // ── Tabs ──────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'transcript', label: 'Transcript', copy: 'Copy transcript' },
    { id: 'summary', label: 'Summary', copy: 'Copy summary' },
    { id: 'mindmap', label: 'Mind map', copy: 'Copy outline', isNew: true },
    { id: 'website', label: 'Website', copy: 'Copy article' },
    { id: 'facebook', label: 'Facebook', copy: 'Copy post' },
    { id: 'instagram', label: 'Instagram', copy: 'Copy caption' },
    { id: 'linkedin', label: 'LinkedIn', copy: 'Copy post' },
    { id: 'twitter', label: 'X', copy: 'Copy post' }
  ]
  let currentTab = null
  $('tabs').innerHTML = TABS.map((t) => `<button class="meeting-view-btn" data-tab="${t.id}">${t.label}${t.isNew ? '<span class="new-dot" title="New"></span>' : ''}</button>`).join('')
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]')
    if (b) setTab(b.dataset.tab)
  })

  function setTab(id) {
    if (id !== 'mindmap') setFullscreen(false)
    currentTab = id
    const tab = TABS.find((t) => t.id === id)
    $('tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === id))
    const viewId = ['transcript', 'summary', 'mindmap'].includes(id) ? id : 'other'
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === viewId))
    $('copyBtn').textContent = tab.copy
    // On the map tab the chat shrinks to its input row to leave the map room.
    $('chatPanel').classList.toggle('compact', id === 'mindmap')
    if (id === 'mindmap' && !map) initMap()
  }

  $('copyBtn').addEventListener('click', () => {
    if (currentTab === 'mindmap') copyOutline()
    else toast('Copied (unchanged behaviour, not part of the prototype)')
  })

  // ── Mind map ──────────────────────────────────────────────────────────
  function initMap() {
    map = window.createMindMap($('mmCanvas'), {
      tree,
      dark,
      onSelect: showCard,
      onViewChange: (k) => ($('zoomLabel').textContent = Math.round(k * 100) + '%'),
      onManualToggle: () => {
        setLevelButton(null)
        if (selected) updateCardToggle()
      }
    })
    map.intro(DEFAULT_LEVEL)
    setLevelButton(DEFAULT_LEVEL)
  }

  function setLevelButton(level) {
    document.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('active', Number(b.dataset.level) === level))
  }
  document.querySelectorAll('[data-level]').forEach((b) =>
    b.addEventListener('click', () => {
      const level = Number(b.dataset.level)
      map.setLevel(level)
      setLevelButton(level)
      if (selected) updateCardToggle()
    })
  )

  $('zoomIn').addEventListener('click', () => map.zoomBy(1.25))
  $('zoomOut').addEventListener('click', () => map.zoomBy(1 / 1.25))
  $('zoomLabel').addEventListener('click', () => map.resetZoom())
  $('fitBtn').addEventListener('click', () => map.fit())

  const hideHint = () => $('mmHint').classList.add('hide')
  $('mmCanvas').addEventListener('pointerdown', hideHint)
  $('mmCanvas').addEventListener('wheel', hideHint, { passive: true })

  // Full screen = the map fills the whole app window (not the OS screen).
  const ICON_EXPAND = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'
  const ICON_SHRINK = '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'
  function setFullscreen(on) {
    const win = $('window')
    if (win.classList.contains('mm-full') === on) return
    win.classList.toggle('mm-full', on)
    $('fullIcon').innerHTML = on ? ICON_SHRINK : ICON_EXPAND
    $('fullBtn').title = on ? 'Exit full screen (Esc)' : 'Full screen (Esc to exit)'
    if (map) requestAnimationFrame(() => map.fit())
  }
  $('fullBtn').addEventListener('click', () => setFullscreen(!$('window').classList.contains('mm-full')))

  // ── Node detail card ──────────────────────────────────────────────────
  let selected = null
  const branchColor = (node) => (node.depth === 0 ? '#6366f1' : `oklch(${dark ? 0.72 : 0.62} 0.14 ${node.branch.hue})`)
  const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  function showCard(node) {
    selected = node
    const card = $('mmCard')
    if (!node) {
      card.classList.remove('show')
      map.setInsetRight(0)
      return
    }
    const path = []
    for (let p = node.parent; p && p.depth > 0; p = p.parent) path.unshift(p.label)
    $('cardCrumb').textContent = node.depth === 0 ? 'Recording' : node.depth === 1 ? KIND_LABEL[node.kind] : path.join('  ›  ')
    $('cardCrumb').style.color = branchColor(node)
    $('cardDot').style.background = branchColor(node)
    $('cardTitle').textContent = node.label
    $('cardNote').textContent = node.note || ''
    const chips = []
    const single = node.from === node.to && node.depth > 1
    chips.push(`${ICON_CLOCK}${single ? fmt(node.startMs) : `${fmt(node.startMs)} – ${fmt(node.endMs)}`}`)
    if (!single) chips.push(fmtDuration(node.endMs - node.startMs))
    if (node.meta && node.meta.owner) chips.push(`Owner: ${escapeHtml(node.meta.owner)}`)
    if (node.meta && node.meta.due) chips.push(`Due: ${escapeHtml(node.meta.due)}`)
    if (node.children.length) chips.push(`${node.children.length} ${node.children.length === 1 ? 'point' : 'points'}`)
    $('cardChips').innerHTML = chips.map((c) => `<span class="mm-chip">${c}</span>`).join('')
    $('showInTranscript').style.display = node.depth === 0 ? 'none' : ''
    updateCardToggle()
    card.classList.add('show')
    map.setInsetRight(card.offsetWidth + 12)
    map.ensureVisible(node.id)
  }

  function updateCardToggle() {
    const btn = $('cardToggle')
    const can = selected && selected.depth > 0 && selected.children.length > 0
    btn.style.display = can ? '' : 'none'
    if (can) btn.textContent = map.isExpanded(selected.id) ? 'Collapse' : 'Expand'
  }
  $('cardToggle').addEventListener('click', () => {
    map.toggle(selected.id)
    updateCardToggle()
  })
  $('cardClose').addEventListener('click', () => map.select(null))

  // ── Show in transcript ────────────────────────────────────────────────
  function clearHighlight() {
    $('transcript').querySelectorAll('.meeting-paragraph-highlighted').forEach((p) => p.classList.remove('meeting-paragraph-highlighted'))
    $('fromMap').classList.remove('show')
  }
  $('showInTranscript').addEventListener('click', () => {
    const node = selected
    clearHighlight()
    setTab('transcript')
    const list = $('transcript')
    for (let i = node.from; i <= node.to; i++) list.children[i - 1].classList.add('meeting-paragraph-highlighted')
    $('fromMapLabel').textContent = node.label
    $('fromMapDot').style.background = branchColor(node)
    $('fromMap').classList.add('show')
    const first = list.children[node.from - 1]
    const top = first.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - 12
    list.scrollTo({ top, behavior: 'smooth' })
  })
  $('backToMap').addEventListener('click', () => setTab('mindmap'))
  $('clearFromMap').addEventListener('click', clearHighlight)

  // ── Export ────────────────────────────────────────────────────────────
  const menu = $('exportMenu')
  $('exportBtn').addEventListener('click', (e) => {
    e.stopPropagation()
    menu.classList.toggle('show')
  })
  document.addEventListener('click', () => menu.classList.remove('show'))

  function outlineMarkdown() {
    const lines = [`# ${SESSION.title}`, '', `_Mind map · ${SESSION.createdAt} · ${fmt(SESSION.durationMs)}_`, '']
    for (const branch of tree.children) {
      lines.push(branch.kind === 'topic' ? `## ${branch.label} (${fmt(branch.startMs)} – ${fmt(branch.endMs)})` : `## ${branch.label}`)
      ;(function walk(nodes, indent) {
        for (const node of nodes) {
          const meta = node.meta ? ` — ${[node.meta.owner, node.meta.due && `due ${node.meta.due}`].filter(Boolean).join(', ')}` : ''
          const box = branch.kind === 'actions' ? '[ ] ' : ''
          lines.push(`${'  '.repeat(indent)}- ${box}${node.label}${meta} [${fmt(node.startMs)}]`)
          walk(node.children, indent + 1)
        }
      })(branch.children, 0)
      lines.push('')
    }
    return lines.join('\n')
  }

  async function copyOutline() {
    const text = outlineMarkdown()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast('Markdown outline copied to the clipboard')
  }
  $('exportMd').addEventListener('click', copyOutline)

  $('exportPng').addEventListener('click', () => {
    const { svg, width, height } = map.exportSvg(48)
    const scale = Math.min(2, 8000 / Math.max(width, height))
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'q4-product-planning-mind-map.png'
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 2000)
        toast(`PNG saved (${canvas.width} × ${canvas.height})`)
      }, 'image/png')
    }
    img.onerror = () => toast('Could not render the PNG in this browser')
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  })

  // ── Generating state (what the first open of the tab looks like) ──────
  let genTimers = []
  function playGenerating() {
    genTimers.forEach(clearTimeout)
    genTimers = []
    setTab('mindmap')
    map.select(null)
    const parts = 6
    const steps = [`Reading the transcript · ${fmtDuration(SESSION.durationMs)}`]
    for (let i = 1; i <= parts; i++) steps.push(`Outlining part ${i} of ${parts}…`)
    steps.push('Merging the parts into one map…', 'Linking every point to the transcript…')
    $('genBar').style.width = '0%'
    $('mmGen').classList.add('show')
    steps.forEach((text, i) => {
      genTimers.push(
        setTimeout(() => {
          $('genStep').textContent = text
          $('genBar').style.width = Math.round(((i + 1) / steps.length) * 100) + '%'
        }, i * 520)
      )
    })
    genTimers.push(
      setTimeout(() => {
        $('mmGen').classList.remove('show')
        map.intro(DEFAULT_LEVEL)
        setLevelButton(DEFAULT_LEVEL)
      }, steps.length * 520 + 350)
    )
  }
  $('regenBtn').addEventListener('click', playGenerating)
  $('replayGen').addEventListener('click', playGenerating)

  // ── Window size (prototype only) ──────────────────────────────────────
  $('sizeSeg').addEventListener('click', (e) => {
    const size = e.target.dataset.size
    if (!size) return
    $('sizeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.target))
    $('stage').classList.toggle('compact', size === 'compact')
    if (map && currentTab === 'mindmap') requestAnimationFrame(() => map.fit())
  })

  // ── Keyboard ──────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (currentTab !== 'mindmap' || e.target.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Escape') {
      if (menu.classList.contains('show')) menu.classList.remove('show')
      else if (selected) map.select(null)
      else setFullscreen(false)
    } else if (e.key === '+' || e.key === '=') map.zoomBy(1.25)
    else if (e.key === '-') map.zoomBy(1 / 1.25)
    else if (e.key === '0') map.resetZoom()
    else if (e.key === 'f' || e.key === 'F') map.fit()
  })

  setTab('mindmap')
})()
