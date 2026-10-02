/*
 * Automated check: what the app does when Wispra Cloud answers "this month's AI
 * allowance is used up" (HTTP 402, code "ai_quota_exceeded") — for every AI text
 * feature: dictation cleanup, transcript translation, summary, the five content tabs,
 * chat and the mind map.
 *
 * Run with `npm run check:ai-quota` (builds first). Two parts, no API key, account or
 * network in either:
 *
 *   A. The main-process AI functions (bundled from src/ on the fly) run against a fake
 *      server: `fetch` is replaced by a stub that answers 402. Checks that each feature
 *      calls once and never retries, that dictation still returns the user's words, that
 *      a long mind map stops, and that a user on their own key is not affected.
 *   B. The built Settings renderer with the real preload and stub IPC handlers: checks
 *      what the user sees in each tab, in the chat, in the mind map and on the Account
 *      page (also against an older server that does not report the allowance).
 *
 * The app's own main process is not started (no hotkey, tray, protocol or login-item
 * registration); the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const PLATFORMS = [
  { id: 'website', tab: 'Website' },
  { id: 'facebook', tab: 'Facebook' },
  { id: 'instagram', tab: 'Instagram' },
  { id: 'linkedin', tab: 'LinkedIn' },
  { id: 'twitter', tab: 'X' }
]
/** How long a failing view is left open before its calls are counted (a retry loop would add ~10 a second). */
const SETTLE_MS = 1200

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

// What the server sends when the allowance is used up (see wispra-web lib/ai-quota.ts).
const RESET_AT = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString()
const quotaBody = (plan) => ({
  error: 'Monthly AI limit reached.',
  code: 'ai_quota_exceeded',
  plan,
  limitTokens: plan === 'pro' ? 5_000_000 : 300_000,
  usedTokens: plan === 'pro' ? 5_000_120 : 300_512,
  resetAt: RESET_AT
})

// ── Part A: main-process functions against a fake server ─────────────────────
async function partA() {
  const outfile = path.join(TMP, 'ai-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { aiQuota } from './src/main/aiQuota'
        export * as post from './src/main/postprocess'
        export { generateMindMap } from './src/main/mindMap'
        export { WISPRA_API_BASE, GROQ_API_BASE } from './src/shared/constants'`,
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
  const { aiQuota, post, generateMindMap, WISPRA_API_BASE, GROQ_API_BASE } = require(outfile)
  const CLOUD_URL = `${WISPRA_API_BASE}/api/chat/completions`

  // The fake server. Nothing leaves this process.
  let answer = 'quota'
  let calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    await sleep(5)
    if (answer === 'quota') return new Response(JSON.stringify(quotaBody('free')), { status: 402, headers: { 'content-type': 'application/json' } })
    if (answer === 'quota-no-date') return new Response(JSON.stringify({ ...quotaBody('free'), resetAt: undefined }), { status: 402 })
    if (answer === 'other-402') return new Response(JSON.stringify({ error: { message: 'Payment required' } }), { status: 402 })
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Cleaned text.' } }] }), { status: 200 })
  }
  const quiet = console.error
  console.error = () => {} // the functions log every failed call; that is expected here
  const run = async (fn) => {
    calls = []
    aiQuota.clear()
    const value = await fn()
    return { value, calls: calls.length, urls: [...new Set(calls)], notice: aiQuota.current() }
  }
  const segments = (count, chars) =>
    Array.from({ length: count }, (_, i) => {
      let text = `Paragraph ${i + 1}:`
      while (text.length < chars) text += ' we talked about the quarterly revenue and the launch plan for November.'
      return { id: `s${i}`, text, startMs: i * 30000, endMs: (i + 1) * 30000, startedAt: new Date(Date.UTC(2026, 8, 28, 2, 0, i * 30)).toISOString(), isNewParagraph: true }
    })
  const proxy = ['proxy', '', '', undefined, undefined, 'test-token'] // provider, groqKey, openaiKey, localBaseUrl, localLlmModel, proxyToken
  const target = { apiKey: 'test-token', base: `${WISPRA_API_BASE}/api`, model: 'openai/gpt-oss-120b' }

  try {
    const raw = 'so um the meeting is moved to thursday at three'
    let r = await run(() => post.postProcess(raw, 'proxy', '', '', undefined, [], undefined, undefined, undefined, 'test-token'))
    check('dictation cleanup: the raw words come back unchanged', r.value === raw, { returned: r.value })
    check('dictation cleanup: one call to the Cloud server, no retry', r.calls === 1 && r.urls[0] === CLOUD_URL, { calls: r.calls, urls: r.urls })
    check('the notice carries plan, numbers and reset date', r.notice && r.notice.plan === 'free' && r.notice.limitTokens === 300000 && r.notice.usedTokens === 300512 && r.notice.resetAt === RESET_AT, r.notice)
    check('dictation: the "cleanup paused" notification is claimed once, not on every dictation', aiQuota.claimDictationNotice() !== null && aiQuota.claimDictationNotice() === null)
    check('dictation: further cleanup calls are skipped while the allowance is used up', aiQuota.shouldSkipCleanup() === true)

    const long = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ')
    r = await run(() => post.postProcess(long, 'proxy', '', '', undefined, [], undefined, undefined, undefined, 'test-token'))
    check('long dictation (3 chunks): every word is kept, in order', r.value.split(/\s+/).join(' ') === long, { words: r.value.split(/\s+/).length })
    check('long dictation: one call per chunk, no retries', r.calls === 3, { calls: r.calls })

    r = await run(() => post.translateSegment('Hello there.', 'vi', ...proxy))
    check('transcript translation: the untranslated text is kept, one call', r.value === 'Hello there.' && r.calls === 1, { returned: r.value, calls: r.calls })

    r = await run(() => post.generateMeetingTitle('We agreed to launch in November.', ...proxy))
    check('summary: fails cleanly with one call and a notice', r.value === null && r.calls === 1 && !!r.notice, { calls: r.calls })

    for (const { id } of PLATFORMS) {
      r = await run(() => post.generateMeetingContent(id, 'We agreed to launch in November.', ...proxy))
      check(`${id} content: fails cleanly with one call and a notice`, r.value === null && r.calls === 1 && !!r.notice, { calls: r.calls })
    }

    r = await run(() => post.askMeetingChat('What was decided?', segments(3, 200), [], ...proxy))
    check('chat: fails cleanly with one call and a notice', r.value === null && r.calls === 1 && !!r.notice, { calls: r.calls })

    r = await run(() => generateMindMap(segments(8, 400), target, 'auto'))
    check('mind map, short recording: one call, no retry, no map', r.value === null && r.calls === 1 && !!r.notice, { calls: r.calls })

    const progress = []
    r = await run(() => generateMindMap(segments(260, 480), target, 'auto', (p) => progress.push(p)))
    check('mind map, long recording (11 parts): stops after the calls already in flight, no retry, no map', r.value === null && r.calls <= 3 && !!r.notice && progress[0].total >= 10, { calls: r.calls, parts: progress[0] && progress[0].total })

    answer = 'other-402'
    r = await run(() => post.generateMeetingContent('website', 'We agreed to launch in November.', 'groq', 'user-own-key', '', undefined, undefined, undefined))
    check('own Groq key: a 402 that is not the quota error leaves no notice (own-key users are not affected)', r.value === null && r.notice === null && r.urls[0] === `${GROQ_API_BASE}/chat/completions`, { urls: r.urls })

    answer = 'quota'
    await post.generateMeetingTitle('We agreed to launch in November.', ...proxy)
    const before = aiQuota.current()
    answer = 'ok'
    await sleep(10)
    const cleaned = await post.postProcess('hello', 'proxy', '', '', undefined, [], undefined, undefined, undefined, 'test-token')
    check('once the server accepts a call again, the notice is dropped and cleanup works', before !== null && aiQuota.current() === null && cleaned === 'Cleaned text.', { cleaned })

    answer = 'quota-no-date'
    r = await run(() => post.generateMeetingTitle('We agreed to launch in November.', ...proxy))
    check('a quota answer without a reset date falls back to the 1st of next month', r.notice && r.notice.resetAt === RESET_AT, r.notice && r.notice.resetAt)
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the user sees ───────────────────────────────────────────────
async function partB() {
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
  const calls = {}
  const count = (key) => (calls[key] = (calls[key] ?? 0) + 1)
  let plan = 'free'
  let mode = 'quota' // 'quota' = the server answers 402 quota; 'error' = an ordinary failure
  let notice = null
  let accountInfo = { email: 'user@example.com', plan: 'free', usageSeconds: 600, limitSeconds: 1800, subscribeUrl: 'https://example.com/upgrade', aiTokensUsed: 300512, aiTokensLimit: 300000, aiTokensResetAt: RESET_AT }
  let win = null
  // What the real main process does when a call hits the allowance: broadcast first, then fail the call.
  const fail = () => {
    if (mode !== 'quota') return
    const body = quotaBody(plan)
    notice = { plan: body.plan, limitTokens: body.limitTokens, usedTokens: body.usedTokens, resetAt: body.resetAt, seenAt: Date.now() }
    win.webContents.send(IPC.AI_QUOTA_CHANGED, notice)
  }

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [], cloudSyncEnabled: false }))
  handle(IPC.GET_ACCOUNT_INFO, () => accountInfo)
  handle(IPC.GET_AI_QUOTA, () => notice)
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => sessions.find((s) => s.id === id) ?? null)
  handle(IPC.MEETING_GENERATE_CONTENT, async (_event, id, platform) => {
    count(`${id}/${platform}`)
    await sleep(40)
    fail()
    return null
  })
  handle(IPC.MEETING_GENERATE_SUMMARY, async (_event, id) => {
    count(`${id}/summary`)
    await sleep(40)
    fail()
    return false
  })
  handle(IPC.MEETING_CHAT_SEND, async (_event, id) => {
    count(`${id}/chat`)
    await sleep(40)
    fail()
    return null
  })
  handle(IPC.MEETING_GENERATE_MIND_MAP, async (_event, id) => {
    count(`${id}/mindmap`)
    // What the background job reports (see mindMapJobs.ts): two of five parts done, then stopped by the allowance.
    const status = { sessionId: id, state: 'running', phase: 'outline', done: 2, total: 5, startedAt: new Date().toISOString() }
    win.webContents.send(IPC.MEETING_MIND_MAP_PROGRESS, status)
    await sleep(40)
    fail()
    win.webContents.send(IPC.MEETING_MIND_MAP_PROGRESS, { ...status, state: 'stopped', reason: 'quota' })
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
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const TABS = `document.querySelector('.meeting-view-toggle')`
  const clickButton = (text, scope = 'document') =>
    js(`(() => { const b = [...${scope}.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
  const clickNav = (text) => js(`(() => { const b = [...document.querySelectorAll('.tab-nav button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); b.click(); return true })()`)
  const openSession = async (id) => {
    await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('session ${id}')).click()`)
    await sleep(400)
  }
  // The allowance message inside `scope`, if any: its text and where its upgrade link points.
  const quotaIn = (scope) =>
    js(`(() => { const m = ${scope} && ${scope}.querySelector('.ai-quota-message'); return m ? { text: m.innerText.replace(/\\s+/g, ' '), link: (m.querySelector('a') || {}).href || null } : null })()`)
  const hasRetry = (scope) => js(`!!(${scope} && [...${scope}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Try again'))`)

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
  for (let i = 0; i < 50 && !(await js(`document.querySelectorAll('.meeting-session-row-main').length === 2`)); i++) await sleep(100)
  const resetLabel = await js(`new Date(${JSON.stringify(RESET_AT)}).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })`)
  const VIEW = `document.querySelector('.meeting-summary-view')`
  await openSession('one')

  for (const { id, tab } of PLATFORMS) {
    const key = `one/${id}`
    await clickButton(tab, TABS)
    await sleep(SETTLE_MS)
    const message = await quotaIn(VIEW)
    check(`${tab} tab: says the allowance is used up, with the reset date, and how to continue`, message && message.text.includes("used all of this month's AI allowance") && message.text.includes(`resets on ${resetLabel}`) && message.text.includes('own Groq API key') && message.link === 'https://example.com/upgrade', message)
    check(`${tab} tab: one call only, with a "Try again" button`, calls[key] === 1 && (await hasRetry(VIEW)), { calls: calls[key] })
    await clickButton('Try again', VIEW)
    await sleep(SETTLE_MS)
    check(`${tab} tab: "Try again" calls exactly once more`, calls[key] === 2 && !!(await quotaIn(VIEW)), { calls: calls[key] })
  }

  await clickButton('Summary', TABS)
  await sleep(500)
  check('Summary tab: explains why there is no summary, without calling on its own', !!(await quotaIn(VIEW)) && calls['one/summary'] === undefined && (await hasRetry(VIEW)))
  await clickButton('Try again', VIEW)
  await sleep(SETTLE_MS)
  check('Summary tab: "Try again" calls once and the message stays', calls['one/summary'] === 1 && !!(await quotaIn(VIEW)), { calls: calls['one/summary'] })

  await clickButton('Transcript', TABS)
  const question = 'What did we decide about the launch?'
  await js(`(() => { const t = document.querySelector('.meeting-chat-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${JSON.stringify(question)}); t.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(100)
  await clickButton('Send', `document.querySelector('.meeting-chat-panel')`)
  await sleep(SETTLE_MS)
  const chat = await js(`({ input: document.querySelector('.meeting-chat-input').value, bubbles: document.querySelectorAll('.meeting-chat-bubble.user').length, redBox: !!document.querySelector('.meeting-chat-error') })`)
  check('chat: the allowance message appears in the chat panel after one call', !!(await quotaIn(`document.querySelector('.meeting-chat-panel')`)) && calls['one/chat'] === 1 && !chat.redBox, { calls: calls['one/chat'] })
  check('chat: the question is put back in the box to send again later', chat.input === question && chat.bubbles === 0, chat)

  await clickButton('Mind map', TABS)
  await sleep(SETTLE_MS)
  const PANEL = `document.querySelector('.mm-panel')`
  const overlay = await js(`(document.querySelector('.mm-overlay') || { innerText: '' }).innerText.replace(/\\s+/g, ' ')`)
  check('mind map: says it was not built, why, and how far it got', overlay.includes('The mind map was not built') && overlay.includes("used all of this month's AI allowance") && overlay.includes('It stopped after 2 of 5 parts. They are kept'), overlay)
  check('mind map: one call only, with a "Continue" button (the finished parts are kept)', calls['one/mindmap'] === 1 && (await js(`[...${PANEL}.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Continue')`)), { calls: calls['one/mindmap'] })
  await clickButton('Continue', PANEL)
  await sleep(SETTLE_MS)
  check('mind map: "Continue" calls exactly once more', calls['one/mindmap'] === 2, { calls: calls['one/mindmap'] })

  // An ordinary failure while an older notice is still around keeps its ordinary message.
  mode = 'error'
  await openSession('two')
  await clickButton('Website', TABS)
  await sleep(SETTLE_MS)
  const plain = await js(`${VIEW}.innerText.replace(/\\s+/g, ' ')`)
  check('an ordinary failure is still shown as an ordinary failure', plain.includes('Could not generate a blog post') && !(await quotaIn(VIEW)) && calls['two/website'] === 1, plain)

  mode = 'quota'
  plan = 'pro'
  await clickButton('Facebook', TABS)
  await sleep(SETTLE_MS)
  const pro = await quotaIn(VIEW)
  check('Pro plan: same message, reset date, no upgrade offer', pro && pro.text.includes('on the Pro plan') && pro.text.includes(`resets on ${resetLabel}`) && !pro.text.includes('upgrade') && pro.link === null, pro)

  // Account page: shows the allowance when the server reports it…
  await clickNav('Account')
  await sleep(600)
  const numbers = await js(`[(300512).toLocaleString(), (300000).toLocaleString()]`)
  let account = await js(`document.querySelector('main').innerText.replace(/\\s+/g, ' ')`)
  check('Account page: shows AI text usage for the month and the reset date', account.includes(`AI text: ${numbers[0]} / ${numbers[1]} tokens used this month · resets ${resetLabel}`), account.slice(0, 260))
  // …and still works with an older server that does not.
  accountInfo = { email: 'user@example.com', plan: 'free', usageSeconds: 600, limitSeconds: 1800, subscribeUrl: null }
  await clickNav('Meeting')
  await sleep(300)
  await clickNav('Account')
  await sleep(600)
  account = await js(`document.querySelector('main').innerText.replace(/\\s+/g, ' ')`)
  check('Account page with an older server (no allowance fields): renders as before, no AI line', account.includes('Wispra Free') && account.includes('30 min used this month') && !account.includes('AI text'), account.slice(0, 200))

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
