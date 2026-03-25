import { describe, it, expect } from "vitest";
import type { KnowledgeScope, KnowledgeEntry } from "../../src/types/knowledge.js";

describe("Knowledge types", () => {
  it("KnowledgeScope accepts valid scope values", () => {
    const scopes: KnowledgeScope[] = ["session", "project", "entity"];
    expect(scopes).toHaveLength(3);
  });

  it("KnowledgeEntry has required fields", () => {
    const entry: KnowledgeEntry = {
      id: "test-id",
      scope: "session",
      key: "agent:topic",
      value: { data: true },
      createdBy: "test-agent",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
    };
    expect(entry.id).toBe("test-id");
    expect(entry.scope).toBe("session");
    expect(entry.tags).toBeUndefined();
  });

  it("KnowledgeEntry accepts optional tags", () => {
    const entry: KnowledgeEntry = {
      id: "test-id",
      scope: "project",
      key: "config:theme",
      value: "dark",
      createdBy: "vp-product",
      createdAt: "2026-03-25T00:00:00.000Z",
      updatedAt: "2026-03-25T00:00:00.000Z",
      tags: ["config", "ui"],
    };
    expect(entry.tags).toEqual(["config", "ui"]);
  });

  it("KnowledgeEntry value accepts arbitrary JSON types", () => {
    const entries: KnowledgeEntry[] = [
      { id: "1", scope: "session", key: "k", value: "string", createdBy: "a", createdAt: "", updatedAt: "" },
      { id: "2", scope: "session", key: "k", value: 42, createdBy: "a", createdAt: "", updatedAt: "" },
      { id: "3", scope: "session", key: "k", value: [1, 2], createdBy: "a", createdAt: "", updatedAt: "" },
      { id: "4", scope: "session", key: "k", value: { nested: true }, createdBy: "a", createdAt: "", updatedAt: "" },
      { id: "5", scope: "session", key: "k", value: null, createdBy: "a", createdAt: "", updatedAt: "" },
    ];
    expect(entries).toHaveLength(5);
  });
});
