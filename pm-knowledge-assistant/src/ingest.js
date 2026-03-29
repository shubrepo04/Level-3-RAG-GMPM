// ─── ingest.js — CLI batch ingestion ─────────────────────────────────────────
// Reads every .pdf / .txt in documents/ and calls ingestFile() on each one.
// The core logic lives in ingest-file.js so server.js can call it directly
// without spawning a child process (required for Vercel serverless).
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config'
import { readdir } from 'fs/promises'
import path        from 'path'
import { fileURLToPath } from 'url'
import { ingestFile } from './ingest-file.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOCS_DIR  = path.resolve(__dirname, '../documents')

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info:    msg => console.log(`  ℹ  ${msg}`),
  ok:      msg => console.log(`  ✓  ${msg}`),
  skip:    msg => console.log(`  ⊘  ${msg}`),
  warn:    msg => console.warn(`  ⚠  ${msg}`),
  error:   msg => console.error(`  ✗  ${msg}`),
  section: msg => console.log(`\n── ${msg} ${'─'.repeat(Math.max(0, 50 - msg.length))}`),
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function ingest() {
  log.section('PM Knowledge Assistant — Document Ingestion')

  // 1. Validate env
  for (const key of ['GROQ_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!process.env[key]) { log.error(`Missing env var: ${key}`); process.exit(1) }
  }

  // 2. Read documents/ folder
  let allFiles
  try {
    allFiles = await readdir(DOCS_DIR)
  } catch {
    log.error(`Cannot read documents/ folder at: ${DOCS_DIR}`)
    log.info('Create the folder and drop PDF or .txt files into it, then re-run.')
    process.exit(1)
  }

  const files = allFiles.filter(f => /\.(pdf|txt)$/i.test(f))
  if (files.length === 0) {
    log.warn('No .pdf or .txt files found in documents/. Nothing to ingest.')
    process.exit(0)
  }
  log.info(`Found ${files.length} file(s): ${files.join(', ')}`)

  // 3. Process each file via the shared ingestFile() module
  let totalChunks = 0
  let totalSkipped = 0

  for (const filename of files) {
    log.section(`Processing: ${filename}`)
    const filePath = path.join(DOCS_DIR, filename)

    try {
      const { chunks, skipped } = await ingestFile(filePath, filename, {
        log: msg => process.stdout.write(`     ${msg}\n`),
      })

      if (skipped) {
        log.skip(`${filename} already ingested — skipping.`)
        totalSkipped++
      } else {
        log.ok(`${filename} complete — ${chunks} chunks stored.`)
        totalChunks += chunks
      }
    } catch (err) {
      log.error(`${filename} failed: ${err.message}`)
    }
  }

  // 4. Summary
  log.section('Ingestion complete')
  console.log(`
  Files processed : ${files.length - totalSkipped}
  Files skipped   : ${totalSkipped}  (already ingested)
  Chunks stored   : ${totalChunks}
`)
}

ingest().catch(err => {
  console.error('\nFatal error:', err.message)
  process.exit(1)
})
