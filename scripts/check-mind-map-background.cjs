/*
 * Automated check for the mind map as a background job: it keeps running whatever the
 * window shows, paces itself to the AI provider's per-minute limit, keeps the parts it
 * has finished so a stopped job continues instead of starting over, and stops with a
 * clear message when it runs out of time.
 *
 * Run with `npm run check:mind-map-background` (builds first). Two parts, no API key,
 * account or network in either:
 *
 *   A. The job code (bundled from src/ on the fly) against a fake AI provider: `fetch`
 *      is replaced by a stub that is slow, enforces a tokens-per-minute limit, rejects
 *      requests that are too large, or fails on purpose. Time is scaled down (the
 *      provider's "minute" lasts a second and a half) so the run takes seconds.
 *   B. The built Settings renderer with the real preload and a stub main process that
 *      plays a job: leaving the tab / the session / the page does not restart it, the
 *      true progress is shown on return, the session list and the tab carry a mark, and
 *      a stopped or interrupted job offers "Continue".
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

const results = []
const check = (name, ok, detail) => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + JSON.stringify(detail)}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A transcript of `count` paragraphs of about `chars` characters, `gapMs` apart. */
function makeSegments(prefix, count, chars, gapMs) {
  return Array.from({ length: count }, (_, i) => {
    let text = `Đoạn ${i + 1}:`
    while (text.length < chars) text += ' chúng ta bàn về kết quả mở bán thử và kế hoạch ra mắt khoá học tháng mười một.'
    return { id: `${prefix}-s${i + 1}`, text, startMs: i * gapMs, endMs: (i + 1) * gapMs, startedAt: new Date(Date.UTC(2026, 8, 20, 12, 40, 0) + i * gapMs).toISOString(), isNewParagraph: true }
  })
}
/** The size of the recording this was reported on: 2 h 28 min, about 84,000 characters in 152 paragraphs. */
const longSegments = () => makeSegments('long', 152, 555, 58_000)

// ── Part A: the job against a fake provider ──────────────────────────────────
async function partA() {
  const outfile = path.join(TMP, 'jobs-lib.cjs')
  require('esbuild').buildSync({
    stdin: {
      contents: `
        export { runMindMap } from './src/main/mindMap'
        export { createMindMapJobs } from './src/main/mindMapJobs'
        export { LANGUAGES } from './src/shared/constants'`,
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
  const { runMindMap, createMindMapJobs, LANGUAGES } = require(outfile)
  const target = { apiKey: 'test', base: 'http://fake.invalid/v1', model: 'm' }

  // The fake provider. `provider` is swapped per scenario.
  let calls = []
  let provider = { latencyMs: 20 }
  let used = []
  const realFetch = globalThis.fetch
  const json = (status, body, headers) => new Response(JSON.stringify(body), { status, headers })
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const system = body.messages[0].content
    const user = body.messages[1].content
    const part = /This is part (\d+) of (\d+)/.exec(user)
    const kind = system.startsWith('You are assembling') ? 'merge' : part ? 'part' : 'single'
    const refs = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]))
    const tokens = Math.ceil((system.length + user.length) / 3)
    const call = { kind, part: part ? Number(part[1]) : 0, refs, tokens, at: Date.now(), status: 200, jsonMode: !!body.response_format }
    calls.push(call)
    const reply = (status, payload, headers) => {
      call.status = status
      return json(status, payload, headers)
    }
    if (provider.maxTokens && tokens > provider.maxTokens) {
      return reply(413, { error: { message: `Request too large for model on tokens per minute (TPM): Limit ${provider.maxTokens}, Requested ${tokens}`, code: 'rate_limit_exceeded' } })
    }
    if (provider.tpm) {
      const now = Date.now()
      used = used.filter((u) => now - u.at < provider.minuteMs)
      const sum = used.reduce((n, u) => n + u.tokens, 0)
      if (sum + tokens > provider.tpm) {
        const wait = Math.max(50, provider.minuteMs - (now - used[0].at))
        return reply(429, { error: { message: 'Rate limit reached for model on tokens per minute (TPM)', code: 'rate_limit_exceeded' } }, { 'retry-after': String(wait / 1000) })
      }
      used.push({ at: now, tokens })
    }
    if (provider.fail && provider.fail(call)) return reply(500, { error: { message: 'The model is overloaded' } })
    if (provider.refuse && provider.refuse(call)) return reply(402, { error: 'Monthly AI limit reached', code: 'ai_quota_exceeded' })
    // What Groq answers when the model's output does not pass its JSON mode check.
    const broken = provider.badJson ? provider.badJson(call) : null
    if (broken && call.jsonMode) {
      return reply(400, { error: { message: "Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", type: 'invalid_request_error', code: 'json_validate_failed', failed_generation: broken.failedGeneration ?? '{"topics": [{"label": "Chủ đề", "note": "Ghi chú bị cắt' } })
    }
    // Honour the caller's time limit like a real slow connection would.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, provider.latencyMs)
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
      })
    })
    const content =
      kind === 'merge'
        ? { title: 'Demo Day', note: 'Tổng quan.', branches: [{ label: 'Tất cả', note: 'Ghi chú.', topics: [...user.matchAll(/^T(\d+)/gm)].map((m) => Number(m[1])) }], decisions: [], actions: [], questions: [] }
        : { title: 'Ghi chú ngắn', topics: [{ label: `Chủ đề ${refs[0]}`, note: 'Ghi chú.', start: refs[0], end: refs[refs.length - 1], points: [] }], decisions: [], actions: [], questions: [] }
    // Without JSON mode a model wraps its JSON in prose, or (plainBroken) still gets it wrong.
    if (broken && broken.plainBroken) return reply(200, { choices: [{ message: { content: 'Here is the outline: {"topics": [{"label": "Chủ đề", "note": "bị cắt' } }] })
    const text = call.jsonMode ? JSON.stringify(content) : 'Here is the JSON you asked for:\n```json\n' + JSON.stringify(content, null, 2) + '\n```\nLet me know if you need anything else.'
    return reply(200, { choices: [{ message: { content: text } }] })
  }
  const quiet = console.error
  console.error = () => {}
  const reset = (next) => {
    calls = []
    used = []
    provider = { latencyMs: 20, ...next }
  }
  const ok = (kind) => calls.filter((c) => c.kind === kind && c.status === 200)
  /** How many paragraphs of `segments` the map's main branches cover, first to last, without a gap. */
  const covered = (map, segments) => {
    const order = new Map(segments.map((s, i) => [s.id, i]))
    const ranges = map.branches.flatMap((b) => b.children).map((n) => [order.get(n.startSegmentId), order.get(n.endSegmentId)]).sort((a, b) => a[0] - b[0])
    let cursor = 0
    for (const [from, to] of ranges) {
      if (from !== cursor) return -1
      cursor = to + 1
    }
    return cursor
  }

  /** A jobs manager on a fresh folder, with one long session and recorded statuses. */
  const makeJobs = (dir, extra = {}) => {
    const session = { id: 'long', title: 'Demo Day', createdAt: '2026-09-20T12:40:00.000Z', durationMs: 152 * 58_000, audioSource: 'both', status: 'stopped', segments: longSegments(), languageConfig: { website: 'vi' } }
    const statuses = []
    const jobs = createMindMapJobs({
      dir,
      getSession: (id) => (id === 'long' ? session : undefined),
      resolveTarget: async () => target,
      saveMindMap: (_id, map) => {
        session.mindMap = map
      },
      notify: (status) => statuses.push({ ...status }),
      languages: LANGUAGES.map((l) => l.code),
      ...extra
    })
    return { jobs, session, statuses }
  }
  const checkpointOf = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'long.json'), 'utf8'))
    } catch {
      return null
    }
  }

  try {
    // ── 1. 2.5 hours, a slow provider with a per-minute limit ──
    // Each part is about 4,400 "tokens"; the allowance fits one per "minute".
    reset({ latencyMs: 250, tpm: 8000, minuteMs: 1500 })
    const progress = []
    let t0 = Date.now()
    let result = await runMindMap(longSegments(), target, 'vi', { onProgress: (p) => progress.push({ ...p }) })
    const total = progress[0].total
    check('2.5-hour recording, slow provider with a per-minute limit: the map is built', !!result.map && covered(result.map, longSegments()) === 152, { parts: total, seconds: ((Date.now() - t0) / 1000).toFixed(1), covered: result.map && covered(result.map, longSegments()) })
    check('…the provider said "too many requests" many times and the run waited instead of failing', calls.filter((c) => c.status === 429).length >= total - 1 && ok('part').length === total && ok('merge').length === 1, { rateLimited: calls.filter((c) => c.status === 429).length, partsOutlined: ok('part').length })
    check('…no part was outlined twice', new Set(ok('part').map((c) => c.part)).size === ok('part').length)
    check('…progress counted every part and said when it was waiting for the limit', progress.some((p) => p.waitingUntil > 0) && progress.filter((p) => p.phase === 'outline').map((p) => p.done).includes(total) && progress[progress.length - 1].phase === 'merge', { steps: [...new Set(progress.map((p) => `${p.phase} ${p.done}/${p.total}`))].length })
    const afterFirstLimit = calls.slice(calls.findIndex((c) => c.status === 429))
    let overlapping = 0
    for (const c of afterFirstLimit.filter((x) => x.status === 200 && x.kind === 'part')) {
      if (afterFirstLimit.some((o) => o !== c && o.status === 200 && o.kind === 'part' && o.at > c.at && o.at < c.at + 200)) overlapping++
    }
    check('…once rate limited, parts go one at a time instead of competing for the same allowance', overlapping === 0, { overlapping })

    // ── 2. A part bigger than the provider allows is cut in two ──
    reset({ maxTokens: 3000 })
    result = await runMindMap(longSegments(), target, 'vi')
    check('a part the provider calls "too large" is cut in two instead of failing the map', !!result.map && covered(result.map, longSegments()) === 152 && calls.some((c) => c.status === 413), { refused: calls.filter((c) => c.status === 413).length, outlined: ok('part').length })
    reset({ maxTokens: 300 })
    result = await runMindMap(longSegments(), target, 'vi')
    check('…and a provider that refuses even small pieces ends the run with a reason, not a spin', !result.map && result.failure.reason === 'refused' && /too large/i.test(result.failure.detail), result.failure)

    // ── 3. One part fails → the job stops, keeps the rest, and continues later ──
    let dir = path.join(TMP, 'jobs-3')
    let { jobs, session, statuses } = makeJobs(dir)
    reset({ latencyMs: 30, fail: (c) => c.kind === 'part' && c.part === 5 })
    let map = await jobs.start('long')
    let stopped = statuses[statuses.length - 1]
    let saved = checkpointOf(dir)
    check('a part that keeps failing stops the job with a reason', map === null && stopped.state === 'stopped' && stopped.reason === 'failed' && /overloaded/.test(stopped.detail) && !session.mindMap, stopped)
    const keptParts = saved.parts.filter(Boolean).length
    check('…the parts already outlined are kept on disk', keptParts >= 4 && keptParts < total && stopped.done === keptParts && saved.state === 'stopped', { kept: keptParts, of: saved.total })
    check('…and the job stays listed as "not finished"', jobs.statuses().length === 1 && jobs.statuses()[0].state === 'stopped')
    reset({ latencyMs: 30 })
    map = await jobs.start('long')
    const redone = ok('part').map((c) => c.part).sort((a, b) => a - b)
    check('"Continue" outlines only the missing parts, then merges — nothing is done twice', !!map && redone.length === total - keptParts && redone.every((n) => !saved.parts[n - 1]) && ok('merge').length === 1 && covered(map, session.segments) === 152, { redone, calls: calls.length })
    check('…the map is saved on the session, the kept parts are cleaned up, and the job reports "done" until looked at', !!session.mindMap && checkpointOf(dir) === null && jobs.statuses()[0].state === 'done')
    jobs.acknowledge('long')
    check('…and is forgotten once the user has seen the map', jobs.statuses().length === 0)

    // ── 4. Time limits ──
    dir = path.join(TMP, 'jobs-4')
    ;({ jobs, session, statuses } = makeJobs(dir, { limits: { partMs: 5000, totalMs: 700 } }))
    reset({ latencyMs: 400 })
    t0 = Date.now()
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    check('a run that passes its total time limit stops by itself and says so', map === null && stopped.state === 'stopped' && stopped.reason === 'time-limit' && Date.now() - t0 < 2500 && stopped.done > 0 && stopped.done < total, { reason: stopped.reason, done: stopped.done, total: stopped.total, ms: Date.now() - t0 })
    dir = path.join(TMP, 'jobs-4b')
    ;({ jobs, session, statuses } = makeJobs(dir, { limits: { partMs: 400, totalMs: 60_000 } }))
    reset({ latencyMs: 5000 })
    t0 = Date.now()
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    check('a provider that does not answer is given up on at the per-part limit, with "did not answer in time"', map === null && stopped.reason === 'timeout' && Date.now() - t0 < 3000, { reason: stopped.reason, ms: Date.now() - t0 })
    dir = path.join(TMP, 'jobs-4c')
    ;({ jobs, session, statuses } = makeJobs(dir, { limits: { partMs: 600, totalMs: 60_000 } }))
    reset({ latencyMs: 30, tpm: 5000, minuteMs: 60_000 })
    t0 = Date.now()
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    check('a provider whose limit never clears within a part\'s time stops the job with "per-minute limit", first part kept', map === null && stopped.reason === 'rate-limit' && stopped.done === 1 && Date.now() - t0 < 3000, { reason: stopped.reason, done: stopped.done, ms: Date.now() - t0 })

    // ── 5. The app is closed while a job runs ──
    dir = path.join(TMP, 'jobs-5')
    ;({ jobs, session, statuses } = makeJobs(dir))
    reset({ latencyMs: 150 })
    const unfinished = jobs.start('long')
    while (!(checkpointOf(dir)?.parts.filter(Boolean).length >= 3)) await sleep(20)
    // What the next launch finds: the folder as it is right now, mid-run.
    const dir2 = path.join(TMP, 'jobs-5-next-launch')
    fs.cpSync(dir, dir2, { recursive: true })
    const atClose = checkpointOf(dir2).parts.filter(Boolean).length
    await unfinished
    const next = makeJobs(dir2)
    next.jobs.restore()
    const found = next.jobs.statuses()[0]
    check('closing the app mid-run: the next launch lists the job as interrupted, with the parts it had', !!found && found.state === 'stopped' && found.reason === 'interrupted' && found.done === atClose && found.total === total, found)
    reset({ latencyMs: 20 })
    map = await next.jobs.start('long')
    check('…and "Continue" there only does the parts that were missing', !!map && ok('part').length === total - atClose && !!next.session.mindMap, { outlined: ok('part').length, missing: total - atClose })

    // ── 6. One job per session, whoever asks ──
    dir = path.join(TMP, 'jobs-6')
    ;({ jobs, session, statuses } = makeJobs(dir))
    reset({ latencyMs: 40 })
    const first = jobs.start('long')
    await sleep(60)
    const second = jobs.start('long')
    const running = jobs.statuses()[0]
    const [m1, m2] = await Promise.all([first, second])
    check('asking again while a job runs joins it — no second run', m1 === m2 && !!m1 && ok('part').length === total && ok('merge').length === 1 && running.state === 'running', { calls: calls.length })
    check('every finished part was reported as it happened', statuses.filter((s) => s.state === 'running' && s.phase === 'outline').map((s) => s.done).join().includes([...Array(total + 1).keys()].slice(1).join()), statuses.map((s) => `${s.state[0]}${s.done}`).join(' '))

    // ── 7. Dictation goes first ──
    dir = path.join(TMP, 'jobs-7')
    let busy = true
    ;({ jobs, session, statuses } = makeJobs(dir, { busy: () => busy }))
    reset({ latencyMs: 20 })
    const held = jobs.start('long')
    await sleep(500)
    const whileBusy = calls.length
    busy = false
    map = await held
    check('while a dictation is being processed the job sends nothing, then goes on', whileBusy === 0 && !!map, { callsWhileBusy: whileBusy })

    // ── 8. No key ──
    dir = path.join(TMP, 'jobs-8')
    ;({ jobs, session, statuses } = makeJobs(dir, { resolveTarget: async () => null }))
    reset({})
    map = await jobs.start('long')
    check('no API key / signed out: stops at once with that reason, without calling anything', map === null && statuses[statuses.length - 1].reason === 'no-key' && calls.length === 0)

    // ── 9. Wispra Cloud's monthly AI allowance runs out on the way ──
    dir = path.join(TMP, 'jobs-9')
    ;({ jobs, session, statuses } = makeJobs(dir, { quotaExceededSince: () => calls.some((c) => c.status === 402) }))
    reset({ latencyMs: 30, refuse: (c) => c.kind === 'part' && c.part >= 4 })
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    check('allowance used up part-way: stops with that reason, keeps the finished parts, and does not keep calling', map === null && stopped.reason === 'quota' && stopped.done === 3 && calls.filter((c) => c.status === 402).length <= 3, { reason: stopped.reason, done: stopped.done, refused: calls.filter((c) => c.status === 402).length })

    // ── 10. The AI's answer cannot be read as JSON (Groq: HTTP 400 "Failed to generate JSON") ──
    const of4 = () => calls.filter((c) => c.part === 4)
    let seen = 0
    reset({ badJson: (c) => (c.part === 4 && seen++ === 0 ? {} : null) })
    result = await runMindMap(longSegments(), target, 'vi')
    check('HTTP 400 "Failed to generate JSON" on a part in the middle: the part is asked again and the map is completed', !!result.map && covered(result.map, longSegments()) === 152 && of4().map((c) => c.status).join() === '400,200' && ok('part').length === total, { part4: of4().map((c) => `${c.status}${c.jsonMode ? ' json' : ' plain'}`), parts: ok('part').length })

    reset({ badJson: (c) => (c.part === 4 ? {} : null) })
    result = await runMindMap(longSegments(), target, 'vi')
    check('JSON mode keeps failing for that part: after two tries it is asked without JSON mode and the JSON is taken out of the text', !!result.map && covered(result.map, longSegments()) === 152 && of4().map((c) => `${c.status}${c.jsonMode ? 'j' : 'p'}`).join() === '400j,400j,200p' && new Set(ok('part').map((c) => c.part)).size === total, { part4: of4().map((c) => `${c.status}${c.jsonMode ? ' json' : ' plain'}`) })

    const usable = JSON.stringify({ topics: [{ label: 'Cứu được', note: 'Ghi chú.', start: 1, end: 1, points: [] }], decisions: [], actions: [], questions: [] })
    reset({ badJson: (c) => (c.part === 4 ? { failedGeneration: `${usable}\n\nI hope this helps!`.replace('"start":1,"end":1', `"start":${c.refs[0]},"end":${c.refs[c.refs.length - 1]}`) } : null) })
    result = await runMindMap(longSegments(), target, 'vi')
    check('…and when the rejected text is usable JSON with something after it, it is used as it is — no extra call', !!result.map && covered(result.map, longSegments()) === 152 && of4().length === 1 && JSON.stringify(result.map).includes('Cứu được'), { part4Calls: of4().length })

    reset({ badJson: (c) => (c.part === 4 && c.refs.length > 12 ? { plainBroken: true } : null) })
    result = await runMindMap(longSegments(), target, 'vi')
    const whole = of4().filter((c) => c.refs.length > 12)
    const halves = of4().filter((c) => c.refs.length <= 12)
    check('the part stays unreadable in every mode: it is cut in two and both halves go through', !!result.map && covered(result.map, longSegments()) === 152 && whole.length === 3 && halves.length === 2 && halves.every((c) => c.status === 200), { wholeTries: whole.length, halves: halves.map((c) => c.refs.length) })

    // Nothing helps for that part: the job stops, says what happened, and keeps the rest.
    dir = path.join(TMP, 'jobs-10')
    ;({ jobs, session, statuses } = makeJobs(dir))
    let poison = null
    reset({
      badJson: (c) => {
        if (c.part === 4 && poison === null) poison = c.refs[0]
        return poison !== null && c.refs.includes(poison) ? { plainBroken: true } : null
      }
    })
    map = await jobs.start('long')
    stopped = statuses[statuses.length - 1]
    saved = checkpointOf(dir)
    const keptNow = saved.parts.filter(Boolean).length
    check('every retry used up (JSON mode, plain mode, halves): the job stops with "the AI returned a broken result" — not "refused", not a key or plan problem', map === null && stopped.state === 'stopped' && stopped.reason === 'bad-answer' && !saved.parts[3], { reason: stopped.reason, detail: stopped.detail, triesOnPart4: of4().length })
    check('…the finished parts are kept', keptNow >= 3 && stopped.done === keptNow && saved.state === 'stopped', { kept: keptNow, of: saved.total })
    reset({})
    map = await jobs.start('long')
    const after = ok('part').map((c) => c.part).sort((a, b) => a - b)
    check('…and "Continue" goes on from the part that failed: only the missing parts, then the map', !!map && after.includes(4) && after.length === total - keptNow && after.every((n) => !saved.parts[n - 1]) && covered(map, session.segments) === 152, { redone: after })
  } finally {
    console.error = quiet
    globalThis.fetch = realFetch
  }
}

// ── Part B: what the user sees ───────────────────────────────────────────────
async function partB() {
  const base = (id, title, segments) => ({ id, title, createdAt: '2026-09-20T12:40:00.000Z', durationMs: segments.length * 58_000, audioSource: 'both', status: 'stopped', segments, summary: 'Tóm tắt.' })
  const sessions = [
    base('long', 'Check long session', makeSegments('long', 40, 300, 58_000)),
    base('other', 'Check other session', makeSegments('other', 6, 200, 40_000)),
    base('halted', 'Check halted session', makeSegments('halted', 30, 300, 58_000)),
    base('closed', 'Check closed session', makeSegments('closed', 30, 300, 58_000))
  ]
  const byId = (id) => sessions.find((s) => s.id === id)
  const mapOf = (id) => ({
    title: 'Demo Day',
    note: 'Tổng quan.',
    language: 'vi',
    generatedAt: new Date().toISOString(),
    branches: [1, 2, 3].map((n) => ({ label: `Nhánh ${n}`, note: 'Ghi chú.', kind: 'topic', startSegmentId: `${id}-s${n}`, endSegmentId: `${id}-s${n + 1}`, children: [{ label: `Ý ${n}`, startSegmentId: `${id}-s${n}`, endSegmentId: `${id}-s${n}`, children: [] }] }))
  })

  // The stub main process: jobs live here, exactly as in the app, and outlive the page.
  const jobs = new Map([
    ['halted', { sessionId: 'halted', state: 'stopped', reason: 'rate-limit', detail: 'Rate limit reached for model on tokens per minute (TPM): Limit 8000', phase: 'outline', done: 4, total: 9, startedAt: new Date().toISOString() }],
    ['closed', { sessionId: 'closed', state: 'stopped', reason: 'interrupted', phase: 'outline', done: 2, total: 9, startedAt: new Date().toISOString() }]
  ])
  const starts = {}
  const acks = []
  let win = null
  const push = (status) => {
    jobs.set(status.sessionId, status)
    if (win && !win.isDestroyed()) win.webContents.send(IPC.MEETING_MIND_MAP_PROGRESS, status)
  }
  /** Moves the running job of `id` on, as the real job does when a part finishes. */
  const advance = (id, patch) => push({ ...jobs.get(id), ...patch })
  const finishers = new Map()
  const finish = (id) => {
    const session = byId(id)
    session.mindMap = mapOf(id)
    push({ ...jobs.get(id), state: 'done', done: jobs.get(id).total })
    if (win && !win.isDestroyed()) win.webContents.send(IPC.MEETING_SESSION_UPDATED, session)
    finishers.get(id)?.(session.mindMap)
  }

  for (const channel of Object.values(IPC)) ipcMain.handle(channel, () => null)
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, fn)
  }
  handle(IPC.GET_SETTINGS, () => ({ modes: [], vocabulary: [], templates: [], appContextRules: [] }))
  handle(IPC.MEETING_GET_STATE, () => 'idle')
  handle(IPC.MEETING_GET_SPACES, () => [])
  handle(IPC.MEETING_GET_SESSIONS, () => sessions.map(({ segments, mindMap, ...summary }) => summary))
  handle(IPC.MEETING_GET_SESSION, (_event, id) => byId(id) ?? null)
  handle(IPC.MEETING_GET_MIND_MAP_JOBS, () => [...jobs.values()])
  handle(IPC.MEETING_ACK_MIND_MAP, (_event, id) => {
    acks.push(id)
    if (jobs.get(id)?.state === 'done') jobs.delete(id)
  })
  handle(IPC.MEETING_GENERATE_MIND_MAP, (_event, id) => {
    const session = byId(id)
    if (session.mindMap) return session.mindMap
    starts[id] = (starts[id] ?? 0) + 1
    const previous = jobs.get(id)
    push({ sessionId: id, state: 'running', phase: 'outline', done: previous?.done ?? 0, total: 9, startedAt: new Date().toISOString() })
    return new Promise((resolve) => finishers.set(id, resolve))
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
  const click = async (expr, wait = 350) => {
    const p = await js(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
    if (!p) throw new Error('element not found: ' + expr)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await sleep(wait)
  }
  const button = (text, scope = 'document') => `[...${scope}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && b.getClientRects().length > 0)`
  const row = (id) => `[...document.querySelectorAll('.meeting-session-row-main')].find((r) => r.textContent.includes('Check ${id} session'))`
  const openSession = (id) => click(row(id), 500)
  const tab = (label) => click(`[...document.querySelectorAll('.meeting-view-btn')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`, 400)
  const waitFor = async (code, label, timeout = 8000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; ) {
      if (await js(code)) return
      await sleep(100)
    }
    throw new Error('timeout waiting for ' + label)
  }
  const load = async () => {
    await win.loadFile(path.join(ROOT, 'out/renderer/index.html'), { query: { page: 'settings', tab: 'meeting' } })
    await waitFor(`document.querySelectorAll('.meeting-session-row-main').length === ${sessions.length}`, 'session list')
  }
  const overlay = () =>
    js(`(() => { const o = [...document.querySelectorAll('.mm-overlay')].find((e) => e.getClientRects().length > 0); if (!o) return null; const bar = o.querySelector('.mm-gen-bar i'); return { title: (o.querySelector('.mm-overlay-title') || {}).textContent || '', step: (o.querySelector('.mm-overlay-step') || {}).textContent || '', detail: (o.querySelector('.mm-overlay-detail') || {}).textContent || '', bar: bar ? bar.style.width : '', button: (o.querySelector('button') || {}).textContent || '', foot: (o.querySelector('.mm-overlay-foot') || {}).textContent || '' } })()`)
  const tagOf = (id) => js(`(() => { const r = ${row(id)}; const t = r && r.querySelector('.meeting-session-map-tag'); return t ? t.className.replace('meeting-session-map-tag', '').trim() + ': ' + t.textContent.trim() : null })()`)
  const tabDot = () => js(`(() => { const b = [...document.querySelectorAll('.meeting-view-btn')].find((x) => x.textContent.trim() === 'Mind map'); const d = b && b.querySelector('.meeting-map-dot'); return d ? d.className.replace('meeting-map-dot', '').trim() : null })()`)

  const shot = async (name) => {
    if (!process.env.CHECK_SHOTS) return
    fs.mkdirSync(process.env.CHECK_SHOTS, { recursive: true })
    fs.writeFileSync(path.join(process.env.CHECK_SHOTS, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }

  await load()
  check('jobs left unfinished show in the session list as soon as the page opens', (await tagOf('halted')) === 'stopped: Mind map not finished' && (await tagOf('closed')) === 'stopped: Mind map not finished' && (await tagOf('long')) === null)

  // ── Start, then leave ──
  await openSession('long')
  await tab('Mind map')
  await waitFor(`!!document.querySelector('.mm-overlay-title')`, 'building overlay')
  let o = await overlay()
  check('opening the Mind map tab starts the job once and says it runs in the background', starts.long === 1 && o.title === 'Building the mind map' && /keeps running in the background/.test(o.foot), o)
  advance('long', { done: 2 })
  await sleep(300)
  o = await overlay()
  check('progress is the real count of parts, not a fixed "Reading the transcript"', /^2 of 9 parts done/.test(o.step) && o.bar === '20%' && (await tagOf('long')) === 'running: Mind map 2/9' && (await tabDot()) === 'running', { step: o.step, bar: o.bar, tag: await tagOf('long') })

  await shot('running')
  await tab('Summary')
  advance('long', { done: 3 })
  await tab('Transcript')
  await tab('Mind map')
  o = await overlay()
  check('another tab of the recording and back: same job, true progress at once, no restart', starts.long === 1 && /^3 of 9 parts done/.test(o.step), { starts: starts.long, step: o.step })

  await openSession('other')
  advance('long', { done: 5 })
  await sleep(300)
  check('another recording open: the job goes on, and its row in the list shows it', starts.long === 1 && (await tagOf('long')) === 'running: Mind map 5/9', await tagOf('long'))
  await openSession('long')
  await tab('Mind map')
  o = await overlay()
  check('back to the recording: true progress at once, no restart', starts.long === 1 && /^5 of 9 parts done/.test(o.step) && o.bar === '50%', { starts: starts.long, step: o.step })

  // Leaving the Meeting page (Dictate, History…) unmounts it; coming back mounts it anew.
  advance('long', { done: 6, waitingUntil: Date.now() + 60_000 })
  await load()
  check('leaving the Meeting page and coming back: the list still shows the running job', (await tagOf('long')) === 'running: Mind map 6/9')
  await openSession('long')
  await tab('Mind map')
  await waitFor(`!!document.querySelector('.mm-overlay-step')`, 'overlay after remount')
  o = await overlay()
  check('…and the tab shows where it is — here waiting for the provider\'s per-minute limit — without starting again', starts.long === 1 && /^6 of 9 parts done — waiting for the AI provider's per-minute limit/.test(o.step), { starts: starts.long, step: o.step })

  // Minimised: nothing in the page drives the job, so it simply goes on.
  win.minimize()
  await sleep(300)
  advance('long', { done: 9, phase: 'merge', waitingUntil: undefined })
  win.restore()
  win.showInactive()
  win.setPosition(-4000, -4000)
  await sleep(500)
  o = await overlay()
  check('minimised and restored: still the same job, now on its last step', starts.long === 1 && /All parts done — putting them together/.test(o.step), o && o.step)

  // ── Finishes while the user is elsewhere ──
  await openSession('other')
  finish('long')
  await sleep(400)
  check('finished while another recording is open: its row says "Mind map ready"', (await tagOf('long')) === 'done: Mind map ready' && acks.length === 0, await tagOf('long'))
  await openSession('long')
  check('…the Mind map tab carries the mark too, until it is opened', (await tabDot()) === 'done')
  await tab('Mind map')
  await waitFor(`document.querySelectorAll('.mm-panel svg g').length > 0 && !document.querySelector('.mm-overlay')`, 'the finished map')
  await sleep(300)
  check('opening it shows the map, clears the mark, and starts nothing', starts.long === 1 && acks.join() === 'long' && (await tagOf('long')) === null && (await tabDot()) === null, { starts: starts.long, acks })

  // ── A job that stopped part-way ──
  await openSession('halted')
  await tab('Mind map')
  await sleep(900)
  o = await overlay()
  check('a job stopped by the provider\'s limit: says why, what is kept, and does not restart by itself', starts.halted === undefined && /per-minute limit/.test(o.title) && /4 of 9 parts are done and kept/.test(o.step) && /Limit 8000/.test(o.detail) && o.button === 'Continue', o)
  await shot('stopped')
  await click(button('Continue', `document.querySelector('.mm-panel')`), 500)
  o = await overlay()
  check('"Continue" starts it once, from the kept parts', starts.halted === 1 && /^4 of 9 parts done/.test(o.step), { starts: starts.halted, step: o.step })
  advance('halted', { state: 'stopped', reason: 'time-limit', done: 7 })
  await sleep(1200)
  o = await overlay()
  check('past the time limit: stops with a clear message and "Continue" — no endless spinner, no automatic retry', starts.halted === 1 && /taking too long/.test(o.title) && /7 of 9 parts are done and kept/.test(o.step) && o.button === 'Continue' && (await tagOf('halted')) === 'stopped: Mind map not finished', o)

  advance('halted', { state: 'stopped', reason: 'bad-answer', detail: "HTTP 400 — Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", done: 7 })
  await sleep(500)
  o = await overlay()
  check('the AI\'s answer kept coming back broken: the message says so, says it is not the key or plan, keeps the parts, offers "Continue"', o.title === 'The AI returned a result that could not be used' && /not a problem with your API key or plan/.test(o.step) && !/Check your/.test(o.step) && /7 of 9 parts are done and kept/.test(o.step) && /Failed to generate JSON/.test(o.detail) && o.button === 'Continue', o)
  advance('halted', { state: 'stopped', reason: 'refused', detail: "HTTP 400 — Failed to generate JSON. Please adjust your prompt. See 'failed_generation' for more details.", done: 2, total: 8 })
  await sleep(500)
  o = await overlay()
  check('a job that 0.6.1 stopped with this error (recorded there as "refused") shows the corrected message too', o.title === 'The AI returned a result that could not be used' && !/Check your/.test(o.step) && /2 of 8 parts are done and kept/.test(o.step), o)
  advance('halted', { state: 'stopped', reason: 'refused', detail: 'HTTP 401 — Invalid API Key', done: 2, total: 8 })
  await sleep(500)
  o = await overlay()
  check('a real refusal (HTTP 401) still points at the API key', o.title === 'The AI provider refused the request' && /Check your API key or plan/.test(o.step), o)

  // ── The app was closed mid-run ──
  await openSession('closed')
  await tab('Mind map')
  await sleep(900)
  o = await overlay()
  check('a job cut short by closing the app: says it was not finished and offers to continue', starts.closed === undefined && o.title === 'The mind map was not finished' && /Wispra was closed while it was being built. 2 of 9 parts are done and kept/.test(o.step) && o.button === 'Continue', o)
  await click(button('Continue', `document.querySelector('.mm-panel')`), 400)
  finish('closed')
  await waitFor(`document.querySelectorAll('.mm-panel svg g').length > 0 && !document.querySelector('.mm-overlay')`, 'the continued map')
  check('…and continuing it ends with the map', starts.closed === 1)

  // ── A failure with nothing kept ──
  const fresh = base('fresh', 'Check fresh session', makeSegments('fresh', 8, 200, 40_000))
  sessions.push(fresh)
  await load()
  await openSession('fresh')
  await tab('Mind map')
  await sleep(400)
  advance('fresh', { state: 'stopped', reason: 'offline', done: 0, total: 1 })
  finishers.get('fresh')(null)
  await sleep(1200)
  o = await overlay()
  check('a failure with nothing to keep offers "Try again", once', starts.fresh === 1 && o.title === 'Could not reach the AI' && o.button === 'Try again', o)
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
