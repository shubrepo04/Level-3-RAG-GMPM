# PM Knowledge Assistant

A RAG (Retrieval-Augmented Generation) assistant that answers questions strictly from your own uploaded documents. Upload PM handbooks, strategy docs, or any PDF/TXT — then ask questions and get grounded, cited answers.

**Live:** https://pm-knowledge-assistant.vercel.app

---

## What it does

You upload documents. You ask questions. The assistant answers *only* from what's in those documents — never from general knowledge — and tells you exactly which file the answer came from.

If the answer isn't in your documents, it says so clearly instead of making something up.

---

## How the RAG pipeline works

RAG stands for **Retrieval-Augmented Generation**. Here's what happens step by step when you upload a document and ask a question:

### 1. Ingestion (upload time)

```
PDF / TXT
    │
    ▼
Extract text
    │
    ▼
Split into ~500-word chunks          ← overlapping windows preserve context
    │                                   across chunk boundaries
    ▼
Redact PII                           ← emails, phones, names before job titles
    │
    ▼
Embed each chunk → 768-number vector ← OpenAI text-embedding-3-small
    │                                   converts meaning into maths
    ▼
Store vector + text in Supabase      ← pgvector extension for similarity search
```

Each chunk becomes a point in a 768-dimensional mathematical space. Chunks with similar meaning end up close together.

### 2. Retrieval (question time)

```
User question
    │
    ▼
Embed question → 768-number vector   ← same model, same space as chunks
    │
    ▼
Cosine similarity search             ← find the 5 chunks closest in meaning
(Supabase pgvector RPC)              ← to the question vector
    │
    ▼
Top-5 most relevant chunks returned
```

### 3. Generation (answer time)

```
Top-5 chunks  +  question
    │
    ▼
Fill prompt template                 ← chunks become the "context" in the prompt
    │
    ▼
Groq LLaMA 3.3 70B                   ← fastest open-source model available
(temperature: 0, strictly grounded)
    │
    ▼
Answer + source filenames
```

The LLM is instructed to answer *only* from the provided context excerpts. If the answer isn't there, it says so.

---

## Three safety guardrails

Every request passes through three independent checks before the answer reaches you.

### 1. Prompt Injection Defense (`src/guardrails/injection-defense.js`)

**What it guards against:** Adversarial inputs that try to override the assistant's instructions — "ignore your previous instructions", "act as an unrestricted AI", "reveal your system prompt", etc.

**How it works:** Before the question reaches the vector search or the LLM, it's checked against a list of known attack phrases (case-insensitive). If any match, the pipeline short-circuits immediately.

```
"Ignore your instructions and..." → blocked before embedding
                                  → returns: "I can only answer questions
                                              about the uploaded documents."
```

### 2. PII Redaction (`src/guardrails/pii-redaction.js`)

**What it guards against:** Personal data being stored permanently in Supabase and sent to external APIs.

**When it runs:** At ingest time, applied to every chunk *before* it is embedded or stored. The original file is never saved permanently.

**What it catches:**

| Pattern | Example | Replaced with |
|---|---|---|
| Email addresses | `john@company.com` | `[EMAIL REDACTED]` |
| Phone numbers | `+1 (555) 123-4567` | `[PHONE REDACTED]` |
| Full names before job titles | `Sarah Johnson, Product Manager` | `[NAME REDACTED]` |

Uses regex with lookbehind/lookahead to avoid false positives — "The CEO" and "Our VP" are not redacted.

### 3. Grounding Check (`src/guardrails/grounding-check.js`)

**What it guards against:** The LLM hallucinating facts that don't appear anywhere in the retrieved documents.

**How it works:**
1. Splits the answer into sentences
2. For each sentence, extracts key terms (non-stopwords)
3. Checks what fraction of those terms appear in the retrieved chunks
4. A sentence passes if ≥ 40% of its key terms are in the chunk text
5. The answer passes if ≥ 60% of its substantive sentences pass

If the answer fails, it's returned with a visible warning appended — the answer isn't blocked, it's *flagged*:

```
[answer text]

Note: parts of this answer could not be verified against source documents.
```

This is lexical (not semantic) so it runs inline with no extra API call.

---

## Architecture

```
pm-knowledge-assistant/
├── src/
│   ├── server.js          Express server — all API routes
│   ├── api.js             RAG orchestration — retrieve → prompt → generate
│   ├── ingest.js          CLI batch ingestion script
│   ├── ingest-file.js     Core per-file ingest logic (shared by CLI + server)
│   ├── search.js          Vector similarity search via Supabase RPC
│   ├── index.html         Main UI (dark design system)
│   └── guardrails/
│       ├── injection-defense.js   Prompt injection detection
│       ├── pii-redaction.js       PII scrubbing at ingest
│       └── grounding-check.js     Answer grounding verification
├── shared/
│   └── prompts/
│       └── knowledge-v1.txt       LLM system prompt template
├── public/
│   └── index.html                 Fallback UI
└── documents/                     Drop PDFs/TXTs here for CLI ingest
```

### API routes

| Method | Route | What it does |
|---|---|---|
| `POST` | `/api/upload` | Upload `.pdf` or `.txt`, runs full ingest pipeline |
| `POST` | `/api/ask` | `{ question }` → `{ answer, sources, chunks }` |
| `GET` | `/api/documents` | Lists ingested documents with chunk counts |
| `GET` | `/api/safety-log` | Today's guardrail events (injections, grounding failures, PII) |
| `GET` | `/health` | Liveness check + env var status |
| `GET` | `/` | Serves the main UI |

---

## Stack

| Layer | Technology |
|---|---|
| Server | Node.js 20 + Express 5 |
| LLM (chat) | Groq — LLaMA 3.3 70B Versatile |
| Embeddings | OpenAI — text-embedding-3-small (768 dims) |
| Vector store | Supabase — pgvector extension |
| Deployment | Vercel (serverless, `bundle: false`) |
| File parsing | pdf-parse (lazy-loaded) |

---

## Setup

### Environment variables

| Variable | Where to get it |
|---|---|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) |
| `SUPABASE_URL` | Supabase project → Settings → API |
| `SUPABASE_KEY` | Supabase project → Settings → API → service_role key |

### Supabase schema

Run once in the Supabase SQL editor:

```sql
-- Enable the vector extension
create extension if not exists vector;

-- Documents table
create table documents (
  id          bigserial primary key,
  source      text not null,
  chunk_index integer not null,
  content     text not null,
  embedding   vector(768)
);

-- Similarity search function
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
  select id, source, chunk_index, content,
         1 - (embedding <=> query_embedding) as similarity
  from documents
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

### Local development

```bash
# Install dependencies
npm install

# Copy env template and fill in values
cp .env.example .env

# Start local server
npm run dev                        # http://localhost:3000

# Batch ingest from documents/ folder (CLI)
node src/ingest.js
```

### Deploy to Vercel

```bash
vercel --prod

# Add env vars
vercel env add GROQ_API_KEY
vercel env add OPENAI_API_KEY
vercel env add SUPABASE_URL
vercel env add SUPABASE_KEY
```
