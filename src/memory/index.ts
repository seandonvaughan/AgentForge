// Barrel exports — memory module

export {
  MCPMemoryProvider,
  type MCPResource,
  type MCPResourceContent,
  type MCPReadResult,
  type MCPWriteInput,
} from "./mcp-memory-provider.js";

export {
  SemanticSearch,
  DEFAULT_SIMILARITY_THRESHOLD,
  KEYWORD_FALLBACK_THRESHOLD,
  type SearchHit,
  type SearchResult,
  type SearchOptions,
} from "./semantic-search.js";

export {
  KnowledgeIngester,
  type CodeSymbol,
  type KnowledgeIndex,
} from "./knowledge-ingester.js";
