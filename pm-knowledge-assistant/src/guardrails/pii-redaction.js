// ─── PII Redaction Guardrail ──────────────────────────────────────────────────
// Applied to every chunk BEFORE it is embedded or stored in Supabase.
// Three categories: email addresses, phone numbers, full names before job titles.
//
// Design principle: replace with a labelled placeholder so downstream text
// stays readable and the LLM can still understand sentence structure — e.g.
// "[NAME REDACTED] led the Q3 planning session" is still useful context.
// ─────────────────────────────────────────────────────────────────────────────

// ── Email addresses ───────────────────────────────────────────────────────────
// Covers: user@domain.com, first.last+tag@sub.domain.co.uk, etc.
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/gi

// ── Phone numbers ─────────────────────────────────────────────────────────────
// Covers all common formats:
//   +1 (555) 123-4567   →  international with country code
//   (555) 123-4567      →  US with area code in parens
//   555-123-4567        →  dashes
//   555.123.4567        →  dots
//   555 123 4567        →  spaces
//   +44 7911 123456     →  UK mobile
// (?<!\d) stops the pattern matching mid-number (e.g. the "0" left over in "07911").
const PHONE_RE = /(?<!\d)(\+?\d{1,3}[\s.\-])?(\(?\d{2,4}\)?[\s.\-])(\d{3,4}[\s.\-]\d{3,4})(?!\d)/g

// ── Full names before job titles ──────────────────────────────────────────────
// Matches: one to three Title-Cased words (the name) followed by an optional
// separator (comma, dash, em-dash, parenthesis, "as", "is") and then a known
// job title keyword.
//
// Examples matched:
//   "Sarah Johnson, Product Manager"   →  "[NAME REDACTED], Product Manager"
//   "John Smith (VP of Engineering)"   →  "[NAME REDACTED] (VP of Engineering)"
//   "Dr. Maria Chen — Head of Design"  →  "[NAME REDACTED] — Head of Design"
//   "Wei Liu as Director of Research"  →  "[NAME REDACTED] as Director of Research"
//
// The job title itself is preserved — it is context, not PII.

const JOB_TITLE_KEYWORDS = [
  // C-suite & executives
  'CEO', 'CTO', 'CPO', 'CMO', 'CFO', 'COO', 'CHRO', 'CXO',
  // VP tiers
  'VP', 'SVP', 'EVP', 'AVP',
  // Director / manager / lead
  'Director', 'Senior Director', 'Managing Director',
  'Manager', 'Senior Manager', 'Program Manager', 'Product Manager',
  'Head', 'Lead', 'Principal', 'Staff',
  // Individual contributor titles
  'Engineer', 'Designer', 'Architect', 'Developer',
  'Analyst', 'Researcher', 'Scientist', 'Strategist',
  'Consultant', 'Advisor', 'Specialist', 'Coordinator',
  'Associate', 'Executive', 'Officer', 'Partner',
  'Founder', 'Co-Founder', 'President',
].join('|')

// Common single-word false positives: articles, pronouns, prepositions that
// happen to be Title-Cased at the start of a sentence.
const STOPWORDS = new Set([
  'The','A','An','This','That','These','Those','Our','Your','Their',
  'His','Her','Its','My','We','He','She','They','It','Each','Every',
  'Both','All','Some','Any','No','New','Last','Next','First','Second',
])

// Optional honorific prefix: Dr., Mr., Ms., Mrs., Prof.
const HONORIFIC   = '(?:Dr\\.|Mr\\.|Ms\\.|Mrs\\.|Prof\\.\\s*)?'
// Name: at least TWO Title-Cased words (first + last), optionally a middle initial.
// Requiring 2+ words prevents single common words like "The" from matching.
const NAME_PART   = '[A-Z][a-z]{1,}'
const NAME_PAT    = `${HONORIFIC}${NAME_PART}(?:\\s[A-Z]\\.)?\\s${NAME_PART}(?:\\s${NAME_PART})?`
// Separators between name and title
const SEPARATOR   = '(?:\\s*[,\\-\\u2013\\u2014]\\s*|\\s+(?:as|is)\\s+|\\s*\\(|\\s+)'
// Full pattern — capture group 1 = the name, the rest stays in place
const NAME_JOB_RAW = new RegExp(
  `\\b(${NAME_PAT})${SEPARATOR}(?=${JOB_TITLE_KEYWORDS})`,
  'g'
)

// Wrap the raw regex to filter out stopword-only first words at runtime
function NAME_JOB_RE_replace(text) {
  return text.replace(NAME_JOB_RAW, (match, name) => {
    const firstWord = name.trim().split(/\s+/)[0].replace(/\.$/, '')
    if (STOPWORDS.has(firstWord)) return match   // not a name — leave unchanged
    return '[NAME REDACTED] '
  })
}

// ─── Export ───────────────────────────────────────────────────────────────────
/**
 * Redact PII from a text string.
 *
 * Replacements applied (in order):
 *   1. Email addresses     → [EMAIL REDACTED]
 *   2. Phone numbers       → [PHONE REDACTED]
 *   3. Full names before   → [NAME REDACTED]
 *      known job titles
 *
 * @param  {string} text  - Raw chunk text
 * @returns {string}       - Cleaned text with PII replaced
 */
export function redactPII(text) {
  if (typeof text !== 'string') return text

  return NAME_JOB_RE_replace(
    text
      .replace(EMAIL_RE, '[EMAIL REDACTED]')
      .replace(PHONE_RE, '[PHONE REDACTED]')
  )
}
