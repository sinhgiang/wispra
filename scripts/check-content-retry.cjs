/*
 * Automated check for the Mind map, Website, Facebook, Instagram, LinkedIn and X tabs of a
 * finished meeting:
 *   - opening a tab that has no content yet calls the AI NOT AT ALL — it shows a
 *     "Create …" button, and nothing happens until that button is pressed;
 *   - pressing it asks the main process once; a failure shows the error with "Try again",
 *     which asks exactly once more (before an earlier fix a failing tab asked again in a
 *     loop for as long as it stayed open — 29 times in 3 seconds);
 *   - a tab that already has content shows it, with no "Create" button and no call.
 *
 * Run with `npm run check:content-retry` (builds first). It loads the built Settings
 * renderer and the real preload in Electron with stub IPC handlers — every
 * generateMeetingContent() / generateMeetingMindMap() call the renderer makes is an AI
 * job in the real app, so counting them here needs no API key, account or network. The
 * app's own main process is not started (no hotkey, tray, protocol or login-item
 * registration), and the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PLATFORMS = [
  { id: 'website', tab: 'Website', create: 'Create website content' },
  { id: 'facebook', tab: 'Facebook', create: 'Create Facebook post' },
  { id: 'instagram', tab: 'Instagram', create: 'Create Instagram post' },
  { id: 'linkedin', tab: 'LinkedIn', create: 'Create LinkedIn post' },
  { id: 'twitter', tab: 'X', create: 'Create X post' }
]
/** How long a tab is left open before its calls are counted — the old retry loop made ~10 calls a second. */
const SETTLE_MS = 1500

// Channel names come from the single source of truth, src/shared/ipc.ts.
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-')))
// The window sits off-screen; without this Windows marks it occluded and stops painting it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const session = (id, extra = {}) => ({
  id,
  title: `Check session ${id}`,
  createdAt: '2026-09-28T02:00:00.000Z',
  durationMs: 60_000,
  audioSource: 'mic',
  status: 'stopped',
  segments: [{ id: `${id}-s1`, text: 'We agreed to launch in November.', startMs: 0, endMs: 60_000, startedAt: '2026-09-28T02:00:00.000Z', isNewParagraph: true }],
  ...extra
})
const mindMapOf = (id) => ({
  title: 'November launch',
  note: 'What was agreed.',
  language: 'en',
  generatedAt: '2026-09-28T03:00:00.000Z',
  branches: [{ label: 'Launch in November', kind: 'topic', startSegmentId: `${id}-s1`, endSegmentId: `${id}-s1`, children: [] }]
})
const sessions = [
  session('one'),
  session('two'),
  // Everything already made: opening its tabs must only show it.
  session('done', {
    mindMap: mindMapOf('done'),
    content: {
      website: { title: 'Saved title', metaDescription: 'Saved description', body: 'Saved body.' },
      facebook: ['Saved post 1', 'Saved post 2', 'Saved post 3'],
      instagram: ['Saved post 1', 'Saved post 2', 'Saved post 3'],
      linkedin: ['Saved post 1', 'Saved post 2', 'Saved post 3'],
      twitter: ['Saved post 1', 'Saved post 2', 'Saved post 3']
    }
  })
]

/** Generator calls seen, per "sessionId/platform" ("sessionId/mindmap" for the mind map). */
const calls = {}
const total = () => Object.values(calls).reduce((n, c) => n + c, 0)
/** Platforms whose next call succeeds. */
const succeed = new Set()

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [] }))
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments, mindMap, content, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => sessions.find((s) => s.id === id) ?? null)
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [])
  handle(IPC.MEETING_GENERATE_CONTENT, async (_event, id, platform) => {
    calls[`${id}/${platform}`] = (calls[`${id}/${platform}`] ?? 0) + 1
    await sleep(50)
    if (!succeed.has(platform)) return null
    return platform === 'website'
      ? { platform, title: 'Generated title', metaDescription: 'Generated description', body: 'Generated body.' }
      : { platform, posts: ['Generated post 1', 'Generated post 2', 'Generated post 3'] }
  })
  handle(IPC.MEETING_GENERATE_MIND_MAP, async (_event, id) => {
    const s = sessions.find((x) => x.id === id)
    if (s.mindMap) return s.mindMap
    calls[`${id}/mindmap`] = (calls[`${id}/mindmap`] ?? 0) + 1
    await sleep(50)
    if (!succeed.has('mindmap')) return null
    s.mindMap = mindMapOf(id)
    return s.mindMap
  })

  const win = new BrowserWindow({
    width: 900,
    height: 600,
    x: -4000,
    y: -4000,
    show: false,
    skipTaskbar: true,
    webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const clickButton = (text, scope = 'document') =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getClientRects().length > 0); if (!b) return false; b.click(); return true })()`)
  const openSession = async (id) => {
    await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('session ${id}')).click()`)
    await sleep(400)
  }
  const openTab = (tab) => clickButton(tab, `document.querySelector('.meeting-view-toggle')`)
  const CONTENT = `document.querySelector('.meeting-summary-view')`
  const MAP = `document.querySelector('.mm-panel')`
  /** What the visible content tab (or mind map panel) shows: its text and its buttons. */
  const view = (scope = CONTENT) =>
    js(`(() => { const v = ${scope}; return { text: v ? v.innerText.replace(/\\s+/g, ' ').trim() : '', buttons: v ? [...v.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0).map((b) => b.textContent.trim()) : [] } })()`)

  // CHECK_SHOTS=<folder> saves screenshots of the empty tabs, to look at by eye.
  const shot = async (name) => {
    if (!process.env.CHECK_SHOTS) return
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    fs.writeFileSync(path.join(process.env.CHECK_SHOTS, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }

  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 180_000)

  try {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
    for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === ${sessions.length}`)); i++) await sleep(100)

    // ── Only opening the tabs ──
    await openSession('one')
    for (const { tab, create } of PLATFORMS) {
      await openTab(tab)
      await sleep(SETTLE_MS)
      const v = await view()
      await shot(`empty-${tab}`)
      check(`${tab}: opening the tab calls the AI not at all and shows "${create}"`, total() === 0 && v.buttons.join() === create && !/Writing/.test(v.text), { calls: total(), buttons: v.buttons })
    }
    await openTab('Mind map')
    await sleep(SETTLE_MS)
    let m = await view(MAP)
    await shot('empty-mind-map')
    check('Mind map: opening the tab calls the AI not at all and shows "Create mind map"', total() === 0 && m.buttons.includes('Create mind map') && !/Building the mind map/.test(m.text), { calls: total(), buttons: m.buttons })
    for (const tab of ['Summary', 'Transcript', 'Website', 'Mind map', 'X', 'Transcript']) {
      await openTab(tab)
      await sleep(200)
    }
    await openSession('two')
    await openSession('one')
    await sleep(SETTLE_MS)
    check('going through every tab, and to another session and back, still calls nothing', total() === 0, calls)

    // ── Pressing "Create", failure, "Try again", success ──
    for (const { id, tab, create } of PLATFORMS) {
      const key = `one/${id}`
      await openTab(tab)
      await clickButton(create, CONTENT)
      await sleep(SETTLE_MS)
      const failed = await view()
      check(`${tab}: "${create}" calls the generator once`, calls[key] === 1, { calls: calls[key] })
      check(`${tab}: a failure is shown with "Try again" (and no "Create" button)`, failed.buttons.join() === 'Try again' && failed.text.includes('Could not generate'), failed)

      await clickButton('Try again', CONTENT)
      await sleep(SETTLE_MS)
      check(`${tab}: "Try again" calls exactly once more`, calls[key] === 2, { calls: calls[key] })

      // Leaving the tab and coming back does not retry on its own.
      await openTab('Transcript')
      await openTab(tab)
      await sleep(600)
      check(`${tab}: coming back to the failed tab makes no new call`, calls[key] === 2 && (await view()).buttons.join() === 'Try again', { calls: calls[key] })

      succeed.add(id)
      await clickButton('Try again', CONTENT)
      await sleep(SETTLE_MS)
      const done = await view()
      check(`${tab}: once it succeeds the content is shown, with no "Create" button, and nothing more is called`, calls[key] === 3 && done.text.includes('Generated') && !done.buttons.some((b) => b.startsWith('Create')), { calls: calls[key], buttons: done.buttons })
      await openTab('Transcript')
      await openTab(tab)
      await sleep(600)
      check(`${tab}: coming back shows the content without calling`, calls[key] === 3 && (await view()).text.includes('Generated'))
      succeed.delete(id)
    }

    // ── The mind map ──
    await openTab('Mind map')
    await clickButton('Create mind map', MAP)
    await sleep(SETTLE_MS)
    m = await view(MAP)
    check('Mind map: "Create mind map" asks once; a failure offers "Try again"', calls['one/mindmap'] === 1 && m.buttons.includes('Try again') && !m.buttons.includes('Create mind map'), { calls: calls['one/mindmap'], buttons: m.buttons })
    succeed.add('mindmap')
    await clickButton('Try again', MAP)
    for (let i = 0; i < 40 && (await js(`!!document.querySelector('.mm-overlay')`)); i++) await sleep(100)
    m = await view(MAP)
    check('Mind map: "Try again" asks once more and the map is shown, with no "Create" button', calls['one/mindmap'] === 2 && (await js(`document.querySelectorAll('.mm-panel svg g').length > 0`)) && !m.buttons.includes('Create mind map'), { calls: calls['one/mindmap'] })

    // ── Content that already exists ──
    const before = total()
    await openSession('done')
    for (const { tab } of PLATFORMS) {
      await openTab(tab)
      await sleep(300)
      const v = await view()
      check(`${tab}, already made: shown as before, no "Create" button, no call`, v.text.includes('Saved') && !v.buttons.some((b) => b.startsWith('Create')) && total() === before, { buttons: v.buttons })
    }
    await openTab('Mind map')
    await sleep(600)
    check('Mind map, already made: the map is shown, no "Create" button, no call', (await js(`document.querySelectorAll('.mm-panel svg g').length > 0 && !document.querySelector('.mm-overlay')`)) && total() === before)

    // A failure belongs to its session: another session starts clean.
    await openSession('two')
    await openTab('Facebook')
    await sleep(600)
    check('another session: its tab shows "Create" again, not the other session\'s error', (await view()).buttons.join() === 'Create Facebook post' && calls['two/facebook'] === undefined)
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }

  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
