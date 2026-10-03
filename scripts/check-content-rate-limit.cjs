/*
 * Automated check: a Website / social post request that hits the AI provider's per-minute
 * limit (HTTP 429) waits as long as the provider asks and tries again, the tab says it is
 * waiting for that limit, and a limit that never clears is reported as what it is — not
 * as a connection or API-key problem.
 *
 * Run with `npm run check:content-rate-limit` (builds first). Two parts, no real key,
 * account or network — the key and session token below are placeholders:
 *
 *   A. generateMeetingContent (bundled from src/ on the fly) with `fetch` replaced by a
 *      stub that answers 429 the way Groq does directly (retry-after header) and through
 *      Wispra Cloud (Groq's message passed on, no header).
 *   B. The built Settings renderer with the real preload and stub IPC handlers playing
 *      the main process: a request that waits, then succeeds; one that gives up.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)
app.setPath('userData', path.join(TMP, 'userdata'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const OWN_KEY = 'placeholder-own-groq-key'
const SESSION = 'placeholder-session-token'
const WAITING = "Waiting for the AI provider's per-minute limit, then trying again…"

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Part A: the request itself ───────────────────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'content-lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export { generateMeetingContent, rateLimitWaitMs } from './src/main/postprocess'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    external: ['electron'],
    outfile,
    logLevel: 'silent'
  })
  const { generateMeetingContent, rateLimitWaitMs } = require(outfile)

  let answers = []
  let calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push({ at: Date.now(), host: new URL(String(url)).host })
    const next = answers.length > 1 ? answers.shift() : answers[0]
    return next()
  }
  const ok = () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Launch in November', metaDescription: 'What was agreed.', body: 'We agreed to launch in November.', posts: ['One', 'Two', 'Three'] }) } }] }), { status: 200 })
  const direct429 = (seconds) => () =>
    new Response(JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 4200.', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': String(seconds) } })
  // What the Wispra Cloud proxy sends on: Groq's status and body text, without its headers.
  const cloud429 = (seconds) => () =>
    new Response(JSON.stringify({ error: JSON.stringify({ error: { message: `Rate limit reached for model on tokens per minute (TPM): Limit 8000. Please try again in ${seconds}s. Visit https://console.groq.com/docs/rate-limits for more information.`, type: 'tokens', code: 'rate_limit_exceeded' } }) }), { status: 429 })
  const quiet = console.error
  console.error = () => {}
  const run = async (provider, hooksExtra = {}) => {
    calls = []
    const waits = []
    let rateLimited = 0
    const t0 = Date.now()
    const result = await generateMeetingContent(
      'website', 'We agreed to launch in November.', provider, OWN_KEY, '', undefined, undefined, provider === 'proxy' ? SESSION : undefined, undefined,
      { onWait: (until) => waits.push(until - Date.now()), onRateLimited: () => rateLimited++, ...hooksExtra }
    )
    return { result, waits, rateLimited, ms: Date.now() - t0 }
  }

  try {
    answers = [direct429(0.4), ok]
    let r = await run('groq')
    check('own Groq key: the first request gets HTTP 429, the app waits as told, tries again and the post is created', r.result && r.result.title === 'Launch in November' && calls.length === 2 && r.waits.length === 1 && r.ms >= 380 && calls[1].at - calls[0].at >= 380 && r.rateLimited === 0, { calls: calls.length, waitedMs: calls[1] && calls[1].at - calls[0].at })

    answers = [cloud429(0.3), ok]
    r = await run('proxy')
    check('Wispra Cloud: same, with the wait taken from Groq\'s message the server passes on', r.result && calls.length === 2 && calls.every((c) => c.host === 'wispra-web.vercel.app') && calls[1].at - calls[0].at >= 280, { calls: calls.length, waitedMs: calls[1] && calls[1].at - calls[0].at })

    answers = [direct429(0.2)]
    r = await run('groq', { budgetMs: 700 })
    check('the limit never clears: after waiting its budget the request gives up and says it was the per-minute limit', r.result === null && r.rateLimited === 1 && calls.length === 4 && r.waits.length === 3, { calls: calls.length, waits: r.waits.length, rateLimited: r.rateLimited })

    answers = [() => new Response('{"error":{"message":"Internal error"}}', { status: 500 })]
    r = await run('groq')
    check('any other failure is not retried and not reported as a rate limit', r.result === null && calls.length === 1 && r.rateLimited === 0 && r.waits.length === 0)

    check(
      'how long to wait: retry-after header, else "try again in …" in the message, capped, else 5 s',
      rateLimitWaitMs('12', '') === 12000 &&
        rateLimitWaitMs(null, 'Please try again in 7.5s.') === 7500 &&
        rateLimitWaitMs(null, 'Please try again in 1m2.5s.') === 62500 &&
        rateLimitWaitMs('600', '') === 75000 &&
        rateLimitWaitMs(null, 'busy') === 5000,
      [rateLimitWaitMs('12', ''), rateLimitWaitMs(null, 'Please try again in 7.5s.'), rateLimitWaitMs(null, 'Please try again in 1m2.5s.'), rateLimitWaitMs('600', ''), rateLimitWaitMs(null, 'busy')]
    )
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the tab shows ───────────────────────────────────────────────
async function partB() {
  const session = (id) => ({
    id,
    title: `Check session ${id}`,
    createdAt: '2026-10-02T02:00:00.000Z',
    durationMs: 60_000,
    audioSource: 'mic',
    status: 'stopped',
    segments: [{ id: `${id}-s1`, text: 'We agreed to launch in November.', startMs: 0, endMs: 60_000, startedAt: '2026-10-02T02:00:00.000Z', isNewParagraph: true }]
  })
  const sessions = [session('one')]
  let behaviour = 'wait-then-ok'
  const calls = []
  let win = null

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
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [])
  // Plays generateSessionContent: the statuses it broadcasts, then its answer.
  handle(IPC.MEETING_GENERATE_CONTENT, async (_event, id, platform) => {
    calls.push(`${id}/${platform}`)
    win.webContents.send(IPC.MEETING_CONTENT_STATUS, { sessionId: id, platform, waitingUntil: Date.now() + 1500 })
    await sleep(1500)
    if (behaviour === 'wait-then-ok') {
      return platform === 'website'
        ? { platform, title: 'Launch in November', metaDescription: 'What was agreed.', body: 'We agreed to launch in November.' }
        : { platform, posts: ['Post one', 'Post two', 'Post three'] }
    }
    win.webContents.send(IPC.MEETING_CONTENT_STATUS, { sessionId: id, platform, rateLimited: true })
    return null
  })

  win = new BrowserWindow({
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
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const clickButton = (text, scope) =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getClientRects().length > 0); if (!b) return false; b.click(); return true })()`)
  const TABS = `document.querySelector('.meeting-view-toggle')`
  const VIEW = `document.querySelector('.meeting-summary-view')`
  const text = () => js(`(${VIEW} || { innerText: '' }).innerText.replace(/\\s+/g, ' ').trim()`)

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
  for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === 1`)); i++) await sleep(100)
  await js(`document.querySelector('.meeting-session-row-main').click()`)
  await sleep(500)

  await clickButton('Website', TABS)
  await clickButton('Create website content', VIEW)
  await sleep(500)
  let t = await text()
  check('while the request waits, the Website tab says it is waiting for the per-minute limit', t === WAITING, t)
  await sleep(1500)
  t = await text()
  check('…and the post is shown once the retry succeeds', /Launch in November/.test(t) && calls.length === 1, t.slice(0, 120))

  behaviour = 'give-up'
  await clickButton('Facebook', TABS)
  await clickButton('Create Facebook post', VIEW)
  await sleep(500)
  t = await text()
  check('Facebook tab while waiting: the same message', t === WAITING, t)
  await sleep(1600)
  t = await text()
  check('the limit never cleared: the tab says it was the per-minute limit — nothing about the connection or the key — and offers "Try again"', /per-minute limit was still reached/.test(t) && !/connection|API key/i.test(t) && /Try again/.test(t), t)
  await clickButton('Try again', VIEW)
  await sleep(500)
  check('"Try again" asks once more and shows the waiting message again', calls.length === 3 && (await text()) === WAITING, { calls: calls.length })
  await sleep(1600)
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 120_000)
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
