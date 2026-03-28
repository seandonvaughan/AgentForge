import { generateId } from '@agentforge/shared';
import type { EdgeCaseInput, EdgeCaseCategory, GenerateEdgeCasesOptions } from './types.js';

/** Built-in edge case templates */
const EDGE_CASES: Array<Omit<EdgeCaseInput, 'id'>> = [
  // Boundary
  { category: 'boundary', name: 'empty_string', value: '', description: 'Empty string input', expectedBehavior: 'reject' },
  { category: 'boundary', name: 'zero', value: 0, description: 'Zero numeric value', expectedBehavior: 'handle_gracefully' },
  { category: 'boundary', name: 'negative_one', value: -1, description: 'Negative integer', expectedBehavior: 'handle_gracefully' },
  { category: 'boundary', name: 'max_safe_integer', value: Number.MAX_SAFE_INTEGER, description: 'JS max safe integer', expectedBehavior: 'handle_gracefully' },
  { category: 'boundary', name: 'min_safe_integer', value: Number.MIN_SAFE_INTEGER, description: 'JS min safe integer', expectedBehavior: 'handle_gracefully' },
  { category: 'boundary', name: 'empty_array', value: [], description: 'Empty array', expectedBehavior: 'handle_gracefully' },
  { category: 'boundary', name: 'empty_object', value: {}, description: 'Empty object', expectedBehavior: 'handle_gracefully' },

  // Injection
  { category: 'injection', name: 'sql_injection', value: "'; DROP TABLE agents; --", description: 'SQL injection attempt', expectedBehavior: 'handle_gracefully' },
  { category: 'injection', name: 'script_injection', value: '<script>alert("xss")</script>', description: 'XSS injection attempt', expectedBehavior: 'handle_gracefully' },
  { category: 'injection', name: 'path_traversal', value: '../../etc/passwd', description: 'Path traversal attempt', expectedBehavior: 'reject' },
  { category: 'injection', name: 'null_byte', value: 'valid\0string', description: 'String with null byte', expectedBehavior: 'handle_gracefully' },
  { category: 'injection', name: 'json_injection', value: '{"__proto__":{"polluted":true}}', description: 'Prototype pollution via JSON', expectedBehavior: 'handle_gracefully' },

  // Null-like
  { category: 'null_like', name: 'null_value', value: null, description: 'Explicit null', expectedBehavior: 'reject' },
  { category: 'null_like', name: 'undefined_str', value: 'undefined', description: 'String "undefined"', expectedBehavior: 'handle_gracefully' },
  { category: 'null_like', name: 'null_str', value: 'null', description: 'String "null"', expectedBehavior: 'handle_gracefully' },
  { category: 'null_like', name: 'nan_value', value: NaN, description: 'Not-a-number', expectedBehavior: 'handle_gracefully' },
  { category: 'null_like', name: 'infinity', value: Infinity, description: 'Positive infinity', expectedBehavior: 'handle_gracefully' },
  { category: 'null_like', name: 'negative_infinity', value: -Infinity, description: 'Negative infinity', expectedBehavior: 'handle_gracefully' },

  // Overflow
  { category: 'overflow', name: 'long_string', value: 'a'.repeat(10_000), description: '10,000 character string', expectedBehavior: 'reject' },
  { category: 'overflow', name: 'deep_nesting', value: JSON.parse('{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{}}}}}}}}}}}'), description: 'Deeply nested object', expectedBehavior: 'handle_gracefully' },
  { category: 'overflow', name: 'large_array', value: new Array(1000).fill(0), description: '1000 element array', expectedBehavior: 'handle_gracefully' },

  // Unicode
  { category: 'unicode', name: 'emoji', value: '🎭🔥💥🚀', description: 'Emoji characters', expectedBehavior: 'handle_gracefully' },
  { category: 'unicode', name: 'rtl_text', value: '\u202Ehello world', description: 'Right-to-left override character', expectedBehavior: 'handle_gracefully' },
  { category: 'unicode', name: 'zero_width', value: 'hello\u200bworld', description: 'Zero-width space in string', expectedBehavior: 'handle_gracefully' },
  { category: 'unicode', name: 'surrogate_pair', value: '\uD83D\uDE00', description: 'Unicode surrogate pair (emoji)', expectedBehavior: 'handle_gracefully' },

  // Malformed
  { category: 'malformed', name: 'malformed_json', value: '{invalid json}', description: 'Malformed JSON string', expectedBehavior: 'reject' },
  { category: 'malformed', name: 'wrong_type_string', value: '42', description: 'Number passed as string', expectedBehavior: 'handle_gracefully' },
  { category: 'malformed', name: 'bool_as_string', value: 'true', description: 'Boolean passed as string', expectedBehavior: 'handle_gracefully' },

  // Type coercion
  { category: 'type_coercion', name: 'numeric_string', value: '1e10', description: 'Scientific notation string', expectedBehavior: 'handle_gracefully' },
  { category: 'type_coercion', name: 'leading_zeros', value: '007', description: 'String with leading zeros', expectedBehavior: 'handle_gracefully' },
  { category: 'type_coercion', name: 'hex_string', value: '0xff', description: 'Hex number as string', expectedBehavior: 'handle_gracefully' },
];

/**
 * AdversarialGenerator — generates edge case inputs for adversarial testing.
 */
export class AdversarialGenerator {
  private customCases: Array<Omit<EdgeCaseInput, 'id'>> = [];

  /**
   * Generate edge cases matching the requested options.
   */
  generate(opts: GenerateEdgeCasesOptions = {}): EdgeCaseInput[] {
    const { categories, count, fieldName, fieldType } = opts;

    let pool = [...EDGE_CASES, ...this.customCases];

    // Filter by category
    if (categories && categories.length > 0) {
      pool = pool.filter(c => categories.includes(c.category));
    }

    // Filter by field type compatibility
    if (fieldType) {
      pool = pool.filter(c => this.isCompatible(c.value, fieldType));
    }

    // Apply count limit
    const selected = count ? pool.slice(0, count) : pool;

    return selected.map(c => ({
      id: generateId(),
      ...c,
      name: fieldName ? `${fieldName}.${c.name}` : c.name,
    }));
  }

  /**
   * Generate a specific category of edge cases.
   */
  generateForCategory(category: EdgeCaseCategory): EdgeCaseInput[] {
    return this.generate({ categories: [category] });
  }

  /**
   * Add a custom edge case to the generator's pool.
   */
  addCustomCase(c: Omit<EdgeCaseInput, 'id'>): void {
    this.customCases.push(c);
  }

  /**
   * Get all available categories.
   */
  getCategories(): EdgeCaseCategory[] {
    return [...new Set([...EDGE_CASES, ...this.customCases].map(c => c.category))];
  }

  /**
   * Total number of built-in + custom edge cases.
   */
  count(): number {
    return EDGE_CASES.length + this.customCases.length;
  }

  private isCompatible(value: unknown, fieldType: string): boolean {
    switch (fieldType) {
      case 'string': return typeof value === 'string' || value === null;
      case 'number': return typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)));
      case 'object': return typeof value === 'object';
      case 'array': return Array.isArray(value) || value === null;
      default: return true;
    }
  }
}
