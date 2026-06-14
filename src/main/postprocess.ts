import { GROQ_API_BASE, OPENAI_API_BASE } from '@shared/constants'
import type { Mode, SttProvider } from '@shared/types'

// Use capable models that handle Vietnamese diacritics correctly
const GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile'
const OPENAI_CHAT_MODEL = 'gpt-4o-mini'
const TIMEOUT_MS = 20_000

const CRITICAL_RULES = `CRITICAL RULES:
- Return ONLY the corrected text. No explanation, no quotes, no preamble.
- NEVER remove content words or change the meaning.
- NEVER change the language.
- If the text is already correct, return it unchanged.`

const FILLER_INSTRUCTION = `- Remove filler words and sounds: "ừm", "ừ", "à", "ờ", "thì là", "ý là", "kiểu như", "kiểu", "như là", "đó là", "thì", "mà", "uh", "um", "erm", "like", "you know", "I mean", "so", "right", "basically", "literally", "actually" (only when used as meaningless fillers, not when they carry real meaning)`

function buildSystemPrompt(mode?: Mode, vocabulary?: string[]): string {
  const vocabLine =
    vocabulary && vocabulary.length > 0
      ? `- Preserve exact spelling of these proper nouns/terms: ${vocabulary.join(', ')}\n`
      : ''

  if (mode?.prompt) {
    const extra = vocabLine ? `\n- ${vocabLine.trim()}` : ''
    return `${mode.prompt}${extra}\n\n${CRITICAL_RULES}`
  }

  const fillerLine = !mode || mode.removeFiller ? `${FILLER_INSTRUCTION}\n` : ''
  return `You are a transcription editor. Fix the raw speech-to-text output:
${fillerLine}${vocabLine}- Add missing punctuation (. , ? ! …)
- Fix obvious spelling errors or misheard words
- Correct Vietnamese diacritics/tones if wrong

${CRITICAL_RULES}`
}

export async function postProcess(
  text: string,
  provider: SttProvider,
  groqKey: string,
  openaiKey: string,
  mode?: Mode,
  vocabulary?: string[],
  localBaseUrl?: string,
  localLlmModel?: string
): Promise<string> {
  if (!text.trim()) return text

  let apiKey: string
  let base: string
  let model: string

  if (provider === 'local') {
    apiKey = 'local'
    base = localBaseUrl ?? 'http://localhost:11434/v1'
    model = localLlmModel ?? 'llama3.2'
  } else {
    apiKey = provider === 'openai' ? openaiKey : groqKey
    if (!apiKey) return text
    base = provider === 'openai' ? OPENAI_API_BASE : GROQ_API_BASE
    model = provider === 'openai' ? OPENAI_CHAT_MODEL : GROQ_CHAT_MODEL
  }
  const systemPrompt = buildSystemPrompt(mode, vocabulary)

  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        max_tokens: 4096,
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

    // Safety: if output is drastically shorter than input, the model likely
    // garbled or summarized — fall back to original
    const ratio = result.length / text.length
    if (ratio < 0.5 || ratio > 3) return text

    return result
  } catch {
    return text
  }
}
