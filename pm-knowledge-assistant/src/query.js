import 'dotenv/config'
import { readFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import Groq from 'groq-sdk'
import { findRelevantChunks } from './search.js'

// ─── Paths ────────────────────────────────────────────────────────────────────
const __dirname     = path.dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH   = path.resolve(__dirname, '../shared/prompts/knowledge-v1.txt')

// ─── Config ───────────────────────────────────────────────────────────────────
const CHAT_MODEL    = 'llama-3.3-70b-versatile'   // Groq chat completion model
const TOP_K         = 5                            // chunks to retrieve per query
const MAX_TOKENS    = 1024                         // cap on answer length

// ─── Client ───────────────────────────────────────────────────────────────────
let _groq
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) throw new Error('Missing env var: GROQ_API_KEY')
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
  }
  return _groq
}

// ─── Prompt loader ────────────────────────────────────────────────────────────
/**
 * Read the prompt template fresh on every call so edits to knowledge-v1.txt
 * take effect without restarting the server.
 */
async function loadPrompt() {
  try {
    return await readFile(PROMPT_PATH, 'utf-8')
  } catch {
    throw new Error(`Could not load prompt template at: ${PROMPT_PATH}`)
  }
}

/**
 * Replace {context} and {question} placeholders in the template string.
 */
function buildPrompt(template, context, question) {
  return template
    .replace('{context}', context)
    .replace('{question}', question)
}

// ─── Context formatter ────────────────────────────────────────────────────────
/**
 * Turn retrieved chunks into a numbered, source-labelled context block.
 *
 * Format:
 *   [1] Source: roadmap.pdf
 *   "The product roadmap should be updated every quarter..."
 *
 *   [2] Source: metrics-101.txt
 *   "Retention is defined as..."
 *
 * Numbered so the model can reference specific excerpts in its answer.
 */
function formatContext(chunks) {
  if (!chunks.length) return 'No relevant excerpts found.'

  return chunks
    .map((chunk, i) =>
      `[${i + 1}] Source: ${chunk.source}\n"${chunk.content.trim()}"`
    )
    .join('\n\n')
}

// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Answer a question using only the content stored in Supabase.
 *
 * Pipeline:
 *   question → findRelevantChunks → format context → fill prompt → Groq LLM → answer
 *
 * @param {string} question         - The user's natural-language question
 * @param {number} topK             - How many chunks to retrieve (default 5)
 *
 * @returns {Promise<{
 *   answer:  string,               // LLM answer grounded in the retrieved chunks
 *   sources: string[],             // deduplicated list of source filenames cited
 *   chunks:  Array<{               // raw retrieved chunks for transparency/debug
 *     content:    string,
 *     source:     string,
 *     chunkIndex: number,
 *     similarity: number,
 *   }>,
 * }>}
 */
export async function askQuestion(question, topK = TOP_K) {
  if (!question?.trim()) throw new Error('question must be a non-empty string')

  // Step 1 — retrieve the most relevant chunks from Supabase
  const chunks = await findRelevantChunks(question, topK)

  // Step 2 — build the grounded prompt
  const template = await loadPrompt()
  const context  = formatContext(chunks)
  const prompt   = buildPrompt(template, context, question.trim())

  // Step 3 — call Groq chat completion with the filled prompt as the user turn
  // The entire prompt (instructions + context + question) goes in the user
  // message so the model treats it as a single, self-contained task.
  let completion
  try {
    completion = await getGroq().chat.completions.create({
      model:      CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,          // 0 = deterministic — critical for factual RAG
      messages: [
        {
          role:    'user',
          content: prompt,
        },
      ],
    })
  } catch (err) {
    throw new Error(`Groq chat completion failed: ${err.message}`)
  }

  const answer = completion.choices[0].message.content.trim()

  // Step 4 — collect unique source filenames that were actually passed to the model
  const sources = [...new Set(chunks.map(c => c.source))]

  return { answer, sources, chunks }
}
