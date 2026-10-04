/*
 * Automated check: nothing the speaker did not say reaches the text.
 *
 * Whisper reads its "prompt" as text that came before the audio, and on silence or noise
 * writes it out again. Earlier prompts carried instruction sentences ("Các từ/tên riêng cần
 * giữ nguyên: …"), which came back in meetings and dictations as "Các từ và các nội dung
 * cần giữ nguyên." Run with `npm run check:no-invented-text` (no build needed, no key, no
 * network). transcribe() (bundled from src/ on the fly) runs against a stub speech-to-text
 * server that behaves like Whisper does on silence — it echoes the prompt it was sent and
 * the old echo sentences — through each place the app transcribes:
 *
 *   Dictate (own Groq key and Wispra Cloud), Meeting (the session queue) and the Transcribe tab.
 *
 * It checks that the prompt holds only the user's terms, that a silent recording gives no
 * text at all (so Dictate says "No speech detected", Meeting adds no paragraph, the
 * Transcribe tab says no speech), and that echoes inside real speech are dropped while
 * the speech itself is kept. Runs in Electron only because the Meeting queue needs it.
 */
const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
app.setPath('userData', path.join(TMP, 'userdata'))

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TERMS = ['Sơn', 'Kima API', 'Wispra', 'Builder']
const SPEECH = 'Sau đó nó sẽ viết ra một file rồi.'
const SPEECH_2 = 'Khoảng 30 phút sau Sơn bắt đầu công việc.'
// What Whisper has written instead of silence (seen in the owner's meetings and dictations, 2026-10).
const OLD_ECHOES = [
  'Các từ và các nội dung cần giữ nguyên.',
  'Các từ vài chữ khác cần giữ nguyên.',
  'Đây là bản ghi âm tiếng Việt, có dấu đầy đủ, viết hoa đầu câu và tên riêng.',
  'Keep these terms spelled exactly.'
]

/** A WAV whose first sample says what it holds: 0 = silence, 1 = speech. */
function wav(kind) {
  const n = 1600
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
  b.writeInt16LE(kind === 'speech' ? 1 : 0, 44)
  return new Uint8Array(b)
}

// ── A speech-to-text server that echoes like Whisper on silence ──────────────
const prompts = []
const realFetch = globalThis.fetch
async function stubFetch(url, init) {
  let file = null
  let prompt = null
  for (const [key, value] of init.body.entries()) {
    if (key === 'file') file = new Uint8Array(await value.arrayBuffer())
    if (key === 'prompt') prompt = value
  }
  prompts.push({ url: String(url), prompt })
  const speech = new DataView(file.buffer).getInt16(44, true) === 1
  const echo = [prompt, ...OLD_ECHOES].filter(Boolean)
  // Silence: only echoes. Speech: real sentences with echoes in between, as in the owner's 10:35 meeting.
  const sentences = speech ? [SPEECH, ...echo, SPEECH_2] : echo
  const segments = sentences.map((text) => ({ text: ' ' + text, no_speech_prob: 0.1, avg_logprob: -0.3 }))
  return new Response(JSON.stringify({ text: sentences.join(' '), language: 'vietnamese', segments }), { status: 200 })
}

app.whenReady().then(async () => {
  const outfile = path.join(TMP, 'lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `export { transcribe, buildSttPrompt, filterKnownHallucinations } from './src/main/transcribe'
        export { transcribeFileAt } from './src/main/transcribeFile'
        export { meetingSessions } from './src/main/meetingSessions'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    outfile,
    logLevel: 'silent'
  })
  const lib = require(outfile)
  globalThis.fetch = stubFetch
  const quiet = console.error
  console.error = () => {}
  try {
    // ── The prompt itself ──
    const prompt = lib.buildSttPrompt('vi', TERMS)
    check('the prompt is only the user\x27s terms — no sentence of instructions', prompt === 'Sơn, Kima API, Wispra, Builder.' && !/giữ nguyên|bản ghi âm|Keep these|spelled/i.test(prompt), prompt)
    check('without terms no prompt is sent at all', lib.buildSttPrompt('vi', []) === undefined && lib.buildSttPrompt('en', undefined) === undefined)

    const dictate = (provider, kind) => lib.transcribe(wav(kind), provider, 'test-key', '', 'vi', 'audio/wav', undefined, undefined, 3, provider === 'proxy' ? 'test-token' : undefined, TERMS)

    // ── Dictate, own Groq key ──
    let r = await dictate('groq', 'silence')
    check('Dictate (own key): silence gives no text (the app then says "No speech detected", nothing is typed)', r.text === '', r.text)
    r = await dictate('groq', 'speech')
    check('Dictate (own key): echoes inside speech are dropped, every spoken sentence kept', r.text === `${SPEECH} ${SPEECH_2}`, r.text)
    check('Dictate (own key): the prompt sent to the server has no instruction sentence', prompts.every((p) => !/giữ nguyên|bản ghi âm/.test(p.prompt || '')), prompts.map((p) => p.prompt))

    // ── Dictate, Wispra Cloud ──
    r = await dictate('proxy', 'silence')
    check('Dictate (Wispra Cloud): silence gives no text', r.text === '', r.text)
    r = await dictate('proxy', 'speech')
    check('Dictate (Wispra Cloud): echoes dropped, speech kept', r.text === `${SPEECH} ${SPEECH_2}`, r.text)

    // ── Meeting: the session queue adds a paragraph only for real text ──
    const session = lib.meetingSessions.start('both', { input: 'vi', transcript: 'vi', summary: 'vi', website: 'vi' })
    const chunk = (startMs) => ({ startMs, endMs: startMs + 20000, startedAt: new Date(Date.UTC(2026, 9, 4, 3, 35) + startMs).toISOString(), voice: 'others' })
    const meetingFn = (kind) => async () => (await lib.transcribe(wav(kind), 'groq', 'test-key', '', 'vi', 'audio/webm', undefined, undefined, 20, undefined, TERMS)).text || null
    lib.meetingSessions.enqueueChunk(chunk(0), meetingFn('speech'))
    lib.meetingSessions.enqueueChunk(chunk(20000), meetingFn('silence'))
    lib.meetingSessions.enqueueChunk(chunk(40000), meetingFn('speech'))
    await sleep(200)
    const stopped = await lib.meetingSessions.stop()
    const texts = stopped.segments.map((s) => s.text)
    check('Meeting: a silent stretch adds no paragraph, and no paragraph holds an echo', texts.length === 2 && texts.every((t) => t === `${SPEECH} ${SPEECH_2}`), texts)
    lib.meetingSessions.delete(session.id)

    // ── Transcribe tab ──
    const deps = {
      settings: () => ({ provider: 'groq', groqApiKey: 'test-key', openaiApiKey: '', localBaseUrl: '', localSttModel: '', vocabulary: [] }),
      getToken: async () => null,
      sttTerms: () => TERMS,
      applyReplacements: (t) => t
    }
    fs.writeFileSync(path.join(TMP, 'silence.wav'), wav('silence'))
    fs.writeFileSync(path.join(TMP, 'talk.wav'), wav('speech'))
    let file = await lib.transcribeFileAt(path.join(TMP, 'silence.wav'), 'vi', deps)
    check('Transcribe tab: a silent file says no speech, with no text', !file.ok && /No speech detected/.test(file.error), file)
    file = await lib.transcribeFileAt(path.join(TMP, 'talk.wav'), 'vi', deps)
    check('Transcribe tab: echoes dropped, speech kept', file.ok && file.text === `${SPEECH} ${SPEECH_2}`, file)

    // ── The filter on its own ──
    const f = (t) => lib.filterKnownHallucinations(t, prompt)
    check('every old echo sentence is dropped, wherever it sits', OLD_ECHOES.every((e) => f(e) === '' && f(`${SPEECH} ${e} ${SPEECH_2}`) === `${SPEECH} ${SPEECH_2}`))
    check('the prompt\x27s term list on its own is dropped', f('Sơn, Kima API, Wispra, Builder.') === '' && f('Kima API, Wispra.') === '')
    const real = ['Chúng ta cần giữ nguyên các từ khoá này trong bài.', 'Sơn dùng Kima API để quản lý dự án.', 'Các từ mới cần học hôm nay là ba từ.', 'Đây là bản ghi âm buổi họp hôm qua.']
    check('real sentences that share words with the prompt are kept', real.every((t) => f(t) === t), real.map(f))
  } catch (err) {
    check('check run completed', false, String(err && err.stack ? err.stack : err))
  } finally {
    globalThis.fetch = realFetch
    console.error = quiet
  }
  const failures = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failures}/${results.length} checks passed`)
  app.exit(failures ? 1 : 0)
})
