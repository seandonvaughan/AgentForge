---
agent: researcher
date: 2026-03-26
v4_features_tested: [SemanticSearch, MCPMemoryProvider]
verdict: partial
---

## What Worked
- MCP URI scheme (memory://) follows standard patterns
- MCP read/write/list/delete operations work correctly
- Keyword-based search adequate for exact-match queries
- Tag-based filtering is fast and reliable

## What Didn't Work
- **Bag-of-words search is fundamentally limited** — industry standard is embedding-based search (FAISS, Qdrant, ChromaDB). Our approach will fail for real agent knowledge retrieval.
- **No external knowledge ingestion** — can only store manually. No web scrape → memory pipeline.
- **MCP provider doesn't support resource templates** — can't query by agent or category via MCP URI

## v4.1 Recommendations
1. **P0: Evaluate embedding options** — local embeddings (transformers.js) vs API (Anthropic/OpenAI)
2. Add MCP resource templates: `memory://agent/{agentId}`, `memory://category/{cat}`
3. Add knowledge ingestion pipeline: URL → extract → store → index
4. Benchmark search quality: precision@5, recall@10, MRR across test queries
