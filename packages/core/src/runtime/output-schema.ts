import type { AgentOutputSchema } from './types.js';

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStrictJsonSchemaNode(node: unknown): unknown {
  if (!isJsonObject(node)) return node;

  const normalized: Record<string, unknown> = { ...node };

  if (isJsonObject(normalized.properties)) {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([key, value]) => [
        key,
        normalizeStrictJsonSchemaNode(value),
      ]),
    );
  }

  if ('items' in normalized) {
    normalized.items = normalizeStrictJsonSchemaNode(normalized.items);
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(normalized[key])) {
      normalized[key] = normalized[key].map((value) => normalizeStrictJsonSchemaNode(value));
    }
  }

  if (normalized.type === 'object' && isJsonObject(normalized.properties)) {
    const propertyKeys = Object.keys(normalized.properties);
    const existingRequired = Array.isArray(normalized.required)
      ? normalized.required.filter((key): key is string => typeof key === 'string')
      : [];
    normalized.required = Array.from(new Set([...existingRequired, ...propertyKeys]));
    normalized.additionalProperties = normalized.additionalProperties ?? false;
  }

  return normalized;
}

export function normalizeStrictOutputSchema(schema: AgentOutputSchema): AgentOutputSchema {
  if (schema.strict === false) return schema;

  return {
    ...schema,
    schema: normalizeStrictJsonSchemaNode(schema.schema) as AgentOutputSchema['schema'],
  };
}
