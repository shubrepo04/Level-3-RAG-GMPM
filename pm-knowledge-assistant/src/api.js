import 'dotenv/config'
import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import Groq from 'groq-sdk'
import { findRelevantChunks } from './search.js'
import { isPromptInjection } from './guardrails/injection-defense.js'
import { isGrounded }        from './guardrails/grounding-check.js'

// ─── Paths ────────────────────────────────────────────────────────────────────
const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = path.resolve(__dirname, '../shared/prompts/knowledge-v1.txt')

// ─── Config ───────────────────────────────────────────────────────────────────
const CHAT_MODEL  = 'llama-3.3-70b-versatile'
const TOP_K       = 5
const MAX_TOKENS  = 1024
const NO_DOCS_MSG = "I don't have information on this topic"

// ─── Groq client (lazy) ───────────────────────────────────────────────────────
let _groq
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) throw new Error('Missing env var: GROQ_API_KEY')
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
  }
  return _groq
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read knowledge-v1.txt and fill {context} and {question} placeholders.
 * Reads fresh on every call so prompt edits apply without a server restart.
 */
async function fillPrompt(context, question) {
  const template = await readFile(PROMPT_PATH, 'utf-8').catch(() => {
    throw new Error(`Prompt template not found at: ${PROMPT_PATH}`)
  })
  return template
    .replace('{context}', context)
    .replace('{question}', question.trim())
}

/**
 * Format retrieved chunks into a numbered, source-labelled block.
 *
 *   [1] Source: pm-handbook.pdf
 *   "Retention should be measured as..."
 *
 *   [2] Source: okr-guide.txt
 *   "Key results must be quantifiable..."
 */
function formatContext(chunks) {
  return chunks
    .map((c, i) => `[${i + 1}] Source: ${c.source}\n"${c.content.trim()}"`)
    .join('\n\n')
}

// ─── Export ───────────────────────────────────────────────────────────────────
/**
 * Answer a question grounded strictly in the uploaded documents.
 *
 * @param  {string} question
 * @returns {Promise<{ answer: string, sources: string[] }>}
 *
 *   answer   — LLM response, or the no-docs fallback string if nothing was found
 *   sources  — deduplicated list of filenames whose chunks were sent to the model
 *              empty array when the no-docs fallback is returned
 */
export async function answerQuestion(question) {
  if (!question?.trim()) throw new Error('question must be a non-empty string')

  // 0 — Reject prompt injection attempts before anything else runs
  if (isPromptInjection(question)) {
    return { answer: 'I can only answer questions about the uploaded documents.', sources: [] }
  }

  // 1 — Retrieve top-5 most similar chunks from Supabase
  const chunks = await findRelevantChunks(question, TOP_K)

  // 2 — Early return if nothing was found above the similarity threshold
  if (!chunks.length) {
    return { answer: NO_DOCS_MSG, sources: [] }
  }

  // 3 — Build the grounded prompt by filling knowledge-v1.txt
  const context = formatContext(chunks)
  const prompt  = await fillPrompt(context, question)

  // 4 — Call Groq
  const completion = await getGroq().chat.completions.create({
    model:       CHAT_MODEL,
    max_tokens:  MAX_TOKENS,
    temperature: 0,        // deterministic — prevents the model drifting outside the docs
    messages: [{ role: 'user', content: prompt }],
  })

  const answer  = completion.choices[0].message.content.trim()

  // 5 — Grounding check: warn if answer introduces terms absent from all chunks
  const groundedAnswer = isGrounded(answer, chunks)
    ? answer
    : `${answer}\n\nNote: parts of this answer could not be verified against source documents.`

  // 6 — Deduplicate source filenames from the chunks that were actually used
  const sources = [...new Set(chunks.map(c => c.source))]

  // 7 — Expose the raw chunks so UIs can reveal the exact passages cited
  const usedChunks = chunks.map(c => ({ content: c.content, source: c.source, similarity: c.similarity }))

  return { answer: groundedAnswer, sources, chunks: usedChunks }
}
