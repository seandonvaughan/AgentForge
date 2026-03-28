# v5 Embedding Search MVP Specification

**Author:** rd-lead
**Sprint:** v4.9 (item v49-7)
**Date:** 2026-03-27
**Status:** Complete

---

## 1. Overview

AgentForge v5 includes a local-first embedding search system. No external API calls. No cloud dependency. The embedding model runs in-process using `@xenova/transformers` (ONNX Runtime). Results are stored in SQLite alongside workspace data.

**Goal:** Semantic search across all workspace knowledge — sessions, feedback, memory entries, sprint items, and code patterns. Sub-100ms retrieval over 10,000+ documents.

---

## 2. What Gets Indexed

| Source Type | Content Indexed | Update Trigger |
|-------------|----------------|----------------|
| `session` | Session task description + result summary. For long sessions, chunk into 512-token segments. | On session completion |
| `feedback` | Feedback content (praise, correction, suggestion, escalation). | On feedback creation |
| `memory` | Memory entry value. Key is included as prefix. | On memory write/update |
| `sprint` | Sprint item title + description. | On sprint item creation/update |
| `code` | Code file content, chunked by function/class boundaries. Indexed on demand via CLI command. | Manual trigger: `agentforge index code ./src` |

### 2.1 Chunking Strategy

Documents longer than 512 tokens are split into overlapping chunks:
- **Chunk size:** 512 tokens (approximately 2048 characters)
- **Overlap:** 64 tokens (approximately 256 characters)
- **Boundary awareness:** Prefer splitting at paragraph boundaries, sentence boundaries, or blank lines. Never split mid-word.

Each chunk gets its own embedding. Search returns the best-matching chunk with a reference to the parent document.

---

## 3. Embedding Model

**Model:** `Xenova/all-MiniLM-L6-v2`
- **Dimensions:** 384
- **Architecture:** MiniLM (distilled BERT), 6 layers, 22M parameters
- **ONNX size:** ~23 MB (downloaded once, cached locally)
- **Inference speed:** ~5ms per sentence on modern CPU (no GPU required)
- **Quality:** Top-tier for its size class. Achieves 68.1% on STS benchmark (vs 69.2% for the full model).

**Runtime:** `@xenova/transformers` (v3.x)
- Runs ONNX models in Node.js via `onnxruntime-node`
- No Python dependency. No external API calls.
- First load: ~2 seconds (model initialization). Subsequent calls: <10ms.
- Thread-safe: uses worker threads for concurrent embedding generation.

### 3.1 Model Loading

```typescript
import { pipeline } from '@xenova/transformers';

class EmbeddingEngine {
  private embedder: any = null;

  async initialize(): Promise<void> {
    this.embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,           // Use quantized model (smaller, faster)
      cache_dir: '.agentforge/models',  // Cache model locally
    });
  }

  async embed(text: string): Promise<Float32Array> {
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const outputs = await this.embedder(texts, { pooling: 'mean', normalize: true });
    // Split batch output into individual vectors
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(new Float32Array(outputs.data.slice(i * 384, (i + 1) * 384)));
    }
    return vectors;
  }
}
```

---

## 4. Storage

Embeddings are stored in the workspace SQLite database:

```sql
CREATE TABLE embeddings (
    id              TEXT PRIMARY KEY,
    source_type     TEXT NOT NULL CHECK(source_type IN ('session', 'feedback', 'memory', 'sprint', 'code')),
    source_id       TEXT NOT NULL,                -- ID of the source record
    chunk_index     INTEGER DEFAULT 0,            -- For multi-chunk documents
    content_hash    TEXT NOT NULL,                 -- SHA-256 of source content (for dedup)
    content_preview TEXT,                          -- First 200 chars for display
    vector          BLOB NOT NULL,                 -- Float32Array as Buffer (384 * 4 = 1536 bytes)
    metadata_json   TEXT DEFAULT '{}',             -- Additional metadata (agent, team, date range)
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(source_type, source_id, chunk_index)
);

CREATE INDEX idx_embeddings_source ON embeddings(source_type, source_id);
CREATE INDEX idx_embeddings_type ON embeddings(source_type);
CREATE INDEX idx_embeddings_hash ON embeddings(content_hash);
```

**Vector storage:** The 384-dimensional Float32Array is stored as a BLOB (1,536 bytes per vector). For 10,000 documents, this is approximately 15 MB — trivial for SQLite.

**No vector extension required.** Cosine similarity is computed in JavaScript (see section 5). SQLite just stores and retrieves the BLOBs. This avoids dependency on sqlite-vss or other native extensions that complicate deployment.

---

## 5. Similarity Search

### 5.1 Cosine Similarity in JavaScript

```typescript
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

Since vectors are normalized at embedding time (`normalize: true`), `normA` and `normB` are always 1.0, so cosine similarity simplifies to dot product:

```typescript
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
```

### 5.2 Search Algorithm

```typescript
async function search(
  query: string,
  opts: { type?: string; limit?: number; minScore?: number }
): Promise<SearchResult[]> {
  const queryVector = await embeddingEngine.embed(query);
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0.3;

  // Load all vectors from DB (or filtered by type)
  let sql = 'SELECT id, source_type, source_id, chunk_index, content_preview, vector, metadata_json FROM embeddings';
  const params: any[] = [];
  if (opts.type) {
    sql += ' WHERE source_type = ?';
    params.push(opts.type);
  }
  const rows = db.prepare(sql).all(...params);

  // Score each vector
  const scored = rows.map(row => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index,
    preview: row.content_preview,
    metadata: JSON.parse(row.metadata_json),
    score: dotProduct(queryVector, new Float32Array(row.vector.buffer)),
  }));

  // Sort by score descending, filter by min score, take top N
  return scored
    .filter(r => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

### 5.3 Performance Analysis

**10,000 documents (worst case: scan all):**
- Load 10K vectors from SQLite: ~15ms (15MB of BLOBs, SQLite is fast for sequential reads)
- Compute 10K dot products (384 dims each): ~2ms (3.84M float multiplications + additions)
- Sort + filter: ~1ms
- **Total: ~18ms** (well under 100ms target)

**100,000 documents:**
- Load: ~150ms (exceeds target)
- Mitigation: Add a source_type filter index. Most queries filter by type, reducing scan to 10-20K rows.
- Further mitigation at scale: HNSW index via `hnswlib-node` for approximate nearest neighbor. Adds ~10ms build time per 1K docs but reduces search to O(log N).

---

## 6. Index Management

### 6.1 Incremental Indexing

New documents are indexed as they are created:

```typescript
// In session completion handler
async function onSessionCompleted(session: Session) {
  const text = `${session.task}\n\n${session.result}`;
  const chunks = chunkText(text, 512, 64);

  for (let i = 0; i < chunks.length; i++) {
    const hash = sha256(chunks[i]);
    const existing = db.getEmbedding(session.id, 'session', i);

    if (existing && existing.contentHash === hash) continue; // Already indexed, content unchanged

    const vector = await embeddingEngine.embed(chunks[i]);
    db.upsertEmbedding({
      sourceType: 'session',
      sourceId: session.id,
      chunkIndex: i,
      contentHash: hash,
      contentPreview: chunks[i].substring(0, 200),
      vector: Buffer.from(vector.buffer),
      metadata: { agentId: session.agentId, team: session.team },
    });
  }
}
```

### 6.2 Bulk Re-Index

```bash
# Re-index all sessions (e.g., after model upgrade)
agentforge index rebuild --type session

# Re-index everything
agentforge index rebuild --all

# Index code files
agentforge index code ./src --extensions ts,js
```

Re-indexing is idempotent. Content hashes prevent redundant embedding calls.

### 6.3 Index Statistics

```bash
agentforge index stats
```

Output:
```
Embedding Index Statistics
─────────────────────────
Source Type    Documents    Chunks    Size (MB)
session       2,847        4,123     6.3
feedback      1,293        1,293     2.0
memory        412          412       0.6
sprint        156          156       0.2
code          0            0         0.0
─────────────────────────
Total         4,708        5,984     9.1

Model: all-MiniLM-L6-v2 (384 dims, quantized)
Last full index: 2026-03-27T14:30:00Z
```

---

## 7. Query API

### 7.1 REST Endpoint

```
GET /api/v5/search?q={query}&type={type}&limit={limit}&minScore={minScore}
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | (required) | Search query in natural language |
| `type` | string | (all) | Filter by source type: `session`, `feedback`, `memory`, `sprint`, `code` |
| `limit` | number | 10 | Maximum results (1-100) |
| `minScore` | number | 0.3 | Minimum similarity score (0.0-1.0) |

**Response:**

```json
{
  "data": {
    "results": [
      {
        "id": "emb_01JQR...",
        "sourceType": "session",
        "sourceId": "sess_01JQR...",
        "chunkIndex": 0,
        "score": 0.847,
        "preview": "Implement the WebSocket handler for real-time dashboard updates. The handler should support multiplexed channels...",
        "metadata": {
          "agentId": "api-gateway-engineer",
          "team": "backend"
        },
        "link": "/sessions/sess_01JQR..."
      },
      {
        "id": "emb_01JQS...",
        "sourceType": "feedback",
        "sourceId": "fb_01JQS...",
        "chunkIndex": 0,
        "score": 0.723,
        "preview": "The SSE implementation should be replaced with WebSocket for bidirectional communication...",
        "metadata": {
          "agentId": "cto",
          "team": "executive"
        },
        "link": "/feedback/fb_01JQS..."
      }
    ],
    "query": "websocket implementation",
    "totalResults": 2,
    "searchTimeMs": 23
  },
  "meta": {
    "indexSize": 5984,
    "model": "all-MiniLM-L6-v2"
  }
}
```

### 7.2 CLI Search

```bash
agentforge search "how did we handle cost anomaly detection"
```

Output:
```
Search: "how did we handle cost anomaly detection" (23ms, 4 results)

1. [session] sess_01JQR... (score: 0.89)
   Agent: observability-engineer | Team: backend
   "Implemented cost anomaly detection using z-score analysis on rolling 24h windows..."

2. [feedback] fb_01JQS... (score: 0.76)
   Agent: cfo | Team: executive
   "The cost anomaly threshold should be configurable per workspace..."

3. [sprint] si_01JQT... (score: 0.71)
   Sprint: v4.8 | Item: P2-4
   "Cost Anomaly Detection UI: Real-time banner when cost anomaly detected..."

4. [memory] mem_01JQU... (score: 0.65)
   Agent: budget-strategy-researcher
   "cost_anomaly_threshold: 2.5 standard deviations from 7-day rolling mean"
```

---

## 8. Dashboard Integration

The search bar in the v5 dashboard header uses this API:

1. User types in search box (debounced 300ms)
2. Frontend calls `GET /api/v5/search?q={input}&limit=5`
3. Results displayed in dropdown with source type badges, preview, and score
4. Click a result to navigate to the source (session detail, feedback entry, etc.)
5. Full search page at `/search` with filters, pagination, and type facets

---

## 9. Future Enhancements (v5.1+)

1. **HNSW index.** For >50K documents, switch from brute-force scan to approximate nearest neighbor using `hnswlib-node`. Reduces search from O(N) to O(log N).
2. **Hybrid search.** Combine embedding similarity with BM25 keyword matching for better precision on exact terms.
3. **Re-ranking.** Use a cross-encoder model to re-rank top-20 results for improved relevance.
4. **Agent-aware search.** Weight results based on the querying agent's domain — a backend engineer searching "auth" should see backend auth results first.
5. **Model upgrade path.** When a better embedding model is available, run `agentforge index rebuild --all` to re-embed everything. Content hashes ensure only changed documents are re-processed.
