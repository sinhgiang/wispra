/*
 * Automated check for the Transcript table of a recording in progress: the four columns
 * from the moment Start is pressed, the transcript running into the middle column,
 * topics and action items named part by part while recording (only finished parts are
 * sent to the AI), speaker names said in the recording, renaming a speaker by hand, and
 * no transcript printed twice.
 *
 * Run with `npm run check:live-transcript` (builds first). Two parts, no API key, account
 * or network in either:
 *
 *   A. The main-process code (bundled from src/ on the fly) against a fake AI: `fetch` is
 *      replaced by a stub. The live outline engine is fed a recording segment by segment;
 *      the daily limit and the backup route; Stop while a call is in flight; finishing
 *      the outline after Stop; the speaker rule in the prompts; and the session queue
 *      ignoring a second copy of the same audio.
 *   B. The built Settings renderer with the real preload and stub IPC handlers, plus
 *      Chromium's fake microphone: leaving and reopening the Meeting tab, then Start —
 *      one recorder only; the table at once; segments and topics arriving; renaming a
 *      speaker; the daily-limit line; and Stop finishing the outline.
 *
 * The app's own main process is not started; the window and its data folder are throwaway.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wispra-check-'))
// Channel names come from the single source of truth, src/shared/ipc.ts.
const IPC = Object.fromEntries(
  [...fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8').matchAll(/^\s*([A-Z0-9_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
)

app.setPath('userData', path.join(TMP, 'userdata'))
// The window sits off-screen; without this Windows marks it occluded and stops painting it.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
// A fake microphone, granted without a prompt: the real recorder code runs, no real audio.
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A recording of 14 paragraphs on three subjects (A: 1-5, B: 6-10, C: 11-14), each
 * paragraph about 600 characters and 40 s long. Paragraph 1 is Sơn speaking about
 * himself by name; paragraphs 3 and 8 state a task.
 */
const SUBJECT = (n) => (n <= 5 ? 'A' : n <= 10 ? 'B' : 'C')
function makeRecording(prefix) {
  return Array.from({ length: 14 }, (_, i) => {
    const n = i + 1
    let text = n === 1 ? 'Buổi này Sơn nói về cách thiết lập nhiều dự án. ' : ''
    if (n === 3) text += 'VIỆC: Linh gửi số liệu mở bán trước thứ Sáu. '
    if (n === 8) text += 'VIỆC: Sơn gộp ba bản tài liệu cài đặt. '
    text += `Chủ đề ${SUBJECT(n)}, đoạn ${n}:`
    while (text.length < 600) text += ` chúng ta tiếp tục bàn về chủ đề ${SUBJECT(n)} và những gì cần chuẩn bị.`
    return { id: `${prefix}-s${n}`, text, startMs: i * 40000, endMs: (i + 1) * 40000, startedAt: new Date(Date.UTC(2026, 9, 4, 6, 50, i * 40)).toISOString(), isNewParagraph: true, voice: 'others' }
  })
}

// ── The fake AI ──────────────────────────────────────────────────────────────
// Answers from the paragraphs it is sent: a topic wherever the subject letter changes,
// a task wherever a paragraph says "VIỆC:", and Sơn wherever he names himself.
function fakeAnswer(user) {
  const lines = [...user.matchAll(/^\[(\d+)\] \([^)]*\) (.*)$/gm)].map((m) => ({ ref: Number(m[1]), text: m[2] }))
  const topics = []
  for (const line of lines) {
    const subject = /Chủ đề ([A-Z])/.exec(line.text)[1]
    if (!topics.length || topics[topics.length - 1].subject !== subject) topics.push({ subject, title: `Chủ đề ${subject} của buổi họp`, start: line.ref })
  }
  const actions = lines.filter((l) => l.text.includes('VIỆC:')).map((l) => ({ text: /VIỆC: ([^.]*)/.exec(l.text)[1], ref: l.ref }))
  const speakers = lines.filter((l) => /Sơn nói về/.test(l.text)).map((l) => ({ name: 'Sơn', start: l.ref, end: l.ref }))
  const previous = /PREVIOUS TOPIC: Chủ đề ([A-Z])/.exec(user)
  return { continues: !!previous && topics[0].subject === previous[1], topics: topics.map(({ title, start }) => ({ title, start })), actions, speakers }
}

const DAILY_429 = () =>
  new Response(
    JSON.stringify({ error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199500, Requested 3000. Please try again in 1h2m3.5s.', type: 'tokens', code: 'rate_limit_exceeded' } }),
    { status: 429, headers: { 'retry-after': '3723' } }
  )

// ── Part A: the main-process code against a fake AI ──────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'live-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { createLiveOutliner } from './src/main/liveOutline'
        export { generateOutline } from './src/main/outline'
        export { applyLiveAnswer, joinOutlines, liveCallDue, openLines, remainingSegments } from './src/main/outlineLogic'
        export { buildTranscriptLines } from './src/main/mindMapLogic'
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
  const main = { apiKey: 'test', base: 'http://main.invalid/v1', model: 'openai/gpt-oss-120b' }
  const backup = { apiKey: 'test', base: 'http://backup.invalid/v1', model: 'openai/gpt-oss-20b', label: 'gpt-oss-20b' }

  let calls = []
  let respond = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    const system = body.messages[0].content
    const user = body.messages[1].content
    const kind = system.startsWith('You organise a meeting/voice-memo transcript WHILE') ? 'live' : system.startsWith('You are organising one part') ? 'part' : system.startsWith('You are tidying') ? 'merge' : 'single'
    const call = { kind, url: String(url), system, user, refs: [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1])) }
    calls.push(call)
    const custom = respond && (await respond(call))
    if (custom) return custom
    await sleep(3)
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(fakeAnswer(user)) } }] }), { status: 200 })
  }
  const quiet = [console.error, console.warn]
  console.error = () => {}
  console.warn = () => {}

  // A recording in memory, fed to an outliner segment by segment.
  const newRecording = (backups = []) => {
    const session = { id: 'rec', status: 'recording', segments: [], languageConfig: { summary: 'vi' } }
    const statuses = []
    let saves = 0
    const outliner = lib.createLiveOutliner({
      getSession: (id) => (id === session.id ? session : null),
      resolveTarget: async () => main,
      resolveBackups: () => backups,
      language: () => 'vi',
      saveOutline: (_id, outline) => {
        saves++
        session.outline = outline
      },
      notify: (status) => statuses.push(status)
    })
    return { session, statuses, outliner, saves: () => saves }
  }
  const settle = async () => {
    for (let i = 0; i < 100 && (await Promise.resolve(true)); i++) await sleep(5)
  }
  const titles = (outline) => (outline ? outline.topics.map((t) => /Chủ đề ([A-Z])/.exec(t.title)[1]) : [])

  try {
    // ── Pure pieces ──
    check('a call is due only once the open part is long enough and has grown by a step', !lib.liveCallDue(2000, 0, { min: 2500, step: 2500 }) && lib.liveCallDue(2600, 0, { min: 2500, step: 2500 }) && !lib.liveCallDue(4000, 2600, { min: 2500, step: 2500 }) && lib.liveCallDue(5200, 2600, { min: 2500, step: 2500 }))
    const segs = makeRecording('p')
    const lines = lib.buildTranscriptLines(segs.slice(0, 7))
    const first = lib.applyLiveAnswer(fakeAnswer(lines.map((l) => `[${l.ref}] (0:00:00) ${l.text}`).join('\n')), lines, undefined, 'vi', 'now', false)
    check('an answer with two topics names the first and leaves the second open', first.topics.length === 1 && first.topics[0].startSegmentId === 'p-s1' && first.topics[0].endSegmentId === 'p-s5' && first.openFromSegmentId === 'p-s6', first)
    check('only the action items and speakers inside the named topic are kept', first.actions.length === 1 && first.actions[0].startSegmentId === 'p-s3' && first.speakers.length === 1 && first.speakers[0].name === 'Sơn')
    const one = lib.buildTranscriptLines(segs.slice(0, 3))
    const answerOne = fakeAnswer(one.map((l) => `[${l.ref}] (0:00:00) ${l.text}`).join('\n'))
    check('a single topic stays open (nothing is finished yet)', lib.applyLiveAnswer(answerOne, one, undefined, 'vi', 'now', false) === 'unchanged')
    const forced = lib.applyLiveAnswer(answerOne, one, undefined, 'vi', 'now', true)
    check('a very long open part is named as it stands, up to its last paragraph', forced.topics.length === 1 && forced.topics[0].endSegmentId === 'p-s2' && forced.openFromSegmentId === 'p-s3', forced)
    const allLines = lib.buildTranscriptLines(segs)
    const open = lib.openLines(allLines, first)
    const cont = lib.applyLiveAnswer({ continues: true, topics: [{ title: 'x', start: 6 }, { title: 'Chủ đề C', start: 11 }], actions: [], speakers: [] }, open, first, 'vi', 'now', false)
    check('a part that carries on the previous topic extends it instead of starting a new one', cont.topics.length === 1 && cont.topics[0].title === first.topics[0].title && cont.topics[0].endSegmentId === 'p-s10' && cont.openFromSegmentId === 'p-s11', cont.topics)

    // ── The engine, fed a recording ──
    calls = []
    respond = null
    let rec = newRecording()
    const namedWhileRecording = []
    for (const [i, seg] of segs.entries()) {
      rec.session.segments.push(seg)
      rec.outliner.onSegment('rec')
      await settle()
      if (i === 2) check('no AI call before the transcript holds enough for a finished topic', calls.length === 0, { calls: calls.length })
      namedWhileRecording[i] = titles(rec.session.outline).join('')
    }
    check('topic A is named while recording, soon after topic B begins', namedWhileRecording.findIndex((t) => t === 'A') >= 5 && namedWhileRecording.findIndex((t) => t === 'A') <= 8, namedWhileRecording)
    check('topic B is named while recording too, once topic C has begun', namedWhileRecording[13] === 'AB', namedWhileRecording)
    check('the part still being spoken (topic C) stays open', rec.session.outline.openFromSegmentId === 'p-s11')
    check('far fewer AI calls than segments', calls.length > 0 && calls.length <= 5, { calls: calls.length, segments: segs.length })
    const afterA = calls.slice(calls.findIndex((c) => c.refs.includes(6)) + 1)
    check('once topic A is named, its paragraphs are not sent again — each call starts at the open part', afterA.length > 0 && afterA.every((c) => c.refs[0] === 6 && !c.user.includes('đoạn 1:')), calls.map((c) => c.refs))
    check('the action items of finished topics show while recording, next to where they were said', rec.session.outline.actions.map((a) => a.startSegmentId).join() === 'p-s3,p-s8', rec.session.outline.actions)
    check('a speaker who names himself in the recording is labelled (Sơn)', rec.session.outline.speakers.some((s) => s.name === 'Sơn' && s.startSegmentId === 'p-s1'), rec.session.outline.speakers)
    check('the status says when a part is being named', rec.statuses.some((s) => s.working) && rec.statuses[rec.statuses.length - 1].working === false)
    check('the prompts tell the AI that a speaker may name himself in the third person, and only when sure', calls[0].system.includes('call themselves by their own name') && calls[0].system.includes('when in doubt leave the paragraphs out'))

    // ── After Stop: only the rest is outlined, then joined ──
    rec.session.status = 'stopped'
    calls = []
    const { segments: rest, named } = lib.remainingSegments(rec.session.segments, rec.session.outline)
    const tail = await lib.generateOutline(rest, main, 'vi')
    const finished = lib.joinOutlines(named, tail)
    check('Stop: one call for the part left open, and the whole recording is covered', calls.length === 1 && rest[0].id === 'p-s11' && titles(finished).join('') === 'ABC' && !finished.openFromSegmentId && finished.topics[2].endSegmentId === 'p-s14', { calls: calls.length, titles: titles(finished) })
    check('the prompt used after Stop has the speaker rule too', calls[0].system.includes('call themselves by their own name'))

    // ── Daily limit, no backup: stop sending ──
    calls = []
    respond = (call) => (call.url.startsWith('http://main') ? DAILY_429() : null)
    rec = newRecording()
    for (const seg of segs) {
      rec.session.segments.push(seg)
      rec.outliner.onSegment('rec')
      await settle()
    }
    const last = rec.statuses[rec.statuses.length - 1]
    check('daily limit with no backup: one call, then nothing more is sent while recording', calls.length === 1 && last.dailyLimit && last.dailyLimit.limit === 200000 && last.dailyLimit.used === 199500 && !rec.session.outline, { calls: calls.length, last })

    // ── Daily limit with a backup: go on there and say so ──
    calls = []
    rec = newRecording([backup])
    for (const seg of segs) {
      rec.session.segments.push(seg)
      rec.outliner.onSegment('rec')
      await settle()
    }
    const mainCalls = calls.filter((c) => c.url.startsWith('http://main')).length
    check('daily limit with a backup: the backup names the topics, the main model is not asked again', mainCalls === 1 && titles(rec.session.outline).join('') === 'AB' && rec.session.outline.backupModel === 'gpt-oss-20b' && rec.statuses.some((s) => s.backupModel === 'gpt-oss-20b'), { mainCalls, titles: titles(rec.session.outline) })

    // ── Stop while a call is in flight ──
    calls = []
    respond = async () => {
      await sleep(300)
      return null
    }
    rec = newRecording()
    for (const seg of segs.slice(0, 7)) rec.session.segments.push(seg)
    rec.outliner.onSegment('rec')
    await sleep(50)
    const savesBefore = rec.saves()
    const late = await rec.outliner.end('rec')
    check('Stop during a call: the answer is handed back (saved after Stop writes the session), not saved by itself', calls.length === 1 && savesBefore === 0 && rec.saves() === 0 && late && late.topics.length === 1 && late.openFromSegmentId === 'p-s6', { saves: rec.saves(), late: late && late.topics.length })
    rec.session.segments.push(...segs.slice(7))
    rec.outliner.onSegment('rec')
    await sleep(100)
    check('nothing more is sent after Stop', calls.length === 1)
    respond = null

    // ── The same audio sent twice is transcribed once ──
    const s = lib.meetingSessions.start('both', { input: 'vi', transcript: 'vi', summary: 'vi', website: 'vi' })
    const chunk = (startMs, endMs) => ({ startMs, endMs, startedAt: new Date(Date.UTC(2026, 9, 4, 6, 50) + startMs).toISOString(), voice: 'others' })
    let transcribed = 0
    const fn = (text) => async () => {
      transcribed++
      return text
    }
    lib.meetingSessions.enqueueChunk(chunk(0, 21709), fn('Buổi này Sơn cũng nói về cách setup.'))
    lib.meetingSessions.enqueueChunk(chunk(1, 21708), fn('Buổi này Sơn cũng nói về cách setup.'))
    lib.meetingSessions.enqueueChunk(chunk(-40, 21802), fn('Buổi này Sơn cũng nói về cách setup.'))
    lib.meetingSessions.enqueueChunk(chunk(21708, 41812), fn('Hôm nay Sơn làm rất nhiều phòng ban khác nhau.'))
    await sleep(100)
    const stopped = await lib.meetingSessions.stop()
    check('a second and third copy of the same chunk (the 04/10 recording) are ignored: each stretch appears once', stopped.id === s.id && stopped.segments.length === 2 && transcribed === 2 && stopped.segments[0].startMs === 0 && stopped.segments[1].startMs === 21708, stopped.segments.map((x) => x.startMs))
    lib.meetingSessions.delete(s.id)
  } finally {
    ;[console.error, console.warn] = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the user sees ───────────────────────────────────────────────
async function partB() {
  const segs = makeRecording('live')
  const live = { id: 'live', title: 'Meeting — Oct 4, 6:50 AM', createdAt: '2026-10-04T06:50:00.000Z', durationMs: 0, audioSource: 'both', status: 'recording', segments: [] }
  let state = 'idle'
  let win = null
  const calls = { outline: 0 }
  let speakerPatches = []

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  const send = (channel, ...args) => win.webContents.send(channel, ...args)
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [], autoAiSince: '2026-01-01T00:00:00.000Z' }))
  handle(IPC.MEETING_GET_STATE, () => state)
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => (state === 'idle' && live.status === 'recording' ? [] : [{ id: live.id, title: live.title, createdAt: live.createdAt, durationMs: live.durationMs, audioSource: live.audioSource, status: live.status }]))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => (id === live.id ? live : null))
  handle(IPC.MEETING_GET_LIVE_OUTLINE_STATUS, () => null)
  handle(IPC.MEETING_SET_SPEAKER_NAMES, (_event, id, names) => {
    speakerPatches.push({ id, names })
    live.speakerNames = { ...live.speakerNames, ...names }
    send(IPC.MEETING_SESSION_UPDATED, live)
  })
  handle(IPC.MEETING_GENERATE_OUTLINE, async (_event, id) => {
    calls.outline++
    await sleep(300)
    live.outline = { ...live.outline, topics: [...live.outline.topics, { title: 'Chủ đề C của buổi họp', startSegmentId: 'live-s11', endSegmentId: 'live-s14' }], generatedAt: new Date().toISOString() }
    delete live.outline.openFromSegmentId
    send(IPC.MEETING_SESSION_UPDATED, live)
    return live.outline
  })
  let chunks = 0
  ipcMain.on(IPC.MEETING_CHUNK_CAPTURED, () => chunks++)
  ipcMain.on(IPC.MEETING_START, () => {
    state = 'recording'
    send(IPC.MEETING_STATE_CHANGED, 'recording')
    send(IPC.MEETING_CAPTURE_START)
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
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) errors.push(message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const click = async (expr, wait = 350) => {
    const p = await js(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const b = el.getBoundingClientRect(); const x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2); const hit = document.elementFromPoint(x, y); return { x, y, hit: hit ? hit.tagName + '.' + hit.className : null } })()`)
    if (process.env.CHECK_DEBUG) console.log('CLICK', expr.slice(-60), JSON.stringify(p))
    if (!p) throw new Error('element not found: ' + expr)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && b.getClientRects().length > 0)`
  const waitFor = async (code, label, timeout = 8000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
      if (await js(code)) return
      await sleep(50)
    }
    throw new Error('timeout waiting for ' + label)
  }
  const table = () =>
    js(`(() => { const tx = document.querySelector('.txc'); if (!tx) return null; return { cls: tx.className, heads: [...tx.querySelectorAll('.txc-head > span')].filter((e) => e.getClientRects().length).map((e) => (e.matches('.txc-col-text') ? e.firstElementChild : e).textContent.trim().split(/\\s+/).slice(0, 2).join(' ')), sections: [...tx.querySelectorAll('.txc-sec')].map((s) => ({ title: (s.querySelector('.txc-topic h3') || {}).textContent || null, pending: (s.querySelector('.txc-pending-label') || {}).textContent || null, paragraphs: [...s.querySelectorAll('.txc-text')].map((p) => p.dataset.blockId.replace('live-s', '')), actions: [...s.querySelectorAll('.txc-sec-actions .txc-act-text')].map((a) => a.textContent) })), empty: (tx.querySelector('.meeting-transcript-empty') || {}).textContent || null, status: (tx.querySelector('.txc-status') || {}).textContent || null, speakers: [...tx.querySelectorAll('.txc-time')].map((t) => { const s = t.querySelector('.txc-speaker'); return s ? s.textContent.trim() : '' }) } })()`)

  await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
  await waitFor(`!!${button('Start recording')}`, 'Start button')

  // Leave the Meeting tab and come back twice (each visit used to add a recorder), counting microphone requests.
  for (let i = 0; i < 2; i++) {
    await click(button('Transcribe'), 300)
    await click(button('Meeting'), 400)
  }
  await js(`(() => { window.__mic = 0; const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (c) => { window.__mic++; return real(c) }; return true })()`)
  const t0 = Date.now()
  await click(button('Start recording'), 0)
  await waitFor(`!!document.querySelector('.txc')`, 'table after Start')
  const shownAfter = Date.now() - t0
  let t = await table()
  check('pressing Start shows the four-column table at once, before any speech', shownAfter < 1500 && t.heads.join('|').startsWith('Time ·|Topic|Transcript|Action items') && /Listening/.test(t.empty || ''), { shownAfter, heads: t.heads, empty: t.empty })
  await sleep(1500)
  check('after leaving and reopening the Meeting tab twice, Start opens the microphone once — one recorder, not three', (await js('window.__mic')) === 1, { micRequests: await js('window.__mic') })

  // Segments arrive one by one.
  for (const seg of segs.slice(0, 4)) {
    live.segments.push(seg)
    send(IPC.MEETING_SEGMENT_READY, seg, live.id)
    await sleep(60)
  }
  await sleep(300)
  t = await table()
  check('the transcript runs into the middle column as it arrives, in order', t.sections.length === 1 && t.sections[0].paragraphs.join() === '1,2,3,4', t.sections)
  check('the part being spoken has no topic yet and says so', t.sections[0].pending === 'Named when this part ends' && t.sections[0].title === null, t.sections[0])
  check('without a name, the other side of a "Both" recording shows as Others', t.speakers.slice(0, 4).every((s) => s === 'Others'), t.speakers)

  send(IPC.MEETING_LIVE_OUTLINE_STATUS, { sessionId: live.id, working: true })
  await sleep(200)
  t = await table()
  check('while a finished part is being named, the open part says so', /Naming the part just finished/.test(t.sections[0].pending || ''), t.sections[0].pending)

  // Topic A is named while recording: paragraphs 1-5, one action item, Sơn speaking in paragraph 1.
  for (const seg of segs.slice(4, 8)) {
    live.segments.push(seg)
    send(IPC.MEETING_SEGMENT_READY, seg, live.id)
  }
  live.outline = {
    language: 'vi',
    generatedAt: '2026-10-04T06:55:00.000Z',
    topics: [{ title: 'Chủ đề A của buổi họp', startSegmentId: 'live-s1', endSegmentId: 'live-s5' }],
    actions: [{ text: 'Linh gửi số liệu mở bán trước thứ Sáu', startSegmentId: 'live-s3', endSegmentId: 'live-s3' }],
    speakers: [{ name: 'Sơn', startSegmentId: 'live-s1', endSegmentId: 'live-s1' }],
    openFromSegmentId: 'live-s6'
  }
  send(IPC.MEETING_SESSION_UPDATED, live)
  send(IPC.MEETING_LIVE_OUTLINE_STATUS, { sessionId: live.id, working: false })
  await sleep(400)
  t = await table()
  check('a finished part gets its topic while recording, the rest stays open', t.sections.length === 2 && t.sections[0].title === 'Chủ đề A của buổi họp' && t.sections[0].paragraphs.join() === '1,2,3,4,5' && t.sections[1].pending === 'Named when this part ends' && t.sections[1].paragraphs.join() === '6,7,8', t.sections)
  check('its action item shows in the last column, next to its topic', t.sections[0].actions.join() === 'Linh gửi số liệu mở bán trước thứ Sáu' && t.sections[1].actions.length === 0, t.sections.map((s) => s.actions))
  check('the speaker named in the recording replaces "Others" on that paragraph', t.speakers[0] === 'Sơn' && t.speakers[1] === 'Others', t.speakers.slice(0, 3))

  // Topic B named a little later.
  for (const seg of segs.slice(8, 12)) {
    live.segments.push(seg)
    send(IPC.MEETING_SEGMENT_READY, seg, live.id)
  }
  live.outline = {
    ...live.outline,
    generatedAt: '2026-10-04T06:58:00.000Z',
    topics: [...live.outline.topics, { title: 'Chủ đề B của buổi họp', startSegmentId: 'live-s6', endSegmentId: 'live-s10' }],
    actions: [...live.outline.actions, { text: 'Sơn gộp ba bản tài liệu cài đặt', startSegmentId: 'live-s8', endSegmentId: 'live-s8' }],
    openFromSegmentId: 'live-s11'
  }
  send(IPC.MEETING_SESSION_UPDATED, live)
  await sleep(400)
  t = await table()
  check('topics and action items keep appearing part by part', t.sections.map((s) => s.title || 'open').join('|') === 'Chủ đề A của buổi họp|Chủ đề B của buổi họp|open' && t.sections[1].actions.join() === 'Sơn gộp ba bản tài liệu cài đặt' && t.sections[2].paragraphs.join() === '11,12', t.sections)

  if (process.env.CHECK_SHOTS) {
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    fs.writeFileSync(path.join(process.env.CHECK_SHOTS, 'live-1250.png'), (await win.webContents.capturePage()).toPNG())
  }
  // Rename "Others" by hand while recording.
  await click(`[...document.querySelectorAll('.txc-time .txc-speaker')][1]`, 300)
  await js(`(() => { const i = document.querySelector('.txc-speaker-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Anh Sơn'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true })()`)
  await sleep(500)
  t = await table()
  check('renaming "Others" while recording names every paragraph of that speaker and saves it on the recording', speakerPatches.length === 1 && speakerPatches[0].id === 'live' && Object.keys(speakerPatches[0].names).length === 11 && t.speakers.slice(1).every((s) => s === 'Anh Sơn') && t.speakers[0] === 'Sơn', { patch: speakerPatches[0] && Object.keys(speakerPatches[0].names).length, speakers: t.speakers })

  // The daily limit: said in the table, the transcript goes on.
  send(IPC.MEETING_LIVE_OUTLINE_STATUS, { sessionId: live.id, working: false, dailyLimit: { unit: 'tokens', used: 199500, limit: 200000, resetAt: Date.now() + 3600000, viaCloud: false } })
  for (const seg of segs.slice(12, 14)) {
    live.segments.push(seg)
    send(IPC.MEETING_SEGMENT_READY, seg, live.id)
  }
  await sleep(300)
  t = await table()
  check('daily limit while recording: the table says so, with the numbers, and the transcript keeps coming', /daily limit is reached: 199,500 of 200,000 tokens/.test(t.status || '') && /after you press Stop/.test(t.status || '') && t.sections[2].paragraphs.join() === '11,12,13,14', t.status)
  check('no paragraph is shown twice', (await js(`[...document.querySelectorAll('.txc-text')].map((p) => p.dataset.blockId)`)).length === 14)

  // Stop: the past view opens, the part left open is named once.
  live.status = 'stopped'
  live.durationMs = 14 * 40000
  state = 'idle'
  send(IPC.MEETING_STATE_CHANGED, 'idle')
  send(IPC.MEETING_CAPTURE_STOP)
  await waitFor(`document.querySelectorAll('.txc-topic h3').length === 3`, 'finished outline after Stop')
  await sleep(300)
  t = await table()
  check('Stop: the part left open is named (one request) and every paragraph has its topic', calls.outline === 1 && t.sections.map((s) => s.title).join('|') === 'Chủ đề A của buổi họp|Chủ đề B của buổi họp|Chủ đề C của buổi họp' && !t.sections.some((s) => s.pending), { calls: calls.outline, sections: t.sections.map((s) => s.title || s.pending) })
  check('the names typed while recording are kept after Stop', t.speakers[0] === 'Sơn' && t.speakers[5] === 'Anh Sơn', t.speakers.slice(0, 6))
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
