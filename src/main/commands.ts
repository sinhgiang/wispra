export interface VoiceCommandResult {
  type: 'inject' | 'undo' | 'cancel'
  value?: string
}

const COMMANDS: Array<{ patterns: string[]; result: VoiceCommandResult }> = [
  // Paragraphs / newlines
  { patterns: ['new paragraph', 'đoạn mới', 'paragraph'], result: { type: 'inject', value: '\n\n' } },
  { patterns: ['new line', 'xuống dòng', 'next line', 'dòng mới'], result: { type: 'inject', value: '\n' } },

  // Punctuation
  { patterns: ['period', 'full stop', 'chấm', 'dấu chấm'], result: { type: 'inject', value: '. ' } },
  { patterns: ['comma', 'phẩy', 'dấu phẩy'], result: { type: 'inject', value: ', ' } },
  { patterns: ['question mark', 'dấu hỏi', 'dấu chấm hỏi'], result: { type: 'inject', value: '? ' } },
  { patterns: ['exclamation mark', 'exclamation point', 'dấu chấm than'], result: { type: 'inject', value: '! ' } },
  { patterns: ['colon', 'dấu hai chấm'], result: { type: 'inject', value: ': ' } },
  { patterns: ['semicolon', 'dấu chấm phẩy'], result: { type: 'inject', value: '; ' } },
  { patterns: ['ellipsis', 'dot dot dot', 'ba chấm'], result: { type: 'inject', value: '… ' } },
  { patterns: ['open bracket', 'open parenthesis', 'mở ngoặc'], result: { type: 'inject', value: '(' } },
  { patterns: ['close bracket', 'close parenthesis', 'đóng ngoặc'], result: { type: 'inject', value: ')' } },
  { patterns: ['open quote', 'mở ngoặc kép'], result: { type: 'inject', value: '"' } },
  { patterns: ['close quote', 'đóng ngoặc kép'], result: { type: 'inject', value: '"' } },
  { patterns: ['dash', 'gạch ngang'], result: { type: 'inject', value: ' — ' } },
  { patterns: ['tab', 'indent'], result: { type: 'inject', value: '\t' } },

  // Undo / delete
  { patterns: ['delete that', 'xóa cái đó', 'xóa đó', 'undo that', 'bỏ đi', 'undo'], result: { type: 'undo' } },

  // Cancel
  { patterns: ['cancel', 'hủy', 'thôi', 'không gửi', 'bỏ qua'], result: { type: 'cancel' } },
]

/**
 * Checks if the transcribed text is a voice command.
 * Returns the command result, or null if it's regular dictation.
 * Matching is case-insensitive and strips trailing punctuation.
 */
export function matchVoiceCommand(text: string, enabled: boolean): VoiceCommandResult | null {
  if (!enabled) return null
  const normalized = text.trim().toLowerCase().replace(/[.!?,;:]+$/, '').trim()
  for (const cmd of COMMANDS) {
    if (cmd.patterns.includes(normalized)) return cmd.result
  }
  return null
}
