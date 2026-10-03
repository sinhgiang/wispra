/*
 * Prototype shell for the four-column Transcript (ticket T-0021): a static copy of the
 * Meeting session view with the new Transcript layout wired to the sample data. Nothing
 * here talks to the real app, the AI, or the network.
 */
;(function () {
  const { SESSION, SPEAKERS, PARAGRAPHS, TOPICS, ACTIONS } = window.SAMPLE
  const $ = (id) => document.getElementById(id)

  // Same format as formatElapsed() in the app's Meeting tab.
  function fmt(ms) {
    const total = Math.floor(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (v) => String(v).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  }
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  $('sessionTitle').textContent = SESSION.title
  $('sideTitle').textContent = SESSION.title
  $('sessionDate').textContent = SESSION.createdAt

  // ── Columns 1-3: one grid per topic; the topic cell spans all of its paragraphs ──
  function speakerChip(key) {
    const sp = SPEAKERS[key]
    if (!sp) return ''
    const how = sp.source === 'self' ? `Named from ${sp.quote} at ${sp.at}` : sp.source === 'introduced' ? `Named from ${sp.quote} at ${sp.at}` : 'Voice not named in the recording'
    return `<span class="speaker${sp.source ? '' : ' unnamed'}" style="--hue:${sp.hue}" title="${escapeHtml(how)}"><i></i><span>${escapeHtml(sp.name)}</span></span>`
  }
  // Action items in the order they come up; the same buttons are used by topic and in the list.
  const actions = [...ACTIONS].sort((a, b) => a.at - b.at)
  function actionButton(a, i) {
    const p = PARAGRAPHS[a.at - 1]
    const meta = [a.owner, a.due].filter(Boolean).join(' · ')
    return `<button class="act" data-act="${i}" data-p="${p.id}" title="Jump to ${fmt(p.startMs)} in the transcript"><span class="act-time">${fmt(p.startMs)}</span><span class="act-body"><span class="act-text">${escapeHtml(a.text)}</span>${meta ? `<span class="act-meta">${escapeHtml(meta)}</span>` : ''}</span></button>`
  }

  $('sections').innerHTML = TOPICS.map((topic) => {
    const rows = PARAGRAPHS.slice(topic.from - 1, topic.to)
    const end = topic.to < PARAGRAPHS.length ? PARAGRAPHS[topic.to].startMs : SESSION.durationMs
    const cells = rows
      .map(
        (p, i) =>
          `<div class="p-time" data-p="${p.id}" style="grid-column:1;grid-row:${i + 1}"><span class="elapsed">${fmt(p.startMs)}</span><span class="clock">${p.clock}</span>${speakerChip(p.speaker)}</div>` +
          `<p class="p-text" data-p="${p.id}" style="grid-column:3;grid-row:${i + 1}">${escapeHtml(p.text)}</p>`
      )
      .join('')
    return (
      `<section class="tx-cols sec" style="--hue:${topic.hue}">` +
      `<div class="sec-topic" style="grid-column:2;grid-row:1 / span ${rows.length}"><div class="sec-topic-inner"><h3>${escapeHtml(topic.title)}</h3><span class="range">${fmt(rows[0].startMs)} – ${fmt(end)}</span></div></div>` +
      // By topic: this topic's action items; an empty cell when it has none (nothing is made up).
      (() => {
        const own = actions.map((a, i) => ({ a, i })).filter(({ a }) => a.at >= topic.from && a.at <= topic.to)
        return `<div class="sec-actions${own.length ? '' : ' empty'}" style="grid-column:4;grid-row:1 / span ${rows.length}"><div class="sec-actions-inner">${own.map(({ a, i }) => actionButton(a, i)).join('')}</div></div>`
      })() +
      cells +
      `</section>`
    )
  }).join('')

  // ── Column 4: action items, in the order they come up; each jumps to its paragraph ──
  $('actCount').textContent = String(actions.length)
  $('actCountToggle').textContent = String(actions.length)
  document.querySelectorAll('[data-count]').forEach((el) => (el.textContent = String(actions.length)))
  $('actList').innerHTML = actions.map(actionButton).join('') + '<div class="act-hint">Click an action to jump to where it was said.</div>'

  // By topic / List switch — remembered, like the app does.
  const VIEW_KEY = 'wispra-prototype-actions-view'
  function setView(view) {
    $('tx').classList.toggle('by-topic', view === 'topic')
    $('tx').classList.remove('actions-open')
    document.querySelectorAll('.view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {}
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.view-switch button')
    if (b) setView(b.dataset.view)
  })
  let savedView = 'topic'
  try {
    savedView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'topic'
  } catch {}
  setView(savedView)

  // ── Jump + highlight ──────────────────────────────────────────────────
  const scroller = $('txScroll')
  let activeAct = null
  function clearHighlight() {
    document.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'))
    document.querySelectorAll('.act.active').forEach((el) => el.classList.remove('active'))
    activeAct = null
  }
  function jumpTo(button) {
    const same = !!activeAct && activeAct.dataset.act === button.dataset.act
    clearHighlight()
    $('tx').classList.remove('actions-open')
    if (same) return // clicking the active action again clears the highlight
    activeAct = button
    // The same action shows both next to its topic and in the list.
    document.querySelectorAll(`.act[data-act="${button.dataset.act}"]`).forEach((b) => b.classList.add('active'))
    const cells = document.querySelectorAll(`#sections [data-p="${button.dataset.p}"]`)
    cells.forEach((el) => el.classList.add('hl'))
    const text = [...cells].find((el) => el.classList.contains('p-text'))
    const top = text.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    scroller.scrollTo({ top: Math.max(0, top - 32 - 40), behavior: 'smooth' })
  }
  $('tx').addEventListener('click', (e) => {
    const button = e.target.closest('.act')
    if (button) jumpTo(button)
  })

  // Narrow layout: the action items live in a slide-over panel.
  $('actionsToggle').addEventListener('click', () => $('tx').classList.toggle('actions-open'))
  $('actionsClose').addEventListener('click', () => $('tx').classList.remove('actions-open'))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('tx').classList.remove('actions-open')
  })

  // ── Prototype bar ─────────────────────────────────────────────────────
  function seg(id, attr, apply, initial) {
    const el = $(id)
    const set = (value) => {
      el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset[attr] === value))
      apply(value)
    }
    el.addEventListener('click', (e) => {
      if (e.target.dataset[attr]) set(e.target.dataset[attr])
    })
    set(initial)
  }
  seg('themeSeg', 'theme', (v) => document.documentElement.setAttribute('data-theme', v), window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  seg('sizeSeg', 'size', (v) => {
    $('stage').dataset.size = v
    $('stage').classList.toggle('sized', v !== 'fill')
    $('tx').classList.remove('actions-open')
  }, 'fill')
  seg('speakerSeg', 'speakers', (v) => $('tx').classList.toggle('no-speakers', v === 'off'), 'on')
})()
