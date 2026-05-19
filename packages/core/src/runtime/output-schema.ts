import type { AgentOutputSchema } from './types.js';

export function normalizeStrictOutputSchema(schema: AgentOutputSchema): AgentOutputSchema {
  if (schema.strict === false) return schema;

  const propertyKeys = Object.keys(schema.schema.properties);
  const required = Array.from(new Set([...(schema.schema.required ?? []), ...propertyKeys]));

  return {
    ...schema,
    schema: {
      ...schema.schema,
      required,
      additionalProperties: schema.schema.additionalProperties ?? false,
    },
  };
}
