/*
 * Automated check for the Transcript tab's four columns (time · speaker, topic,
 * transcript, action items) and the outline they are built from.
 *
 * Run with `npm run check:transcript-columns` (builds first). Two parts, no API key,
 * account or network in either:
 *
 *   A. The outline functions (bundled from src/ on the fly) against a fake AI: `fetch` is
 *      replaced by a stub. Checks call counts for a short and a long recording, that
 *      topics always cover the whole transcript, that nothing is invented where the AI
 *      returns no action items, the language rule, and the "you / others" decision.
 *   B. The built Settings renderer with the real preload and stub IPC handlers: first
 *      open builds the outline once, reopening does not, a topic without action items
 *      stays empty, the By topic / List switch (and that it is remembered), clicking an
 *      action jumps to its paragraph, speaker names, a long recording, failure with
 *      "Try again", narrow windows, and the dark theme.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
// Channel names come from the single source of truth, src/shared/ipc.ts.
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)

app.setPath('userData', path.join(TMP, 'userdata'))
// The window sits off-screen; without this Windows marks it occluded and stops painting it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** `count` one-paragraph segments of about `chars` characters, 40 s apart. */
function makeSegments(prefix, count, chars) {
  return Array.from({ length: count }, (_, i) => {
    let text = `Đoạn ${i + 1}:`
    while (text.length < chars) text += ' chúng ta bàn về kết quả mở bán thử và kế hoạch ra mắt khoá học tháng mười một.'
    return { id: `${prefix}-s${i + 1}`, text, startMs: i * 40000, endMs: (i + 1) * 40000, startedAt: new Date(Date.UTC(2026, 8, 28, 7, 5, i * 40)).toISOString(), isNewParagraph: true }
  })
}

// ── Part A: the outline functions against a fake AI ──────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'outline-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { generateOutline } from './src/main/outline'
        export { outlineLanguage } from './src/main/outlineLogic'
        export { voiceOf, rmsOf } from './src/renderer/meeting/voice'
        export { LANGUAGES } from './src/shared/constants'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const { generateOutline, outlineLanguage, voiceOf, rmsOf, LANGUAGES } = require(outfile)
  const target = { apiKey: 'test', base: 'http://fake.invalid/v1', model: 'm' }

  // The fake AI. `script` decides what each kind of call answers.
  let calls = []
  let script = {}
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const system = body.messages[0].content
    const user = body.messages[1].content
    const kind = system.startsWith('You are organising one part') ? 'part' : system.startsWith('You are tidying') ? 'merge' : 'single'
    calls.push({ kind, system, maxTokens: body.max_tokens, jsonMode: !!body.response_format })
    // Groq's answer when the model's output fails its JSON mode check (see callJson in mindMap.ts).
    if (script.badJson && script.badJson(kind, body)) {
      return new Response(JSON.stringify({ error: { message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", type: 'invalid_request_error', code: 'json_validate_failed', failed_generation: '{"topics": [' } }), { status: 400 })
    }
    await sleep(3)
    const refs = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    const answer = script[kind] ? script[kind](refs, user) : null
    if (answer === null) return new Response('boom', { status: 500 })
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 })
  }
  const quiet = console.error
  console.error = () => {}
  const run = async (segments, language = 'auto') => {
    calls = []
    return generateOutline(segments, target, language)
  }

  try {
    check('language follows the Summary box, not the Website box', outlineLanguage({ summary: 'vi', website: 'en' }, LANGUAGES.map((l) => l.code)) === 'vi' && outlineLanguage(undefined, ['vi']) === 'auto' && outlineLanguage({ summary: 'xx' }, ['vi']) === 'auto')

    // A short recording: 10 paragraphs, one call.
    const short = makeSegments('a', 10, 300)
    script = {
      single: () => ({
        topics: [{ title: 'Kết quả mở bán', start: 3 }, { title: 'Kế hoạch ra mắt', start: 7 }, { title: 'Không có thật', start: 99 }],
        actions: [{ text: 'Viết lại trang đăng ký', owner: 'Linh', due: 'thứ Sáu', ref: 8 }, { text: 'Việc trỏ ra ngoài bản ghi', ref: 42 }],
        speakers: [{ name: 'Sơn', start: 1, end: 2 }, { name: 'Ai đó', start: 77 }]
      })
    }
    let outline = await run(short, 'vi')
    check('short recording: one AI call, in JSON mode budget, asking for Vietnamese', calls.length === 1 && calls[0].kind === 'single' && calls[0].system.includes('in Vietnamese'), { calls: calls.length, maxTokens: calls[0].maxTokens })
    check('topics cover the whole transcript: the first is pulled back to the first paragraph, each ends where the next begins, invented refs are dropped', outline.topics.length === 2 && outline.topics[0].startSegmentId === 'a-s1' && outline.topics[0].endSegmentId === 'a-s6' && outline.topics[1].startSegmentId === 'a-s7' && outline.topics[1].endSegmentId === 'a-s10', outline.topics)
    check('an action keeps its paragraph, owner and due; one pointing outside the transcript is dropped', outline.actions.length === 1 && outline.actions[0].startSegmentId === 'a-s8' && outline.actions[0].owner === 'Linh' && outline.actions[0].due === 'thứ Sáu', outline.actions)
    check('speaker names only where the transcript says so', outline.speakers.length === 1 && outline.speakers[0].name === 'Sơn' && outline.speakers[0].endSegmentId === 'a-s2', outline.speakers)
    check('outline records its language', outline.language === 'vi')

    script = { single: () => ({ topics: [{ title: 'Ghi chú nhanh', start: 1 }], actions: [], speakers: [] }) }
    outline = await run(short)
    check('no action items in the answer → none in the outline (nothing is made up)', outline.actions.length === 0 && outline.topics.length === 1 && calls[0].system.includes('SAME language as the transcript'))

    script = { single: () => ({ topics: [], actions: [{ text: 'x', ref: 1 }] }) }
    check('an answer without topics is a failure, not an empty outline', (await run(short)) === null && calls.length === 1, { calls: calls.length })

    // The outline shares callJson with the mind map, so it gets the mind map's JSON retry (T-0024).
    let refusals = 0
    script = {
      single: () => ({ topics: [{ title: 'Kết quả mở bán', start: 1 }], actions: [], speakers: [] }),
      badJson: (kind) => kind === 'single' && refusals++ < 2
    }
    outline = await run(short)
    check('HTTP 400 "Failed to generate JSON" on the outline: asked again (the last time without JSON mode) and the outline is built', outline !== null && outline.topics.length === 1 && calls.map((c) => (c.jsonMode ? 'json' : 'plain')).join() === 'json,json,plain', calls.map((c) => (c.jsonMode ? 'json' : 'plain')))

    // A long recording: about 2 h 13 min, 200 paragraphs → parts + one merge call.
    const long = makeSegments('b', 200, 620)
    script = {
      part: (refs, user) => {
        const n = Number(/This is part (\d+) of/.exec(user)[1])
        const mid = refs[Math.floor(refs.length / 2)]
        return {
          topics: [{ title: `Chủ đề ${n}a`, start: refs[0] }, { title: `Chủ đề ${n}b`, start: mid }],
          actions: [{ text: `Việc của phần ${n}`, ref: refs[1] }],
          speakers: n === 1 ? [{ name: 'Sơn', start: refs[0], end: refs[2] }] : []
        }
      },
      // Join each part's second topic with the next part's first one; drop action 2 as a repeat.
      merge: (_refs, user) => {
        const count = [...user.matchAll(/^T(\d+)/gm)].length
        const actions = [...user.matchAll(/^A(\d+)/gm)].map((m) => Number(m[1])).filter((n) => n !== 2)
        const topics = [{ from: 1, to: 1, title: 'Mở đầu' }]
        for (let i = 2; i < count; i += 2) topics.push({ from: i, to: i + 1, title: `Chủ đề gộp ${i / 2}` })
        topics.push({ from: count, to: count, title: 'Kết thúc' }, { from: 3, to: 9, title: 'Chồng lên run khác (phải bị bỏ qua)' })
        return { topics, actions }
      }
    }
    outline = await run(long)
    const parts = calls.filter((c) => c.kind === 'part').length
    check('long recording: outlined in parts, then one merge call', parts >= 8 && calls.filter((c) => c.kind === 'merge').length === 1 && calls[calls.length - 1].kind === 'merge', { parts, calls: calls.length })
    const order = new Map(long.map((s, i) => [s.id, i]))
    let cursor = 0
    let contiguous = true
    for (const t of outline.topics) {
      if (order.get(t.startSegmentId) !== cursor) contiguous = false
      cursor = order.get(t.endSegmentId) + 1
    }
    check('long recording: topics run from the first paragraph to the last with no gap and no overlap (the middle is not skipped)', contiguous && cursor === long.length, { topics: outline.topics.length, coveredTo: cursor, paragraphs: long.length })
    check('merge joined topics cut at part boundaries; an overlapping run was ignored', outline.topics.length === parts + 1 && outline.topics[1].title === 'Chủ đề gộp 1', outline.topics.slice(0, 3).map((t) => t.title))
    check('merge dropped the repeated action and kept the rest', outline.actions.length === parts - 1 && !outline.actions.some((a) => a.text === 'Việc của phần 2'), outline.actions.length)

    script.merge = () => null
    outline = await run(long)
    check('if the merge call fails the outline is still built from the parts', outline !== null && outline.topics.length === parts * 2 && outline.actions.length === parts, outline && { topics: outline.topics.length, actions: outline.actions.length })

    const partScript = script.part
    script.part = (refs, user) => (/This is part 2 of/.test(user) ? null : partScript(refs, user))
    outline = await run(long)
    check('if a part cannot be outlined there is no outline (never one with a hole), and the remaining parts are not called', outline === null && calls.length < parts + 2, { calls: calls.length })

    // "You / others" from the two sources' energy in "Both" mode.
    check('you / others: clear dominance labels the chunk; close levels or silence leave it unlabelled', voiceOf(4, 0.5) === 'me' && voiceOf(0.2, 3) === 'others' && voiceOf(1, 0.6) === undefined && voiceOf(0, 0) === undefined, [voiceOf(4, 0.5), voiceOf(0.2, 3), voiceOf(1, 0.6), voiceOf(0, 0)])
    check('level of a silent frame is 0, of a full-scale frame about 1', rmsOf(new Uint8Array(256).fill(128)) === 0 && rmsOf(Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0))) > 0.98)
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the user sees ───────────────────────────────────────────────
async function partB() {
  const base = (id, title, segments) => ({ id, title, createdAt: '2026-09-28T07:05:00.000Z', durationMs: segments.length * 40000, audioSource: 'both', status: 'stopped', segments, summary: 'Tóm tắt.' })
  const seg = (prefix, n) => `${prefix}-s${n}`
  // 16 paragraphs, 5 topics; the 4th topic has no action item. Paragraphs 5-6 carry "you"/"others".
  const oldSegments = makeSegments('old', 16, 260)
  oldSegments[4].voice = 'me'
  oldSegments[5].voice = 'others'
  const oldOutline = {
    language: 'vi',
    generatedAt: '2026-09-28T08:00:00.000Z',
    topics: [
      { title: 'Mở đầu và mục tiêu', startSegmentId: seg('old', 1), endSegmentId: seg('old', 2) },
      { title: 'Kết quả đợt mở bán thử', startSegmentId: seg('old', 3), endSegmentId: seg('old', 6) },
      { title: 'Nội dung và lịch học', startSegmentId: seg('old', 7), endSegmentId: seg('old', 9) },
      { title: 'Kế hoạch truyền thông', startSegmentId: seg('old', 10), endSegmentId: seg('old', 12) },
      { title: 'Phân công và mốc thời gian', startSegmentId: seg('old', 13), endSegmentId: seg('old', 16) }
    ],
    actions: [
      { text: 'Gửi số liệu mở bán cho cả nhóm', owner: 'Linh', startSegmentId: seg('old', 4), endSegmentId: seg('old', 4) },
      { text: 'Gộp ba bản tài liệu cài đặt', owner: 'Sơn', due: '25/10', startSegmentId: seg('old', 8), endSegmentId: seg('old', 8) },
      { text: 'Viết lại trang đăng ký', owner: 'Linh', due: 'thứ Sáu', startSegmentId: seg('old', 13), endSegmentId: seg('old', 13) },
      { text: 'Nhắn lại 22 người chưa chuyển khoản', owner: 'Linh', startSegmentId: seg('old', 15), endSegmentId: seg('old', 15) }
    ],
    speakers: [
      { name: 'Sơn', startSegmentId: seg('old', 1), endSegmentId: seg('old', 3) },
      { name: 'Linh', startSegmentId: seg('old', 4), endSegmentId: seg('old', 4) }
    ]
  }
  const longSegments = makeSegments('long', 200, 420)
  const longOutline = {
    language: 'vi',
    generatedAt: '2026-09-28T09:00:00.000Z',
    topics: Array.from({ length: 25 }, (_, i) => ({ title: `Chủ đề số ${i + 1} của buổi họp dài`, startSegmentId: seg('long', i * 8 + 1), endSegmentId: seg('long', i * 8 + 8) })),
    actions: Array.from({ length: 12 }, (_, i) => ({ text: `Việc cần làm số ${i + 1}`, owner: 'Linh', startSegmentId: seg('long', i * 16 + 5), endSegmentId: seg('long', i * 16 + 5) })),
    speakers: []
  }
  const sessions = [
    base('old', 'Check old session', oldSegments),
    { ...base('long', 'Check long session', longSegments), outline: longOutline },
    base('fail', 'Check fail session', makeSegments('fail', 6, 200)),
    base('empty', 'Check empty session', [])
  ]
  const byId = (id) => sessions.find((s) => s.id === id)
  const calls = {}
  let speakerPatches = []
  let win = null

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  // Recordings here count as made after this install first ran the version that limits automatic AI
  // to new recordings (Settings.autoAiSince), so their Transcript topics start by themselves.
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [], autoAiSince: '2026-01-01T00:00:00.000Z' }))
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments, outline, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => byId(id) ?? null)
  handle(IPC.MEETING_GENERATE_OUTLINE, async (_event, id, options) => {
    const session = byId(id)
    if (session.outline && !(options && options.regenerate)) return session.outline
    calls[id] = (calls[id] ?? 0) + 1
    win.webContents.send(IPC.MEETING_OUTLINE_PROGRESS, { sessionId: id, phase: 'outline', done: 0, total: 1 })
    await sleep(500)
    if (id !== 'old') return null
    session.outline = { ...oldOutline, generatedAt: new Date().toISOString() }
    win.webContents.send(IPC.MEETING_SESSION_UPDATED, session)
    return session.outline
  })
  handle(IPC.MEETING_SET_SPEAKER_NAMES, (_event, id, names) => {
    speakerPatches.push({ id, names })
    const session = byId(id)
    session.speakerNames = { ...session.speakerNames, ...names }
    win.webContents.send(IPC.MEETING_SESSION_UPDATED, session)
  })

  win = new BrowserWindow({
    // The app's default Settings window size (see openSettingsWindow in windows.ts).
    width: 1250,
    height: 700,
    x: -4000,
    y: -4000,
    show: false,
    skipTaskbar: true,
    webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const click = async (expr, wait = 350) => {
    const p = await js(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2); const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? hit.tagName + '.' + hit.className : null } })()`)
    if (process.env.CHECK_DEBUG) console.log('CLICK', expr.slice(-60), JSON.stringify(p))
    if (!p) throw new Error('element not found: ' + expr)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const button = (text, scope = 'document') => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.getClientRects().length > 0)`
  const openSession = async (id) => {
    await click(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('Check ${id} session'))`, 500)
  }
  const waitFor = async (code, label, timeout = 8000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
      if (await js(code)) return
      await sleep(100)
    }
    throw new Error('timeout waiting for ' + label)
  }
  const load = async () => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
    await waitFor(`document.querySelectorAll('.meeting-session-row-main').length === ${sessions.length}`, 'session list')
  }
  // Positions of the columns in the first section that has action items, and layout facts.
  const layout = () =>
    js(`(() => { const r = (el) => { if (!el || el.getClientRects().length === 0) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) } }; const tx = document.querySelector('.txc'); const sec = [...document.querySelectorAll('.txc-sec')].find((s) => s.querySelector('.txc-act')) || document.querySelector('.txc-sec'); const scroll = document.querySelector('.txc-scroll'); const panel = document.querySelector('.txc-panel'); const pr = panel && panel.getBoundingClientRect(); const txr = tx.getBoundingClientRect(); return { cls: tx.className, width: Math.round(txr.width), time: r(sec.querySelector('.txc-time')), topic: r(sec.querySelector('.txc-topic')), text: r(sec.querySelector('.txc-text')), actions: r(sec.querySelector('.txc-sec-actions')), panel: !!panel, panelOnScreen: !!panel && pr.left < txr.right - 20, panelToggle: !!document.querySelector('.txc-panel-toggle') && document.querySelector('.txc-panel-toggle').getClientRects().length > 0, hScroll: scroll.scrollWidth > scroll.clientWidth + 1, widths: [scroll.scrollWidth, scroll.clientWidth, scroll.offsetWidth], overflowing: [...scroll.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right - scroll.getBoundingClientRect().left > scroll.clientWidth + 0.5).slice(0, 6).map((e) => e.tagName + '.' + e.className + ':' + Math.round(e.getBoundingClientRect().right - scroll.getBoundingClientRect().left)) } })()`)
  const highlight = () =>
    js(`(() => { const s = document.querySelector('.txc-scroll').getBoundingClientRect(); const hl = [...document.querySelectorAll('.txc-text.txc-hl')]; const b = hl[0] && hl[0].getBoundingClientRect(); return { blocks: hl.map((e) => e.dataset.blockId), inView: !!b && b.top >= s.top + 30 && b.top < s.bottom - 10, active: [...document.querySelectorAll('.txc-act.active')].map((a) => a.querySelector('.txc-act-text').textContent) } })()`)
  const sections = () =>
    js(`[...document.querySelectorAll('.txc-sec')].map((s) => ({ title: (s.querySelector('.txc-topic h3') || {}).textContent || null, range: (s.querySelector('.txc-range') || {}).textContent || null, paragraphs: s.querySelectorAll('.txc-text').length, actions: [...s.querySelectorAll('.txc-sec-actions .txc-act-text')].map((a) => a.textContent), actionCell: !!s.querySelector('.txc-sec-actions') }))`)

  await load()
  const size = await js(`({ w: window.innerWidth, h: window.innerHeight })`)
  check('the app opens its Settings window 1250 px wide', /width:\s*1250/.test(fs.readFileSync(path.join(ROOT, 'out/main/index.js'), 'utf8')), size)

  // ── First open of an older session: the outline is built once ──
  await openSession('old')
  await waitFor(`!!document.querySelector('.txc-status') && document.querySelectorAll('.txc-text').length === 16`, 'building status')
  check('first open: the transcript is readable at once (two columns) while the outline is being built', (await js(`document.querySelector('.txc').className`)).includes('txc--plain') && /Finding topics and action items/.test(await js(`document.querySelector('.txc-status').textContent`)))
  await waitFor(`document.querySelectorAll('.txc-topic').length === 5`, 'outline')
  await sleep(300)
  let secs = await sections()
  check('first open: one AI request, then five topics with their time ranges', calls.old === 1 && secs.length === 5 && secs.every((s) => s.title && /–/.test(s.range)), secs.map((s) => `${s.title} [${s.range}] ${s.paragraphs}p`))
  let l = await layout()
  check('default window: four columns side by side — time, topic, transcript, action items', l.cls.includes('txc--by-topic') && l.time.x < l.topic.x && l.topic.x < l.text.x && l.text.x < l.actions.x && Math.abs(l.topic.y - l.text.y) < 6 && !l.hScroll && l.text.w > 300, l)
  check('by topic (the default): each action item sits in the row of its topic', secs[1].actions.join('|') === 'Gửi số liệu mở bán cho cả nhóm' && secs[2].actions.join('|') === 'Gộp ba bản tài liệu cài đặt' && secs[4].actions.length === 2, secs.map((s) => s.actions.length))
  check('a topic with no action item keeps an empty cell — nothing is made up', secs[0].actions.length === 0 && secs[3].actions.length === 0 && secs[3].actionCell && (await js(`document.querySelectorAll('.txc-sec-actions.empty').length`)) === 2)
  const bold = await js(`(() => { const sec = document.querySelectorAll('.txc-sec')[1]; const t = sec.querySelector('.txc-topic').getBoundingClientRect(); const ps = [...sec.querySelectorAll('.txc-text')]; return { weight: getComputedStyle(sec.querySelector('h3')).fontWeight, top: Math.round(ps[0].getBoundingClientRect().top - t.top), bottom: Math.round(ps[ps.length - 1].getBoundingClientRect().bottom - t.bottom) } })()`)
  check('the topic is bold and spans all paragraphs of its section', Number(bold.weight) >= 700 && Math.abs(bold.top) <= 4 && Math.abs(bold.bottom) <= 4, bold)

  // ── Clicking an action item ──
  await click(`[...document.querySelectorAll('.txc-act')].find((a) => a.textContent.includes('Nhắn lại 22 người'))`, 900)
  let h = await highlight()
  check('by topic: clicking an action highlights its paragraph and brings it into view', h.blocks.join() === 'old-s15' && h.inView && h.active.join() === 'Nhắn lại 22 người chưa chuyển khoản', h)
  await click(`[...document.querySelectorAll('.txc-act')].find((a) => a.textContent.includes('Nhắn lại 22 người'))`, 500)
  h = await highlight()
  check('clicking the same action again clears the highlight', h.blocks.length === 0 && h.active.length === 0)

  // ── The By topic / List switch ──
  await click(button('List', `document.querySelector('.txc')`), 500)
  l = await layout()
  const listed = await js(`[...document.querySelectorAll('.txc-panel .txc-act')].map((a) => a.querySelector('.txc-act-time').textContent + ' ' + a.querySelector('.txc-act-text').textContent)`)
  check('List: all action items together in one column, in time order, no per-topic cells', l.cls.includes('txc--list') && l.panelOnScreen && listed.length === 4 && listed[0].includes('Gửi số liệu') && listed[3].includes('Nhắn lại') && !(await js(`!!document.querySelector('.txc-sec-actions')`)), listed)
  await click(`[...document.querySelectorAll('.txc-panel .txc-act')][1]`, 900)
  h = await highlight()
  check('List: clicking an action highlights its paragraph and brings it into view', h.blocks.join() === 'old-s8' && h.inView, h)
  check('the choice is stored', (await js(`localStorage.getItem('wispra-transcript-actions-view')`)) === 'list')
  await load()
  await openSession('old')
  await waitFor(`document.querySelectorAll('.txc-topic').length === 5`, 'outline after reload')
  check('after closing and reopening, the List choice is remembered and no new AI request is made', (await js(`document.querySelector('.txc').className`)).includes('txc--list') && calls.old === 1, { calls: calls.old })
  await click(button('By topic', `document.querySelector('.txc')`), 500)
  check('By topic switches back', (await js(`document.querySelector('.txc').className`)).includes('txc--by-topic') && (await js(`localStorage.getItem('wispra-transcript-actions-view')`)) === 'topic')
  await openSession('long')
  await openSession('old')
  await sleep(600)
  check('going to another session and back makes no new AI request', calls.old === 1 && (await js(`document.querySelectorAll('.txc-topic').length`)) === 5, { calls: calls.old })

  // ── Speaker names ──
  const speakers = await js(`[...document.querySelectorAll('.txc-time')].map((t) => { const s = t.querySelector('.txc-speaker'); return s ? s.textContent.trim() + (s.classList.contains('txc-speaker-voice') ? '*' : '') : '' })`)
  check('speaker labels: names the recording gives, "You"/"Others" from the audio levels, nothing where unknown', speakers.slice(0, 7).join(',') === 'Sơn,Sơn,Sơn,Linh,You*,Others*,+ name', speakers.slice(0, 7))
  await click(`document.querySelector('.txc-time .txc-speaker')`, 300)
  await js(`(() => { const i = document.querySelector('.txc-speaker-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Anh Sơn'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  await sleep(500)
  const renamed = await js(`[...document.querySelectorAll('.txc-time .txc-speaker')].slice(0, 4).map((s) => s.textContent.trim())`)
  check('renaming a speaker renames every paragraph of that speaker, and is saved on the session', renamed.join(',') === 'Anh Sơn,Anh Sơn,Anh Sơn,Linh' && speakerPatches.length === 1 && Object.keys(speakerPatches[0].names).sort().join() === 'old-s1,old-s2,old-s3' && byId('old').speakerNames['old-s2'] === 'Anh Sơn', speakerPatches[0])

  // ── A long recording ──
  await openSession('long')
  await waitFor(`document.querySelectorAll('.txc-topic').length === 25`, 'long outline')
  l = await layout()
  check('long recording (200 paragraphs, 25 topics, 12 actions): all there, no sideways scroll, no AI request (saved outline)', (await js(`document.querySelectorAll('.txc-text').length`)) === 200 && (await js(`document.querySelectorAll('.txc-act').length`)) === 12 && !l.hScroll && calls.long === undefined, l)
  await click(`[...document.querySelectorAll('.txc-act')].pop()`, 1200)
  h = await highlight()
  check('long recording: the last action jumps to its paragraph near the end', h.blocks.join() === 'long-s181' && h.inView, h)

  // ── Failure: one request, "Try again" makes one more ──
  await openSession('fail')
  await waitFor(`/Could not find topics/.test((document.querySelector('.txc-status') || {}).textContent || '')`, 'failure line')
  await sleep(1500)
  check('failure: the transcript stays readable, an error line with "Try again", and no repeated requests', calls.fail === 1 && (await js(`document.querySelectorAll('.txc-text').length`)) === 6 && !!(await js(`!!${button('Try again', `document.querySelector('.txc')`)}`)), { calls: calls.fail })
  await click(button('Try again', `document.querySelector('.txc')`), 1200)
  check('"Try again" makes exactly one more request', calls.fail === 2, { calls: calls.fail })
  await openSession('empty')
  await sleep(500)
  check('a recording with no speech makes no request', calls.empty === undefined && /No speech was transcribed/.test(await js(`document.querySelector('.txc').textContent`)))

  // ── Narrower windows ──
  win.setSize(1100, 600)
  await openSession('old')
  await waitFor(`document.querySelectorAll('.txc-topic').length === 5`, 'outline at 1100')
  await sleep(400)
  l = await layout()
  secs = await sections()
  check('1100 px window: topics fold into heading rows, by-topic action items sit under their topic, topics without actions show nothing', l.topic.y < l.text.y && l.actions && l.actions.y > l.topic.y && l.actions.y < l.text.y && !l.hScroll && secs[4].actions.length === 2 && (await js(`[...document.querySelectorAll('.txc-sec-actions.empty')].every((e) => e.getClientRects().length === 0)`)), l)
  win.setSize(900, 600)
  await sleep(600)
  l = await layout()
  check('900 px window, by topic: still readable, no sideways scroll, the By topic / List switch is reachable', l.topic.y < l.text.y && !l.hScroll && l.text.w > 300 && !!(await js(`!!${button('List', `document.querySelector('.txc')`)}`)), l)
  await click(`[...document.querySelectorAll('.txc-act')].find((a) => a.textContent.includes('Gộp ba bản'))`, 900)
  h = await highlight()
  check('900 px window: clicking an action still jumps and highlights', h.blocks.join() === 'old-s8' && h.inView, h)
  await click(button('List', `document.querySelector('.txc')`), 500)
  l = await layout()
  check('900 px window, List: the action list is behind an "Action items" button instead of taking a column', l.panel && !l.panelOnScreen && l.panelToggle && !l.hScroll, l)
  await click(`document.querySelector('.txc-panel-toggle')`, 600)
  l = await layout()
  check('the button slides the action list in', l.panelOnScreen)
  await click(`[...document.querySelectorAll('.txc-panel .txc-act')][3]`, 1000)
  l = await layout()
  h = await highlight()
  check('clicking an action there closes the list, jumps and highlights', !l.panelOnScreen && h.blocks.join() === 'old-s15' && h.inView, h)
  await click(`document.querySelector('.txc-panel-toggle')`, 500)
  await click(button('By topic', `document.querySelector('.txc-panel')`), 500)
  win.setSize(1250, 700)
  await sleep(500)

  // ── Dark theme ──
  nativeTheme.themeSource = 'dark'
  await sleep(600)
  const dark = await js(`({ bg: getComputedStyle(document.querySelector('.txc')).backgroundColor, text: getComputedStyle(document.querySelector('.txc-text')).color, topic: getComputedStyle(document.querySelector('.txc-topic h3')).color })`)
  await click(`[...document.querySelectorAll('.txc-act')].find((a) => a.textContent.includes('Viết lại trang'))`, 900)
  h = await highlight()
  check('dark theme: dark panel, light text, and jumping still works', dark.bg === 'rgb(15, 17, 23)' && dark.text === 'rgb(238, 240, 245)' && h.blocks.join() === 'old-s13' && h.inView, dark)
  if (process.env.CHECK_SHOTS) {
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    const shot = async (name) => fs.writeFileSync(path.join(process.env.CHECK_SHOTS, name + '.png'), (await win.webContents.capturePage()).toPNG())
    await shot('dark-1250')
    nativeTheme.themeSource = 'light'
    await sleep(500)
    await shot('light-1250')
    await click(button('List', `document.querySelector('.txc')`), 500)
    await shot('light-1250-list')
    await click(button('By topic', `document.querySelector('.txc')`), 400)
    win.setSize(900, 600)
    await sleep(600)
    await shot('light-900')
    win.setSize(1700, 950)
    await sleep(600)
    await shot('light-1700')
  }
  nativeTheme.themeSource = 'system'
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 240_000)
  try {
    await partA()
    await partB()
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
