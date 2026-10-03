/*
 * Automated check for the "Where transcription and AI run" choice on the Account page
 * (Wispra Cloud or the user's own Groq key) and for the Transcribe tab on Wispra Cloud.
 *
 * Run with `npm run check:cloud-switch` (builds first). Two parts, no real key, account
 * or network in either — every "key" and "token" below is a made-up placeholder:
 *
 *   A. Main-process code (bundled from src/ on the fly) with `fetch` replaced by a stub
 *      that records where each request goes and with which credential: AI text and
 *      transcription go to the Wispra Cloud server with the session token when the
 *      provider is "proxy", and straight to Groq with the user's key when it is "groq";
 *      the Transcribe tab's file transcription does the same.
 *   B. The built Settings renderer with the real preload and stub IPC handlers: the
 *      choice on the Account page changes only `provider` (a saved key is never removed,
 *      changed or shown), Cloud needs a sign-in, a key can be added when none is saved,
 *      and the Transcribe tab works on Wispra Cloud without a key of the user's own.
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

/** Placeholders standing in for a saved key and a signed-in session. */
const OWN_KEY = 'placeholder-own-groq-key'
const SESSION = 'placeholder-session-token'

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The bundled main-process code (Part A builds it; Part B takes the default settings from it). */
let lib = null

// ── Part A: where requests go ────────────────────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'route-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { resolveChatTarget, generateMeetingContent } from './src/main/postprocess'
        export { transcribe } from './src/main/transcribe'
        export { transcribeFileAt, CLOUD_FILE_MAX_BYTES } from './src/main/transcribeFile'
        export { WISPRA_API_BASE, DEFAULT_SETTINGS } from './src/shared/constants'`,
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
  const cloud = new URL(lib.WISPRA_API_BASE).host

  const requests = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers || {}) }
    const auth = headers.Authorization || headers.authorization || ''
    requests.push({ host: new URL(String(url)).host, path: new URL(String(url)).pathname, auth: auth.replace(/^Bearer /, ''), duration: headers['X-Audio-Duration-Seconds'] })
    if (String(url).includes('/audio/transcriptions') || String(url).endsWith('/api/transcribe')) {
      return new Response(JSON.stringify({ text: 'Hello from the recording.', language: 'english', segments: [{ text: 'Hello from the recording.', no_speech_prob: 0.01, avg_logprob: -0.2 }] }), { status: 200 })
    }
    const content = JSON.stringify({ title: 'A title', metaDescription: 'A description.', body: 'Body.', posts: ['One', 'Two', 'Three'] })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }
  const quiet = console.error
  console.error = () => {}
  const last = () => requests[requests.length - 1]
  try {
    const viaCloud = lib.resolveChatTarget('proxy', OWN_KEY, '', undefined, undefined, SESSION)
    const viaKey = lib.resolveChatTarget('groq', OWN_KEY, '', undefined, undefined, SESSION)
    check('AI text, Wispra Cloud chosen: goes to the Wispra server with the session, never with the own key', viaCloud && new URL(viaCloud.base).host === cloud && viaCloud.apiKey === SESSION, viaCloud && { host: new URL(viaCloud.base).host })
    check('AI text, own key chosen: goes straight to Groq with the own key', viaKey && new URL(viaKey.base).host === 'api.groq.com' && viaKey.apiKey === OWN_KEY, viaKey && { host: new URL(viaKey.base).host })

    requests.length = 0
    await lib.generateMeetingContent('facebook', 'We agreed to launch in November.', 'proxy', OWN_KEY, '', undefined, undefined, SESSION)
    check('a real AI feature (Facebook posts) on Wispra Cloud: the request goes to the Wispra server with the session', requests.length >= 1 && requests.every((r) => r.host === cloud && r.auth === SESSION), requests.map((r) => r.host))
    requests.length = 0
    await lib.generateMeetingContent('facebook', 'We agreed to launch in November.', 'groq', OWN_KEY, '', undefined, undefined, undefined)
    check('…and on the own key: straight to Groq with the key', requests.length >= 1 && requests.every((r) => r.host === 'api.groq.com' && r.auth === OWN_KEY), requests.map((r) => r.host))

    const audio = new Uint8Array(2048)
    requests.length = 0
    await lib.transcribe(audio, 'proxy', OWN_KEY, '', 'auto', 'audio/webm', undefined, undefined, 12.4, SESSION)
    check('transcription on Wispra Cloud: to the Wispra server with the session, and its length for the monthly minutes', last().host === cloud && last().path === '/api/transcribe' && last().auth === SESSION && last().duration === '13', last())
    requests.length = 0
    await lib.transcribe(audio, 'groq', OWN_KEY, '', 'auto', 'audio/webm', undefined, undefined, 12.4, undefined)
    check('transcription on the own key: straight to Groq with the key', last().host === 'api.groq.com' && last().auth === OWN_KEY, { host: last().host })

    // ── The Transcribe tab ──
    const file = path.join(TMP, 'talk.mp3')
    fs.writeFileSync(file, Buffer.alloc(4096))
    const deps = (settings, token) => ({
      settings: () => ({ groqApiKey: '', openaiApiKey: '', localBaseUrl: undefined, localSttModel: undefined, vocabulary: [], ...settings }),
      getToken: async () => token,
      sttTerms: () => [],
      applyReplacements: (t) => t
    })
    requests.length = 0
    let r = await lib.transcribeFileAt(file, 'auto', deps({ provider: 'proxy' }, SESSION))
    check('Transcribe tab on Wispra Cloud, signed in, no own key: the file is transcribed through the Wispra server', r.ok && r.text.includes('Hello') && requests.length === 1 && last().host === cloud && last().auth === SESSION, { result: r, request: last() })
    check('…and no made-up length is sent for it (the server is told nothing rather than a wrong number)', last().duration === undefined)
    requests.length = 0
    r = await lib.transcribeFileAt(file, 'auto', deps({ provider: 'proxy' }, null))
    check('Transcribe tab on Wispra Cloud while signed out: a clear message, nothing sent', !r.ok && /sign in on the Account tab/i.test(r.error) && requests.length === 0, r)
    const big = path.join(TMP, 'long-talk.mp3')
    fs.writeFileSync(big, Buffer.alloc(lib.CLOUD_FILE_MAX_BYTES + 1))
    r = await lib.transcribeFileAt(big, 'auto', deps({ provider: 'proxy' }, SESSION))
    check('a file too big for Wispra Cloud: says so and how to go on, nothing sent', !r.ok && /over 4 MB/.test(r.error) && requests.length === 0, r)
    r = await lib.transcribeFileAt(file, 'auto', deps({ provider: 'groq', groqApiKey: OWN_KEY }, SESSION))
    check('Transcribe tab on the own key: straight to Groq with the key, as before', r.ok && last().host === 'api.groq.com' && last().auth === OWN_KEY, { host: last() && last().host })
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: the Account page and the Transcribe tab ──────────────────────────
async function partB() {
  let settings = { ...lib.DEFAULT_SETTINGS, provider: 'groq', groqApiKey: OWN_KEY, openaiApiKey: '' }
  let signedIn = true
  const patches = []
  const keyTests = []
  const fileCalls = []
  let win = null

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => settings)
  handle(IPC.SET_SETTINGS, (_event, patch) => {
    patches.push(patch)
    settings = { ...settings, ...patch }
    win.webContents.send(IPC.SETTINGS_CHANGED, settings)
    return settings
  })
  handle(IPC.TEST_API_KEY, (_event, provider, key) => {
    keyTests.push({ provider, sameAsTyped: key === 'placeholder-new-key' })
    return { ok: true }
  })
  handle(IPC.GET_ACCOUNT_INFO, () => (signedIn ? { email: 'owner@example.com', plan: 'free', usageSeconds: 0, limitSeconds: 1800, subscribeUrl: null, aiTokensUsed: 0, aiTokensLimit: 300000 } : null))
  handle(IPC.PICK_FILE, () => path.join(TMP, 'talk.mp3'))
  handle(IPC.TRANSCRIBE_FILE, (_event, filePath) => {
    fileCalls.push(filePath)
    return { ok: true, text: 'Hello from the recording.' }
  })

  win = new BrowserWindow({
    width: 900,
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
  const click = async (expr, wait = 400) => {
    const p = await js(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
    if (!p) throw new Error('element not found: ' + expr)
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const option = (name) => `[...document.querySelectorAll('.ai-route-option')].find((o) => o.textContent.includes(${JSON.stringify(name)}))`
  const state = () =>
    js(`(() => { const o = (n) => { const el = [...document.querySelectorAll('.ai-route-option')].find((x) => x.textContent.includes(n)); return el ? { checked: el.querySelector('input').checked, disabled: el.querySelector('input').disabled } : null }; return { cloud: o('Use Wispra Cloud'), own: o('Use my own Groq API key'), text: (document.querySelector('.ai-route') || {}).innerText || '', keyField: !!document.querySelector('.ai-route-key input') } })()`)
  const leaks = () => js(`document.body.innerText.includes(${JSON.stringify(OWN_KEY)}) || [...document.querySelectorAll('input')].some((i) => i.value.includes(${JSON.stringify(OWN_KEY)}))`)
  // Opens the Settings window on its first tab, then goes to `tab` (Account / Transcribe) the way a user does.
  const load = async (tab) => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings' } })
    await sleep(600)
    await js(`(() => { const b = [...document.querySelectorAll('header button')].find((x) => x.textContent.trim() === ${JSON.stringify(tab)}); if (b) b.click(); return !!b })()`)
    await sleep(700)
  }

  await load('Account')
  let s = await state()
  // CHECK_SHOTS=<folder> saves a screenshot of the choice, to look at by eye.
  if (process.env.CHECK_SHOTS) {
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    await js(`document.querySelector('.ai-route').scrollIntoView({ block: 'center' })`)
    fs.writeFileSync(path.join(process.env.CHECK_SHOTS, 'account-choice.png'), (await win.webContents.capturePage()).toPNG())
  }
  check('Account page shows the choice; the own key is selected, a saved key is mentioned, its value is not shown', s.own && s.own.checked && !s.cloud.checked && /A key is saved on this computer/.test(s.text) && !(await leaks()), s)
  check('the page says which route counts toward the allowance', /count toward this account's monthly minutes and AI allowance/.test(s.text) && /Nothing is counted on this page/.test(s.text))
  await click(option('Use Wispra Cloud'))
  s = await state()
  check('choosing Wispra Cloud changes only the route — the saved key is left as it is', patches.length === 1 && JSON.stringify(patches[0]) === '{"provider":"proxy"}' && settings.groqApiKey === OWN_KEY && s.cloud.checked, patches)
  await click(option('Use my own Groq API key'))
  s = await state()
  check('choosing the own key again switches straight back, with the same key, without asking for it', patches.length === 2 && JSON.stringify(patches[1]) === '{"provider":"groq"}' && settings.groqApiKey === OWN_KEY && s.own.checked && !s.keyField, patches)
  check('the key never appears on the page', !(await leaks()))

  // Signed out: Wispra Cloud cannot be chosen.
  signedIn = false
  await load('Account')
  s = await state()
  check('signed out: Wispra Cloud cannot be chosen and the page says to sign in first', s.cloud.disabled && /Sign in with Google first/.test(s.text), s.cloud)

  // No key saved yet, on Wispra Cloud: choosing the own key asks for one.
  signedIn = true
  settings = { ...settings, provider: 'proxy', groqApiKey: '' }
  patches.length = 0
  await load('Account')
  s = await state()
  check('no key saved: the page says so', s.cloud.checked && /No key is saved yet/.test(s.text))
  await click(option('Use my own Groq API key'))
  s = await state()
  check('…choosing the own key asks for one instead of switching to a route that cannot work', s.keyField && patches.length === 0)
  await js(`(() => { const i = document.querySelector('.ai-route-key input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'placeholder-new-key'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(100)
  await click(`[...document.querySelectorAll('.ai-route-key button')].find((b) => b.textContent.includes('Save key'))`, 600)
  s = await state()
  check('…the key is tested, saved, and the own-key route chosen', keyTests.length === 1 && keyTests[0].provider === 'groq' && keyTests[0].sameAsTyped && patches.length === 1 && patches[0].provider === 'groq' && patches[0].groqApiKey === 'placeholder-new-key' && s.own.checked && !s.keyField, { keyTests, patchKeys: patches.map((p) => Object.keys(p)) })

  // The Transcribe tab on Wispra Cloud with no key of the user's own.
  settings = { ...settings, provider: 'proxy', groqApiKey: '' }
  await load('Transcribe')
  const warned = await js(`/before transcribing/.test(document.body.innerText)`)
  await click(`document.querySelector('.drop-zone')`, 500)
  const button = `document.querySelector('.transcribe-controls button')`
  const enabled = await js(`(() => { const b = ${button}; return !!b && !b.disabled })()`)
  if (enabled) await click(button, 600)
  check('Transcribe tab on Wispra Cloud: no "add a key" warning, the button works, and the file is sent', !warned && enabled && fileCalls.length === 1 && /Hello from the recording/.test(await js('document.body.innerText')), { warned, enabled, calls: fileCalls.length })
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
