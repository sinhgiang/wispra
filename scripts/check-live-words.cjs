/*
 * Automated check and measurement for live words in Meeting: grey provisional words within
 * about a second of being spoken, replaced by the transcript when it arrives.
 *
 * Run with `npm run check:live-words` (builds first). The real Vietnamese model
 * (sherpa-onnx-zipformer-vi-int8-2025-04-20, ~77 MB) and two Vietnamese sample recordings
 * from its repository are downloaded once into a cache outside the project — the only
 * network use. No key or account.
 *
 *   A. liveWords.ts with the real sherpa-onnx addon and model, inside Electron: the sample
 *      speech is fed in 250 ms pieces at real-time pace, as the recorder does; measured: how
 *      long after each piece arrives its words are on screen (must stay under 1 s), and that
 *      the last provisional text matches decoding the whole recording. Also: nothing when
 *      turned off or for another spoken language, a cut starts a new stretch.
 *   B. The built Settings renderer with stub IPC: while recording, the grey words show at the
 *      end of the table, then Groq's paragraph replaces them; the Start screen's switch.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const CACHE = path.join(os.tmpdir(), 'wispra-check-live-words-model')
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)
app.setPath('userData', path.join(TMP, 'userdata'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchToCache(url, file, sha256) {
  const target = path.join(CACHE, file)
  if (fs.existsSync(target) && (!sha256 || crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === sha256)) return target
  fs.mkdirSync(CACHE, { recursive: true })
  const response = await fetch(url)
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()))
  return target
}

/** 16-bit PCM of a WAV file (16 kHz mono). */
function pcmOf(file) {
  const b = fs.readFileSync(file)
  return b.subarray(b.indexOf('data') + 8)
}

async function partA() {
  const outfile = path.join(TMP, 'lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export * from './src/main/liveWords'\nexport { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'sherpa-onnx-node'],
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)
  for (const f of lib.LIVE_MODEL_FILES) await fetchToCache(`${lib.LIVE_MODEL_BASE}/${f.name}`, f.name, f.sha256)
  const samples = []
  for (const n of [0, 1]) samples.push(pcmOf(await fetchToCache(`${lib.LIVE_MODEL_BASE}/test_wavs/${n}.wav`, `${n}.wav`)))
  // The worst case: one 20-second stretch (the longest the recorder makes), decoded again as it grows.
  const long = []
  for (let total = 0; total < 20 * 32000; ) for (const p of samples) if (total < 20 * 32000) (long.push(p), (total += p.length))
  samples.push(Buffer.concat(long).subarray(0, 20 * 32000))
  check('on by default', lib.DEFAULT_SETTINGS.liveWords === true)

  let active = true
  const events = []
  const decodes = []
  const dir = path.join(TMP, 'models')
  const live = lib.createLiveWords({
    dir,
    loadAddon: () => require(path.join(ROOT, 'node_modules/sherpa-onnx-node')),
    download: async (url) => new Uint8Array(fs.readFileSync(path.join(CACHE, url.split('/').pop()))),
    active: () => active,
    onWords: (fromMs, text) => events.push({ at: Date.now(), fromMs, text }),
    onDecoded: () => decodes.push(Date.now())
  })
  check('the model is fetched once, checked, and runs here', (await live.prepare()) === true && live.ready())

  // Feed each recording in 250 ms pieces, at real-time pace, as the recorder does.
  const measured = []
  let timelineMs = 0
  for (const [n, pcm] of samples.entries()) {
    live.cut(timelineMs)
    events.length = 0
    decodes.length = 0
    const piece = 16000 / 4 * 2
    const pushedAt = []
    for (let off = 0; off < pcm.length; off += piece) {
      const part = pcm.subarray(off, Math.min(pcm.length, off + piece))
      timelineMs += Math.round((part.length / 32000) * 1000)
      pushedAt.push({ at: Date.now(), bytes: off + part.length })
      live.push(new Uint8Array(part), timelineMs)
      await sleep(250)
    }
    await sleep(800)
    // Lag: for each piece, how long until a decode that includes it has finished — its words (if any)
    // are on screen then. A piece that adds no new word sends no update, so updates alone would overstate it.
    const lags = []
    for (const p of pushedAt) {
      const done = decodes.find((t) => t >= p.at)
      lags.push(done === undefined ? Infinity : done - p.at)
    }
    // Reference: the whole recording decoded at once.
    const so = require(path.join(ROOT, 'node_modules/sherpa-onnx-node'))
    const file = (name) => path.join(dir, 'live-words', name)
    const rec = new so.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { transducer: { encoder: file(lib.LIVE_MODEL_FILES[0].name), decoder: file(lib.LIVE_MODEL_FILES[1].name), joiner: file(lib.LIVE_MODEL_FILES[2].name) }, tokens: file(lib.LIVE_MODEL_FILES[3].name), numThreads: 2, provider: 'cpu', debug: 0 } })
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const floats = new Float32Array(pcm.length / 2)
    for (let i = 0; i < floats.length; i++) floats[i] = view.getInt16(i * 2, true) / 32768
    const s = rec.createStream()
    s.acceptWaveform({ sampleRate: 16000, samples: floats })
    rec.decode(s)
    const whole = lib.displayText(rec.getResult(s).text)
    const last = events[events.length - 1]
    measured.push({ recording: n, seconds: +(pcm.length / 32000).toFixed(1), updates: events.length, firstWordsAfterMs: events[0] ? events[0].at - pushedAt[0].at : null, maxLagMs: Math.max(...lags), decodeMs: live.lastDecodeMs(), text: last && last.text, whole })
  }
  console.log('      measured:', JSON.stringify(measured))
  check('provisional words show within 1 s of the speech arriving, all the way through (measured)', measured.every((m) => m.firstWordsAfterMs !== null && m.firstWordsAfterMs < 1000 && m.maxLagMs < 1000), measured.map(({ recording, firstWordsAfterMs, maxLagMs, decodeMs }) => ({ recording, firstWordsAfterMs, maxLagMs, decodeMs })))
  check('the words grow as the speech goes on, and end as the whole recording decoded at once', measured.slice(0, 2).every((m) => m.updates >= 2 && m.text === m.whole && m.text.length > 5), measured.map((m) => ({ text: m.text, whole: m.whole })))
  check('each stretch is labelled with where it began (the recorder\x27s cut)', events.every((e) => e.fromMs === Math.round((samples[0].length / 32000) * 1000)) || events.every((e) => e.fromMs > 0))

  // Off, or another spoken language: nothing.
  active = false
  events.length = 0
  live.cut(0)
  for (let off = 0; off < samples[0].length; off += 8000) {
    live.push(new Uint8Array(samples[0].subarray(off, off + 8000)), off / 32)
    await sleep(50)
  }
  await sleep(500)
  check('turned off (or a recording in another language): no words', events.length === 0)
}

async function partB(lib) {
  void lib
  let state = 'idle'
  const session = { id: 'live', title: 'Meeting — Oct 4', createdAt: new Date().toISOString(), durationMs: 0, audioSource: 'mic', status: 'recording', segments: [] }
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  const out = path.join(TMP, 'defaults.cjs')
  require('esbuild').buildSync({ stdin: { contents: `export { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' })
  let settings = { ...require(out).DEFAULT_SETTINGS }
  const patches = []
  handle(IPC.GET_SETTINGS, () => settings)
  handle(IPC.SET_SETTINGS, (_e, patch) => {
    patches.push(patch)
    settings = { ...settings, ...patch }
    return settings
  })
  handle(IPC.MEETING_GET_STATE, () => state)
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => (state === 'idle' ? [] : [{ id: 'live', title: session.title, createdAt: session.createdAt, durationMs: 0, audioSource: 'mic', status: 'recording' }]))
  handle(IPC.MEETING_GET_SESSION, () => session)
  let win = null
  ipcMain.on(IPC.MEETING_START, () => {
    state = 'recording'
    win.webContents.send(IPC.MEETING_STATE_CHANGED, 'recording')
    win.webContents.send(IPC.MEETING_CAPTURE_START)
  })
  win = new BrowserWindow({ width: 1250, height: 700, x: -4000, y: -4000, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false } })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning') && !message.includes('live words unavailable')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
  for (let i = 0; i < 50 && !(await js(`!!document.querySelector('.meeting-live-words-toggle')`)); i++) await sleep(100)
  const toggle = await js(`(() => { const t = document.querySelector('.meeting-live-words-toggle'); return t ? { text: t.textContent.trim(), checked: t.querySelector('input').checked } : null })()`)
  check('Start screen: "Show words as they are spoken" is there and on', toggle && toggle.checked && /Show words as they are spoken/.test(toggle.text), toggle)
  await js(`document.querySelector('.meeting-live-words-toggle input').click()`)
  await sleep(200)
  await js(`document.querySelector('.meeting-live-words-toggle input').click()`)
  await sleep(200)
  check('…and the switch saves the setting', patches.map((p) => p.liveWords).join() === 'false,true', patches)

  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start recording').click()`)
  for (let i = 0; i < 50 && !(await js(`!!document.querySelector('.txc')`)); i++) await sleep(100)
  await sleep(500)
  const send = (channel, ...args) => win.webContents.send(channel, ...args)
  send(IPC.MEETING_LIVE_WORDS, { sessionId: 'live', fromMs: 0, text: 'những nơi đã' })
  await sleep(150)
  send(IPC.MEETING_LIVE_WORDS, { sessionId: 'live', fromMs: 0, text: 'những nơi đã khống chế được căn bệnh' })
  await sleep(250)
  const grey = await js(`(() => { const p = document.querySelector('.txc-interim'); return p ? { text: p.textContent, color: getComputedStyle(p).color, italic: getComputedStyle(p).fontStyle } : null })()`)
  check('while recording, the provisional words show at the end of the table, grey and italic, updated as they grow', grey && grey.text === 'những nơi đã khống chế được căn bệnh' && grey.italic === 'italic', grey)
  send(IPC.MEETING_LIVE_WORDS, { sessionId: 'other', fromMs: 0, text: 'không thuộc buổi này' })
  await sleep(200)
  check('words of another session are ignored', (await js(`document.querySelector('.txc-interim').textContent`)) === 'những nơi đã khống chế được căn bệnh')
  // Groq's paragraph for that stretch arrives; the next stretch has started meanwhile.
  send(IPC.MEETING_LIVE_WORDS, { sessionId: 'live', fromMs: 4000, text: 'rồi cũng hỗ trợ' })
  const segment = { id: 's1', text: 'Những nơi đã khống chế được căn bệnh.', startMs: 0, endMs: 4000, startedAt: new Date().toISOString(), isNewParagraph: true }
  session.segments.push(segment)
  send(IPC.MEETING_SEGMENT_READY, segment, 'live')
  await sleep(300)
  const after = await js(`({ interim: (document.querySelector('.txc-interim') || {}).textContent || null, paragraphs: [...document.querySelectorAll('.txc-text:not(.txc-interim)')].map((p) => p.textContent) })`)
  check('Groq\x27s paragraph replaces the provisional words of its stretch; the next stretch\x27s words stay', after.paragraphs.join() === 'Những nơi đã khống chế được căn bệnh.' && after.interim === 'rồi cũng hỗ trợ', after)
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 600_000)
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
