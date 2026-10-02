import {
  MIND_MAP_CONCURRENCY,
  MIND_MAP_MAX_PARTS,
  MIND_MAP_PART_CHARS,
  MIND_MAP_SINGLE_PASS_CHARS
} from '@shared/constants'
import type { MeetingMindMap, MeetingSegment, MindMapProgress } from '@shared/types'
import { ANTI_FABRICATION_RULE, languageName, type ChatTarget } from './postprocess'
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

const CALL_TIMEOUT_MS = 60_000
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

const TRANSCRIPT_FORMAT =
  'The transcript is given as one tagged line per paragraph: "[ref] (h:mm:ss) text" — ref is that paragraph\'s reference number.'

const JSON_ONLY = 'Respond with ONLY a JSON object (no markdown, no code fences, no explanation) in this exact shape:'

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

/**
 * One JSON-mode chat call. Retries once on a failure that can pass (timeout, 5xx,
 * cut-off JSON) and waits out a rate limit; a refused request (bad key, bad input) is
 * not retried. Returns the parsed object, or null — never throws.
 */
async function callJson(
  target: ChatTarget,
  system: string,
  user: string,
  maxTokens: number,
  what: string
): Promise<Record<string, unknown> | null> {
  let rateLimitWaits = 0
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    try {
      const response = await fetch(`${target.base}/chat/completions`, {
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
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
      })
      if (!response.ok) {
        console.error(`[meeting] mind map ${what}: HTTP ${response.status} — ${(await response.text().catch(() => '')).slice(0, 500)}`)
        if (response.status === 429) {
          // Several parts are outlined at once, so a per-minute limit is easy to hit on a
          // long recording: wait as told and try again, without using up the retry above.
          if (rateLimitWaits++ >= MAX_RATE_LIMIT_WAITS) return null
          const retryAfter = Number(response.headers.get('retry-after'))
          await sleep(Math.min(MAX_RATE_LIMIT_WAIT_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000))
          attempt--
          continue
        }
        if (response.status >= 500) continue
        return null
      }
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const raw = data.choices?.[0]?.message?.content?.trim()
      if (!raw) {
        console.error(`[meeting] mind map ${what}: empty response content`)
        continue
      }
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed: unknown = JSON.parse(cleaned)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
      console.error(`[meeting] mind map ${what}: response was not a JSON object`)
    } catch (err) {
      console.error(`[meeting] mind map ${what} failed:`, err)
    }
  }
  return null
}

/** Runs `task` over `items` with at most `limit` in flight, keeping results in order. */
async function mapLimited<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

/**
 * Builds the mind map of a finished session's transcript in `language` ("auto" = same
 * as the transcript). Returns null on any failure (offline, bad key/token, a part that
 * could not be outlined, an answer with no topics) so the caller keeps whatever map the
 * session already had and the renderer can offer "Try again" — never throws, and never
 * returns a map with a stretch of the recording silently missing.
 */
export async function generateMindMap(
  segments: MeetingSegment[],
  target: ChatTarget,
  language: string,
  onProgress?: (progress: Omit<MindMapProgress, 'sessionId'>) => void
): Promise<MeetingMindMap | null> {
  const lines = buildTranscriptLines(segments)
  if (lines.length === 0) return null

  if (linesLength(lines) <= MIND_MAP_SINGLE_PASS_CHARS) {
    onProgress?.({ phase: 'outline', done: 0, total: 1 })
    const raw = await callJson(
      target,
      `${SINGLE_PROMPT}\n${languageRule(language, 'transcript')}`,
      transcriptOf(lines),
      SINGLE_MAX_TOKENS,
      'outline'
    )
    if (!raw) return null
    const outline = parseOutline(raw, lines, 2)
    if (outline.topics.length === 0) {
      console.error('[meeting] mind map outline: response JSON had no topics')
      return null
    }
    return assembleMindMap({
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

  const parts = splitIntoParts(lines, MIND_MAP_PART_CHARS, MIND_MAP_MAX_PARTS)
  let done = 0
  // One part that cannot be outlined fails the whole map, so the parts still waiting are skipped.
  let failed = false
  onProgress?.({ phase: 'outline', done, total: parts.length })
  const outlines = await mapLimited(parts, MIND_MAP_CONCURRENCY, async (part, index): Promise<Outline | null> => {
    if (failed) return null
    const raw = await callJson(
      target,
      `${PART_PROMPT}\n${languageRule(language, 'transcript')}`,
      `This is part ${index + 1} of ${parts.length}.\n\n${transcriptOf(part)}`,
      PART_MAX_TOKENS,
      `part ${index + 1}/${parts.length}`
    )
    if (!raw) {
      failed = true
      return null
    }
    onProgress?.({ phase: 'outline', done: ++done, total: parts.length })
    return parseOutline(raw, part, 1)
  })
  if (outlines.some((o) => o === null)) return null

  const all: Outline = { topics: [], decisions: [], actions: [], questions: [] }
  for (const outline of outlines as Outline[]) {
    all.topics.push(...outline.topics)
    all.decisions.push(...outline.decisions)
    all.actions.push(...outline.actions)
    all.questions.push(...outline.questions)
  }
  if (all.topics.length === 0) {
    console.error('[meeting] mind map: no part produced a topic')
    return null
  }

  onProgress?.({ phase: 'merge', done: parts.length, total: parts.length })
  const merged = await callJson(
    target,
    `${MERGE_PROMPT}\n${languageRule(language, 'lists')}`,
    describeForMerge(all, lines),
    MERGE_MAX_TOKENS,
    'merge'
  )
  if (!merged) return null
  const branches = groupTopics(merged, all.topics)
  if (!branches) {
    console.error('[meeting] mind map merge: response JSON had no usable branches')
    return null
  }
  return assembleMindMap({
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
