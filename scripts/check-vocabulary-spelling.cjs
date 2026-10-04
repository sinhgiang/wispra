/*
 * Automated check: the Custom vocabulary is spelled as the user wrote it in Dictate, Meeting
 * and Transcribe — and nothing the speaker did not say is ever added.
 *
 * Run with `npm run check:vocabulary-spelling` (builds first). No key, account or network.
 *
 *   A. spellVocabulary() on its own (bundled from src/ on the fly): the owner's own list
 *      (Github, Capcut, Timio, Wispra, TikTok, Facebook, MCP, claude, push, Helme, commit,
 *      Lenvid, Agent, Dictate) and the ways Whisper writes them; ordinary words left alone;
 *      and, over a few thousand sentences, never a word more than was heard.
 *   B. The app's REAL main process, isolated like check:dictation-any-length (throwaway data
 *      folder, hotkey captured, typing / clipboard / notifications stubbed). Speech-to-text goes
 *      to a stub server through the "local" provider; it answers with the vocabulary written
 *      wrongly. A Meeting chunk, a Transcribe-tab file and a dictation must all come out with
 *      the user's spelling. The prompt sent to the server is the plain term list (T-0088).
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
const VOCABULARY = ['Github', 'Capcut', 'Timio', 'Wispra', 'TikTok', 'Facebook', 'MCP', 'claude', 'push', 'Helme', 'commit', 'Lenvid', 'Agent', 'Dictate']
// What the stub speech-to-text server "hears" — the vocabulary written the way Whisper writes it.
const HEARD = 'Hôm nay Sơn đẩy code lên git hub, dựng video bằng Cap Cut rồi đăng Tik Tok và Face book. Bên Timeo dùng Lenvit với mcp.'
const WANT = 'Hôm nay Sơn đẩy code lên Github, dựng video bằng Capcut rồi đăng TikTok và Facebook. Bên Timio dùng Lenvid với MCP.'

// ── Isolation, before the app's main process loads ───────────────────────────
fs.mkdirSync(USERDATA, { recursive: true })
app.setPath('userData', USERDATA)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.setAsDefaultProtocolClient = () => true
app.setLoginItemSettings = () => {}
let hotkey = null
globalShortcut.register = (_a, cb) => ((hotkey = cb), true)
globalShortcut.isRegistered = () => hotkey !== null
globalShortcut.unregister = () => {}
globalShortcut.unregisterAll = () => {}
childProcess.execFile = (_c, _a, _o, cb) => {
  const done = typeof _o === 'function' ? _o : cb
  if (done) setImmediate(() => done(null, '', ''))
  return { on() {}, kill() {} }
}
let clip = ''
clipboard.readText = () => clip
clipboard.writeText = (t) => {
  clip = t
}
clipboard.readImage = () => require('electron').nativeImage.createEmpty()
clipboard.writeImage = () => {}
Notification.prototype.show = function () {}
app.on('browser-window-created', (_e, w) => w.setPosition(-4000, -4000))
if (app.getPath('userData') !== USERDATA) {
  console.log('ABORT: could not isolate the app')
  process.exit(2)
}

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function wav(seconds) {
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
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(5000 * Math.sin(i / 6)), 44 + i * 2)
  return b
}

// ── The stub speech-to-text server ───────────────────────────────────────────
const prompts = []
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1')
    const prompt = /name="prompt"\r\n\r\n([^\r]*)\r\n/.exec(body)
    prompts.push(prompt ? Buffer.from(prompt[1], 'latin1').toString('utf8') : null)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ text: HEARD, language: 'vietnamese', segments: [{ text: ' ' + HEARD, no_speech_prob: 0.01, avg_logprob: -0.2 }] }))
  })
})

let lib = null
function partA() {
  const outfile = path.join(TMP, 'lib.cjs')
  require('esbuild').buildSync({
    stdin: { contents: `export { spellVocabulary, spellingKey } from './src/main/vocabularySpelling'\nexport { DEFAULT_SETTINGS } from './src/shared/constants'`, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  lib = require(outfile)
  const f = (t, v = VOCABULARY) => lib.spellVocabulary(t, v)
  check('words split, joined or cased differently get the user\x27s spelling', f(HEARD) === WANT, f(HEARD))
  check('accents and punctuation inside a term: "Nguyen Van A" → "Nguyễn Văn A", "GPT 4o" → "GPT-4o"', f('Anh Nguyen Van A dùng GPT 4o.', ['Nguyễn Văn A', 'GPT-4o']) === 'Anh Nguyễn Văn A dùng GPT-4o.')
  check('a lowercase term does not change a capital at the start of a sentence ("Push", "Claude")', f('Push code lên. Claude rất tốt, dùng claude và push.') === 'Push code lên. Claude rất tốt, dùng claude và push.')
  check('ordinary words near a name are left alone ("timid", "Agents", a word at the start of a sentence)', f('The agents commit. Timid people. Agents run. Timeo said hi.') === 'The agents commit. Timid people. Agents run. Timeo said hi.')
  check('a term is not joined across a comma or a sentence end ("git, hub", "Cap. Cut")', f('Lên git, hub. Cap. Cut.') === 'Lên git, hub. Cap. Cut.')
  check('URLs and file names are left alone', f('Xem github.com/sinhgiang và capcut.exe nhé.') === 'Xem github.com/sinhgiang và capcut.exe nhé.')

  // Never a word more than was heard: thousands of sentences made of real and lookalike words.
  const pool = ['git', 'hub', 'Github', 'cap', 'cut', 'Tik', 'tok', 'face', 'book', 'Timeo', 'timid', 'Lenvit', 'mcp', 'push', 'Push', 'commit', 'agents', 'Agent', 'dictate', 'Helm', 'Helme', 'Wisper', 'Wispra', 'và', 'rồi', 'là', 'Sơn', 'claude', 'code', 'lên']
  let seed = 7
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  let worst = null
  for (let k = 0; k < 3000; k++) {
    const words = Array.from({ length: 4 + Math.floor(rand() * 12) }, () => pool[Math.floor(rand() * pool.length)])
    const sentence = words.map((w, i) => (rand() < 0.15 && i < words.length - 1 ? w + ',' : w)).join(' ') + '.'
    const out = f(sentence)
    const inWords = sentence.match(/[\p{L}\p{N}]+/gu)
    const outWords = out.match(/[\p{L}\p{N}]+/gu) || []
    const allowed = new Set([...inWords.map((w) => lib.spellingKey(w)), ...VOCABULARY.flatMap((v) => v.match(/[\p{L}\p{N}]+/gu).map((w) => lib.spellingKey(w)))])
    // Every word out was heard (or is the user's spelling of heard words), and there are never more words than heard.
    const extra = outWords.filter((w) => !allowed.has(lib.spellingKey(w)))
    if (outWords.length > inWords.length || extra.length) {
      worst = { sentence, out, extra }
      break
    }
  }
  check('3,000 sentences: never a word that was not heard, never more words than heard', worst === null, worst)
  check('without a vocabulary the text is untouched', f(HEARD, []) === HEARD)
}

async function partB() {
  const port = server.address().port
  fs.writeFileSync(
    path.join(USERDATA, 'settings.json'),
    JSON.stringify({ ...lib.DEFAULT_SETTINGS, provider: 'local', localBaseUrl: `http://127.0.0.1:${port}/v1`, localSttModel: 'whisper', aiPostProcess: false, soundFeedback: false, vocabulary: VOCABULARY, voiceRecognition: false, onboardingDone: true })
  )
  require(path.join(ROOT, 'out/main/index.js'))
  for (let i = 0; i < 100 && !hotkey; i++) await sleep(100)
  const overlay = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('page=overlay'))
  for (let i = 0; i < 50 && !overlay(); i++) await sleep(100)
  check('the real app started (isolated)', !!hotkey && !!overlay())
  const fake = { sender: overlay().webContents, senderFrame: overlay().webContents.mainFrame, reply() {} }
  const send = (channel, ...args) => ipcMain.emit(channel, fake, ...args)

  // Meeting: one chunk through the app's own handler.
  prompts.length = 0
  send(IPC.MEETING_START, { input: 'vi', transcript: 'auto', summary: 'vi', website: 'vi' }, 'mic')
  await sleep(300)
  const chunk = wav(6)
  send(IPC.MEETING_CHUNK_CAPTURED, chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength), { startMs: 0, endMs: 6000, startedAt: new Date().toISOString(), mimeType: 'audio/wav' })
  const meetingsDir = path.join(USERDATA, 'meetings')
  let segmentText = null
  for (let i = 0; i < 100 && !segmentText; i++) {
    await sleep(100)
    for (const file of fs.existsSync(meetingsDir) ? fs.readdirSync(meetingsDir) : []) {
      const s = JSON.parse(fs.readFileSync(path.join(meetingsDir, file), 'utf8'))
      if (s.segments && s.segments[0]) segmentText = s.segments[0].text
    }
  }
  check('Meeting: the paragraph is written with the user\x27s spelling', segmentText === WANT, segmentText)
  check('…and the prompt sent with it is only the term list (no instruction sentence)', prompts.length === 1 && prompts[0] === VOCABULARY.join(', ') + '.', prompts)

  // Transcribe tab: a file, through the renderer and the preload like a user.
  const file = path.join(TMP, 'talk.wav')
  fs.writeFileSync(file, wav(6))
  const win = new BrowserWindow({ width: 800, height: 600, x: -4000, y: -4000, show: false, webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), contextIsolation: true } })
  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings' } })
  const transcribed = await win.webContents.executeJavaScript(`window.api.transcribeFile(${JSON.stringify(file)}, 'vi')`, true)
  check('Transcribe tab: the file\x27s text has the user\x27s spelling', transcribed && transcribed.ok && transcribed.text === WANT, transcribed)

  // Dictate: AI cleanup off — the spelling still applies.
  hotkey()
  await sleep(300)
  const dictation = wav(5)
  const history = () => {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(USERDATA, 'history.json'), 'utf8'))
      return Array.isArray(h) ? h : h.entries || []
    } catch {
      return []
    }
  }
  if (IPC.DICTATION_AUDIO_CHUNK) {
    send(IPC.DICTATION_AUDIO_CHUNK, dictation.subarray(44).buffer.slice(dictation.byteOffset + 44, dictation.byteOffset + dictation.byteLength))
    hotkey()
    send(IPC.DICTATION_AUDIO_END, { hasSpeech: true })
  } else {
    hotkey()
    send(IPC.AUDIO_CAPTURED, dictation.buffer.slice(dictation.byteOffset, dictation.byteOffset + dictation.byteLength), 5, 'audio/wav')
  }
  for (let i = 0; i < 100 && history().length === 0; i++) await sleep(100)
  const typed = history()[0]
  check('Dictate (AI cleanup off): the text typed and kept in History has the user\x27s spelling', typed && typed.text === WANT && typed.rawText === HEARD, typed && { text: typed.text, rawText: typed.rawText })
}

app.whenReady().then(async () => {
  const killer = setTimeout(() => {
    console.log('FAIL  timed out')
    app.exit(1)
  }, 180_000)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    partA()
    await partB()
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  }
  clearTimeout(killer)
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
