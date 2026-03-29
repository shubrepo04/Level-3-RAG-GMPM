// ─── ingest-file.js ───────────────────────────────────────────────────────────
// Core per-file ingest logic, extracted so it can be called:
//   • programmatically from server.js (upload endpoint, no child-process spawn)
//   • from the CLI ingest.js script (batch folder ingestion)
//
// This module is the single source of truth for chunking, embedding, and
// Supabase insertion — both code paths use identical logic.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, unlink } from 'fs/promises'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { redactPII } from './guardrails/pii-redaction.js'
// pdf-parse is lazy-loaded inside extractText() to avoid top-level import
// side-effects that can crash the ncc bundler on Vercel cold-start.

// ─── Config ───────────────────────────────────────────────────────────────────
// Groq dropped embedding support — embeddings now use OpenAI.
// dimensions:768 keeps vectors compatible with the existing vector(768) column.
const CHUNK_SIZE       = 500
const OVERLAP          = 50
const EMBED_MODEL      = 'text-embedding-3-small'
const EMBED_DIMENSIONS = 768
const SUPABASE_TABLE   = 'documents'

// ─── Lazy client ──────────────────────────────────────────────────────────────
let _supabase

function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL)         throw new Error('Missing env var: SUPABASE_URL')
    if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing env var: SUPABASE_SERVICE_KEY')
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  }
  return _supabase
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkText(text, size = CHUNK_SIZE, overlap = OVERLAP) {
  const words = text.split(/\s+/).filter(Boolean)
  const chunks = []
  const step   = size - overlap
  for (let i = 0; i < words.length; i += step) {
    const chunk = words.slice(i, i + size).join(' ')
    if (chunk.trim()) chunks.push(chunk)
    if (i + size >= words.length) break
  }
  return chunks
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.pdf') {
    const { default: pdfParse } = await import('pdf-parse')
    const buffer = await readFile(filePath)
    const parsed = await pdfParse(buffer)
    return parsed.text
  }
  if (ext === '.txt') return readFile(filePath, 'utf-8')
  throw new Error(`Unsupported file type: ${ext}`)
}

async function embed(text) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing env var: OPENAI_API_KEY')

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text, dimensions: EMBED_DIMENSIONS }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`OpenAI embed error: ${err.error?.message ?? res.status}`)
  }

  const data = await res.json()
  return data.data[0].embedding
}

async function isAlreadyIngested(filename) {
  const { data, error } = await getSupabase()
    .from(SUPABASE_TABLE)
    .select('source')
    .eq('source', filename)
    .limit(1)
  if (error) throw new Error(`Supabase check error: ${error.message}`)
  return (data ?? []).length > 0
}

async function insertChunk({ content, embedding, source, chunkIndex }) {
  const { error } = await getSupabase()
    .from(SUPABASE_TABLE)
    .insert({ content, embedding, source, chunk_index: chunkIndex })
  if (error) throw new Error(`Supabase insert error: ${error.message}`)
}

// ─── Export ───────────────────────────────────────────────────────────────────
/**
 * Extract, chunk, embed and store a single document.
 *
 * @param {string}  filePath      Absolute path to the file (may be in /tmp on serverless)
 * @param {string}  filename      Logical name stored as the source in Supabase (e.g. "report.pdf")
 * @param {object}  [opts]
 * @param {boolean} [opts.cleanup=false]  Delete the file from disk after ingestion
 * @param {(msg:string)=>void} [opts.log] Optional progress logger
 *
 * @returns {Promise<{ chunks: number, skipped: boolean }>}
 */
export async function ingestFile(filePath, filename, { cleanup = false, log = () => {} } = {}) {
  if (await isAlreadyIngested(filename)) {
    log(`${filename} already ingested — skipping`)
    return { chunks: 0, skipped: true }
  }

  log(`Extracting text from ${filename}…`)
  const text   = await extractText(filePath)
  const chunks = chunkText(text)
  log(`${chunks.length} chunks to embed`)

  let stored = 0
  for (let i = 0; i < chunks.length; i++) {
    const clean     = redactPII(chunks[i])
    const embedding = await embed(clean)
    await insertChunk({ content: clean, embedding, source: filename, chunkIndex: i })
    stored++
    log(`  chunk ${i + 1}/${chunks.length} stored`)
  }

  if (cleanup) {
    await unlink(filePath).catch(() => {})   // best-effort cleanup from /tmp
  }

  return { chunks: stored, skipped: false }
}
