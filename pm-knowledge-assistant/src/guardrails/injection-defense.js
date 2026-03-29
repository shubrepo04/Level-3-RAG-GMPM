// ─── Prompt Injection Defense ─────────────────────────────────────────────────
// Detects adversarial inputs that attempt to override the system prompt,
// hijack the assistant's persona, or exfiltrate internal instructions.
//
// Checked BEFORE the question reaches the vector search or the LLM, so no
// attacker-controlled text ever enters the grounded prompt template.
// ─────────────────────────────────────────────────────────────────────────────

// Phrases that signal prompt injection or jailbreak attempts.
// All comparisons are case-insensitive and trimmed.
const INJECTION_PATTERNS = [
  'ignore your instructions',
  'forget what you were told',
  'pretend you are',
  'reveal your system prompt',
  'act as',
  'jailbreak',
]

/**
 * Returns true if the question contains a known prompt injection pattern.
 *
 * @param  {string} question
 * @returns {boolean}
 */
export function isPromptInjection(question) {
  if (typeof question !== 'string') return false
  const lower = question.toLowerCase()
  return INJECTION_PATTERNS.some(pattern => lower.includes(pattern))
}
