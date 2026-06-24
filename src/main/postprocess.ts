import { GROQ_API_BASE, OPENAI_API_BASE, WISPRA_API_BASE } from '@shared/constants'
import type { Mode, SttProvider } from '@shared/types'

// Use capable models that handle Vietnamese diacritics correctly
const GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile'
const OPENAI_CHAT_MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 30_000
const SUMMARY_TIMEOUT_MS = 30_000

const CRITICAL_RULES = `CRITICAL RULES:
- Return ONLY the corrected text. No explanation, no quotes, no preamble.
- NEVER remove content words or change the meaning.
- NEVER change the language.
- If the text is already correct, return it unchanged.`

const FILLER_INSTRUCTION = `- Remove filler words and sounds: "ừm", "ừ", "à", "ờ", "thì là", "ý là", "kiểu như", "kiểu", "như là", "đó là", "thì", "mà", "uh", "um", "erm", "like", "you know", "I mean", "so", "right", "basically", "literally", "actually" (only when used as meaningless fillers, not when they carry real meaning)`

function buildSystemPrompt(mode?: Mode, vocabulary?: string[], appContextHint?: string): string {
  const vocabLine =
    vocabulary && vocabulary.length > 0
      ? `- Preserve exact spelling of these proper nouns/terms: ${vocabulary.join(', ')}\n`
      : ''

  const contextLine = appContextHint
    ? `Context: ${appContextHint}\n\n`
    : ''

  if (mode?.prompt) {
    const extra = vocabLine ? `\n- ${vocabLine.trim()}` : ''
    return `${contextLine}${mode.prompt}${extra}\n\n${CRITICAL_RULES}`
  }

  const fillerLine = !mode || mode.removeFiller ? `${FILLER_INSTRUCTION}\n` : ''
  return `${contextLine}You are a transcription editor. Fix the raw speech-to-text output:
${fillerLine}${vocabLine}- Capitalize the first word of every sentence and all proper nouns (names of people, places, organizations)
- Add missing punctuation: period (.) at end of sentences, comma (,) between clauses and after introductory phrases, question mark (?) for questions
- Fix obvious spelling errors or misheard words
- Correct Vietnamese diacritics/tones if wrong

${CRITICAL_RULES}`
}

// Split long text into chunks to avoid LLM token limits
const MAX_CHUNK_WORDS = 350

function splitIntoChunks(text: string): string[] {
  const words = text.split(/\s+/)
  if (words.length <= MAX_CHUNK_WORDS) return [text]

  // Prefer splitting at sentence boundaries if present; fall back to word count
  const sentences = text.split(/(?<=[.!?…\n])\s+/)
  const hasSentenceBoundaries = sentences.length > 1

  if (hasSentenceBoundaries) {
    const chunks: string[] = []
    let current = ''
    let currentWords = 0
    for (const sentence of sentences) {
      const sw = sentence.split(/\s+/).length
      if (currentWords + sw > MAX_CHUNK_WORDS && current) {
        chunks.push(current.trim())
        current = sentence
        currentWords = sw
      } else {
        current = current ? `${current} ${sentence}` : sentence
        currentWords += sw
      }
    }
    if (current.trim()) chunks.push(current.trim())
    if (chunks.length > 0) return chunks
  }

  // Raw speech: no punctuation — split strictly by word count
  const chunks: string[] = []
  for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
    chunks.push(words.slice(i, i + MAX_CHUNK_WORDS).join(' '))
  }
  return chunks
}

export async function postProcess(
  text: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  mode?: Mode,
  vocabulary?: string[],
  localBaseUrl?: string,
  localLlmModel?: string,
  appContextHint?: string,
  proxyToken?: string
): Promise<string> {
  if (!text.trim()) return text

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else if (provider === 'proxy') {
    // Route through Wispra Cloud — uses server-side Groq key
    if (!proxyToken) return text
    apiKey = proxyToken
    base = `${WISPRA_API_BASE}/api`
    model = GROQ_CHAT_MODEL
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return text
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  const systemPrompt = buildSystemPrompt(mode, vocabulary, appContextHint)

  // For long texts, process in parallel chunks to avoid token limit truncation
  const chunks = splitIntoChunks(text)
  const results = await Promise.all(chunks.map((chunk) => processChunk(chunk, base, apiKey, model, systemPrompt, provider === 'proxy')))
  return results.join(' ')
}

async function processChunk(
  text: string,
  base: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  isProxy: boolean
): Promise<string> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (isProxy) {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`
    }

    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        max_tokens: 8192,
        temperature: 0
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })

    if (!response.ok) return text

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const result = data.choices?.[0]?.message?.content?.trim()
    if (!result) return text

    // Safety: if model returned near-empty or extremely long output, it likely failed
    const ratio = result.length / text.length
    if (ratio < 0.1 || ratio > 8) return text

    return result
  } catch {
    return text
  }
}

export async function summarizeTexts(
  texts: string[],
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  localBaseUrl?: string,
  localLlmModel?: string
): Promise<string> {
  const combined = texts.slice(0, 50).map((t, i) => `[${i + 1}] ${t}`).join('\n\n')

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) throw new Error('No API key configured — add one in Settings.')
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a productivity assistant. Summarize the following dictated notes into a clear, concise summary. Group related points. Preserve key details like names, dates, and numbers. Use bullet points where helpful. Return only the summary, no preamble.'
        },
        { role: 'user', content: combined }
      ],
      max_tokens: 1024,
      temperature: 0.3
    }),
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
  })

  if (!response.ok) throw new Error(`AI error (HTTP ${response.status})`)
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const result = data.choices?.[0]?.message?.content?.trim()
  if (!result) throw new Error('Empty response from AI')
  return result
}
