/**
 * MCPMemoryProvider — Sprint 3.2a
 *
 * Exposes MemoryRegistry entries as MCP resources.
 * Standard MCP protocol: listResources, readResource, writeResource, deleteResource.
 *
 * URI scheme: memory://{entryId}
 */

import type { MemoryRegistryEntry, MemoryCategory } from "../types/v4-api.js";
import type { MemoryRegistry } from "../registry/memory-registry.js";

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

export interface MCPResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface MCPReadResult {
  contents: MCPResourceContent[];
}

export interface MCPWriteInput {
  ownerAgentId: string;
  category: MemoryCategory;
  summary: string;
  tags?: string[];
  contentPath?: string;
  relevanceScore?: number;
  decayRatePerDay?: number;
  expiresAt?: string | null;
}

export class MCPMemoryProvider {
  constructor(private readonly registry: MemoryRegistry) {}

  listResources(): MCPResource[] {
    return this.registry.getAll().map((e) => ({
      uri: `memory://${e.id}`,
      name: e.summary,
      description: `[${e.category}] by ${e.ownerAgentId}`,
      mimeType: "text/markdown",
    }));
  }

  readResource(uri: string): MCPReadResult {
    const id = this.extractId(uri);
    const entry = this.registry.get(id);
    if (!entry) throw new Error(`Memory resource "${uri}" not found`);
    this.registry.recordAccess(id);

    return {
      contents: [{
        uri,
        mimeType: "text/markdown",
        text: this.formatEntry(entry),
      }],
    };
  }

  writeResource(input: MCPWriteInput): { id: string } {
    const entry = this.registry.store({
      type: "memory",
      version: "1.0.0",
      ownerAgentId: input.ownerAgentId,
      category: input.category,
      summary: input.summary,
      contentPath: input.contentPath ?? `/.forge/memory/${input.ownerAgentId}/${Date.now()}.md`,
      relevanceScore: input.relevanceScore ?? 0.9,
      decayRatePerDay: input.decayRatePerDay ?? 0.01,
      lastAccessedAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
      tags: input.tags ?? [],
    });
    return { id: entry.id };
  }

  searchResources(query: string, options?: { tags?: string[] }): MCPResource[] {
    let entries: MemoryRegistryEntry[];
    if (options?.tags && options.tags.length > 0) {
      entries = this.registry.searchByTags(options.tags);
    } else if (query) {
      entries = this.registry.searchByKeyword(query);
    } else {
      entries = this.registry.getAll();
    }
    return entries.map((e) => ({
      uri: `memory://${e.id}`,
      name: e.summary,
      description: `[${e.category}] by ${e.ownerAgentId}`,
      mimeType: "text/markdown",
    }));
  }

  deleteResource(uri: string): void {
    const id = this.extractId(uri);
    this.registry.remove(id);
  }

  private extractId(uri: string): string {
    return uri.replace("memory://", "");
  }

  private formatEntry(entry: MemoryRegistryEntry): string {
    return [
      `# ${entry.summary}`,
      "",
      `**Category:** ${entry.category}`,
      `**Owner:** ${entry.ownerAgentId}`,
      `**Relevance:** ${entry.relevanceScore.toFixed(2)}`,
      `**Tags:** ${entry.tags.join(", ") || "none"}`,
      `**Content:** ${entry.contentPath}`,
      `**Created:** ${entry.createdAt}`,
      `**Last Accessed:** ${entry.lastAccessedAt}`,
    ].join("\n");
  }
}
