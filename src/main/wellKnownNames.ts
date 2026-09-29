/**
 * Well-known product, company and technology names, spelled the way their owners spell them.
 *
 * Used only as a yardstick by the learning code (suggestLogic.ts), never as vocabulary handed to
 * the recogniser and never as text to write: a word that keeps turning up in the user's History
 * and is a near-miss of one of these ("Cloud" for "Claude", "Anthropix" for "Anthropic") is far
 * more likely a recurring mishearing than a name of its own, so it is not learned. The name itself
 * is fine — when it turns up spelled exactly right, it is learned like any other.
 *
 * Only names of at least 5 letters are useful here (shorter ones are too close to ordinary words),
 * and only ones speech-to-text is likely to get wrong. Add to it freely: a missing name only means
 * one look-alike is not caught; a wrong one only means one ordinary word is not learned.
 */
export const WELL_KNOWN_NAMES: readonly string[] = [
  // AI
  'Claude', 'Claude Code', 'Anthropic', 'ChatGPT', 'OpenAI', 'Gemini', 'Copilot', 'Cursor',
  'Midjourney', 'Perplexity', 'DeepSeek', 'Mistral', 'Whisper', 'Windsurf', 'Lovable', 'Replit',
  'Hugging Face', 'Ollama',
  // Dev and cloud
  'GitHub', 'GitLab', 'Vercel', 'Supabase', 'Firebase', 'Netlify', 'Docker', 'Kubernetes',
  'PostgreSQL', 'MongoDB', 'TypeScript', 'JavaScript', 'Electron', 'Tailwind', 'Stripe', 'Cloudflare',
  'Next.js', 'Node.js', 'Postman', 'Terraform', 'Figma', 'Notion', 'Slack', 'Airtable', 'Zapier',
  'HubSpot', 'Salesforce', 'Shopify', 'WordPress', 'Canva', 'Photoshop', 'CapCut', 'PayPal',
  // Consumer platforms
  'YouTube', 'Facebook', 'Instagram', 'TikTok', 'LinkedIn', 'Twitter', 'WhatsApp', 'Telegram',
  'Messenger', 'Discord', 'Spotify', 'Netflix', 'Airbnb', 'Google', 'Microsoft', 'Nvidia',
  // Vietnam
  'ZaloPay', 'Shopee', 'Lazada'
]
