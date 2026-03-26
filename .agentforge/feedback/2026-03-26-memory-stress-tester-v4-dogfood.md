---
agent: memory-stress-tester
date: 2026-03-26
v4_features_tested: [MemoryRegistry, SemanticSearch, MCPMemoryProvider, StorageGovernor]
verdict: pass
---

## What Worked
- MemoryRegistry stores/retrieves/updates/removes entries cleanly
- Immutability enforcement works — returned entries are deep copies (tags array cloned)
- Relevance decay math is correct: `score - (daysSinceAccess * decayRate)`, floors at 0.0
- Expiration purge removes entries with past `expiresAt` correctly
- StorageGovernor enforces hard limit, LRU eviction selects oldest by lastAccessedAt
- Per-agent quotas work independently of global limit
- MCPMemoryProvider URI scheme `memory://` is consistent
- MCP read records access (updates lastAccessedAt)
- Semantic search returns >90% accuracy on keyword-overlap queries (gate met)

## What Didn't Work
- **SemanticSearch uses bag-of-words cosine similarity** — fails for semantically related but lexically different queries. "How do I test?" won't match "TDD improves quality" because no shared tokens.
- **No embedding support** — the search is purely keyword-based. This limits real-world usefulness.
- **findPotentialDuplicates is too aggressive** — matching ANY word means "the" or "a" could trigger false duplicates
- **StorageGovernor doesn't integrate with MemoryRegistry** — they track files independently. Removing from one doesn't remove from the other.
- **No bulk operations** — storing 500 entries requires 500 individual `store()` calls. No `storeMany()`.
- **MCP search lacks pagination** — returns all matches, no limit/offset

## v4.1 Recommendations
1. **PRIORITY: Add embedding-based search** — integrate with an embedding model for real semantic similarity. Keep keyword fallback below 0.60 threshold.
2. Add `StorageGovernor.syncWithRegistry(registry)` to keep file tracking in sync
3. Add `storeMany()` and `removeMany()` bulk operations
4. Add pagination to `searchResources()` and `searchByKeyword()`
5. Improve dedup: use n-gram overlap or Jaccard similarity instead of ANY-word match
6. Add memory categories enum validation — currently accepts any string

## Edge Cases Found
- `decayRatePerDay: 1.0` makes a memory worthless after 1 day — no minimum relevance floor configured
- `searchByTags([])` with empty array returns nothing (correct but could return all)
- `relevanceScore: NaN` can be stored — no input validation
