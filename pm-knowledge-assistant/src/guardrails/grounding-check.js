// ─── Grounding Check ──────────────────────────────────────────────────────────
// Verifies that the LLM's answer is lexically derivable from the retrieved
// chunks, catching cases where the model invents facts not present in the docs.
//
// Approach — term overlap per sentence:
//   1. Build a set of all meaningful terms across every retrieved chunk.
//   2. Split the answer into sentences; ignore trivial ones (< MIN_TERMS tokens).
//   3. For each substantive sentence, compute what fraction of its key terms
//      appear in the chunk term-set.
//   4. A sentence is "grounded" if ≥ TERM_THRESHOLD of its terms overlap.
//   5. The answer is grounded if ≥ SENTENCE_THRESHOLD of substantive sentences
//      are individually grounded.
//
// Why lexical and not semantic?  This runs inline on every response with no
// extra API call.  Lexical overlap is a strong signal for factual hallucination
// in domain-specific RAG: if the model claims "launched in Q3 2019", those
// specific tokens should appear in the context; if they don't, flag it.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tuneable thresholds ───────────────────────────────────────────────────────
const MIN_TERMS          = 4    // sentences with fewer key terms are skipped (e.g. "Yes." / "See below.")
const TERM_THRESHOLD     = 0.40 // ≥40% of a sentence's key terms must appear in chunks
const SENTENCE_THRESHOLD = 0.60 // ≥60% of substantive sentences must pass TERM_THRESHOLD

// ── Stopword list ─────────────────────────────────────────────────────────────
// Removed before term comparison — these carry no factual signal.
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','as','is','was','are','were','be','been','being','have',
  'has','had','do','does','did','will','would','could','should','may',
  'might','shall','can','this','that','these','those','it','its',
  'i','you','he','she','we','they','them','their','our','your','his','her',
  'what','which','who','when','where','why','how','all','each','both',
  'more','most','other','some','such','no','not','only','same','so',
  'than','too','very','just','also','about','after','before','during',
  'into','through','up','out','if','then','there','here','any','each',
])

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lowercase, strip punctuation, split on whitespace, drop stopwords & short tokens. */
function keyTerms(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w))
}

/** Split text into sentences on .  !  ? followed by whitespace or end-of-string. */
function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+|(?<=[.!?])$/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// ─── Export ───────────────────────────────────────────────────────────────────
/**
 * Returns true if the answer is sufficiently grounded in the retrieved chunks.
 *
 * @param  {string}   answer  - LLM-generated response text
 * @param  {Array}    chunks  - Retrieved chunk objects with a `.content` string field
 * @returns {boolean}
 */
export function isGrounded(answer, chunks) {
  if (typeof answer !== 'string' || !answer.trim()) return true
  if (!Array.isArray(chunks) || chunks.length === 0)  return false

  // Build a flat set of every key term present across all chunks
  const chunkTerms = new Set()
  for (const chunk of chunks) {
    const text = typeof chunk === 'string' ? chunk : (chunk.content ?? '')
    for (const term of keyTerms(text)) chunkTerms.add(term)
  }
  if (chunkTerms.size === 0) return false

  // Evaluate each sentence
  let substantive = 0
  let grounded    = 0

  for (const sentence of sentences(answer)) {
    const terms = keyTerms(sentence)
    if (terms.length < MIN_TERMS) continue  // too short to evaluate meaningfully

    substantive++
    const matched  = terms.filter(t => chunkTerms.has(t)).length
    const overlap  = matched / terms.length
    if (overlap >= TERM_THRESHOLD) grounded++
  }

  // No evaluable sentences → treat as grounded (single-word or list answers)
  if (substantive === 0) return true

  return (grounded / substantive) >= SENTENCE_THRESHOLD
}
