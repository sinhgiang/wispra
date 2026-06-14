/** Keyword-based topic detection for dictation history entries. */
const TOPIC_PATTERNS: [string, RegExp][] = [
  [
    'Email',
    /\b(email|subject:|dear |hi |hello |regards|sincerely|cc:|bcc:|inbox|reply to|unsubscribe|attachment|forwarded)\b/i
  ],
  [
    'Meeting',
    /\b(meeting|agenda|attendees?|schedule|conference call|zoom|google meet|teams|standup|sync|presentation|slide|deck)\b/i
  ],
  [
    'Tasks',
    /\b(task|to-?do|remind(er)?|deadline|due (date|by)|need to|must|should|finish by|by (monday|tuesday|wednesday|thursday|friday|tomorrow|end of))\b/i
  ],
  [
    'Notes',
    /\b(note|remember|idea|thought|insight|key (point|takeaway)|draft|brainstorm|outline|summary of)\b/i
  ],
  [
    'Message',
    /\b(message|text (to|him|her|them)|send (to|him|her|them)|tell (him|her|them)|let (him|her|them) know|reply (to|him|her))\b/i
  ],
]

export function detectTopic(text: string): string {
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic
  }
  return 'General'
}
