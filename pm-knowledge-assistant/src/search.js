import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

// ─── Config ───────────────────────────────────────────────────────────────────
// Groq dropped embedding support — we now use OpenAI text-embedding-3-small.
// dimensions:768 keeps vectors compatible with the existing vector(768) column.
const EMBED_MODEL        = 'text-embedding-3-small'
const EMBED_DIMENSIONS   = 768
const MATCH_RPC          = 'match_documents'
const DEFAULT_THRESHOLD  = 0.3

// ─── Clients ──────────────────────────────────────────────────────────────────
let _supabase

function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL)        throw new Error('Missing env var: SUPABASE_URL')
    if (!process.env.SUPABASE_SERVICE_KEY) throw new Error('Missing env var: SUPABASE_SERVICE_KEY')
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  }
  return _supabase
}

// ─── Embed ────────────────────────────────────────────────────────────────────
/**
 * Convert a text string into a 768-dim float vector via OpenAI embeddings.
 * Must use the same model + dimensions as ingest-file.js so query and chunk
 * vectors live in the same embedding space.
 */
async function embedQuestion(text) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing env var: OPENAI_API_KEY')

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.trim(), dimensions: EMBED_DIMENSIONS }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`OpenAI embed error: ${err.error?.message ?? res.status}`)
  }

  const data = await res.json()
  return data.data[0].embedding   // float[]
}

// ─── Search ───────────────────────────────────────────────────────────────────
/**
 * Find the topK document chunks most semantically similar to a question.
 *
 * How it works:
 *   1. Embeds the question into the same 768-dim space as the stored chunks
 *   2. Calls the match_documents Postgres function via Supabase RPC
 *      which runs: ORDER BY embedding <=> query_embedding (cosine distance)
 *   3. Returns results above the similarity threshold, ranked best-first
 *
 * @param {string} question   - The user's natural-language question
 * @param {number} topK       - Maximum number of chunks to return (default 5)
 * @param {number} threshold  - Minimum similarity score 0–1 (default 0.3)
 *
 * @returns {Promise<Array<{
 *   content:    string,   // the chunk text
 *   source:     string,   // filename the chunk came from
 *   chunkIndex: number,   // position of chunk within that file
 *   similarity: number,   // cosine similarity score 0–1 (higher = more relevant)
 * }>>}
 */
export async function findRelevantChunks(question, topK = 5, threshold = DEFAULT_THRESHOLD) {
  if (!question?.trim()) throw new Error('question must be a non-empty string')
  if (topK < 1 || topK > 100) throw new Error('topK must be between 1 and 100')

  // Step 1 — embed the question
  let queryEmbedding
  try {
    queryEmbedding = await embedQuestion(question)
  } catch (err) {
    throw new Error(`Embedding failed: ${err.message}`)
  }

  // Step 2 — call Supabase RPC for vector similarity search
  // The match_documents function (see SQL below) accepts:
  //   query_embedding  vector(768)
  //   match_threshold  float      — filter out low-confidence results
  //   match_count      int        — LIMIT equivalent
  const { data, error } = await getSupabase().rpc(MATCH_RPC, {
    query_embedding:  queryEmbedding,
    match_threshold:  threshold,
    match_count:      topK,
  })

  if (error) throw new Error(`Supabase RPC error: ${error.message}`)
  if (!data?.length) return []

  // Step 3 — normalise field names and return
  return data.map(row => ({
    content:    row.content,
    source:     row.source,
    chunkIndex: row.chunk_index,
    similarity: parseFloat(row.similarity.toFixed(4)),
  }))
}

/*
──────────────────────────────────────────────────────────────────────────────
  SUPABASE SQL — run this once in the Supabase SQL editor
  Creates the match_documents RPC that this module calls.
  Requires the `vector` extension and the `documents` table from ingest.js.
──────────────────────────────────────────────────────────────────────────────

create or replace function match_documents (
  query_embedding  vector(768),
  match_threshold  float,
  match_count      int
)
returns table (
  id          bigint,
  source      text,
  chunk_index integer,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    id,
    source,
    chunk_index,
    content,
    1 - (embedding <=> query_embedding) as similarity
  from documents
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding   -- ascending distance = descending similarity
  limit match_count;
$$;

──────────────────────────────────────────────────────────────────────────────
*/
