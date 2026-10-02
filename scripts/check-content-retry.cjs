/*
 * Automated check: a failing Website / Facebook / Instagram / LinkedIn / X tab asks the
 * main process to generate its content ONCE, shows the error with "Try again", and
 * "Try again" asks exactly once more. (Before the fix a failing tab asked again in a
 * loop for as long as it stayed open — 29 times in 3 seconds.)
 *
 * Run with `npm run check:content-retry` (builds first). It loads the built Settings
 * renderer and the real preload in Electron with stub IPC handlers — every
 * generateMeetingContent() call the renderer makes is one LLM call in the real app, so
 * counting them here needs no API key, account or network. The app's own main process
 * is not started (no hotkey, tray, protocol or login-item registration), and the window
 * and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PLATFORMS = [
  { id: 'website', tab: 'Website' },
  { id: 'facebook', tab: 'Facebook' },
  { id: 'instagram', tab: 'Instagram' },
  { id: 'linkedin', tab: 'LinkedIn' },
  { id: 'twitter', tab: 'X' }
]
/** How long a failing tab is left open before its calls are counted — the old loop made ~10 calls a second. */
const SETTLE_MS = 1500

// Channel names come from the single source of truth, src/shared/ipc.ts.
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-')))
// The window sits off-screen; without this Windows marks it occluded and stops painting it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const session = (id) => ({
  id,
  title: `Check session ${id}`,
  createdAt: '2026-09-28T02:00:00.000Z',
  durationMs: 60_000,
  audioSource: 'mic',
  status: 'stopped',
  segments: [{ id: `${id}-s1`, text: 'We agreed to launch in November.', startMs: 0, endMs: 60_000, startedAt: '2026-09-28T02:00:00.000Z', isNewParagraph: true }]
})
const sessions = [session('one'), session('two')]

/** generateMeetingContent() calls seen, per "sessionId/platform". */
const calls = {}
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
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => sessions.find((s) => s.id === id) ?? null)
  handle(IPC.MEETING_GENERATE_CONTENT, async (_event, id, platform) => {
    calls[`${id}/${platform}`] = (calls[`${id}/${platform}`] ?? 0) + 1
    await sleep(50)
    if (!succeed.has(platform)) return null
    return platform === 'website'
      ? { platform, title: 'Generated title', metaDescription: 'Generated description', body: 'Generated body.' }
      : { platform, posts: ['Generated post 1', 'Generated post 2', 'Generated post 3'] }
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
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
  const openSession = async (id) => {
    await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('session ${id}')).click()`)
    await sleep(400)
  }
  const view = () =>
    js(`(() => { const v = document.querySelector('.meeting-summary-view'); return { text: v ? v.innerText : '', retry: !!(v && [...v.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Try again')) } })()`)

  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 120_000)

  try {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
    for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === 2`)); i++) await sleep(100)
    await openSession('one')

    for (const { id, tab } of PLATFORMS) {
      const key = `one/${id}`
      await clickButton(tab, `document.querySelector('.meeting-view-toggle')`)
      await sleep(SETTLE_MS)
      const failed = await view()
      check(`${tab}: a failing tab calls the generator once`, calls[key] === 1, { calls: calls[key] })
      check(`${tab}: the error is shown with a "Try again" button`, failed.retry && failed.text.includes('Could not generate'), failed)

      await clickButton('Try again', `document.querySelector('.meeting-summary-view')`)
      await sleep(SETTLE_MS)
      check(`${tab}: "Try again" calls exactly once more`, calls[key] === 2, { calls: calls[key] })

      // Leaving the tab and coming back does not retry on its own.
      await clickButton('Transcript', `document.querySelector('.meeting-view-toggle')`)
      await clickButton(tab, `document.querySelector('.meeting-view-toggle')`)
      await sleep(600)
      check(`${tab}: coming back to the failed tab makes no new call`, calls[key] === 2 && (await view()).retry, { calls: calls[key] })

      succeed.add(id)
      await clickButton('Try again', `document.querySelector('.meeting-summary-view')`)
      await sleep(SETTLE_MS)
      const done = await view()
      check(`${tab}: once a retry succeeds the content is shown and nothing more is called`, calls[key] === 3 && done.text.includes('Generated') && !done.retry, { calls: calls[key] })
      succeed.delete(id)
    }

    // A failure belongs to its session: another session starts clean, with one call of its own.
    await openSession('two')
    await clickButton('Facebook', `document.querySelector('.meeting-view-toggle')`)
    await sleep(SETTLE_MS)
    check('another session: its failing tab also calls once', calls['two/facebook'] === 1 && (await view()).retry, { calls: calls['two/facebook'] })
    check('no call was made for a tab that was never opened', calls['two/website'] === undefined)
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }

  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
