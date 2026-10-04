// ── Recognising speakers by voice: the arithmetic ────────────────────────────
// Pure (no Electron, no disk, no model): a voice is a vector of numbers (an "embedding")
// that the speaker-embedding model computes from a stretch of speech; two stretches of the
// same person's speech give vectors pointing in nearly the same direction. See voiceprints.ts
// for where the vectors come from and where they are kept.

/** A remembered voice: the mean direction of every stretch the person was named on. */
export interface StoredVoice {
  id: string
  name: string
  /** Unit-length mean of the embeddings it was enrolled from. */
  centroid: number[]
  /** How many stretches of speech it was built from. */
  samples: number
  createdAt: string
  updatedAt: string
  /** When it last labelled a paragraph by itself. */
  lastMatchedAt?: string
}

/**
 * A match needs a cosine similarity of at least this much with the remembered voice…
 * (Measured with the CAM++ zh+en model: one speaker's own sentences score about 0.86–0.96,
 * two different speakers about 0.12–0.27, on clean speech. Real meetings score lower — kept
 * on the cautious side: a wrong name is worse than no name.)
 */
export const MATCH_THRESHOLD = 0.6
/** …and must beat the second-best remembered voice by this much. */
export const MATCH_MARGIN = 0.08
/** Stretches shorter than this are not used to enrol or to recognise anyone (too little to go on). */
export const MIN_SPEECH_SECONDS = 3

export function normalize(v: ArrayLike<number>): number[] {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const length = Math.sqrt(sum) || 1
  return Array.from(v, (x) => x / length)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let x = 0
  let y = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    x += a[i] * a[i]
    y += b[i] * b[i]
  }
  return x && y ? dot / Math.sqrt(x * y) : 0
}

/** The voice a stretch of speech belongs to, or null when no remembered voice is clearly it. */
export function matchVoice(embedding: ArrayLike<number>, voices: StoredVoice[]): { voice: StoredVoice; score: number } | null {
  const scored = voices.map((voice) => ({ voice, score: cosine(embedding, voice.centroid) })).sort((a, b) => b.score - a.score)
  const [best, second] = scored
  if (!best || best.score < MATCH_THRESHOLD) return null
  if (second && best.score - second.score < MATCH_MARGIN) return null
  return best
}

/**
 * Adds stretches of speech to the voice called `name` (case-insensitive), creating it when
 * new. Returns the updated list; the input is not changed.
 */
export function enrol(voices: StoredVoice[], name: string, embeddings: ArrayLike<number>[], now: string, newId: () => string): StoredVoice[] {
  const clean = name.trim()
  if (!clean || embeddings.length === 0) return voices
  const key = clean.toLocaleLowerCase()
  const existing = voices.find((v) => v.name.toLocaleLowerCase() === key)
  const dim = embeddings[0].length
  const sum = new Array<number>(dim).fill(0)
  let count = 0
  if (existing && existing.centroid.length === dim) {
    for (let i = 0; i < dim; i++) sum[i] += existing.centroid[i] * existing.samples
    count += existing.samples
  }
  for (const e of embeddings) {
    if (e.length !== dim) continue
    const unit = normalize(e)
    for (let i = 0; i < dim; i++) sum[i] += unit[i]
    count++
  }
  const updated: StoredVoice = {
    id: existing?.id ?? newId(),
    name: existing?.name ?? clean,
    centroid: normalize(sum),
    samples: count,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastMatchedAt ? { lastMatchedAt: existing.lastMatchedAt } : {})
  }
  return existing ? voices.map((v) => (v.id === existing.id ? updated : v)) : [...voices, updated]
}
