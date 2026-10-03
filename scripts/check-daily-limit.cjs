/*
 * Automated check: the AI provider's DAILY limit (Groq "tokens per day (TPD)" / "requests
 * per day (RPD)") is told apart from its per-minute limit. A daily limit is not waited
 * out — it can take hours — and the Mind map, Transcript and Website / social tabs say
 * "daily limit" with the numbers used / allowed and when it resets. A per-minute limit is
 * still waited out and the request sent again.
 *
 * Run with `npm run check:daily-limit` (builds first). Two parts, no real key, account or
 * network — the provider below is a stub answering the way Groq does directly (message
 * and retry-after header) and through Wispra Cloud (Groq's message inside the server's
 * own "error", no headers):
 *
 *   A. The main-process code (bundled from src/ on the fly) with `fetch` replaced.
 *   B. The built Settings renderer with the real preload and stub IPC handlers.
 *
 * Covers the Mind map, the Transcript outline, the Website / social posts and the Summary.
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

/** The message the owner got (organisation id replaced). */
const TPD_MESSAGE =
  'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_placeholder` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 198051, Requested 4320. Please try again in 18m12.288s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing'
const TPM_MESSAGE = 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_placeholder` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7600, Requested 4300. Please try again in 0.3s.'
const RPD_MESSAGE = 'Rate limit reached for model `openai/gpt-oss-120b` on requests per day (RPD): Limit 1000, Used 1000, Requested 1. Please try again in 2h3m4s.'

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeSegments(prefix, count, chars) {
  return Array.from({ length: count }, (_, i) => {
    let text = `Đoạn ${i + 1}:`
    while (text.length < chars) text += ' chúng ta bàn về kết quả mở bán thử và kế hoạch ra mắt khoá học tháng mười một.'
    return { id: `${prefix}-s${i + 1}`, text, startMs: i * 58000, endMs: (i + 1) * 58000, startedAt: new Date(Date.UTC(2026, 9, 3, 7, 0, 0) + i * 58000).toISOString(), isNewParagraph: true }
  })
}

// ── Part A ───────────────────────────────────────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'daily-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { parseRateLimit } from './src/main/rateLimit'
        export { createMindMapJobs } from './src/main/mindMapJobs'
        export { generateOutline } from './src/main/outline'
        export { generateMeetingContent, generateMeetingTitle } from './src/main/postprocess'
        export { LANGUAGES, WISPRA_API_BASE } from './src/shared/constants'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    external: ['electron'],
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)
  const direct = { apiKey: 'placeholder-own-groq-key', base: 'https://api.groq.com/openai/v1', model: 'm' }
  const cloud = { apiKey: 'placeholder-session-token', base: `${lib.WISPRA_API_BASE}/api`, model: 'm' }

  // ── Reading the answer ──
  const groqBody = (message) => JSON.stringify({ error: { message, type: 'tokens', code: 'rate_limit_exceeded' } })
  const proxyBody = (message) => JSON.stringify({ error: groqBody(message) })
  let r = lib.parseRateLimit(null, groqBody(TPD_MESSAGE))
  check('Groq "tokens per day (TPD)" is read as a daily limit, with used / allowed and the wait', r.scope === 'day' && r.unit === 'tokens' && r.used === 198051 && r.limit === 200000 && r.retryAfterMs === 1092288, r)
  r = lib.parseRateLimit('1093', groqBody(TPD_MESSAGE))
  check('…the retry-after header gives the wait when there is one', r.scope === 'day' && r.retryAfterMs === 1093000, r)
  r = lib.parseRateLimit(null, proxyBody(TPD_MESSAGE))
  check('…and through Wispra Cloud (Groq\'s message inside the server\'s error, no headers) it reads the same', r.scope === 'day' && r.used === 198051 && r.limit === 200000 && r.retryAfterMs === 1092288, r)
  r = lib.parseRateLimit(null, groqBody(RPD_MESSAGE))
  check('"requests per day (RPD)" is a daily limit too, counted in requests', r.scope === 'day' && r.unit === 'requests' && r.retryAfterMs === (2 * 3600 + 3 * 60 + 4) * 1000, r)
  r = lib.parseRateLimit(null, groqBody(TPM_MESSAGE))
  check('"tokens per minute (TPM)" stays a per-minute limit', r.scope === 'minute' && r.retryAfterMs === 300, r)
  check('a message that does not say: a long wait means a daily limit, a short one a per-minute one', lib.parseRateLimit('900', '{}').scope === 'day' && lib.parseRateLimit('20', '{}').scope === 'minute')

  // ── The fake provider ──
  let calls = []
  let answer = () => null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const user = body.messages[1].content
    const part = /This is part (\d+) of/.exec(user)
    const call = { host: new URL(String(url)).host, part: part ? Number(part[1]) : 0, system: body.messages[0].content, at: Date.now() }
    calls.push(call)
    const special = answer(call, calls.length)
    if (special) return special
    const refs = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    let content
    if (call.system.startsWith('You are assembling')) content = { title: 'Demo Day', branches: [{ label: 'Tất cả', topics: [...user.matchAll(/^T(\d+)/gm)].map((m) => Number(m[1])) }], decisions: [], actions: [], questions: [] }
    else if (call.system.startsWith('You organise') || call.system.startsWith('You are organising')) content = { topics: [{ title: 'Kết quả mở bán', start: refs[0] }], actions: [], speakers: [] }
    else if (call.system.startsWith('You are tidying')) content = { topics: [], actions: [] }
    else if (refs.length) content = { title: 'Demo Day', topics: [{ label: `Chủ đề ${refs[0]}`, note: 'Ghi chú.', start: refs[0], end: refs[refs.length - 1], points: [] }], decisions: [], actions: [], questions: [] }
    else content = { title: 'A title', metaDescription: 'A description.', body: 'Body.', posts: ['One', 'Two', 'Three'] }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 })
  }
  const daily429 = (viaCloud) => () =>
    viaCloud ? new Response(proxyBody(TPD_MESSAGE), { status: 429 }) : new Response(groqBody(TPD_MESSAGE), { status: 429, headers: { 'retry-after': '1093' } })
  const minute429 = () => new Response(groqBody(TPM_MESSAGE), { status: 429, headers: { 'retry-after': '0.3' } })
  const quiet = console.error
  console.error = () => {}

  try {
    // ── Mind map job ──
    const longSegments = makeSegments('long', 152, 555)
    const makeJobs = (dir, target) => {
      const session = { id: 'long', title: 'Demo Day', createdAt: '2026-10-03T07:00:00.000Z', durationMs: 152 * 58000, audioSource: 'both', status: 'stopped', segments: longSegments, languageConfig: { website: 'vi' } }
      const statuses = []
      const jobs = lib.createMindMapJobs({
        dir,
        getSession: (id) => (id === 'long' ? session : undefined),
        resolveTarget: async () => target,
        saveMindMap: (_id, map) => (session.mindMap = map),
        notify: (s) => statuses.push({ ...s }),
        languages: lib.LANGUAGES.map((l) => l.code)
      })
      return { jobs, statuses, session }
    }
    calls = []
    answer = (call) => (call.part === 3 ? daily429(false)() : null)
    let dir = path.join(TMP, 'jobs-daily')
    let { jobs, statuses } = makeJobs(dir, direct)
    let t0 = Date.now()
    let map = await jobs.start('long')
    let stopped = statuses[statuses.length - 1]
    check('mind map, own key: a daily limit stops the job at once — no waiting it out — with the reason "daily-limit"', map === null && stopped.state === 'stopped' && stopped.reason === 'daily-limit' && Date.now() - t0 < 3000 && calls.filter((c) => c.part === 3).length === 1, { reason: stopped.reason, ms: Date.now() - t0, part3Calls: calls.filter((c) => c.part === 3).length })
    check('…the status carries the numbers and the reset time (about 18 min from now), and that it was the own key', stopped.dailyLimit && stopped.dailyLimit.used === 198051 && stopped.dailyLimit.limit === 200000 && stopped.dailyLimit.unit === 'tokens' && Math.abs(stopped.dailyLimit.resetAt - (Date.now() + 1093000)) < 5000 && stopped.dailyLimit.viaCloud === false, stopped.dailyLimit)
    check('…the finished parts are kept for Continue', stopped.done >= 2 && JSON.parse(fs.readFileSync(path.join(dir, 'long.json'), 'utf8')).parts.filter(Boolean).length === stopped.done, { done: stopped.done })
    const next = makeJobs(dir, direct)
    next.jobs.restore()
    const restored = next.jobs.statuses()[0]
    check('…and after a restart the job still says it was the daily limit, with the numbers', restored && restored.reason === 'daily-limit' && restored.dailyLimit && restored.dailyLimit.used === 198051, restored && { reason: restored.reason, used: restored.dailyLimit && restored.dailyLimit.used })

    calls = []
    answer = (call) => (call.part === 3 ? daily429(true)() : null)
    ;({ jobs, statuses } = makeJobs(path.join(TMP, 'jobs-daily-cloud'), cloud))
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    check('mind map through Wispra Cloud: same, and marked as Wispra Cloud\'s limit', map === null && stopped.reason === 'daily-limit' && stopped.dailyLimit && stopped.dailyLimit.viaCloud === true && stopped.dailyLimit.used === 198051, stopped.dailyLimit)

    calls = []
    let seen = 0
    answer = (call) => (call.part === 3 && seen++ === 0 ? minute429() : null)
    ;({ jobs, statuses } = makeJobs(path.join(TMP, 'jobs-minute'), direct))
    map = await jobs.start('long')
    const part3 = calls.filter((c) => c.part === 3)
    check('mind map, per-minute limit: still waited out and the part sent again — the map is built', !!map && part3.length === 2 && part3[1].at - part3[0].at >= 280 && statuses.some((s) => s.waitingUntil), { part3Calls: part3.length, waitedMs: part3[1] && part3[1].at - part3[0].at })

    // ── Transcript outline ──
    const short = makeSegments('short', 10, 300)
    calls = []
    answer = () => daily429(false)()
    let daily = []
    t0 = Date.now()
    let outline = await lib.generateOutline(short, direct, 'vi', undefined, (info) => daily.push(info))
    check('Transcript outline: a daily limit ends it at once and reports the numbers', outline === null && calls.length === 1 && Date.now() - t0 < 2000 && daily.length === 1 && daily[0].used === 198051 && daily[0].limit === 200000, { calls: calls.length, reported: daily.length })
    calls = []
    seen = 0
    answer = () => (seen++ === 0 ? minute429() : null)
    daily = []
    outline = await lib.generateOutline(short, direct, 'vi', undefined, (info) => daily.push(info))
    check('Transcript outline, per-minute limit: waited out and asked again', outline !== null && calls.length === 2 && calls[1].at - calls[0].at >= 280 && daily.length === 0, { calls: calls.length })

    // ── Website / social posts ──
    calls = []
    answer = () => daily429(true)()
    daily = []
    let rateLimited = 0
    let waits = 0
    let post = await lib.generateMeetingContent('website', 'We agreed to launch in November.', 'proxy', '', '', undefined, undefined, 'placeholder-session-token', undefined, {
      onDailyLimit: (info) => daily.push(info),
      onRateLimited: () => rateLimited++,
      onWait: () => waits++
    })
    check('posts through Wispra Cloud: a daily limit is not waited out and is reported with its numbers', post === null && calls.length === 1 && waits === 0 && rateLimited === 0 && daily.length === 1 && daily[0].viaCloud === true && daily[0].used === 198051, { calls: calls.length, waits })
    calls = []
    seen = 0
    answer = () => (seen++ === 0 ? minute429() : null)
    daily = []
    post = await lib.generateMeetingContent('facebook', 'We agreed to launch in November.', 'groq', 'placeholder-own-groq-key', '', undefined, undefined, undefined, undefined, {
      onDailyLimit: (info) => daily.push(info),
      onWait: () => waits++
    })
    check('posts, per-minute limit: still waited out and created', post && post.posts.length === 3 && calls.length === 2 && daily.length === 0, { calls: calls.length })

    // ── Summary ──
    const transcript = 'We agreed to launch in November. Linh rewrites the sign-up page by Friday.'
    calls = []
    answer = () => daily429(false)()
    daily = []
    waits = 0
    let summary = await lib.generateMeetingTitle(transcript, 'groq', 'placeholder-own-groq-key', '', undefined, undefined, undefined, undefined, {
      onDailyLimit: (info) => daily.push(info),
      onWait: () => waits++
    })
    check('Summary: a daily limit is not waited out and is reported with its numbers', summary === null && calls.length === 1 && waits === 0 && daily.length === 1 && daily[0].used === 198051 && daily[0].limit === 200000 && daily[0].viaCloud === false, { calls: calls.length, waits })
    calls = []
    answer = () => daily429(true)()
    daily = []
    summary = await lib.generateMeetingTitle(transcript, 'proxy', '', '', undefined, undefined, 'placeholder-session-token', undefined, { onDailyLimit: (info) => daily.push(info) })
    check('Summary through Wispra Cloud: the same, marked as the Wispra Cloud limit', summary === null && calls.length === 1 && daily.length === 1 && daily[0].viaCloud === true && calls[0].host === new URL(lib.WISPRA_API_BASE).host, { calls: calls.length })
    calls = []
    seen = 0
    answer = () => (seen++ === 0 ? minute429() : null)
    daily = []
    waits = 0
    summary = await lib.generateMeetingTitle(transcript, 'groq', 'placeholder-own-groq-key', '', undefined, undefined, undefined, undefined, {
      onDailyLimit: (info) => daily.push(info),
      onWait: () => waits++
    })
    check('Summary, per-minute limit: waited out, asked again, and the summary is made', summary && summary.title && calls.length === 2 && calls[1].at - calls[0].at >= 280 && waits === 1 && daily.length === 0, { calls: calls.length, waitedMs: calls[1] && calls[1].at - calls[0].at })
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the tabs say ────────────────────────────────────────────────
async function partB() {
  const session = (id, extra = {}) => ({
    id,
    title: `Check session ${id}`,
    createdAt: '2026-10-03T07:00:00.000Z',
    durationMs: 10 * 58000,
    audioSource: 'mic',
    status: 'stopped',
    segments: makeSegments(id, 10, 200),
    ...extra
  })
  const sessions = [session('one'), session('cloud')]
  const resetAt = () => Date.now() + 18 * 60_000 + 20_000
  const daily = (viaCloud) => ({ unit: 'tokens', used: 198051, limit: 200000, resetAt: resetAt(), viaCloud })
  const jobs = new Map([
    ['one', { sessionId: 'one', state: 'stopped', reason: 'daily-limit', detail: TPD_MESSAGE.slice(0, 200), dailyLimit: daily(false), phase: 'outline', done: 2, total: 8, startedAt: new Date().toISOString() }],
    ['cloud', { sessionId: 'cloud', state: 'stopped', reason: 'daily-limit', dailyLimit: daily(true), phase: 'outline', done: 2, total: 8, startedAt: new Date().toISOString() }]
  ])
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
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [...jobs.values()])
  // The Transcript outline and the posts: the daily-limit status first, then the failure.
  handle(IPC.MEETING_GENERATE_OUTLINE, async (_event, id) => {
    win.webContents.send(IPC.MEETING_OUTLINE_PROGRESS, { sessionId: id, phase: 'outline', done: 0, total: 0, dailyLimit: daily(id === 'cloud') })
    await sleep(50)
    return null
  })
  // The Summary: one made right after Stop already hit the daily limit; Try again waits (per minute), then hits it again.
  handle(IPC.MEETING_GET_SUMMARY_STATUS, (_event, id) => (id === 'one' ? { sessionId: id, dailyLimit: daily(false) } : null))
  let summaryCalls = 0
  handle(IPC.MEETING_GENERATE_SUMMARY, async (_event, id) => {
    summaryCalls++
    win.webContents.send(IPC.MEETING_SUMMARY_STATUS, { sessionId: id, waitingUntil: Date.now() + 1200 })
    await sleep(1200)
    win.webContents.send(IPC.MEETING_SUMMARY_STATUS, { sessionId: id, dailyLimit: daily(id === 'cloud') })
    return false
  })
  handle(IPC.MEETING_GENERATE_CONTENT, async (_event, id, platform) => {
    win.webContents.send(IPC.MEETING_CONTENT_STATUS, { sessionId: id, platform, dailyLimit: daily(id === 'cloud') })
    await sleep(50)
    return null
  })

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
  const clickButton = (text, scope) =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getClientRects().length > 0); if (!b) return false; b.click(); return true })()`)
  const TABS = `document.querySelector('.meeting-view-toggle')`
  const openSession = async (id) => {
    await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('session ${id}')).click()`)
    await sleep(600)
  }
  const textOf = (sel) => js(`((document.querySelector(${JSON.stringify(sel)}) || { innerText: '' }).innerText || '').replace(/\\s+/g, ' ').trim()`)

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
  for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === ${sessions.length}`)); i++) await sleep(100)

  // Transcript tab (the outline is asked for on first open of an older recording).
  await openSession('one')
  await sleep(500)
  let t = await textOf('.txc-status')
  check('Transcript tab: "daily limit", 198,051 of 200,000 tokens, resets in about 18 min, Try again — no per-minute or connection wording', /daily limit is reached/.test(t) && /198,051 of 200,000 tokens used today/.test(t) && /resets in about 18 min/.test(t) && /Use Wispra Cloud/.test(t) && /Try again/.test(t) && !/per-minute|connection/i.test(t), t)

  // Mind map tab.
  await clickButton('Mind map', TABS)
  await sleep(500)
  t = await textOf('.mm-overlay')
  check('Mind map tab: "daily limit" with the numbers, the reset time, the parts kept, Continue or Wispra Cloud', /daily limit/.test(t) && /198,051 of 200,000 tokens used today/.test(t) && /resets in about 18 min \(at /.test(t) && /2 of 8 parts are done and kept/.test(t) && /press Continue — or choose "Use Wispra Cloud"/.test(t) && !/per-minute/.test(t), t)

  // Website tab.
  await clickButton('Website', TABS)
  await clickButton('Create website content', `document.querySelector('.meeting-summary-view')`)
  await sleep(500)
  t = await textOf('.meeting-summary-view')
  check('Website tab: the same daily-limit message with Try again — not "per-minute", not "connection/API key"', /daily limit is reached/.test(t) && /198,051 of 200,000 tokens used today/.test(t) && /resets in about 18 min/.test(t) && /Try again/.test(t) && !/per-minute|connection/i.test(t), t)

  // Summary tab.
  await clickButton('Summary', TABS)
  await sleep(400)
  t = await textOf('.meeting-summary-view')
  check('Summary tab: a summary that hit the daily limit after Stop says so — numbers, reset time, Try again — not "No summary available"', /daily limit is reached/.test(t) && /198,051 of 200,000 tokens used today/.test(t) && /resets in about 18 min/.test(t) && /Try again/.test(t) && !/No summary available|per-minute|connection/i.test(t), t)
  await clickButton('Try again', `document.querySelector('.meeting-summary-view')`)
  await sleep(400)
  t = await textOf('.meeting-summary-view')
  check('Summary tab, Try again: while the request waits for the per-minute limit it says so', summaryCalls === 1 && /Waiting for the AI provider's per-minute limit/.test(t), t)
  await sleep(1400)
  t = await textOf('.meeting-summary-view')
  check('…and when it then stops at the daily limit, the daily-limit message is back with Try again', /daily limit is reached/.test(t) && /Try again/.test(t) && !/Waiting/.test(t), t)

  // Through Wispra Cloud: no advice to switch to Wispra Cloud.
  await openSession('cloud')
  await clickButton('Mind map', TABS)
  await sleep(500)
  t = await textOf('.mm-overlay')
  check('on Wispra Cloud the message does not suggest switching to Wispra Cloud', /daily limit/.test(t) && /Wait until then and press Continue\./.test(t) && !/Use Wispra Cloud/.test(t), t)
  check('the session list says the map stopped at the daily limit', /daily limit/.test(await js(`[...document.querySelectorAll('.meeting-session-map-tag')].map((e) => e.title).join(' ')`)))
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 180_000)
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
