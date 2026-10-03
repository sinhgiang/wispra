/*
 * Automated check for the backup routes of AI text: when Groq's gpt-oss-120b reaches its
 * DAILY limit, the Mind map, the Transcript outline, the Summary and the Website / social
 * posts go on with Groq's gpt-oss-20b (same key), then with Cloudflare Workers AI
 * (gpt-oss-120b) when an account id and token are saved — and say so. A per-minute limit
 * is still only waited out. Cloudflare is asked without JSON mode (its JSON mode does not
 * list gpt-oss-120b) and the JSON is taken out of the answer.
 *
 * Run with `npm run check:ai-fallback` (builds first). Two parts, no real key, account
 * or network — every key, token and account id below is a placeholder:
 *
 *   A. The main-process code (bundled from src/ on the fly) with `fetch` replaced by a
 *      stub playing Groq and Cloudflare.
 *   B. The built Settings renderer with the real preload and stub IPC handlers: the
 *      Cloudflare fields on the Account page, and the "backup model" notes.
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

const GROQ_KEY = 'placeholder-own-groq-key'
const CF_ACCOUNT = 'placeholder-account-id'
const CF_TOKEN = 'placeholder-cloudflare-token'
const TPD = (model) =>
  `Rate limit reached for model \`${model}\` in organization \`org_placeholder\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199500, Requested 4300. Please try again in 3h2m10s.`
const CF_ALLOCATION = 'AiError: 3036: Account limited: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.'

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let lib = null

function makeSegments(prefix, count, chars) {
  return Array.from({ length: count }, (_, i) => {
    let text = `Đoạn ${i + 1}:`
    while (text.length < chars) text += ' chúng ta bàn về kết quả mở bán thử và kế hoạch ra mắt khoá học tháng mười một.'
    return { id: `${prefix}-s${i + 1}`, text, startMs: i * 58000, endMs: (i + 1) * 58000, startedAt: new Date(Date.UTC(2026, 9, 3, 7, 0, 0) + i * 58000).toISOString(), isNewParagraph: true }
  })
}

// ── Part A ───────────────────────────────────────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'fallback-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { resolveChatTarget, resolveBackupRoutes, withBackupRoutes, generateMeetingContent, generateMeetingTitle, testCloudflare } from './src/main/postprocess'
        export { runMindMap } from './src/main/mindMap'
        export { createMindMapJobs } from './src/main/mindMapJobs'
        export { generateOutline } from './src/main/outline'
        export { LANGUAGES, DEFAULT_SETTINGS } from './src/shared/constants'`,
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
  lib = require(outfile)

  // The fake providers. `exhausted` holds the routes whose daily limit is reached.
  let calls = []
  let exhausted = new Set()
  let minuteOnce = null
  let cfStatus = 429
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    const body = JSON.parse(init.body)
    const route = u.host === 'api.cloudflare.com' ? 'cloudflare' : body.model === 'openai/gpt-oss-20b' ? 'groq-20b' : 'groq-120b'
    const user = body.messages[body.messages.length - 1].content
    const part = /This is part (\d+) of/.exec(user)
    const call = { route, model: body.model, jsonMode: !!body.response_format, auth: (init.headers.Authorization || '').replace('Bearer ', ''), path: u.pathname, part: part ? Number(part[1]) : 0, at: Date.now(), status: 200 }
    calls.push(call)
    const reply = (status, text, headers) => {
      call.status = status
      return new Response(text, { status, headers })
    }
    if (minuteOnce === route) {
      minuteOnce = null
      return reply(429, JSON.stringify({ error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 8000. Please try again in 0.3s.' } }), { 'retry-after': '0.3' })
    }
    if (exhausted.has(route)) {
      if (route === 'cloudflare') return reply(cfStatus, JSON.stringify({ errors: [{ message: CF_ALLOCATION }], success: false }))
      return reply(429, JSON.stringify({ error: { message: TPD(body.model), code: 'rate_limit_exceeded' } }))
    }
    const refs = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    const system = body.messages[0].content
    let content
    if (system.startsWith('You are assembling')) content = { title: 'Demo Day', branches: [{ label: 'Tất cả', topics: [...user.matchAll(/^T(\d+)/gm)].map((m) => Number(m[1])) }], decisions: [], actions: [], questions: [] }
    else if (system.startsWith('You organise') || system.startsWith('You are organising')) content = { topics: [{ title: 'Kết quả mở bán', start: refs[0] }], actions: [], speakers: [] }
    else if (system.startsWith('You are tidying')) content = { topics: [], actions: [] }
    else if (refs.length) content = { title: 'Demo Day', topics: [{ label: `Chủ đề ${refs[0]}`, note: 'Ghi chú.', start: refs[0], end: refs[refs.length - 1], points: [] }], decisions: [], actions: [], questions: [] }
    else content = { title: `Written by ${route}`, summary: 'Summary.', metaDescription: 'A description.', body: 'Body.', posts: ['One', 'Two', 'Three'] }
    // Without JSON mode a model wraps its JSON in a sentence and a code fence.
    const text = call.jsonMode ? JSON.stringify(content) : 'Here is the JSON:\n```json\n' + JSON.stringify(content, null, 2) + '\n```'
    return reply(200, JSON.stringify({ choices: [{ message: { content: text } }] }))
  }
  const quiet = console.error
  console.error = () => {}
  const reset = (gone = [], minute = null) => {
    calls = []
    exhausted = new Set(gone)
    minuteOnce = minute
    cfStatus = 429
  }
  const settings = (extra) => ({ provider: 'groq', groqApiKey: GROQ_KEY, cloudflareAccountId: CF_ACCOUNT, cloudflareApiToken: CF_TOKEN, ...extra })
  const main = () => lib.resolveChatTarget('groq', GROQ_KEY, '', undefined, undefined, undefined)
  const ok = (route) => calls.filter((c) => c.route === route && c.status === 200)

  try {
    // ── The order of the routes ──
    let routes = lib.resolveBackupRoutes(settings({ cloudflareAccountId: '', cloudflareApiToken: '' }))
    check('own Groq key, no Cloudflare: one backup — Groq gpt-oss-20b, same key', routes.length === 1 && routes[0].model === 'openai/gpt-oss-20b' && routes[0].apiKey === GROQ_KEY && routes[0].label === 'Groq gpt-oss-20b', routes.map((r) => r.label))
    routes = lib.resolveBackupRoutes(settings())
    check('…with Cloudflare saved: Groq gpt-oss-20b, then Cloudflare gpt-oss-120b without JSON mode', routes.length === 2 && routes[1].model === '@cf/openai/gpt-oss-120b' && routes[1].jsonMode === false && routes[1].apiKey === CF_TOKEN && routes[1].base === `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1`, routes.map((r) => r.label))
    check('Wispra Cloud with Cloudflare saved: Cloudflare only (the smaller Groq model is not offered by the server)', lib.resolveBackupRoutes(settings({ provider: 'proxy' })).map((r) => r.model).join() === '@cf/openai/gpt-oss-120b')
    check('OpenAI or a local server: no backups', lib.resolveBackupRoutes(settings({ provider: 'openai' })).length === 0 && lib.resolveBackupRoutes(settings({ provider: 'local' })).length === 0)

    // ── Mind map ──
    const long = makeSegments('long', 152, 555)
    const progress = []
    reset(['groq-120b'])
    let r = await lib.runMindMap(long, main(), 'vi', { backups: lib.resolveBackupRoutes(settings({ cloudflareAccountId: '', cloudflareApiToken: '' })), onProgress: (p) => progress.push({ ...p }) })
    check('mind map, gpt-oss-120b at its daily limit: goes on with gpt-oss-20b and the map is built', !!r.map && ok('groq-20b').length >= 8 && ok('groq-120b').length === 0, { calls120: calls.filter((c) => c.route === 'groq-120b').length, ok20: ok('groq-20b').length })
    check('…the map and the progress say a backup model was used', r.map && r.map.backupModel === 'Groq gpt-oss-20b' && progress.some((p) => p.backupModel === 'Groq gpt-oss-20b'), r.map && r.map.backupModel)
    const doneParts = ok('groq-20b').map((c) => c.part).filter(Boolean)
    check('…every part is outlined exactly once', new Set(doneParts).size === doneParts.length, doneParts)

    reset(['groq-120b', 'groq-20b'])
    r = await lib.runMindMap(long, main(), 'vi', { backups: lib.resolveBackupRoutes(settings()) })
    const cf = calls.filter((c) => c.route === 'cloudflare')
    check('both Groq models at their daily limit: Cloudflare Workers AI builds the map', !!r.map && r.map.backupModel === 'Cloudflare Workers AI (gpt-oss-120b)' && cf.length >= 9, { cfCalls: cf.length })
    check('…Cloudflare gets gpt-oss-120b, its own token, the OpenAI-style path, and no JSON mode (the answer\'s JSON is taken out of the text)', cf.every((c) => c.model === '@cf/openai/gpt-oss-120b' && c.auth === CF_TOKEN && c.path === `/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions` && !c.jsonMode), cf[0])

    reset(['groq-120b', 'groq-20b', 'cloudflare'])
    r = await lib.runMindMap(long, main(), 'vi', { backups: lib.resolveBackupRoutes(settings()) })
    check('all three at their daily limit: the run stops with "daily-limit" and Cloudflare\'s numbers', !r.map && r.failure.reason === 'daily-limit' && r.failure.daily && r.failure.daily.unit === 'neurons', r.failure)
    reset(['groq-120b', 'groq-20b', 'cloudflare'])
    cfStatus = 400
    r = await lib.runMindMap(long, main(), 'vi', { backups: lib.resolveBackupRoutes(settings()) })
    check('…also when Cloudflare reports the used-up allocation with another status than 429', !r.map && r.failure.reason === 'daily-limit', r.failure)

    reset([], 'groq-120b')
    r = await lib.runMindMap(long, main(), 'vi', { backups: lib.resolveBackupRoutes(settings()) })
    check('a per-minute limit on gpt-oss-120b is waited out — no switch to a backup', !!r.map && !r.map.backupModel && calls.every((c) => c.route === 'groq-120b'), { routes: [...new Set(calls.map((c) => c.route))] })

    // The job (what the app runs) passes its backups on.
    reset(['groq-120b'])
    const session = { id: 'long', title: 'Demo', createdAt: '2026-10-03T07:00:00.000Z', durationMs: 152 * 58000, audioSource: 'both', status: 'stopped', segments: long, languageConfig: { website: 'vi' } }
    const statuses = []
    const jobs = lib.createMindMapJobs({
      dir: path.join(TMP, 'jobs'),
      getSession: (id) => (id === 'long' ? session : undefined),
      resolveTarget: async () => main(),
      resolveBackups: () => lib.resolveBackupRoutes(settings({ cloudflareAccountId: '', cloudflareApiToken: '' })),
      saveMindMap: (_id, map) => (session.mindMap = map),
      notify: (s) => statuses.push({ ...s }),
      languages: lib.LANGUAGES.map((l) => l.code)
    })
    const jobMap = await jobs.start('long')
    check('the background job uses the backups too, and its status says which', !!jobMap && jobMap.backupModel === 'Groq gpt-oss-20b' && statuses.some((s) => s.state === 'running' && s.backupModel === 'Groq gpt-oss-20b'))

    // ── Transcript outline ──
    reset(['groq-120b'])
    const outlineProgress = []
    const outline = await lib.generateOutline(makeSegments('short', 10, 300), main(), 'vi', (p) => outlineProgress.push({ ...p }), undefined, lib.resolveBackupRoutes(settings()))
    check('Transcript outline: goes on with gpt-oss-20b and says so', outline && outline.backupModel === 'Groq gpt-oss-20b' && ok('groq-20b').length === 1 && outlineProgress.some((p) => p.backupModel === 'Groq gpt-oss-20b'), outline && outline.backupModel)

    // ── Posts and the Summary (what the main process runs: withBackupRoutes) ──
    const transcript = 'We agreed to launch in November. Linh rewrites the sign-up page by Friday.'
    const post = (route, onDailyLimit) => lib.generateMeetingContent('facebook', transcript, 'groq', GROQ_KEY, '', undefined, undefined, undefined, undefined, { route, onDailyLimit })
    reset(['groq-120b'])
    let res = await lib.withBackupRoutes(lib.resolveBackupRoutes(settings()), post)
    check('Facebook posts: gpt-oss-120b at its daily limit → written by gpt-oss-20b, and the result says so', res.result && res.result.posts.length === 3 && res.backupModel === 'Groq gpt-oss-20b' && calls.map((c) => c.route).join() === 'groq-120b,groq-20b', { routes: calls.map((c) => c.route), backup: res.backupModel })
    reset(['groq-120b', 'groq-20b'])
    res = await lib.withBackupRoutes(lib.resolveBackupRoutes(settings()), post)
    check('…both Groq models out → Cloudflare, in plain mode, and the post is read from its answer', res.result && res.result.posts.length === 3 && res.backupModel === 'Cloudflare Workers AI (gpt-oss-120b)' && calls[2].route === 'cloudflare' && !calls[2].jsonMode, { routes: calls.map((c) => c.route) })
    reset(['groq-120b', 'groq-20b', 'cloudflare'])
    let finalDaily = []
    res = await lib.withBackupRoutes(lib.resolveBackupRoutes(settings()), post, (d) => finalDaily.push(d))
    check('…all out → no post, one daily-limit report (the last route\'s)', res.result === null && finalDaily.length === 1 && finalDaily[0].unit === 'neurons' && calls.length === 3, { calls: calls.length })
    reset([])
    res = await lib.withBackupRoutes(lib.resolveBackupRoutes(settings()), post)
    check('…nothing at its limit → the main model writes it and no backup is named', res.result && !res.backupModel && calls.length === 1 && calls[0].route === 'groq-120b')
    reset(['groq-120b'])
    res = await lib.withBackupRoutes(lib.resolveBackupRoutes(settings()), (route, onDailyLimit) =>
      lib.generateMeetingTitle(transcript, 'groq', GROQ_KEY, '', undefined, undefined, undefined, undefined, { route, onDailyLimit })
    )
    check('Summary: the same — written by gpt-oss-20b when gpt-oss-120b is at its daily limit', res.result && res.result.title === 'Written by groq-20b' && res.backupModel === 'Groq gpt-oss-20b', res.result)

    // ── Testing a Cloudflare id + token ──
    reset([])
    let test = await lib.testCloudflare(CF_ACCOUNT, CF_TOKEN)
    check('"Test and save": one small request to Cloudflare\'s Workers AI with the given id and token', test.ok && calls.length === 1 && calls[0].route === 'cloudflare' && calls[0].auth === CF_TOKEN && calls[0].path.includes(CF_ACCOUNT), test)
    const realFake = globalThis.fetch
    globalThis.fetch = async () => new Response('{"errors":[{"message":"Authentication error"}]}', { status: 403 })
    test = await lib.testCloudflare(CF_ACCOUNT, CF_TOKEN)
    check('…a token without Workers AI permission is refused, with what to do', !test.ok && /Workers AI/.test(test.error), test)
    globalThis.fetch = realFake
    reset([])
    test = await lib.testCloudflare('', CF_TOKEN)
    check('…an empty field is caught without sending anything', !test.ok && calls.length === 0, test)
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the user sees ───────────────────────────────────────────────
async function partB() {
  let settings = { ...lib.DEFAULT_SETTINGS, provider: 'groq', groqApiKey: GROQ_KEY }
  const patches = []
  const tests = []
  let testResult = { ok: true }
  const segments = makeSegments('one', 10, 200)
  const session = {
    id: 'one',
    title: 'Check session one',
    createdAt: '2026-10-03T07:00:00.000Z',
    durationMs: 10 * 58000,
    audioSource: 'mic',
    status: 'stopped',
    segments,
    summary: 'A short summary.',
    content: { website: { title: 'Launch', metaDescription: 'What was agreed.', body: 'Body.' }, facebook: ['Post one', 'Post two', 'Post three'] },
    backupModels: { summary: 'Groq gpt-oss-20b', website: 'Cloudflare Workers AI (gpt-oss-120b)', facebook: 'Groq gpt-oss-20b' },
    mindMap: { title: 'Demo', language: 'vi', generatedAt: '2026-10-03T08:00:00.000Z', backupModel: 'Groq gpt-oss-20b', branches: [{ label: 'Nhánh', kind: 'topic', startSegmentId: 'one-s1', endSegmentId: 'one-s2', children: [] }] },
    outline: { language: 'vi', generatedAt: '2026-10-03T08:00:00.000Z', backupModel: 'Groq gpt-oss-20b', topics: [{ title: 'Kết quả mở bán', startSegmentId: 'one-s1', endSegmentId: 'one-s10' }], actions: [], speakers: [] }
  }
  let win = null

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => settings)
  handle(IPC.SET_SETTINGS, (_event, patch) => {
    patches.push(Object.keys(patch).sort().join(',') + (patch.cloudflareApiToken === '' ? ' (cleared)' : ''))
    settings = { ...settings, ...patch }
    win.webContents.send(IPC.SETTINGS_CHANGED, settings)
    return settings
  })
  handle(IPC.TEST_CLOUDFLARE, (_event, accountId, token) => {
    tests.push(accountId === CF_ACCOUNT && token === CF_TOKEN)
    return testResult
  })
  handle(IPC.GET_ACCOUNT_INFO, () => ({ email: 'owner@example.com', plan: 'free', usageSeconds: 0, limitSeconds: 1800, subscribeUrl: null }))
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => [{ id: session.id, title: session.title, createdAt: session.createdAt, durationMs: session.durationMs, audioSource: session.audioSource, status: session.status }])
  handle(IPC.MEETING_GET_SESSION, () => session)
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [{ sessionId: 'two', state: 'running', phase: 'outline', done: 3, total: 9, startedAt: new Date().toISOString(), backupModel: 'Groq gpt-oss-20b' }])

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
  const typeInto = (selector, value) =>
    js(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const clickText = (text, scope = 'document') =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.getClientRects().length > 0); if (!b) return false; b.click(); return true })()`)
  const leaks = () => js(`[${JSON.stringify(CF_TOKEN)}, ${JSON.stringify(CF_ACCOUNT)}].some((v) => document.body.innerText.includes(v) || [...document.querySelectorAll('input')].some((i) => i.value === v))`)
  const goTo = async (tab) => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', ...(tab === 'Meeting' ? { tab: 'meeting' } : {}) } })
    await sleep(600)
    if (tab !== 'Meeting') await clickText(tab, `document.querySelector('header')`)
    await sleep(600)
  }

  // ── Account page ──
  await goTo('Account')
  let text = await js(`(document.querySelector('.ai-backup') || { innerText: '' }).innerText`)
  check('Account page explains the backups: gpt-oss-20b, then Cloudflare; transcription stays on Groq', /gpt-oss-20b/.test(text) && /Cloudflare Workers AI/.test(text) && /Transcription always stays on Groq/.test(text), text.slice(0, 200))
  check('both fields are hidden (password) fields', (await js(`[...document.querySelectorAll('.ai-backup input')].map((i) => i.type).join()`)) === 'password,password')
  testResult = { ok: false, error: 'Cloudflare did not accept this token for Workers AI.' }
  await typeInto('.ai-backup input[placeholder="Cloudflare Account ID"]', CF_ACCOUNT)
  await typeInto('.ai-backup input[placeholder^="Cloudflare API token"]', CF_TOKEN)
  await sleep(100)
  await clickText('Test and save', `document.querySelector('.ai-backup')`)
  await sleep(500)
  check('a failed test shows why and saves nothing', tests.length === 1 && patches.length === 0 && /did not accept/.test(await js(`document.querySelector('.ai-backup').innerText`)))
  testResult = { ok: true }
  await clickText('Test and save', `document.querySelector('.ai-backup')`)
  await sleep(600)
  text = await js(`document.querySelector('.ai-backup').innerText`)
  check('a passing test saves both values, then only says Cloudflare is set up — the values are not shown again', tests.length === 2 && tests.every(Boolean) && patches.join('|') === 'cloudflareAccountId,cloudflareApiToken' && /is set up/.test(text) && !(await leaks()), { patches, tests })
  await clickText('Remove', `document.querySelector('.ai-backup')`)
  await sleep(500)
  check('"Remove" clears both', patches[1] === 'cloudflareAccountId,cloudflareApiToken (cleared)' && settings.cloudflareAccountId === '' && (await js(`document.querySelectorAll('.ai-backup input').length`)) === 2, patches)

  // ── The notes ──
  await goTo('Meeting')
  await js(`document.querySelector('.meeting-session-row-main').click()`)
  await sleep(700)
  const tabs = `document.querySelector('.meeting-view-toggle')`
  text = await js(`(document.querySelector('.txc-backup-note') || { innerText: '' }).innerText`)
  check('Transcript: "partly written by the backup model Groq gpt-oss-20b"', /backup model Groq gpt-oss-20b/.test(text), text)
  await clickText('Summary', tabs)
  await sleep(300)
  text = await js(`(document.querySelector('.meeting-backup-note') || { innerText: '' }).innerText`)
  check('Summary: says it was written by the backup model', /Written by the backup model Groq gpt-oss-20b/.test(text), text)
  await clickText('Website', tabs)
  await sleep(300)
  text = await js(`(document.querySelector('.meeting-backup-note') || { innerText: '' }).innerText`)
  check('Website: names Cloudflare Workers AI as the backup that wrote it', /Cloudflare Workers AI \(gpt-oss-120b\)/.test(text), text)
  await clickText('Facebook', tabs)
  await sleep(300)
  check('Facebook: says so too', /backup model Groq gpt-oss-20b/.test(await js(`(document.querySelector('.meeting-backup-note') || { innerText: '' }).innerText`)))
  await clickText('Mind map', tabs)
  await sleep(700)
  text = await js(`(document.querySelector('.mm-backup-note') || { innerText: '' }).innerText`)
  check('Mind map: "Partly written by the backup model Groq gpt-oss-20b"', /Partly written by the backup model Groq gpt-oss-20b/.test(text), text)
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
