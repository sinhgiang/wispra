import { createHash } from 'crypto'
import type { DailyLimitInfo, MindMapStopReason } from '@shared/types'
import { dailyLimitInfo, parseRateLimit } from './rateLimit'
import {
  MIND_MAP_CALL_TIMEOUT_MS,
  MIND_MAP_CONCURRENCY,
  MIND_MAP_MAX_PARTS,
  MIND_MAP_MAX_RATE_LIMIT_WAIT_MS,
  MIND_MAP_PART_TIME_LIMIT_MS,
  MIND_MAP_TOTAL_TIME_LIMIT_MS,
  WISPRA_API_BASE,
  MIND_MAP_PART_CHARS,
  MIND_MAP_SINGLE_PASS_CHARS
} from '@shared/constants'
import type { MeetingMindMap, MeetingSegment, MindMapProgress } from '@shared/types'
import { ANTI_FABRICATION_RULE, languageName, type ChatTarget } from './postprocess'
import { aiQuota } from './aiQuota'
import {
  assembleMindMap,
  buildTranscriptLines,
  cleanNote,
  cleanTitle,
  describeForMerge,
  formatLine,
  groupTopics,
  keepListed,
  linesLength,
  parseOutline,
  resolveBranchLabels,
  splitIntoParts,
  type Outline,
  type TranscriptLine
} from './mindMapLogic'

// ── Meeting mind map ─────────────────────────────────────────────────────────
// Built the first time the Mind map tab of a stopped session is opened, then cached on
// the session (see setMindMap in meetingSessions.ts). A transcript that fits one call
// is mapped directly; a longer one is outlined part by part and the outlines are merged
// in one more call, so a multi-hour meeting keeps its middle (the summary and content
// prompts in postprocess.ts only sample both ends of a long transcript).
//
// A run is a background job (mindMapJobs.ts): it can take many minutes on a provider
// with a low per-minute limit, so it paces itself to that limit, hands each finished
// part to the caller to keep, and has a time limit per part and in total.

// gpt-oss-120b spends part of the budget on hidden reasoning before it writes the JSON
// (see generateMeetingTitle in postprocess.ts) — sized with margin so the JSON is never cut.
const SINGLE_MAX_TOKENS = 6000
const PART_MAX_TOKENS = 3500
const MERGE_MAX_TOKENS = 4000
/** Extra attempts after a failed call (timeout, 5xx, rate limit, unparseable JSON). */
const CALL_RETRIES = 1
const MAX_RATE_LIMIT_WAIT_MS = 20_000
/** Times one call waits out a rate limit (HTTP 429) before giving up. */
const MAX_RATE_LIMIT_WAITS = 3
/**
 * Answers one call may get that cannot be read as JSON before it gives up. The first two
 * tries ask in JSON mode; the last asks without it and takes the JSON out of the text —
 * a provider that validates JSON mode (Groq answers HTTP 400 "Failed to generate JSON")
 * then has nothing to reject.
 */
const MAX_BAD_ANSWERS = 3

export const TRANSCRIPT_FORMAT =
  'The transcript is given as one tagged line per paragraph: "[ref] (h:mm:ss) text" — ref is that paragraph\'s reference number.'

export const JSON_ONLY = 'Respond with ONLY a JSON object (no markdown, no code fences, no explanation) in this exact shape:'

const ITEM_RULES = `- Every "label" is 2-6 words, specific, and carries the fact when there is one ("Revenue up 18%", not "Revenue"). Every "note" is one or two sentences with the concrete detail behind the label: names, numbers, reasons.
- "start"/"end": the ref numbers (shown in brackets) of the first and last paragraph the item is about — the same number twice for a single paragraph. Use only refs that appear in the transcript.
- "decisions": what was actually decided. "actions": tasks someone is to do afterwards — "owner" and "due" only when the transcript states them, otherwise leave those keys out. "questions": questions that were raised and left unanswered. Use an empty array for any of the three the transcript does not have; never turn ordinary discussion into a decision or a task.`

const BRANCH_LABELS_RULE =
  '- "branchLabels": the names of those three branches — "Decisions", "Action items", "Open questions" — in the language the map is written in.'

const SINGLE_PROMPT = `You turn a meeting/voice-memo transcript into a mind map that shows the whole recording at a glance. ${TRANSCRIPT_FORMAT}

${JSON_ONLY}
{"title": "...", "note": "...", "topics": [{"label": "...", "note": "...", "start": 1, "end": 4, "points": [{"label": "...", "note": "...", "start": 2, "end": 2, "points": [{"label": "...", "note": "...", "start": 2, "end": 2}]}]}], "decisions": [{"label": "...", "note": "...", "start": 7, "end": 7}], "actions": [{"label": "...", "note": "...", "owner": "...", "due": "...", "start": 9, "end": 9}], "questions": [{"label": "...", "note": "...", "start": 5, "end": 5}], "branchLabels": {"decisions": "...", "actions": "...", "questions": "..."}}

- "title": the centre of the map — what the recording is about, in 2-6 words. No date or time.
- "note": one or two sentences on what the recording covers overall.
- "topics": the main subjects, in the order they were discussed — as many as the recording really has (usually 3-7; one or two for a short memo). Never merge distinct subjects to have fewer, and never split one subject to have more.
- "points": the 2-6 key points under a topic. A point may carry its own "points" (at most 4) only when the transcript gives real detail under it; otherwise leave that key out. Never go deeper than that.
${ITEM_RULES}
${BRANCH_LABELS_RULE}
${ANTI_FABRICATION_RULE}`

const PART_PROMPT = `You are outlining one part of a long meeting/voice-memo recording; the outlines of all parts are merged into one mind map afterwards. ${TRANSCRIPT_FORMAT}

${JSON_ONLY}
{"topics": [{"label": "...", "note": "...", "start": 1, "end": 4, "points": [{"label": "...", "note": "...", "start": 2, "end": 2}]}], "decisions": [{"label": "...", "note": "...", "start": 7, "end": 7}], "actions": [{"label": "...", "note": "...", "owner": "...", "due": "...", "start": 9, "end": 9}], "questions": [{"label": "...", "note": "...", "start": 5, "end": 5}]}

- "topics": the main subjects of THIS part, in the order they were discussed — usually 1-4. A subject that began before this part or runs on after it still counts as a topic here.
- "points": the 2-6 key points under a topic. No deeper level.
${ITEM_RULES}
${ANTI_FABRICATION_RULE}`

const MERGE_PROMPT = `You are assembling the mind map of a long meeting/voice-memo recording from an outline that was made part by part. You are given numbered lists: TOPICS (T1, T2, … in the order they were discussed, with their time range), DECISIONS (D1, …), ACTIONS (A1, …) and QUESTIONS (Q1, …).

${JSON_ONLY}
{"title": "...", "note": "...", "branches": [{"label": "...", "note": "...", "topics": [1, 2, 3]}], "decisions": [1, 2], "actions": [1, 3], "questions": [2], "branchLabels": {"decisions": "...", "actions": "...", "questions": "..."}}

- "title": the centre of the map — what the recording is about, in 2-6 words. No date or time.
- "note": one or two sentences on what the recording covers overall.
- "branches": the main branches of the map. Group the topics into 5-9 branches (fewer when there are fewer than 5 topics): topics that follow each other and belong to the same subject go together. Every topic number goes into exactly one branch, and the branches follow the order of the recording. "label" names what the group is about in 2-6 words; "note" is one or two sentences. A topic that stands on its own is a branch with just that one number.
- "decisions", "actions", "questions": the numbers to keep from each list. Leave out an item that repeats an earlier one, and a question that the DECISIONS list shows was settled later. Keep everything else.
${BRANCH_LABELS_RULE}
- Use only what the lists say. NEVER invent topics, facts or names that are not in them.`

/**
 * The output-language instruction. "auto" mirrors the source, like every other meeting
 * prompt; any other code fixes the language regardless of what was spoken — the map
 * follows the session's "Website & social posts" language (see generateSessionMindMap
 * in index.ts).
 */
function languageRule(language: string, source: 'transcript' | 'lists'): string {
  const what = 'every title, label, note and branch label (and the wording of "owner"/"due")'
  if (language === 'auto') return `- Write ${what} in the SAME language as the ${source}.`
  return `- Write ${what} in ${languageName(language)}, even where the ${source} ${source === 'lists' ? 'are' : 'is'} in another language — translate, never copy wording in another language. Keep names of people, products and companies as they are.`
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Why a JSON call gave up. */
export interface JsonCallFailure {
  kind: 'rate-limit' | 'daily-limit' | 'too-large' | 'timeout' | 'offline' | 'server' | 'refused' | 'bad-answer' | 'deadline'
  status?: number
  /** The provider's own message, shortened. */
  detail?: string
  /** kind "daily-limit": the numbers and the reset time. */
  daily?: DailyLimitInfo
}

/** What a long-running caller hands to callJson so the call fits into its run. */
export interface JsonCallControl {
  /** Give up at this time (ms since epoch), whatever the call is doing. Without one, a per-minute limit gets a few short waits, as for a call with no control. */
  deadline?: number
  /** Awaited before every request; resolves when the request may be sent. */
  gate?: () => Promise<void>
  /** The provider asked to wait this long (HTTP 429) — the caller holds its other calls back too. */
  onRateLimit?: (waitMs: number) => void
  /** Why the call returned null. */
  onFailure?: (failure: JsonCallFailure) => void
}

const TOO_LARGE = /too large|reduce (?:your|the) (?:message|prompt)|context[_ ]length|maximum context/i
/** The provider's JSON mode gave up on what the model wrote (Groq: code "json_validate_failed"). Not a problem with the key, the plan or the request. */
const JSON_MODE_FAILED = /json_validate_failed|failed to generate json|failed_generation/i

/** The JSON object in a model's answer — the whole text, or what sits between its first "{" and last "}" (code fences, a sentence before or after). Null when there is none. */
export function parseJsonObject(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null
  const trimmed = text.trim()
  const candidates = [trimmed]
  const from = trimmed.indexOf('{')
  const to = trimmed.lastIndexOf('}')
  if (from >= 0 && to > from && (from > 0 || to < trimmed.length - 1)) candidates.push(trimmed.slice(from, to + 1))
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

/** What the model had written when the provider's JSON mode rejected it ("failed_generation" in the error body) — often usable as it is. */
function failedGeneration(body: string): string | undefined {
  try {
    const error = (JSON.parse(body) as { error?: unknown })?.error
    // The Wispra Cloud proxy passes the provider's body on as a string inside "error".
    if (typeof error === 'string') return failedGeneration(error)
    const text = (error as { failed_generation?: unknown } | undefined)?.failed_generation
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The message inside a provider's error body ({"error": {"message": "…"}} or {"error": "…"}), shortened. */
function errorDetail(body: string): string {
  let text = body
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    const error = parsed?.error
    // The Wispra Cloud proxy passes the provider's body on as a string inside "error".
    if (typeof error === 'string') return errorDetail(error)
    const message = (error as { message?: unknown } | undefined)?.message
    if (typeof message === 'string') text = message
  } catch {
    /* not JSON — use the text as it is */
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}

/**
 * One JSON-mode chat call. Retries once on a failure that can pass (timeout, 5xx) and
 * waits out a rate limit; a refused request (bad key, bad input) is not retried. An
 * answer that cannot be read as JSON — including the provider's own "could not generate
 * JSON" — is asked for again, the last time without JSON mode (see MAX_BAD_ANSWERS).
 * Returns the parsed object, or null — never throws.
 *
 * With `control` (a background run) a rate limit is waited out for as long as the
 * provider asks, as many times as it takes — until control.deadline; without it, a few
 * short waits and then null, as before.
 */
export async function callJson(
  target: ChatTarget,
  system: string,
  user: string,
  maxTokens: number,
  what: string,
  control?: JsonCallControl
): Promise<Record<string, unknown> | null> {
  let failure: JsonCallFailure = { kind: 'bad-answer' }
  const giveUp = (): null => {
    control?.onFailure?.(failure)
    return null
  }
  const deadline = control?.deadline
  const outOfTime = (): boolean => deadline !== undefined && Date.now() >= deadline
  await control?.gate?.()
  if (outOfTime()) {
    failure = { kind: 'deadline' }
    return giveUp()
  }
  let rateLimitWaits = 0
  let badAnswers = 0
  /** Notes an unreadable answer; true while the call may ask again. */
  const mayAskAgain = (detail: string, status?: number): boolean => {
    failure = { kind: 'bad-answer', status, detail }
    return ++badAnswers < MAX_BAD_ANSWERS && !outOfTime()
  }
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    // The last try for a readable answer goes without JSON mode.
    const jsonMode = badAnswers < MAX_BAD_ANSWERS - 1
    try {
      const response = await aiQuota.fetch(`${target.base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          max_tokens: maxTokens,
          temperature: 0.3,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: AbortSignal.timeout(
          deadline !== undefined ? Math.max(1000, Math.min(MIND_MAP_CALL_TIMEOUT_MS, deadline - Date.now())) : MIND_MAP_CALL_TIMEOUT_MS
        )
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.error(`[meeting] mind map ${what}: HTTP ${response.status} — ${body.slice(0, 500)}`)
        const detail = errorDetail(body)
        if (response.status === 400 && JSON_MODE_FAILED.test(body)) {
          // The model's JSON did not pass the provider's check. What it wrote comes back
          // in the error and is often fine once the text around it is dropped.
          const salvaged = parseJsonObject(failedGeneration(body))
          if (salvaged) return salvaged
          if (!mayAskAgain(detail, 400)) return giveUp()
          await control?.gate?.()
          attempt--
          continue
        }
        // A daily limit (Groq: tokens or requests per day) can take hours to clear: it is
        // reported with its numbers instead of waited out, like a per-minute one would be.
        if (response.status === 429) {
          const limit = parseRateLimit(response.headers.get('retry-after'), body)
          if (limit.scope === 'day') {
            failure = { kind: 'daily-limit', status: 429, detail, daily: dailyLimitInfo(limit, target.base.startsWith(WISPRA_API_BASE)) }
            return giveUp()
          }
        }
        // A request bigger than the provider's per-minute allowance (or the model's
        // context) can never pass, however long we wait: the caller cuts the part in two.
        if (response.status === 413 || ((response.status === 429 || response.status === 400) && TOO_LARGE.test(body))) {
          failure = { kind: 'too-large', status: response.status, detail }
          return giveUp()
        }
        if (response.status === 429) {
          failure = { kind: 'rate-limit', status: 429, detail }
          // Several parts are outlined at once, so a per-minute limit is easy to hit on a
          // long recording: wait as told and try again, without using up the retry above.
          const retryAfter = Number(response.headers.get('retry-after'))
          const asked = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000
          if (control && deadline !== undefined) {
            const wait = Math.min(MIND_MAP_MAX_RATE_LIMIT_WAIT_MS, asked)
            if (Date.now() + wait >= deadline) return giveUp()
            control.onRateLimit?.(wait)
            await sleep(wait)
            await control.gate?.()
          } else {
            if (rateLimitWaits++ >= MAX_RATE_LIMIT_WAITS) return giveUp()
            await sleep(Math.min(MAX_RATE_LIMIT_WAIT_MS, asked))
          }
          attempt--
          continue
        }
        if (response.status >= 500) {
          failure = { kind: 'server', status: response.status, detail }
          continue
        }
        failure = { kind: 'refused', status: response.status, detail }
        return giveUp()
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const raw = data.choices?.[0]?.message?.content?.trim()
      const parsed = parseJsonObject(raw)
      if (parsed) return parsed
      console.error(`[meeting] mind map ${what}: ${raw ? 'response was not a JSON object' : 'empty response content'}`)
      if (!mayAskAgain(raw ? 'The AI answer was not valid JSON.' : 'The AI returned an empty answer.')) return giveUp()
      await control?.gate?.()
      attempt--
      continue
    } catch (err) {
      console.error(`[meeting] mind map ${what} failed:`, err)
      const name = (err as { name?: string } | null)?.name
      if (name === 'TimeoutError' || name === 'AbortError') failure = { kind: 'timeout' }
      else if (!(err instanceof SyntaxError)) failure = { kind: 'offline', detail: String((err as Error)?.message ?? err).slice(0, 240) }
    }
    if (outOfTime()) {
      failure = failure.kind === 'rate-limit' ? failure : { ...failure, kind: failure.kind === 'timeout' ? 'timeout' : 'deadline' }
      return giveUp()
    }
  }
  return giveUp()
}

/** Runs `task` over `items` with at most `limit` in flight, keeping results in order. */
export async function mapLimited<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

const transcriptOf = (lines: TranscriptLine[]): string => lines.map(formatLine).join('\n')

/** Time limits of one run; the defaults are the constants, a test passes smaller ones. */
export interface MindMapLimits {
  partMs: number
  totalMs: number
}

/** Why a run ended without a map — see MindMapStopReason for what each means to the user. */
export interface MindMapRunFailure {
  reason: Exclude<MindMapStopReason, 'interrupted' | 'no-key' | 'quota'>
  detail?: string
  /** reason "daily-limit": the numbers and the reset time. */
  daily?: DailyLimitInfo
}

export interface MindMapRunOptions {
  onProgress?: (progress: Omit<MindMapProgress, 'sessionId'>) => void
  /**
   * Part outlines kept from an earlier, unfinished run of the same transcript: reused
   * when `signature` still matches this run's, so only the missing parts are outlined.
   */
  resume?: { signature: string; parts: Array<Outline | null> }
  /** The run's signature and number of parts, once known — before any AI call. */
  onPlan?: (signature: string, total: number) => void
  /** A part was outlined: the caller keeps it, so a later run can pick up from here. */
  onPartDone?: (index: number, outline: Outline) => void
  /** Awaited before every AI call, on top of the run's own pacing (e.g. "not while a dictation is being processed"). */
  gate?: () => Promise<void>
  limits?: Partial<MindMapLimits>
}

export type MindMapRunResult = { map: MeetingMindMap; failure?: undefined } | { map: null; failure: MindMapRunFailure }

function toRunFailure(failure: JsonCallFailure | null, totalDeadline: number): MindMapRunFailure {
  const detail = failure?.detail || undefined
  if (failure?.kind === 'daily-limit') return { reason: 'daily-limit', detail, daily: failure.daily }
  if (Date.now() >= totalDeadline) return { reason: 'time-limit', detail }
  switch (failure?.kind) {
    case 'rate-limit':
      return { reason: 'rate-limit', detail }
    case 'timeout':
    case 'deadline':
      return { reason: 'timeout', detail }
    case 'offline':
      return { reason: 'offline', detail }
    case 'refused':
      return { reason: 'refused', detail: [failure.status && `HTTP ${failure.status}`, detail].filter(Boolean).join(' — ') || undefined }
    case 'too-large':
      return { reason: 'refused', detail: detail ?? 'The request is too large for this AI provider.' }
    case 'bad-answer':
      return { reason: 'bad-answer', detail }
    default:
      return { reason: 'failed', detail: [failure?.status && `HTTP ${failure.status}`, detail].filter(Boolean).join(' — ') || undefined }
  }
}

/** Identifies a transcript, its split into parts and the language — part outlines are only reused when all three are the same. */
function runSignature(parts: TranscriptLine[][], language: string): string {
  const shape = parts.map((part) => `${part[0].ref}+${part.length}:${linesLength(part)}`).join(',')
  return createHash('sha1').update(`${language}|${shape}`).digest('hex')
}

/**
 * Builds the mind map of a finished session's transcript in `language` ("auto" = same
 * as the transcript). Never throws, and never returns a map with a stretch of the
 * recording silently missing: it is the whole map, or a failure saying why.
 *
 * A long transcript is outlined part by part, MIND_MAP_CONCURRENCY at a time. When the
 * provider answers "too many requests", every call of the run holds back for as long as
 * it asks and the run goes on one part at a time — a key with a small per-minute
 * allowance gets through a long recording slowly instead of failing. A part too big for
 * that allowance is cut in two. Each part has a time budget (waits included) and so has
 * the run; finished parts are reported through onPartDone, and a later run given them
 * back (`resume`) only does what is missing.
 */
export async function runMindMap(
  segments: MeetingSegment[],
  target: ChatTarget,
  language: string,
  options: MindMapRunOptions = {}
): Promise<MindMapRunResult> {
  const lines = buildTranscriptLines(segments)
  if (lines.length === 0) return { map: null, failure: { reason: 'failed', detail: 'The recording has no transcript.' } }
  const limits: MindMapLimits = { partMs: MIND_MAP_PART_TIME_LIMIT_MS, totalMs: MIND_MAP_TOTAL_TIME_LIMIT_MS, ...options.limits }
  const totalDeadline = Date.now() + limits.totalMs

  // Pacing shared by every call of this run.
  let pauseUntil = 0
  let oneAtATime = false
  let lastFailure: JsonCallFailure | null = null
  let progress: Omit<MindMapProgress, 'sessionId'> = { phase: 'outline', done: 0, total: 1 }
  const report = (patch: Partial<Omit<MindMapProgress, 'sessionId'>>): void => {
    progress = { ...progress, ...patch }
    if (progress.waitingUntil === undefined) delete progress.waitingUntil
    options.onProgress?.({ ...progress })
  }
  const gate = async (): Promise<void> => {
    await options.gate?.()
    while (Date.now() < pauseUntil && Date.now() < totalDeadline) await sleep(Math.min(250, pauseUntil - Date.now()))
    if (progress.waitingUntil !== undefined && Date.now() >= pauseUntil) report({ waitingUntil: undefined })
  }
  const controlFor = (deadline: number): JsonCallControl => ({
    deadline: Math.min(deadline, totalDeadline),
    gate,
    onRateLimit: (waitMs) => {
      oneAtATime = true
      pauseUntil = Math.max(pauseUntil, Date.now() + waitMs)
      report({ waitingUntil: pauseUntil })
    },
    onFailure: (failure) => {
      lastFailure = failure
    }
  })
  const fail = (): MindMapRunResult => ({ map: null, failure: toRunFailure(lastFailure, totalDeadline) })

  if (linesLength(lines) <= MIND_MAP_SINGLE_PASS_CHARS) {
    report({ phase: 'outline', done: 0, total: 1 })
    const raw = await callJson(
      target,
      `${SINGLE_PROMPT}\n${languageRule(language, 'transcript')}`,
      transcriptOf(lines),
      SINGLE_MAX_TOKENS,
      'outline',
      controlFor(Date.now() + limits.partMs)
    )
    if (!raw) return fail()
    const outline = parseOutline(raw, lines, 2)
    if (outline.topics.length === 0) {
      console.error('[meeting] mind map outline: response JSON had no topics')
      return { map: null, failure: { reason: 'bad-answer', detail: 'The AI answer had no topics.' } }
    }
    return {
      map: assembleMindMap({
        title: cleanTitle(raw.title) || outline.topics[0].label,
        note: cleanNote(raw.note),
        branches: outline.topics,
        decisions: outline.decisions,
        actions: outline.actions,
        questions: outline.questions,
        labels: resolveBranchLabels(language, raw.branchLabels),
        lines,
        language,
        generatedAt: new Date().toISOString()
      })
    }
  }

  const parts = splitIntoParts(lines, MIND_MAP_PART_CHARS, MIND_MAP_MAX_PARTS)
  const signature = runSignature(parts, language)
  options.onPlan?.(signature, parts.length)
  const kept = options.resume && options.resume.signature === signature ? options.resume.parts : []
  const outlines: Array<Outline | null> = parts.map((_, index) => kept[index] ?? null)
  let done = outlines.filter(Boolean).length
  report({ phase: 'outline', done, total: parts.length })

  /**
   * Outlines one stretch of the transcript. A stretch the provider calls too large, or
   * whose answer could not be read even after the retries, is cut in two (twice at
   * most): a shorter stretch needs a shorter answer, which is far less likely to break.
   */
  const outlineLines = async (part: TranscriptLine[], label: string, deadline: number, depth: number): Promise<Outline | null> => {
    const control = controlFor(deadline)
    let own: JsonCallFailure | null = null
    const raw = await callJson(
      target,
      `${PART_PROMPT}\n${languageRule(language, 'transcript')}`,
      `${label}\n\n${transcriptOf(part)}`,
      PART_MAX_TOKENS,
      label,
      // Parts run side by side: keep this stretch's own failure apart from the others'.
      { ...control, onFailure: (failure) => ((own = failure), control.onFailure?.(failure)) }
    )
    if (raw) return parseOutline(raw, part, 1)
    const kind = (own as JsonCallFailure | null)?.kind
    if ((kind !== 'too-large' && kind !== 'bad-answer') || part.length < 2 || depth >= 2) return null
    const joined: Outline = { topics: [], decisions: [], actions: [], questions: [] }
    for (const half of splitIntoParts(part, linesLength(part) / 2, 2)) {
      const outline = await outlineLines(half, label, deadline, depth + 1)
      if (!outline) return null
      joined.topics.push(...outline.topics)
      joined.decisions.push(...outline.decisions)
      joined.actions.push(...outline.actions)
      joined.questions.push(...outline.questions)
    }
    return joined
  }

  // One part that cannot be outlined stops the run, so the parts still waiting are not started.
  let failed = false
  let next = 0
  const worker = async (workerIndex: number): Promise<void> => {
    while (!failed) {
      // Rate limited: one worker goes on alone, so the calls stop competing for the same allowance.
      if (oneAtATime && workerIndex > 0) return
      while (next < parts.length && outlines[next]) next++
      if (next >= parts.length) return
      const index = next++
      if (Date.now() >= totalDeadline) {
        failed = true
        return
      }
      const outline = await outlineLines(parts[index], `This is part ${index + 1} of ${parts.length}.`, Date.now() + limits.partMs, 0)
      if (!outline) {
        failed = true
        return
      }
      outlines[index] = outline
      options.onPartDone?.(index, outline)
      report({ phase: 'outline', done: ++done, total: parts.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(MIND_MAP_CONCURRENCY, parts.length) }, (_, i) => worker(i)))
  if (outlines.some((o) => o === null)) return fail()

  const all: Outline = { topics: [], decisions: [], actions: [], questions: [] }
  for (const outline of outlines as Outline[]) {
    all.topics.push(...outline.topics)
    all.decisions.push(...outline.decisions)
    all.actions.push(...outline.actions)
    all.questions.push(...outline.questions)
  }
  if (all.topics.length === 0) {
    console.error('[meeting] mind map: no part produced a topic')
    return { map: null, failure: { reason: 'bad-answer', detail: 'The AI found no topics in the recording.' } }
  }

  report({ phase: 'merge', done: parts.length, total: parts.length })
  const merged = await callJson(
    target,
    `${MERGE_PROMPT}\n${languageRule(language, 'lists')}`,
    describeForMerge(all, lines),
    MERGE_MAX_TOKENS,
    'merge',
    controlFor(Date.now() + limits.partMs)
  )
  if (!merged) return fail()
  const branches = groupTopics(merged, all.topics)
  if (!branches) {
    console.error('[meeting] mind map merge: response JSON had no usable branches')
    return { map: null, failure: { reason: 'bad-answer', detail: 'The AI answer for the final step was not usable.' } }
  }
  return {
    map: assembleMindMap({
      title: cleanTitle(merged.title) || branches[0].label,
      note: cleanNote(merged.note),
      branches,
      decisions: keepListed(merged.decisions, all.decisions),
      actions: keepListed(merged.actions, all.actions),
      questions: keepListed(merged.questions, all.questions),
      labels: resolveBranchLabels(language, merged.branchLabels),
      lines,
      language,
      generatedAt: new Date().toISOString()
    })
  }
}

/** runMindMap for a caller that only wants the map: null on any failure. */
export async function generateMindMap(
  segments: MeetingSegment[],
  target: ChatTarget,
  language: string,
  onProgress?: (progress: Omit<MindMapProgress, 'sessionId'>) => void
): Promise<MeetingMindMap | null> {
  return (await runMindMap(segments, target, language, { onProgress })).map
}
