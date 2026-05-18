/**
 * af_kb_lookup — fetch a KB document from AgentForge.
 *
 * Strategy:
 *   1. Try HTTP loopback to running AgentForge server (AGENTFORGE_API_URL or
 *      http://localhost:4751 by default).
 *   2. On network error, surface it — direct adapter reads would require
 *      importing @agentforge/db which adds heavy SQLite deps. Consumers should
 *      ensure the server is running.
 *
 * SECURITY: kb_id and doc_id are validated with match-then-use before
 * being embedded in URLs.
 */

import { z } from 'zod';

export const AfKbLookupInput = z.object({
  kb_id: z.string().min(1).max(63),
  doc_id: z.string().min(1).max(63).optional(),
  version: z.number().int().positive().optional(),
});

export type AfKbLookupInputType = z.infer<typeof AfKbLookupInput>;

export interface AfKbLookupResult {
  ok: boolean;
  data: {
    kbId: string;
    docId: string;
    version: number;
    body: string;
  } | null;
  error: { code: string; message: string } | null;
}

/** Validate a KB/doc slug — lowercase alphanum + dashes, 1-63 chars, no leading dash. */
function validateSlug(slug: string, label: string): { safe: string } | { error: string } {
  const m = slug.match(/^[a-z0-9][a-z0-9-]{0,62}$/);
  if (!m) {
    return { error: `${label} "${slug}" is invalid; must be lowercase alphanumerics and dashes (1-63 chars, no leading dash)` };
  }
  return { safe: m[0] };
}

interface KbDocApiResponse {
  id?: string;
  slug?: string;
  body?: {
    version?: number;
    bodyMd?: string;
  } | null;
}

interface KbDocVersionApiResponse {
  id?: string;
  version?: number;
  bodyMd?: string;
}

export async function afKbLookup(
  input: AfKbLookupInputType,
  baseUrl?: string,
): Promise<AfKbLookupResult> {
  // Validate kb_id (match-then-use)
  const kbResult = validateSlug(input.kb_id, 'kb_id');
  if ('error' in kbResult) {
    return { ok: false, data: null, error: { code: 'INVALID_KB_ID', message: kbResult.error } };
  }
  const safeKbId = kbResult.safe;

  // Validate doc_id if provided
  let safeDocId: string | undefined;
  if (input.doc_id) {
    const docResult = validateSlug(input.doc_id, 'doc_id');
    if ('error' in docResult) {
      return { ok: false, data: null, error: { code: 'INVALID_DOC_ID', message: docResult.error } };
    }
    safeDocId = docResult.safe;
  }

  const apiBase = baseUrl ?? process.env['AGENTFORGE_API_URL'] ?? 'http://localhost:4751';

  try {
    if (safeDocId && input.version !== undefined) {
      // Fetch specific version
      const url = `${apiBase}/api/v5/kbs/${safeKbId}/docs/${safeDocId}/versions/${input.version}`;
      const res = await fetch(url);
      if (!res.ok) {
        return {
          ok: false,
          data: null,
          error: { code: `HTTP_${res.status}`, message: `Server returned ${res.status}: ${res.statusText}` },
        };
      }
      const ver = await res.json() as KbDocVersionApiResponse;
      return {
        ok: true,
        data: {
          kbId: safeKbId,
          docId: safeDocId,
          version: ver.version ?? input.version,
          body: ver.bodyMd ?? '',
        },
        error: null,
      };
    }

    if (safeDocId) {
      // Fetch current version of a doc
      const url = `${apiBase}/api/v5/kbs/${safeKbId}/docs/${safeDocId}`;
      const res = await fetch(url);
      if (!res.ok) {
        return {
          ok: false,
          data: null,
          error: { code: `HTTP_${res.status}`, message: `Server returned ${res.status}: ${res.statusText}` },
        };
      }
      const doc = await res.json() as KbDocApiResponse;
      return {
        ok: true,
        data: {
          kbId: safeKbId,
          docId: doc.slug ?? safeDocId,
          version: doc.body?.version ?? 1,
          body: doc.body?.bodyMd ?? '',
        },
        error: null,
      };
    }

    // No doc_id — return KB metadata summary
    const url = `${apiBase}/api/v5/kbs/${safeKbId}`;
    const res = await fetch(url);
    if (!res.ok) {
      return {
        ok: false,
        data: null,
        error: { code: `HTTP_${res.status}`, message: `Server returned ${res.status}: ${res.statusText}` },
      };
    }
    const kb = await res.json() as { slug?: string; title?: string; description?: string | null };
    return {
      ok: true,
      data: {
        kbId: safeKbId,
        docId: '',
        version: 0,
        body: `KB: ${kb.title ?? safeKbId}\n${kb.description ?? ''}`.trim(),
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      data: null,
      error: { code: 'NETWORK_ERROR', message: `Failed to reach AgentForge server: ${msg}` },
    };
  }
}
