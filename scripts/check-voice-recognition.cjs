/*
 * Automated check for speaker recognition by voice (Meeting, opt-in).
 *
 * Run with `npm run check:voice-recognition` (builds first; Windows — the sample speech is
 * made with the two voices Windows ships, "Microsoft David" and "Microsoft Zira"). The real
 * speaker-embedding model is downloaded once into a cache folder outside the project (about
 * 28 MB, checked against its SHA-256) — the only network use. No key or account.
 *
 *   A. voiceprints.ts with the real sherpa-onnx addon and model, inside Electron (so the
 *      operating system's encryption is the real one): on by default (the owner's decision,
 *      2026-10-04), and turned off nothing is computed; a voice
 *      named once in a meeting is labelled by itself in the next one, another voice is not;
 *      a name said in the recording (the outline's speakers) teaches too; a name recognised
 *      by voice never teaches; Forget and Forget all; nothing is readable on disk.
 *   B. The built Settings renderer with stub IPC: the Meeting Start screen's one-line notice;
 *      the Learned tab's switch (on, can be turned off), list, Forget and Forget all; a
 *      recognised paragraph shows the name in the Transcript.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
const CACHE = path.join(os.tmpdir(), 'wispra-check-voice-model')
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

const SENTENCES = [
  'Good morning everyone. Today we will look at the launch plan and the budget for the next quarter.',
  'The design team finished the new onboarding last week, and the beta group has been using it without major problems.',
  'I think we should keep the launch date, but legal still has to approve the pricing page before we publish anything.',
  'Next, support. We expect more tickets in the first two weeks, so we need short answers for the most common questions.',
  'Let me summarise the action items before we close: the pricing copy goes to legal on Thursday.',
  'One more thing about the website. The download buttons should always follow the latest release.'
]

/** Sample speech: 16 kHz mono 16-bit WAV files made with Windows' own voices. Returns { david: [pcm…], zira: [pcm…] }. */
function makeSpeech() {
  const dir = path.join(TMP, 'speech')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'make.ps1')
  fs.writeFileSync(
    script,
    `Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$texts = @(${SENTENCES.map((t) => `'${t.replace(/'/g, "''")}'`).join(', ')})
foreach ($voice in @('David', 'Zira')) { for ($i = 0; $i -lt $texts.Count; $i++) {
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice("Microsoft $voice Desktop")
  $s.SetOutputToWaveFile((Join-Path '${dir}' ($voice.ToLower() + '-' + $i + '.wav')), $fmt); $s.Speak($texts[$i]); $s.Dispose() } }`,
    'utf8'
  )
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore', timeout: 120000 })
  const pcm = (file) => {
    const b = fs.readFileSync(path.join(dir, file))
    const at = b.indexOf('data') + 8
    return new Uint8Array(b.subarray(at))
  }
  return Object.fromEntries(['david', 'zira'].map((v) => [v, SENTENCES.map((_, i) => pcm(`${v}-${i}.wav`))]))
}

async function partA() {
  const outfile = path.join(TMP, 'lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export * from './src/main/voiceprints'\nexport { namesToLearn } from './src/main/voiceLearning'\nexport { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'sherpa-onnx-node'],
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)

  // The real model, downloaded once into a cache outside the project.
  const cached = path.join(CACHE, lib.MODEL_FILE)
  if (!fs.existsSync(cached)) {
    fs.mkdirSync(CACHE, { recursive: true })
    const response = await fetch(lib.MODEL_URL)
    fs.writeFileSync(cached, Buffer.from(await response.arrayBuffer()))
  }
  const speech = makeSpeech()
  check('sample speech made with two different Windows voices', speech.david.length === 6 && speech.zira.length === 6 && speech.david.every((p) => p.length > 3 * 32000))

  let enabled = false
  let downloads = 0
  let badDownload = false
  const dir = path.join(TMP, 'userdata', 'voices')
  const voices = lib.createVoiceprints({
    dir,
    crypto: safeStorage.isEncryptionAvailable() ? { encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) } : null,
    loadAddon: () => require(path.join(ROOT, 'node_modules/sherpa-onnx-node')),
    download: async () => {
      downloads++
      return badDownload ? new Uint8Array(1000) : new Uint8Array(fs.readFileSync(cached))
    },
    enabled: () => enabled,
    onChange: () => {}
  })

  check('on by default (the owner\'s decision)', lib.DEFAULT_SETTINGS.voiceRecognition === true)
  check('turned off: no voice is computed or kept', voices.embed(speech.david[0]) === null && !fs.existsSync(dir))
  enabled = true
  badDownload = true
  check('a download that is not the expected model is refused', (await voices.prepare()) === false && voices.state().model === 'failed')
  badDownload = false
  const ready = await voices.prepare()
  check('turned on: the model is fetched once, checked, and works here (the OS encryption is available)', ready && voices.state().model === 'ready' && voices.state().available && downloads === 2)

  // Meeting 1: David and Zira take turns; nobody is named yet.
  const segs = (prefix, list) => list.map((pcm, i) => ({ id: `${prefix}-${i}`, pcm, embedding: voices.embed(pcm) }))
  const m1 = [...segs('m1-david', speech.david.slice(0, 3)), ...segs('m1-zira', speech.zira.slice(0, 3))]
  check('a voice vector is computed for each stretch of speech', m1.every((s) => Array.isArray(s.embedding) && s.embedding.length > 100), m1[0].embedding && m1[0].embedding.length)
  check('meeting 1: nobody is known yet, so nobody is labelled', m1.every((s) => voices.recognise(s.embedding) === null))
  for (const s of m1) voices.keepSegment('m1', s.id, s.embedding)
  // The user names David's paragraphs "Sơn" in the Transcript.
  const session1 = {
    segments: m1.map((s, i) => ({ id: s.id, text: 'x', startMs: i * 20000, endMs: (i + 1) * 20000, startedAt: new Date().toISOString(), isNewParagraph: true })),
    speakerNames: { 'm1-david-0': 'Sơn', 'm1-david-1': 'Sơn', 'm1-david-2': 'Sơn' }
  }
  for (const [name, ids] of lib.namesToLearn(session1)) voices.learn('m1', ids, name)
  check('naming a speaker once teaches that voice', voices.state().voices.length === 1 && voices.state().voices[0].name === 'Sơn' && voices.state().voices[0].samples === 3, voices.state().voices)
  for (const [name, ids] of lib.namesToLearn(session1)) voices.learn('m1', ids, name)
  check('the same names saved again teach nothing twice', voices.state().voices[0].samples === 3)

  // Meeting 2: new sentences.
  const m2david = segs('m2-david', speech.david.slice(3))
  const m2zira = segs('m2-zira', speech.zira.slice(3))
  const davidNames = m2david.map((s) => voices.recognise(s.embedding))
  const ziraNames = m2zira.map((s) => voices.recognise(s.embedding))
  check('meeting 2: the named voice is labelled "Sơn" by itself, on sentences it never heard', davidNames.every((n) => n === 'Sơn'), davidNames)
  check('meeting 2: another voice is not given that name', ziraNames.every((n) => n === null), ziraNames)

  // Zira says her name in meeting 2 (the outline's speakers); David's paragraphs were recognised by voice only.
  for (const s of [...m2david, ...m2zira]) voices.keepSegment('m2', s.id, s.embedding)
  const session2 = {
    segments: [...m2david, ...m2zira].map((s, i) => ({ id: s.id, text: 'x', startMs: i * 20000, endMs: (i + 1) * 20000, startedAt: new Date().toISOString(), isNewParagraph: true, ...(s.id.includes('david') ? { voiceName: 'Sơn' } : {}) })),
    outline: { topics: [], actions: [], speakers: [{ name: 'Linh', startSegmentId: 'm2-zira-0', endSegmentId: 'm2-zira-2' }], language: 'en', generatedAt: '' }
  }
  const learned = lib.namesToLearn(session2)
  check('a name said in the recording teaches; a name recognised by voice does not', [...learned.keys()].join() === 'Linh', [...learned.entries()])
  for (const [name, ids] of learned) voices.learn('m2', ids, name)
  const m3 = [...segs('m3-zira', speech.zira.slice(0, 2)), ...segs('m3-david', speech.david.slice(0, 2))]
  const m3names = m3.map((s) => voices.recognise(s.embedding))
  check('meeting 3: both voices are labelled by themselves — Linh and Sơn', m3names.join() === 'Linh,Linh,Sơn,Sơn', m3names)

  // Nothing readable on disk.
  const files = lib.listVoiceFiles(dir).filter((f) => !f.endsWith('.onnx'))
  const plain = files.some((f) => {
    const t = fs.readFileSync(f).toString('latin1')
    return t.includes('Linh') || t.includes('centroid') || t.includes('vectors')
  })
  check('what is kept is encrypted by the OS: no name or number readable in the files', files.length >= 3 && !plain, files.map((f) => path.relative(dir, f)))

  // Forget one, then all.
  const son = voices.state().voices.find((v) => v.name === 'Sơn')
  voices.forget(son.id)
  check('Forget: that voice is no longer recognised, the other still is', voices.recognise(m3[2].embedding) === null && voices.recognise(m3[0].embedding) === 'Linh')
  voices.dropSession('m1')
  check('a deleted meeting takes its voice data with it', !lib.listVoiceFiles(dir).some((f) => path.basename(f) === 'm1.bin') && lib.listVoiceFiles(dir).some((f) => path.basename(f) === 'm2.bin'))
  voices.forgetAll()
  const left = lib.listVoiceFiles(dir).filter((f) => !f.endsWith('.onnx'))
  check('Forget all: no voice and no voice data are left (only the model)', voices.state().voices.length === 0 && left.length === 0 && voices.recognise(m3[0].embedding) === null, left)
  enabled = false
  check('turned off: nothing is computed any more', voices.embed(speech.david[0]) === null)
}

async function partB() {
  const VOICES = [{ id: 'v1', name: 'Sơn', samples: 3, createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-04T08:10:00.000Z' }, { id: 'v2', name: 'Linh', samples: 2, createdAt: '2026-10-04T08:00:00.000Z', updatedAt: '2026-10-04T08:20:00.000Z', lastMatchedAt: '2026-10-04T09:00:00.000Z' }]
  let state = { enabled: true, available: true, model: 'ready', voices: VOICES }
  const calls = { set: [], forget: [], forgetAll: 0 }
  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  let win = null
  const push = () => win.webContents.send(IPC.VOICE_STATE_CHANGED, state)
  const lib = require(path.join(TMP, 'lib.cjs'))
  void lib
  const defaults = (() => {
    const out = path.join(TMP, 'defaults.cjs')
    require('esbuild').buildSync({ stdin: { contents: `export { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' })
    return require(out).DEFAULT_SETTINGS
  })()
  // As the main process does: the switch is the voiceRecognition setting.
  handle(IPC.GET_SETTINGS, () => ({ ...defaults, voiceRecognition: state.enabled }))
  // The rest of the Learned tab, empty.
  handle(IPC.LEXICON_GET, () => [])
  handle(IPC.SUGGESTIONS_GET, () => [])
  handle(IPC.AUTOVOCAB_GET, () => [])
  handle(IPC.STYLE_GET, () => ({ notes: '', habits: [], exampleCount: 0 }))
  handle(IPC.VOICE_GET_STATE, () => state)
  handle(IPC.VOICE_SET_ENABLED, async (_e, on) => {
    calls.set.push(on)
    state = { ...state, enabled: on }
    return state
  })
  handle(IPC.VOICE_FORGET, (_e, id) => {
    calls.forget.push(id)
    state = { ...state, voices: state.voices.filter((v) => v.id !== id) }
    push()
  })
  handle(IPC.VOICE_FORGET_ALL, () => {
    calls.forgetAll++
    state = { ...state, voices: [] }
    push()
  })
  const segment = (id, i, extra) => ({ id, text: `Đoạn ${i}: chúng ta bàn về kế hoạch ra mắt.`, startMs: i * 20000, endMs: (i + 1) * 20000, startedAt: new Date(Date.UTC(2026, 9, 4, 3, 0, i * 20)).toISOString(), isNewParagraph: true, ...extra })
  const session = { id: 's1', title: 'Check voice session', createdAt: '2026-10-04T03:00:00.000Z', durationMs: 60000, audioSource: 'both', status: 'stopped', segments: [segment('a', 0, { voice: 'others', voiceName: 'Sơn' }), segment('b', 1, { voice: 'others' }), segment('c', 2, { voice: 'me' })], summary: 'x', outline: { topics: [{ title: 'Kế hoạch', startSegmentId: 'a', endSegmentId: 'c' }], actions: [], speakers: [], language: 'vi', generatedAt: '2026-10-04T04:00:00.000Z' } }
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => [{ id: 's1', title: session.title, createdAt: session.createdAt, durationMs: 60000, audioSource: 'both', status: 'stopped' }])
  handle(IPC.MEETING_GET_SESSION, () => session)
  handle(IPC.MEETING_GENERATE_OUTLINE, () => session.outline)

  win = new BrowserWindow({ width: 1250, height: 700, x: -4000, y: -4000, show: false, skipTaskbar: true, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true, backgroundThrottling: false } })
  win.showInactive()
  win.setPosition(-4000, -4000)
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const openTab = async (label) => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings' } })
    for (let i = 0; i < 50 && !(await js(`!![...document.querySelectorAll('header button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`)); i++) await sleep(100)
    await js(`[...document.querySelectorAll('header button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`)
    await sleep(700)
  }
  const card = () => js(`(() => { const c = document.querySelector('.voices-card'); return c ? { text: c.innerText, checked: c.querySelector('input[type=checkbox]').checked, items: [...c.querySelectorAll('.voices-name')].map((n) => n.textContent) } : null })()`)

  // The Meeting Start screen says in one line that voices are recognised here, and where to turn it off.
  await openTab('Meeting')
  const notice = await js(`(document.querySelector('.meeting-voice-notice') || {}).textContent || ''`)
  check('Meeting Start screen: one line says speakers are recognised by voice on this computer, nothing is sent, and where to turn it off', /recognises speakers by their voice on this computer/.test(notice) && /nothing is sent anywhere/.test(notice) && /Settings → Learned/.test(notice), notice)
  await openTab('Learned')
  if (process.env.CHECK_DEBUG) console.log('ERR', errors.slice(0, 3), (await js('document.body.innerText')).slice(0, 200))
  let c = await card()
  check('Learned tab: "Recognise speakers by voice" is on, says the data stays on this computer and is not sent, and lists the voices', c && c.checked && /Recognise speakers by voice/.test(c.text) && /only on this\s+computer/.test(c.text) && /nothing is sent anywhere/.test(c.text) && c.items.join() === 'Sơn,Linh' && /last recognised/.test(c.text), c)
  await js(`document.querySelector('.voices-card input[type=checkbox]').click()`)
  await sleep(500)
  c = await card()
  check('it can be turned off (one request to the main process); the remembered voices are still listed to forget', calls.set.join() === 'false' && !c.checked && c.items.join() === 'Sơn,Linh', c)
  await openTab('Meeting')
  check('turned off: the Start screen no longer shows the notice', (await js(`!document.querySelector('.meeting-voice-notice')`)) === true)
  await openTab('Learned')
  await js(`window.confirm = () => true; [...document.querySelectorAll('.voices-item')].find((i) => i.textContent.includes('Sơn')).querySelector('.voices-forget').click()`)
  await sleep(400)
  c = await card()
  check('Forget removes that voice', calls.forget.join() === 'v1' && c.items.join() === 'Linh', c.items)
  await js(`window.confirm = () => true; document.querySelector('.voices-forget-all').click()`)
  await sleep(400)
  c = await card()
  check('Forget all voices removes everything', calls.forgetAll === 1 && c.items.length === 0)

  await openTab('Meeting')
  await js(`[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('Check voice session')).click()`)
  for (let i = 0; i < 50 && (await js(`document.querySelectorAll('.txc-text').length`)) < 3; i++) await sleep(100)
  await sleep(300)
  const labels = await js(`[...document.querySelectorAll('.txc-time')].map((t) => { const s = t.querySelector('.txc-speaker'); return s ? s.textContent.trim() + '|' + s.title : '' })`)
  check('Transcript: a paragraph recognised by voice shows the name (and says so on hover); the others keep Others / You', labels[0] === 'Sơn|Recognised by voice — click to rename this speaker' && labels[1].startsWith('Others|') && labels[2].startsWith('You|'), labels)
  check('no errors in the renderer console', errors.length === 0, errors.slice(0, 5))
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 300_000)
  try {
    if (process.platform !== 'win32') {
      console.log('SKIP  the sample speech needs Windows voices')
    } else {
      await partA()
      await partB()
    }
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
void crypto
