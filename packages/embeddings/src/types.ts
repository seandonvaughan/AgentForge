export interface EmbeddingDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  workspaceId?: string;
}

export interface EmbeddingResult {
  id: string;
  score: number;  // cosine similarity 0–1
  content: string;
  metadata?: Record<string, unknown>;
}

export interface EmbeddingSearchOptions {
  topK?: number;          // default 10
  minScore?: number;      // default 0.5
  workspaceId?: string;   // filter by workspace
}

export interface EmbeddingStats {
  totalDocuments: number;
  indexedAt: string;
  modelId: string;
  dimensionality: number;
}
