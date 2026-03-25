/**
 * Standardized benchmark tasks for the v3 launch gate validation.
 *
 * 10 tasks spanning 3 complexity tiers:
 *   - Tasks 1-3:  Low complexity  → should route to Haiku
 *   - Tasks 4-7:  Medium complexity → should route to Sonnet
 *   - Tasks 8-10: High complexity → should route to Opus/Sonnet
 */

export interface BenchmarkTask {
  id: number;
  name: string;
  prompt: string;
  expectedTier: "haiku" | "sonnet" | "opus";
  complexity: "low" | "medium" | "high";
}

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  // ── Low Complexity (Haiku) ──────────────────────────────────────────────
  {
    id: 1,
    name: "format-json",
    prompt:
      "Format the following data as a valid JSON object with proper indentation: " +
      "name is Alice, age is 30, role is engineer, team is platform, active is true.",
    expectedTier: "haiku",
    complexity: "low",
  },
  {
    id: 2,
    name: "generate-interface",
    prompt:
      "Generate a TypeScript interface called UserProfile with these fields: " +
      "id (string), email (string), displayName (string), createdAt (Date), isAdmin (boolean).",
    expectedTier: "haiku",
    complexity: "low",
  },
  {
    id: 3,
    name: "write-regex",
    prompt:
      "Write a single-line JavaScript regex that validates email addresses. " +
      "It should match standard formats like user@example.com. Return only the regex.",
    expectedTier: "haiku",
    complexity: "low",
  },

  // ── Medium Complexity (Sonnet) ──────────────────────────────────────────
  {
    id: 4,
    name: "review-function",
    prompt:
      "Review this function for bugs and suggest fixes:\n\n" +
      "function findDuplicates(arr) {\n" +
      "  const seen = {};\n" +
      "  const dupes = [];\n" +
      "  for (let i = 0; i <= arr.length; i++) {\n" +
      "    if (seen[arr[i]]) {\n" +
      "      dupes.push(arr[i]);\n" +
      "    }\n" +
      "    seen[arr[i]] = true;\n" +
      "  }\n" +
      "  return dupes;\n" +
      "}",
    expectedTier: "sonnet",
    complexity: "medium",
  },
  {
    id: 5,
    name: "caching-tradeoffs",
    prompt:
      "Explain the trade-offs between these three caching strategies for a web API: " +
      "(1) in-memory LRU cache, (2) Redis distributed cache, (3) HTTP cache headers. " +
      "Consider: latency, consistency, scalability, and implementation complexity.",
    expectedTier: "sonnet",
    complexity: "medium",
  },
  {
    id: 6,
    name: "write-tests",
    prompt:
      "Write 3 unit tests (using vitest syntax) for this sorting function:\n\n" +
      "function insertionSort(arr: number[]): number[] {\n" +
      "  const result = [...arr];\n" +
      "  for (let i = 1; i < result.length; i++) {\n" +
      "    const key = result[i];\n" +
      "    let j = i - 1;\n" +
      "    while (j >= 0 && result[j] > key) {\n" +
      "      result[j + 1] = result[j];\n" +
      "      j--;\n" +
      "    }\n" +
      "    result[j + 1] = key;\n" +
      "  }\n" +
      "  return result;\n" +
      "}",
    expectedTier: "sonnet",
    complexity: "medium",
  },
  {
    id: 7,
    name: "refactor-callbacks",
    prompt:
      "Refactor this callback-heavy Node.js code to use async/await:\n\n" +
      "function processFile(path, callback) {\n" +
      "  fs.readFile(path, 'utf-8', (err, data) => {\n" +
      "    if (err) return callback(err);\n" +
      "    parseJSON(data, (err, parsed) => {\n" +
      "      if (err) return callback(err);\n" +
      "      validateSchema(parsed, (err, valid) => {\n" +
      "        if (err) return callback(err);\n" +
      "        callback(null, valid);\n" +
      "      });\n" +
      "    });\n" +
      "  });\n" +
      "}",
    expectedTier: "sonnet",
    complexity: "medium",
  },

  // ── High Complexity (Opus/Sonnet) ───────────────────────────────────────
  {
    id: 8,
    name: "design-rate-limiter",
    prompt:
      "Design a rate limiter with a sliding window algorithm in TypeScript. " +
      "Requirements: (1) configurable window size and max requests, " +
      "(2) O(1) check operation, (3) memory-efficient for millions of keys, " +
      "(4) thread-safe considerations. Provide the complete implementation.",
    expectedTier: "opus",
    complexity: "high",
  },
  {
    id: 9,
    name: "analyze-race-condition",
    prompt:
      "Analyze this concurrent code for race conditions and propose fixes:\n\n" +
      "class Counter {\n" +
      "  private count = 0;\n" +
      "  private cache = new Map();\n" +
      "\n" +
      "  async increment(key: string) {\n" +
      "    const current = this.cache.get(key) ?? 0;\n" +
      "    await this.persist(key, current + 1);\n" +
      "    this.cache.set(key, current + 1);\n" +
      "    this.count++;\n" +
      "  }\n" +
      "\n" +
      "  async decrement(key: string) {\n" +
      "    const current = this.cache.get(key) ?? 0;\n" +
      "    if (current > 0) {\n" +
      "      await this.persist(key, current - 1);\n" +
      "      this.cache.set(key, current - 1);\n" +
      "      this.count--;\n" +
      "    }\n" +
      "  }\n" +
      "\n" +
      "  private async persist(key: string, value: number) {\n" +
      "    await new Promise(r => setTimeout(r, 10));\n" +
      "  }\n" +
      "}",
    expectedTier: "opus",
    complexity: "high",
  },
  {
    id: 10,
    name: "architect-pubsub",
    prompt:
      "Architect a pub-sub messaging system with backpressure support in TypeScript. " +
      "Requirements: (1) topic-based routing, (2) configurable subscriber buffer sizes, " +
      "(3) backpressure propagation when subscribers fall behind, " +
      "(4) dead letter queue for failed messages, (5) at-least-once delivery guarantee. " +
      "Provide the type definitions and core class structure.",
    expectedTier: "opus",
    complexity: "high",
  },
];
