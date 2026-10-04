/*
 * Automated check for long dictations through Wispra Cloud.
 *
 * Wispra Cloud runs on Vercel, which refuses a request body over 4.5 MB (HTTP 413
 * FUNCTION_PAYLOAD_TOO_LARGE). Dictation audio is 16 kHz 16-bit WAV — 32 KB a second —
 * so anything over about 2 min 20 s used to fail. Run with `npm run check:cloud-long-dictation`
 * (builds first). No API key, account or network:
 *
 *   A. transcribe() (bundled from src/ on the fly) against a stub of the Cloud endpoint that
 *      refuses bodies over 4.5 MB exactly like Vercel does: long dictations are sent in parts
 *      under the limit, cut at pauses, and the text comes back whole and in order; the
 *      server's own error messages are shown as they are; nothing is typed when a part fails.
 *   B. The real overlay recorder in Electron with Chromium's fake microphone: a recording of
 *      CHECK_RECORD_SECONDS (default 185 s, over 3 minutes) is delivered as audio — not
 *      reported as "No speech detected" — and that audio goes through the stub Cloud as text.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
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
const RECORD_SECONDS = Number(process.env.CHECK_RECORD_SECONDS || 185)

app.setPath('userData', path.join(TMP, 'userdata'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MB = 1024 * 1024
const VERCEL_LIMIT = 4.5 * MB

/** 16 kHz mono 16-bit WAV: a tone, with `gapEvery` seconds of tone followed by 0.6 s of silence when given. */
function makeWav(seconds, gapEvery = 0) {
  const n = Math.round(16000 * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const t = i / 16000
    const silent = gapEvery > 0 && t % (gapEvery + 0.6) >= gapEvery
    b.writeInt16LE(silent ? 0 : Math.round(6000 * Math.sin(i / 7)), 44 + i * 2)
  }
  return new Uint8Array(b)
}

/** Where a WAV part sits in the original: its samples' offset, found by matching. */
const pcmOf = (wav) => Buffer.from(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44)

// ── The stub Cloud endpoint ──────────────────────────────────────────────────
let requests = []
let serverAnswer = null
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  const form = init.body
  let size = 0
  let file = null
  for (const [, value] of form.entries()) {
    if (typeof value === 'string') size += value.length + 100
    else {
      size += value.size + 200
      file = new Uint8Array(await value.arrayBuffer())
    }
  }
  const request = { url: String(url), size, file, seconds: Number(init.headers['X-Audio-Duration-Seconds'] || 0) }
  requests.push(request)
  // Exactly what Vercel answers, measured against the live endpoint on 2026-10-04.
  if (request.url.startsWith('https://wispra-web.vercel.app') && size > VERCEL_LIMIT) return new Response('Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\nhkg1::test\n', { status: 413, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  const custom = serverAnswer && serverAnswer(request, requests.length)
  if (custom) return custom
  const text = ` Phần ${requests.length}.`
  return new Response(JSON.stringify({ text, language: 'vietnamese', segments: [{ text, no_speech_prob: 0.01, avg_logprob: -0.2 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function partA(lib) {
  const { transcribe, splitWav } = lib
  const cloud = (audio, seconds, mime = 'audio/wav') => transcribe(audio, 'proxy', '', '', 'vi', mime, undefined, undefined, seconds, 'test-token', [])
  globalThis.fetch = stubFetch
  try {
    requests = []
    let r = await cloud(makeWav(60), 60)
    check('a 1-minute dictation is one request, as before', requests.length === 1 && r.text === 'Phần 1.', { requests: requests.length, text: r.text })

    requests = []
    const three = makeWav(190, 7)
    r = await cloud(three, 190)
    const sizes = requests.map((q) => +(q.size / MB).toFixed(2))
    check('a 3 min 10 s dictation (5.8 MB) is sent in parts, every one under Vercel\x27s 4.5 MB', three.length > VERCEL_LIMIT && requests.length === 2 && requests.every((q) => q.size < VERCEL_LIMIT), { total: +(three.length / MB).toFixed(2), sizes })
    check('the text of every part comes back, joined in order', r.text === 'Phần 1. Phần 2.' && r.detectedLanguage === 'vi', r)
    const counted = requests.reduce((sum, q) => sum + q.seconds, 0)
    check('the minutes counted by the server add up to the recording', Math.abs(counted - 190) <= 2, { perPart: requests.map((q) => q.seconds), counted })
    const joined = Buffer.concat(requests.map((q) => pcmOf(q.file)))
    check('no audio is lost or repeated between the parts', joined.equals(pcmOf(three)), { joined: joined.length, original: pcmOf(three).length })
    // Tone for 7 s, then 0.6 s of silence: every cut must land in a silence.
    const cutAt = pcmOf(requests[0].file).length / 2 / 16000
    const inGap = cutAt % 7.6 >= 7 - 0.03
    check('the cut is made in a pause, not in the middle of a word', inGap, { cutAtSeconds: +cutAt.toFixed(3) })

    requests = []
    r = await cloud(makeWav(600), 600)
    check('a 10-minute dictation (the longest one) goes through in 5 parts', requests.length === 5 && requests.every((q) => q.size < VERCEL_LIMIT) && r.text.split('.').filter(Boolean).length === 5, { parts: requests.length })

    requests = []
    const parts = splitWav(makeWav(30), 4 * MB)
    check('audio that fits is not cut', parts.length === 1)

    // A recording that cannot be cut (not WAV) and is too big: said plainly, not "No speech detected".
    requests = []
    let error = null
    try {
      await cloud(new Uint8Array(Math.round(5.5 * MB)), 200, 'audio/webm')
    } catch (err) {
      error = err.message
    }
    check('a recording that cannot be sent says it is too large for Wispra Cloud, with its size', /too large for Wispra Cloud \(5\.5 MB/.test(error || '') && requests.length === 0, error)

    // The server's own messages are shown as they are.
    serverAnswer = () => new Response(JSON.stringify({ error: 'Monthly free tier limit reached (30 minutes). Upgrade to Pro for unlimited transcription.' }), { status: 402 })
    error = null
    try {
      await cloud(makeWav(20), 20)
    } catch (err) {
      error = err.message
    }
    check('a Wispra Cloud error is shown with its own reason (monthly limit)', /Monthly free tier limit reached \(30 minutes\)/.test(error || ''), error)

    serverAnswer = () => new Response(JSON.stringify({ error: JSON.stringify({ error: { message: 'Rate limit reached for model whisper-large-v3 on audio seconds per hour (ASH): Limit 7200, Used 7190.', type: 'audio_seconds', code: 'rate_limit_exceeded' } }) }), { status: 429 })
    error = null
    try {
      await cloud(makeWav(20), 20)
    } catch (err) {
      error = err.message
    }
    check('an error Groq gave the server is shown with Groq\x27s reason', /^Wispra Cloud: Rate limit reached for model whisper-large-v3/.test(error || ''), error)

    // A part that fails: nothing half-done is returned (and so nothing half is typed).
    serverAnswer = (_q, n) => (n >= 2 ? new Response(JSON.stringify({ error: 'Network error contacting transcription service' }), { status: 503 }) : null)
    requests = []
    error = null
    let text = null
    try {
      text = (await cloud(makeWav(190), 190)).text
    } catch (err) {
      error = err.message
    }
    check('if a part still fails after its retry, the dictation fails with that part\x27s reason and no partial text', text === null && requests.length === 3 && /Network error contacting transcription service/.test(error || ''), { error, text, requests: requests.length })
    serverAnswer = null

    // Own Groq key: unchanged — the whole file in one request (Groq accepts 25 MB).
    requests = []
    r = await transcribe(makeWav(190), 'groq', 'test-key', '', 'vi', 'audio/wav', undefined, undefined, 190, undefined, [])
    check('with your own Groq key the audio still goes in one request', requests.length === 1 && requests[0].url.startsWith('https://api.groq.com'), { requests: requests.length })
  } finally {
    globalThis.fetch = realFetch
  }
}

async function partB(lib) {
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  ipcMain.removeHandler(IPC.GET_SETTINGS)
  ipcMain.handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [], inputMode: 'toggle' }))
  let delivered = null
  let failed = null
  ipcMain.on(IPC.AUDIO_CAPTURED, (_e, audio, durationSeconds, mimeType) => {
    delivered = { audio: new Uint8Array(audio), durationSeconds, mimeType }
  })
  ipcMain.on(IPC.RECORDING_FAILED, (_e, message) => {
    failed = message
  })

  const win = new BrowserWindow({ width: 200, height: 200, x: -4000, y: -4000, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false } })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'overlay' } })
  await sleep(1000)
  win.webContents.send(IPC.STATE_CHANGED, { state: 'recording' })
  win.webContents.send(IPC.RECORDING_START)
  console.log(`      … recording ${RECORD_SECONDS} s with the fake microphone`)
  await sleep(RECORD_SECONDS * 1000)
  win.webContents.send(IPC.RECORDING_STOP)
  for (let i = 0; i < 300 && !delivered && !failed; i++) await sleep(100)
  check(`the overlay delivers a ${RECORD_SECONDS}-second recording as audio, not "No speech detected"`, !!delivered && !failed && delivered.durationSeconds >= RECORD_SECONDS - 2 && delivered.mimeType === 'audio/wav', { failed, durationSeconds: delivered && delivered.durationSeconds, mb: delivered && +(delivered.audio.length / MB).toFixed(2) })
  if (delivered) {
    check('that recording is larger than Vercel accepts in one request', RECORD_SECONDS < 150 || delivered.audio.length > VERCEL_LIMIT, { mb: +(delivered.audio.length / MB).toFixed(2) })
    globalThis.fetch = stubFetch
    requests = []
    let text = null
    let error = null
    try {
      text = (await lib.transcribe(delivered.audio, 'proxy', '', '', 'vi', delivered.mimeType, undefined, undefined, delivered.durationSeconds, 'test-token', [])).text
    } catch (err) {
      error = err.message
    } finally {
      globalThis.fetch = realFetch
    }
    check('through Wispra Cloud it comes back as text, every request under the limit', !error && !!text && requests.every((q) => q.size < VERCEL_LIMIT) && requests.length >= (RECORD_SECONDS >= 150 ? 2 : 1), { error, text, sizes: requests.map((q) => +(q.size / MB).toFixed(2)) })
  }
  check('no errors in the overlay console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, (RECORD_SECONDS + 120) * 1000)
  const outfile = path.join(TMP, 'transcribe-lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export { transcribe } from './src/main/transcribe'\nexport { splitWav } from './src/main/wavSplit'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)
  try {
    await partA(lib)
    await partB(lib)
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
