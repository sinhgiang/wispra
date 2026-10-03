/*
 * Automated check: AI work starts by itself only for recordings made after this install
 * first ran the version with this rule (Settings.autoAiSince). An older recording opened
 * in any tab makes no AI call at all; its Transcript offers "Create topics and action
 * items" instead, and what it already has is shown as before. A newer recording still
 * gets its topics by itself, as before.
 *
 * Run with `npm run check:auto-ai-new-only` (builds first). It loads the built Settings
 * renderer and the real preload in Electron with stub IPC handlers that count every AI
 * request — no API key, account or network. The app's own main process is not started.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-')))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** This install first ran the new version on 25 September. */
const AUTO_AI_SINCE = '2026-09-25T00:00:00.000Z'

function segments(prefix) {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${prefix}-s${i + 1}`,
    text: `Đoạn ${i + 1}: chúng ta bàn về kết quả mở bán thử và kế hoạch ra mắt khoá học tháng mười một.`,
    startMs: i * 40000,
    endMs: (i + 1) * 40000,
    startedAt: new Date(Date.UTC(2026, 8, 20, 7, 0, i * 40)).toISOString(),
    isNewParagraph: true
  }))
}
const outlineOf = (prefix) => ({
  language: 'vi',
  generatedAt: '2026-09-30T08:00:00.000Z',
  topics: [{ title: 'Kết quả mở bán', startSegmentId: `${prefix}-s1`, endSegmentId: `${prefix}-s6` }],
  actions: [{ text: 'Gửi số liệu cho cả nhóm', startSegmentId: `${prefix}-s2`, endSegmentId: `${prefix}-s2` }],
  speakers: []
})
const session = (id, title, createdAt, extra = {}) => ({ id, title, createdAt, durationMs: 240000, audioSource: 'mic', status: 'stopped', segments: segments(id), ...extra })
const sessions = [
  // Before this install first ran the new version: nothing starts by itself.
  session('old', 'Check old recording', '2026-09-20T12:40:00.000Z', { summary: 'An existing summary.' }),
  // Old, but with topics already made: they are shown as before.
  session('done', 'Check done recording', '2026-09-21T09:00:00.000Z', { summary: 'Another summary.', outline: outlineOf('done') }),
  // After: its topics still start by themselves (e.g. the app was closed right after Stop).
  session('new', 'Check new recording', '2026-09-28T07:05:00.000Z', { summary: 'A new summary.' })
]

/** AI requests, per "session/what". */
const calls = {}
const count = (key) => (calls[key] = (calls[key] ?? 0) + 1)
const total = () => Object.values(calls).reduce((n, c) => n + c, 0)
let autoAiSince = AUTO_AI_SINCE

app.whenReady().then(async () => {
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  let win = null
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [], autoAiSince }))
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments: _s, outline: _o, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => sessions.find((s) => s.id === id) ?? null)
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [])
  handle(IPC.MEETING_GENERATE_OUTLINE, async (_event, id) => {
    const s = sessions.find((x) => x.id === id)
    if (s.outline) return s.outline
    count(`${id}/outline`)
    await sleep(200)
    s.outline = outlineOf(id)
    win.webContents.send(IPC.MEETING_SESSION_UPDATED, s)
    return s.outline
  })
  for (const [channel, what] of [
    [IPC.MEETING_GENERATE_MIND_MAP, 'mindmap'],
    [IPC.MEETING_GENERATE_CONTENT, 'content'],
    [IPC.MEETING_GENERATE_SUMMARY, 'summary'],
    [IPC.MEETING_CHAT_SEND, 'chat']
  ]) {
    handle(channel, (_event, id) => {
      count(`${id}/${what}`)
      return null
    })
  }

  win = new BrowserWindow({
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
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const clickText = (text, scope = 'document') =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getClientRects().length > 0); if (!b) return false; b.click(); return true })()`)
  const openSession = async (id) => {
    await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes(${JSON.stringify(id)})).click()`)
    await sleep(900)
  }
  const tabs = `document.querySelector('.meeting-view-toggle')`
  const transcript = () =>
    js(`({ create: !!${`[...document.querySelectorAll('.txc-create button')].find((b) => b.textContent.trim() === 'Create topics and action items')`}, paragraphs: document.querySelectorAll('.txc-text').length, topics: document.querySelectorAll('.txc-topic').length, status: (document.querySelector('.txc-status') || { innerText: '' }).innerText })`)
  const load = async () => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
    for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === ${sessions.length}`)); i++) await sleep(100)
  }
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 120_000)

  try {
    await load()
    // ── An old recording ──
    await openSession('Check old recording')
    let t = await transcript()
    check('old recording, Transcript tab: no AI call — the transcript is shown and "Create topics and action items" is offered', total() === 0 && t.create && t.paragraphs === 6 && t.topics === 0, { calls, ...t })
    for (const tab of ['Summary', 'Mind map', 'Website', 'Facebook', 'Instagram', 'LinkedIn', 'X', 'Transcript']) {
      await clickText(tab, tabs)
      await sleep(400)
    }
    check('…going through every tab of it still makes no AI call', total() === 0, calls)
    check('…its existing summary is shown as before', await (async () => {
      await clickText('Summary', tabs)
      await sleep(300)
      const text = await js(`document.querySelector('.meeting-summary-view').innerText`)
      await clickText('Transcript', tabs)
      await sleep(300)
      return /An existing summary/.test(text)
    })())
    await load()
    await openSession('Check old recording')
    check('…reopening it later makes no AI call either', total() === 0, calls)
    await clickText('Create topics and action items', `document.querySelector('.txc')`)
    for (let i = 0; i < 30 && (await js(`document.querySelectorAll('.txc-topic').length`)) === 0; i++) await sleep(100)
    t = await transcript()
    check('"Create topics and action items" makes exactly one request, and the columns appear', calls['old/outline'] === 1 && total() === 1 && t.topics === 1 && !t.create, { calls, ...t })

    // ── An old recording that already has topics ──
    await openSession('Check done recording')
    t = await transcript()
    check('old recording that already has topics: shown as before, no button, no call', t.topics === 1 && !t.create && calls['done/outline'] === undefined && total() === 1, { calls, ...t })

    // ── A new recording ──
    await openSession('Check new recording')
    for (let i = 0; i < 30 && (await js(`document.querySelectorAll('.txc-topic').length`)) === 0; i++) await sleep(100)
    t = await transcript()
    check('new recording (made after this install first ran the new version): its topics start by themselves, as before', calls['new/outline'] === 1 && t.topics === 1 && !t.create, { calls, ...t })

    // ── Unknown start date: nothing starts by itself ──
    autoAiSince = ''
    sessions.find((s) => s.id === 'new').outline = undefined
    await load()
    await openSession('Check new recording')
    t = await transcript()
    check('when the start date is not known, nothing starts by itself (the button is offered)', calls['new/outline'] === 1 && t.create, { calls, ...t })
    check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
