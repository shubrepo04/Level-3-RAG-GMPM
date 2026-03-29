import 'dotenv/config'
import express            from 'express'
import multer             from 'multer'
import path               from 'path'
import { readFile, writeFile } from 'fs/promises'
import { fileURLToPath }  from 'url'
import { createClient }   from '@supabase/supabase-js'
import { answerQuestion } from './api.js'
import { isPromptInjection } from './guardrails/injection-defense.js'
import { ingestFile }     from './ingest-file.js'

// ─── Env normalisation ────────────────────────────────────────────────────────
// Vercel project was created with SUPABASE_KEY; codebase uses SUPABASE_SERVICE_KEY.
// Alias it once here so every lazy-initialised module sees the right name.
if (!process.env.SUPABASE_SERVICE_KEY && process.env.SUPABASE_KEY) {
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY
}

// ─── Paths ────────────────────────────────────────────────────────────────────
const __dirname     = path.dirname(fileURLToPath(import.meta.url))
const INDEX_HTML    = path.resolve(__dirname, 'index.html')
const FALLBACK_HTML = path.resolve(__dirname, '../public/index.html')
// /tmp is the only writable directory on read-only serverless filesystems (Vercel)
const TMP_DIR = '/tmp'

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT ?? 3000
const SUPABASE_TABLE = 'documents'

// ─── Supabase (lazy) ──────────────────────────────────────────────────────────
let _supabase
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('Missing Supabase env vars')
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  }
  return _supabase
}

// ─── In-memory safety log ─────────────────────────────────────────────────────
// Tracks events for the lifetime of the server process. Resets on restart.
// For persistent storage, write events to Supabase instead.
const _safety = { injections: 0, groundingFailures: 0, piiRedactions: 0, events: [] }

function logSafetyEvent(type, detail = '') {
  _safety.events.push({ type, detail: detail.slice(0, 200), ts: new Date().toISOString() })
  if (type === 'injection') _safety.injections++
  if (type === 'grounding') _safety.groundingFailures++
  if (type === 'pii')       _safety.piiRedactions++
}

// ─── Multer — buffer file in memory (no filesystem writes) ───────────────────
// Using memoryStorage means the upload never touches disk here.
// We write the buffer to /tmp ourselves before calling ingestFile(),
// which is the only writable path on Vercel and other serverless platforms.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    /\.(pdf|txt)$/i.test(file.originalname)
      ? cb(null, true)
      : cb(new Error('Only .pdf and .txt files are accepted'))
  },
  limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB cap
})

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

// ── POST /api/upload ──────────────────────────────────────────────────────────
// Receives a multipart file, holds it in memory, writes to /tmp (the only
// writable path on serverless), calls ingestFile() inline — no child process.
app.post('/api/upload', (req, res) => {
  upload.single('document')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({
      error: 'No file received. Send a .pdf or .txt via the "document" field.',
    })

    const { originalname, buffer, size } = req.file
    const tmpPath = path.join(TMP_DIR, `upload_${Date.now()}_${originalname}`)
    const logLines = []

    try {
      // Write buffer to /tmp — works on both local and Vercel
      await writeFile(tmpPath, buffer)

      const { chunks, skipped } = await ingestFile(tmpPath, originalname, {
        cleanup: true,                          // delete from /tmp when done
        log: msg => logLines.push(msg),
      })

      res.status(201).json({
        message:  skipped
          ? `${originalname} was already ingested — skipped.`
          : `${originalname} ingested successfully.`,
        filename: originalname,
        bytes:    size,
        chunks,
        skipped,
        log: logLines,
      })
    } catch (ingestErr) {
      res.status(500).json({ error: `Ingestion failed: ${ingestErr.message}` })
    }
  })
})

// ── POST /api/ask ─────────────────────────────────────────────────────────────
// Receives { question }, runs the full RAG + guardrail pipeline, returns the
// answer and a deduplicated list of source documents.
app.post('/api/ask', async (req, res) => {
  const question = req.body?.question

  if (!question?.trim()) {
    return res.status(400).json({
      error: 'Request body must contain a non-empty "question" string.',
    })
  }

  // Intercept injection attempts here for the safety log before answerQuestion
  // swallows them internally
  if (isPromptInjection(question)) {
    logSafetyEvent('injection', question)
  }

  try {
    const { answer, sources, chunks } = await answerQuestion(question)

    // Grounding failure is signalled by the note appended inside api.js
    if (answer.includes('could not be verified against source documents')) {
      logSafetyEvent('grounding', question)
    }

    res.json({ answer, sources, chunks })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/documents ────────────────────────────────────────────────────────
// Returns every ingested document with its chunk count, sorted alphabetically.
app.get('/api/documents', async (_req, res) => {
  try {
    const { data, error } = await getSupabase()
      .from(SUPABASE_TABLE)
      .select('source, chunk_index')

    if (error) throw new Error(error.message)

    // Aggregate chunk counts by source filename
    const counts = {}
    for (const { source } of data ?? []) {
      counts[source] = (counts[source] ?? 0) + 1
    }

    const documents = Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([source, chunks]) => ({ source, chunks }))

    res.json({ count: documents.length, documents })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/safety-log ───────────────────────────────────────────────────────
// Returns today's guardrail events. The log resets on server restart; extend
// with Supabase persistence if you need historical data across restarts.
app.get('/api/safety-log', (_req, res) => {
  const today       = new Date().toISOString().slice(0, 10)
  const todayEvents = _safety.events.filter(e => e.ts.startsWith(today))

  res.json({
    date:   today,
    totals: {
      injections_blocked: _safety.injections,
      grounding_failures: _safety.groundingFailures,
      pii_redactions:     _safety.piiRedactions,
    },
    event_count: todayEvents.length,
    events:      todayEvents,
  })
})

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    ts:     new Date().toISOString(),
    env: {
      groq:     !!process.env.GROQ_API_KEY,
      supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    },
  })
})

// ── GET / and GET /batch ──────────────────────────────────────────────────────
// Serves src/index.html (primary UI). Falls back to public/index.html if absent.
async function serveUI(_req, res) {
  for (const p of [INDEX_HTML, FALLBACK_HTML]) {
    try {
      const html = await readFile(p, 'utf-8')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      return res.send(html)
    } catch { /* try next */ }
  }
  res.status(404).send('UI not found. Expected: src/index.html')
}

app.get('/',      serveUI)
app.get('/batch', serveUI)

// ─── Start ────────────────────────────────────────────────────────────────────
// On Vercel the runtime invokes the exported app directly — app.listen() is
// skipped. Locally (no VERCEL env) it starts the HTTP server as normal.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\nPM Knowledge Assistant  →  http://localhost:${PORT}`)
    console.log('  POST /api/upload      upload a .pdf or .txt document')
    console.log('  POST /api/ask         ask a question against the documents')
    console.log('  GET  /api/documents   list ingested documents + chunk counts')
    console.log('  GET  /api/safety-log  today\'s guardrail events')
    console.log('  GET  /health          env + liveness check')
    console.log('  GET  /batch           batch UI  (src/index.html)\n')
  })
}

// Vercel @vercel/node requires the Express app as the default export
export default app
