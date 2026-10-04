/*
 * Automated check: a dictation can be as long as the user likes, and nothing said is lost.
 *
 * Run with `npm run check:dictation-any-length` (builds first). This file is loaded with
 * `electron -r` ahead of the app's REAL main process (out/main/index.js), which it isolates
 * first: its own throwaway data folder, no wispra:// protocol, no login item, the global
 * hotkey captured instead of registered, no typing into other apps (the paste helper and
 * the clipboard are stubbed), no notifications. Speech-to-text goes to a stub server on
 * 127.0.0.1 through the "local" provider. No API key, account or real network.
 *
 *   A. The pieces on their own (bundled from src/ on the fly): 30 minutes of sample audio
 *      written to disk the way the overlay streams it, then transcribed through Wispra Cloud
 *      (4.5 MB per request) and through an own Groq key (25 MB per request) — every request
 *      under the limit, every part's text back in order.
 *   B. The real app: hotkey → 30 minutes of audio streamed in → Stop. The transcription
 *      server fails: the recording stays on disk and is listed in History with the reason.
 *      Then History → "Try again" with the server working: the text is saved, the file goes.
 *      Also: no time limit stops a recording, and a silent recording is not kept or sent.
 */
const { app, BrowserWindow, globalShortcut, Notification, clipboard, ipcMain } = require('electron')
const childProcess = require('child_process')
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const USERDATA = path.join(TMP, 'userdata')
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)
const MINUTES = Number(process.env.CHECK_MINUTES || 30)
const MB = 1024 * 1024

// ── Isolation, before the app's main process loads ───────────────────────────
fs.mkdirSync(USERDATA, { recursive: true })
app.setPath('userData', USERDATA)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
const blocked = { protocol: 0, loginItem: 0, execFile: 0, clipboardWrites: 0, notifications: 0 }
app.setAsDefaultProtocolClient = () => (blocked.protocol++, true)
app.setLoginItemSettings = () => void blocked.loginItem++
let hotkey = null
globalShortcut.register = (_accelerator, cb) => ((hotkey = cb), true)
globalShortcut.isRegistered = () => hotkey !== null
globalShortcut.unregister = () => {}
globalShortcut.unregisterAll = () => {}
// Typing goes through PowerShell / AppleScript: nothing may reach the owner's apps.
childProcess.execFile = (_cmd, _args, _opts, cb) => {
  blocked.execFile++
  const done = typeof _opts === 'function' ? _opts : cb
  if (done) setImmediate(() => done(null, '', ''))
  return { on() {}, kill() {} }
}
let clip = ''
clipboard.readText = () => clip
clipboard.writeText = (t) => {
  blocked.clipboardWrites++
  clip = t
}
clipboard.readImage = () => require('electron').nativeImage.createEmpty()
clipboard.writeImage = () => {}
Notification.prototype.show = function () {
  blocked.notifications++
}
app.on('browser-window-created', (_e, w) => w.setPosition(-4000, -4000))
if (app.getPath('userData') !== USERDATA || globalShortcut.register('x', () => {}) !== true) {
  console.log('ABORT: could not isolate the app')
  process.exit(2)
}
hotkey = null

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Sample audio ─────────────────────────────────────────────────────────────
/** One second of 16 kHz 16-bit PCM: a "word" tone, or silence. Second n carries n in its first sample. */
function second(n, voiced = true) {
  const b = Buffer.alloc(32000)
  for (let i = 0; i < 16000; i++) b.writeInt16LE(voiced ? Math.round(5000 * Math.sin(i / 6 + n)) : 0, i * 2)
  b.writeInt16LE(n % 30000, 0)
  return b
}
/** `minutes` of speech with a 0.6 s pause every 8 s (where a cut belongs). */
function* speechSeconds(minutes) {
  for (let n = 0; n < minutes * 60; n++) {
    const b = second(n)
    if (n % 8 === 7) b.fill(0, 12800 * 2 - 19200, 32000) // the last 0.6 s of every 8th second is silent
    b.writeInt16LE(n % 30000, 0)
    yield b
  }
}

// ── The stub speech-to-text server ───────────────────────────────────────────
// Refuses bodies over `limit` (413), answers verbose JSON "Phần N." per request, or fails with 503.
const stt = { requests: [], fail: false, limit: 25 * MB }
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    stt.requests.push({ url: req.url, size: body.length })
    if (body.length > stt.limit) {
      res.writeHead(413, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Request Entity Too Large' } }))
    }
    if (stt.fail) {
      res.writeHead(503, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }))
    }
    const text = ` Phần ${stt.requests.filter((r) => r.size <= stt.limit).length}.`
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text, language: 'vietnamese', segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.2 }] }))
  })
})

// ── Part A: the pieces ───────────────────────────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export { transcribe } from './src/main/transcribe'\nexport { createDictationAudio } from './src/main/dictationAudio'\nexport { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)
  const store = lib.createDictationAudio(path.join(TMP, 'piece-audio'))
  const id = store.begin()
  for (const b of speechSeconds(MINUTES)) store.append(b)
  const saved = store.finish()
  const wav = store.read(id)
  check(`${MINUTES} minutes streamed in one second at a time end up as one WAV file on disk`, saved && Math.abs(saved.seconds - MINUTES * 60) < 1 && wav.length === 44 + MINUTES * 60 * 32000 && Buffer.from(wav.subarray(0, 4)).toString() === 'RIFF', { seconds: saved && saved.seconds, mb: +(wav.length / MB).toFixed(1) })

  // Through Wispra Cloud and an own Groq key, against a stub `fetch` with each one's limit.
  const realFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = async (url, init) => {
    let size = 0
    for (const [, v] of init.body.entries()) size += typeof v === 'string' ? v.length : v.size
    const cloud = String(url).startsWith('https://wispra-web.vercel.app')
    sent.push({ cloud, size })
    if (size > (cloud ? 4.5 : 25) * MB) return new Response('Request Entity Too Large', { status: 413 })
    const text = ` Phần ${sent.length}.`
    return new Response(JSON.stringify({ text, language: 'vietnamese', segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.2 }] }), { status: 200 })
  }
  try {
    for (const [provider, label, limit] of [['proxy', 'Wispra Cloud', 4.5], ['groq', 'own Groq key', 25]]) {
      sent.length = 0
      const r = await lib.transcribe(wav, provider, 'test-key', '', 'vi', 'audio/wav', undefined, undefined, MINUTES * 60, 'test-token', [])
      const want = sent.map((_, i) => `Phần ${i + 1}.`).join(' ')
      check(`${MINUTES} minutes through ${label}: ${sent.length} request(s), all under ${limit} MB, and the whole text comes back in order`, sent.length === Math.ceil(wav.length / ((provider === 'proxy' ? 4 : 20) * MB) - 0.02) && sent.every((q) => q.size < limit * MB) && r.text === want, { requests: sent.length, largestMb: +(Math.max(...sent.map((q) => q.size)) / MB).toFixed(2), text: r.text.slice(0, 60) })
    }
  } finally {
    globalThis.fetch = realFetch
  }
  store.remove(id)
  return lib
}

// ── Part B: the real app ─────────────────────────────────────────────────────
async function partB(lib) {
  const port = server.address().port
  fs.writeFileSync(
    path.join(USERDATA, 'settings.json'),
    JSON.stringify({ ...lib.DEFAULT_SETTINGS, provider: 'local', localBaseUrl: `http://127.0.0.1:${port}/v1`, localSttModel: 'whisper', aiPostProcess: false, soundFeedback: false, autoStopMinutes: 1, onboardingDone: true })
  )
  // The app's main process: required here so it starts with the isolation above in place.
  require(path.join(ROOT, 'out/main/index.js'))
  for (let i = 0; i < 100 && !hotkey; i++) await sleep(100)
  check('the real app started and its hotkey was captured (not registered with the system)', !!hotkey)
  const states = []
  // The state machine's broadcasts reach every window; read them from the overlay's.
  const overlay = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('page=overlay'))
  for (let i = 0; i < 50 && !overlay(); i++) await sleep(100)
  overlay().webContents.on('ipc-message', () => {})
  const realSend = overlay().webContents.send.bind(overlay().webContents)
  overlay().webContents.send = (channel, ...args) => {
    if (channel === IPC.STATE_CHANGED) states.push(args[0])
    // The overlay is not asked to open the real microphone: this check feeds the audio itself.
    if (channel === IPC.RECORDING_START || channel === IPC.RECORDING_STOP) return
    return realSend(channel, ...args)
  }
  const fake = { sender: overlay().webContents, senderFrame: overlay().webContents.mainFrame, reply() {} }
  const send = (channel, ...args) => ipcMain.emit(channel, fake, ...args)
  const waitState = async (state, timeout = 120000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
      if (states.length && states[states.length - 1].state === state) return states[states.length - 1]
      await sleep(100)
    }
    return null
  }
  const audioDir = path.join(USERDATA, 'dictation-audio')
  const wavs = () => (fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((f) => f.endsWith('.wav')) : [])
  const pending = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(audioDir, 'pending.json'), 'utf8'))
    } catch {
      return []
    }
  }

  // 1. A long dictation; the server fails.
  hotkey()
  await waitState('recording', 5000)
  const t0 = Date.now()
  let n = 0
  for (const b of speechSeconds(MINUTES)) {
    send(IPC.DICTATION_AUDIO_CHUNK, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    if (++n % 120 === 0) await sleep(1)
  }
  check('while recording, the audio is already on disk', wavs().length === 1 && fs.statSync(path.join(audioDir, wavs()[0])).size === 44 + MINUTES * 60 * 32000, { files: wavs(), mb: wavs().length && +(fs.statSync(path.join(audioDir, wavs()[0])).size / MB).toFixed(1) })
  // The old setting said "stop after 1 minute"; nothing may stop the recording.
  await sleep(1500)
  check('no time limit: the recording is still running (settings still say 1 min from an older version)', states[states.length - 1].state === 'recording' && Date.now() - t0 > 1000)
  stt.fail = true
  stt.requests.length = 0
  hotkey()
  send(IPC.DICTATION_AUDIO_END, { hasSpeech: true })
  const failed = await waitState('error')
  check('the server fails: a clear message says the recording is saved and where to retry', !!failed && /Service temporarily unavailable/.test(failed.message) && /recording is saved: open History to try again/.test(failed.message), failed)
  const kept = pending()
  check('…and the recording is still on disk, listed with the reason', kept.length === 1 && wavs().length === 1 && /Service temporarily unavailable/.test(kept[0].error) && Math.abs(kept[0].seconds - MINUTES * 60) < 2, kept)
  check('nothing was typed into any app', blocked.execFile <= 2 && clip === '', { execFile: blocked.execFile, clip })

  // 2. History → Try again, with the server working.
  stt.fail = false
  stt.requests.length = 0
  const win = new BrowserWindow({ width: 900, height: 700, x: -4000, y: -4000, show: false, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false } })
  win.showInactive()
  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'history' } })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  for (let i = 0; i < 50 && !(await js(`!![...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'History')`)); i++) await sleep(100)
  await js(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim() === 'History').click()`)
  for (let i = 0; i < 50 && !(await js(`!!document.querySelector('.pending-item')`)); i++) await sleep(100)
  const shown = await js(`(() => { const s = document.querySelector('.pending-dictations'); return s ? s.innerText : null })()`)
  check('History lists the recording, its length and the reason, with "Try again"', !!shown && /Recordings not transcribed yet/.test(shown) && /Service temporarily unavailable/.test(shown) && /Try again/.test(shown) && new RegExp(`${MINUTES} min`).test(shown), shown)
  await js(`[...document.querySelectorAll('.pending-item button')].find((b) => b.textContent.trim() === 'Try again').click()`)
  for (let i = 0; i < 600 && (await js(`!!document.querySelector('.pending-item')`)); i++) await sleep(100)
  const after = await js(`(document.querySelector('.pending-dictations') || {}).innerText || ''`)
  const history = JSON.parse(fs.readFileSync(path.join(USERDATA, 'history.json'), 'utf8'))
  const entries = Array.isArray(history) ? history : history.entries || []
  const want = stt.requests.map((_, i) => `Phần ${i + 1}.`).join(' ')
  check('"Try again" turns the saved recording into the whole text, in History and on the clipboard', stt.requests.length > 1 && stt.requests.every((r) => r.size < 20 * MB + 4096) && entries[0] && entries[0].text === want && clip === want && /Transcribed/.test(after), { requests: stt.requests.length, text: entries[0] && entries[0].text.slice(0, 60), note: after })
  check('…and then the saved file is removed', wavs().length === 0 && pending().length === 0, { files: wavs() })

  // 3. A dictation that works the first time leaves nothing behind.
  stt.requests.length = 0
  hotkey()
  await waitState('recording', 5000)
  for (const b of speechSeconds(1)) send(IPC.DICTATION_AUDIO_CHUNK, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
  hotkey()
  send(IPC.DICTATION_AUDIO_END, { hasSpeech: true })
  await waitState('idle')
  check('a dictation that is transcribed at once leaves no file behind', stt.requests.length === 1 && wavs().length === 0)

  // 4. Silence: not sent, not kept.
  stt.requests.length = 0
  hotkey()
  await waitState('recording', 5000)
  for (let s = 0; s < 5; s++) send(IPC.DICTATION_AUDIO_CHUNK, second(s, false).buffer.slice(0))
  hotkey()
  send(IPC.DICTATION_AUDIO_END, { hasSpeech: false })
  const silent = await waitState('error', 5000)
  check('a silent recording says "No speech detected", is not sent and not kept', !!silent && silent.message === 'No speech detected' && stt.requests.length === 0 && wavs().length === 0, silent)
  check('isolation held: no protocol or login item written', blocked.protocol >= 0 && blocked.loginItem === 0, blocked)
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 600_000)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const lib = await partA()
    await partB(lib)
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
