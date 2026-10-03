import {
  MIND_MAP_CONCURRENCY,
  MIND_MAP_MAX_PARTS,
  MIND_MAP_PART_CHARS,
  MIND_MAP_SINGLE_PASS_CHARS
} from '@shared/constants'
import type { MeetingOutline, MeetingSegment, OutlineProgress } from '@shared/types'
import { ANTI_FABRICATION_RULE, languageName, type ChatTarget } from './postprocess'
import { callJson, mapLimited, JSON_ONLY, TRANSCRIPT_FORMAT } from './mindMap'
import { buildTranscriptLines, formatLine, linesLength, splitIntoParts, type TranscriptLine } from './mindMapLogic'
import { applyMerge, assembleOutline, describeForMerge, parseOutline, type RefOutline } from './outlineLogic'

// ── Transcript outline: topics, action items and speaker names ───────────────
// What the Transcript tab's four columns are built from. Made once per session (right
// after Stop, or the first time an older session is opened), then cached on the session
// (see setOutline in meetingSessions.ts). Same shape as the mind map's generation, and
// the same part sizes: a transcript that fits one call is outlined directly; a longer
// one part by part, then one small call joins topics cut at a part boundary and drops
// action items repeated later — so the middle of a long recording is never skipped.

// gpt-oss-120b spends part of the budget on hidden reasoning before it writes the JSON.
// The answer itself is short (titles and one-line tasks), so these are smaller than the mind map's.
const SINGLE_MAX_TOKENS = 4000
const PART_MAX_TOKENS = 2500
const MERGE_MAX_TOKENS = 3000

const SHAPE =
  '{"topics": [{"title": "...", "start": 1}], "actions": [{"text": "...", "owner": "...", "due": "...", "ref": 9}], "speakers": [{"name": "...", "start": 1, "end": 3}]}'

const ACTION_RULES = `- "actions": tasks someone is to do after the recording — things that were assigned, promised or agreed to be done. "text" says the task in one short line that starts with a verb. "ref" is the ref of the paragraph where the task is stated. "owner" and "due" only when the transcript says who / by when; otherwise leave those keys out. List each task once, at the place it is first stated clearly. If there are no tasks, return an empty array: never turn ordinary discussion, opinions or decisions into tasks, and never invent one so that a topic has something next to it.
- "speakers": only when the transcript itself makes clear who is speaking — someone says their own name ("I'm Sơn", "mình là Sơn") or is introduced right before they speak ("over to Linh", "mời Linh báo cáo"). Give the name as it is said, and the refs of the first and last paragraph that person clearly speaks. Never guess from context or style; when in doubt leave the paragraphs out. Return an empty array if nobody is named.
- Use only refs that appear in the transcript.`

const SINGLE_PROMPT = `You organise a meeting/voice-memo transcript so it can be re-read quickly: you divide it into topics, list the action items it contains, and note who is speaking where the transcript says so. ${TRANSCRIPT_FORMAT}

${JSON_ONLY}
${SHAPE}

- "topics": the sections of the transcript, in order. A topic begins at the paragraph whose ref is "start" and runs until the next topic begins; the first topic begins at the first paragraph. Begin a new topic only where the subject really changes — several minutes on one subject are one topic (as a guide, one topic per 3-10 minutes of talk; a short memo may be a single topic). "title" says what that stretch is about in 2-7 specific words, with no numbering.
${ACTION_RULES}
${ANTI_FABRICATION_RULE}`

const PART_PROMPT = `You are organising one part of a long meeting/voice-memo recording so it can be re-read quickly; the other parts are handled separately and joined afterwards. You divide this part into topics, list the action items it contains, and note who is speaking where the transcript says so. ${TRANSCRIPT_FORMAT}

${JSON_ONLY}
${SHAPE}

- "topics": the sections of THIS part, in order (usually 1-4). A topic begins at the paragraph whose ref is "start" and runs until the next topic begins; the first topic begins at this part's first paragraph, even if the subject started earlier in the recording. Begin a new topic only where the subject really changes. "title" says what that stretch is about in 2-7 specific words, with no numbering.
${ACTION_RULES}
${ANTI_FABRICATION_RULE}`

const MERGE_PROMPT = `You are tidying the outline of a long meeting/voice-memo recording that was made part by part. You are given numbered lists: TOPICS (T1, T2, … in order, each with its time range) and ACTIONS (A1, …, each with the time it was stated).

${JSON_ONLY}
{"topics": [{"from": 1, "to": 1, "title": "..."}, {"from": 2, "to": 3, "title": "..."}], "actions": [1, 2, 4]}

- "topics": go through the topics in order and give them back as runs. Where two or more consecutive topics are really one subject — typically one that was cut where a part ended — join them: "from" and "to" are the first and last topic number of the run and "title" names the joined topic in 2-7 specific words. A topic that stands on its own is a run of one ("from" equals "to"); keep its title. Every topic number belongs to exactly one run, and runs follow the order of the recording. Do not join topics just to have fewer.
- "actions": the numbers to keep. Leave out an action that repeats an earlier one (for example a task restated in a recap at the end). Keep everything else.
- Use only what the lists say. NEVER invent topics or tasks that are not in them.`

/** "auto" mirrors the source, like every other meeting prompt; any other code fixes the language. */
function languageRule(language: string, source: 'transcript' | 'lists'): string {
  const what = 'every topic title and action text (and the wording of "due")'
  if (language === 'auto') return `- Write ${what} in the SAME language as the ${source}. Names of people stay as they are said.`
  return `- Write ${what} in ${languageName(language)}, even where the ${source} ${source === 'lists' ? 'are' : 'is'} in another language — translate, never copy wording in another language. Names of people, products and companies stay as they are said.`
}

const transcriptOf = (lines: TranscriptLine[]): string => lines.map(formatLine).join('\n')

/**
 * Builds the outline of a finished session's transcript in `language` ("auto" = same
 * as the transcript). Returns null when it could not be built (offline, bad key/token,
 * a part that could not be outlined, an answer with no topics) so the caller keeps
 * whatever the session had and the renderer can offer "Try again" — never throws, and
 * never returns an outline with a stretch of the recording missing. A failed merge
 * call is not fatal: the parts' own topics and actions are used as they are.
 */
export async function generateOutline(
  segments: MeetingSegment[],
  target: ChatTarget,
  language: string,
  onProgress?: (progress: Omit<OutlineProgress, 'sessionId'>) => void
): Promise<MeetingOutline | null> {
  const lines = buildTranscriptLines(segments)
  if (lines.length === 0) return null

  if (linesLength(lines) <= MIND_MAP_SINGLE_PASS_CHARS) {
    onProgress?.({ phase: 'outline', done: 0, total: 1 })
    const raw = await callJson(target, `${SINGLE_PROMPT}\n${languageRule(language, 'transcript')}`, transcriptOf(lines), SINGLE_MAX_TOKENS, 'transcript outline')
    const outline = raw && parseOutline(raw, lines)
    if (!outline) return null
    return assembleOutline(outline, lines, language, new Date().toISOString())
  }

  const parts = splitIntoParts(lines, MIND_MAP_PART_CHARS, MIND_MAP_MAX_PARTS)
  let done = 0
  // One part that cannot be outlined fails the whole outline, so the parts still waiting are skipped.
  let failed = false
  onProgress?.({ phase: 'outline', done, total: parts.length })
  const outlines = await mapLimited(parts, MIND_MAP_CONCURRENCY, async (part, index): Promise<RefOutline | null> => {
    if (failed) return null
    const raw = await callJson(
      target,
      `${PART_PROMPT}\n${languageRule(language, 'transcript')}`,
      `This is part ${index + 1} of ${parts.length}.\n\n${transcriptOf(part)}`,
      PART_MAX_TOKENS,
      `transcript outline part ${index + 1}/${parts.length}`
    )
    const outline = raw && parseOutline(raw, part)
    if (!outline) {
      failed = true
      return null
    }
    onProgress?.({ phase: 'outline', done: ++done, total: parts.length })
    return outline
  })
  if (outlines.some((o) => o === null)) return null

  let all: RefOutline = { topics: [], actions: [], speakers: [] }
  for (const outline of outlines as RefOutline[]) {
    all.topics.push(...outline.topics)
    all.actions.push(...outline.actions)
    all.speakers.push(...outline.speakers)
  }

  onProgress?.({ phase: 'merge', done: parts.length, total: parts.length })
  const merged = await callJson(target, `${MERGE_PROMPT}\n${languageRule(language, 'lists')}`, describeForMerge(all, lines), MERGE_MAX_TOKENS, 'transcript outline merge')
  if (merged) all = applyMerge(merged, all)
  return assembleOutline(all, lines, language, new Date().toISOString())
}
