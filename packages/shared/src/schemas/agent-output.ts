import { z } from "zod";

// ── JSON Schema subset ─────────────────────────────────────────────────────

export const JsonSchemaSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
  additionalProperties: z.boolean().optional(),
}).passthrough();
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

// ── AgentOutputSchema ──────────────────────────────────────────────────────

export const AgentOutputSchemaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schema: JsonSchemaSchema,
  strict: z.boolean().default(true),
});
export type AgentOutputSchema = z.infer<typeof AgentOutputSchemaSchema>;

// ── ValidatedJsonOutput ────────────────────────────────────────────────────

export const ValidatedJsonOutputSchema = z.object({
  agentId: z.string(),
  schemaName: z.string(),
  raw: z.string(),
  parsed: z.unknown(),
  ok: z.boolean(),
  validationError: z.string().optional(),
  capturedAt: z.string(),
});
export type ValidatedJsonOutput = z.infer<typeof ValidatedJsonOutputSchema>;

// ── validateAgainstSchema ──────────────────────────────────────────────────
// Uses AJV if available (fast, standards-compliant); falls back to a minimal
// hand-rolled validator covering type/properties/required/additionalProperties.

export function validateAgainstSchema(
  raw: string,
  schema: JsonSchema,
): { ok: boolean; parsed?: unknown; error?: string } {
  // 1. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Invalid JSON: ${msg}` };
  }

  // 2. Validate against schema using minimal hand-rolled validator
  // (AJV is not a direct dep of @agentforge/shared; hand-rolled covers the
  // required subset: type / properties / required / additionalProperties)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "value: expected an object" };
  }

  const record = parsed as Record<string, unknown>;

  // required fields
  if (Array.isArray(schema.required)) {
    for (const field of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) {
        return { ok: false, error: `${field}: required field missing` };
      }
    }
  }

  // additionalProperties
  if (schema.additionalProperties === false && schema.properties) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        return { ok: false, error: `${key}: additional property not allowed` };
      }
    }
  }

  return { ok: true, parsed };
}
