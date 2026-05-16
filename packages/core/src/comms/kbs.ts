/**
 * Knowledge Bases (Subsystem C v1) — SharePoint-style versioned doc store.
 *
 * v1 scope (per the agent-comm + KB spec, section 5):
 *   - CRUD on KBs with visibility metadata (`private` | `workspace` | `public`)
 *   - CRUD on KB documents within a KB, identified by `(kb_id, slug)`
 *   - Every document update is a NEW version row — body history is never
 *     overwritten. `current_version_id` on the doc points at the head.
 *   - Helpers return view-model shapes (camelCase, current version embedded).
 *
 * Deferred to Phase 2 (flag in PR):
 *   - ACL enforcement (read_scope + write_scope) — v1 is "read all, write
 *     requires authenticated".
 *   - FTS5 full-text search.
 *   - kb_links cross-link table.
 *   - Auto-summarisation + embeddings.
 *
 * See `docs/v2-architecture/agent-comm-and-kb-spec.md` section 5 + ADR notes.
 */

import type {
  WorkspaceAdapter,
  KbRow,
  KbDocRow,
  KbDocVersionRow,
  KbVisibility,
} from '@agentforge/db';

export type { KbVisibility } from '@agentforge/db';

/** Public KB view-model. */
export interface Kb {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  owner: string;
  visibility: KbVisibility;
  createdAt: string;
  updatedAt: string;
}

/** Public KB document summary (no body). */
export interface KbDoc {
  id: string;
  kbId: string;
  slug: string;
  title: string;
  currentVersionId: string | null;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Public KB doc version. */
export interface KbDocVersion {
  id: string;
  docId: string;
  version: number;
  bodyMd: string;
  authoredBy: string;
  authoredAt: string;
  commitMessage: string | null;
}

/** Doc + its head version body, for the read path. */
export interface KbDocWithBody extends KbDoc {
  body: KbDocVersion | null;
}

const VALID_VISIBILITY: ReadonlySet<KbVisibility> = new Set(['private', 'workspace', 'public']);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertSlug(slug: string, label: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `${label} slug "${slug}" is invalid; must match ${SLUG_PATTERN} (lowercase alphanumerics + dashes, 1-63 chars, no leading dash)`,
    );
  }
}

function assertVisibility(visibility: string): asserts visibility is KbVisibility {
  if (!VALID_VISIBILITY.has(visibility as KbVisibility)) {
    throw new Error(
      `Invalid visibility "${visibility}"; must be one of: ${[...VALID_VISIBILITY].join(', ')}`,
    );
  }
}

function rowToKb(row: KbRow): Kb {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    owner: row.owner,
    visibility: row.visibility as KbVisibility,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToKbDoc(row: KbDocRow, currentVersion: number | null): KbDoc {
  return {
    id: row.id,
    kbId: row.kb_id,
    slug: row.slug,
    title: row.title,
    currentVersionId: row.current_version_id,
    currentVersion,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToKbDocVersion(row: KbDocVersionRow): KbDocVersion {
  return {
    id: row.id,
    docId: row.doc_id,
    version: row.version,
    bodyMd: row.body_md,
    authoredBy: row.authored_by,
    authoredAt: row.authored_at,
    commitMessage: row.commit_message,
  };
}

export { rowToKb, rowToKbDoc, rowToKbDocVersion };

// ─── KB CRUD ───────────────────────────────────────────────────────────────

export interface CreateKbInput {
  slug: string;
  title: string;
  description?: string;
  owner: string;
  visibility?: KbVisibility;
}

export function createKb(adapter: WorkspaceAdapter, input: CreateKbInput): Kb {
  const slug = input.slug?.trim();
  const title = input.title?.trim();
  const owner = input.owner?.trim();
  if (!slug) throw new Error('createKb: slug is required');
  assertSlug(slug, 'KB');
  if (!title) throw new Error('createKb: title is required');
  if (!owner) throw new Error('createKb: owner is required');
  const visibility = input.visibility ?? 'workspace';
  assertVisibility(visibility);

  // Pre-flight uniqueness check for a friendlier error than SQLITE_CONSTRAINT.
  if (adapter.getKbBySlug(slug)) {
    throw new Error(`createKb: a KB with slug "${slug}" already exists`);
  }

  const row = adapter.createKb({
    slug,
    title,
    description: input.description ?? null,
    owner,
    visibility,
  });
  return rowToKb(row);
}

export function listKbs(
  adapter: WorkspaceAdapter,
  options: { visibility?: KbVisibility | KbVisibility[]; owner?: string; limit?: number; offset?: number } = {},
): Kb[] {
  if (options.visibility !== undefined) {
    const list = Array.isArray(options.visibility) ? options.visibility : [options.visibility];
    for (const v of list) assertVisibility(v);
  }
  const rows = adapter.listKbs({
    ...(options.visibility !== undefined ? { visibility: options.visibility } : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
  });
  return rows.map(rowToKb);
}

export function getKb(adapter: WorkspaceAdapter, id: string): Kb | undefined {
  const row = adapter.getKb(id);
  return row ? rowToKb(row) : undefined;
}

export function getKbBySlug(adapter: WorkspaceAdapter, slug: string): Kb | undefined {
  const row = adapter.getKbBySlug(slug);
  return row ? rowToKb(row) : undefined;
}

export interface UpdateKbInput {
  title?: string;
  description?: string | null;
  visibility?: KbVisibility;
}

export function updateKb(
  adapter: WorkspaceAdapter,
  id: string,
  patch: UpdateKbInput,
): Kb | undefined {
  if (patch.title !== undefined && !patch.title.trim()) {
    throw new Error('updateKb: title cannot be empty');
  }
  if (patch.visibility !== undefined) assertVisibility(patch.visibility);

  const row = adapter.updateKb(id, {
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
  });
  return row ? rowToKb(row) : undefined;
}

export function deleteKb(adapter: WorkspaceAdapter, id: string): boolean {
  return adapter.deleteKb(id);
}

// ─── KB Document CRUD ───────────────────────────────────────────────────────

export interface CreateKbDocInput {
  slug: string;
  title: string;
  bodyMd: string;
  authoredBy: string;
  commitMessage?: string;
}

function loadDocWithBody(adapter: WorkspaceAdapter, docRow: KbDocRow): KbDocWithBody {
  const version = docRow.current_version_id
    ? adapter.getKbDocVersionById(docRow.current_version_id)
    : undefined;
  return {
    ...rowToKbDoc(docRow, version ? version.version : null),
    body: version ? rowToKbDocVersion(version) : null,
  };
}

export function createKbDoc(
  adapter: WorkspaceAdapter,
  kbId: string,
  input: CreateKbDocInput,
): KbDocWithBody {
  const kb = adapter.getKb(kbId);
  if (!kb) throw new Error(`createKbDoc: KB "${kbId}" not found`);

  const slug = input.slug?.trim();
  const title = input.title?.trim();
  const author = input.authoredBy?.trim();
  if (!slug) throw new Error('createKbDoc: slug is required');
  assertSlug(slug, 'doc');
  if (!title) throw new Error('createKbDoc: title is required');
  if (!author) throw new Error('createKbDoc: authoredBy is required');
  if (typeof input.bodyMd !== 'string' || input.bodyMd.length === 0) {
    throw new Error('createKbDoc: bodyMd is required');
  }

  if (adapter.getKbDocBySlug(kbId, slug)) {
    throw new Error(`createKbDoc: doc with slug "${slug}" already exists in KB "${kbId}"`);
  }

  const { doc, version } = adapter.createKbDoc({
    kbId,
    slug,
    title,
    bodyMd: input.bodyMd,
    authoredBy: author,
    commitMessage: input.commitMessage ?? null,
  });
  return {
    ...rowToKbDoc(doc, version.version),
    body: rowToKbDocVersion(version),
  };
}

export function listKbDocs(adapter: WorkspaceAdapter, kbId: string): KbDoc[] {
  return adapter.listKbDocs(kbId).map((row) => {
    const version = row.current_version_id
      ? adapter.getKbDocVersionById(row.current_version_id)
      : undefined;
    return rowToKbDoc(row, version ? version.version : null);
  });
}

export function getKbDoc(
  adapter: WorkspaceAdapter,
  kbId: string,
  slug: string,
): KbDocWithBody | undefined {
  const docRow = adapter.getKbDocBySlug(kbId, slug);
  if (!docRow) return undefined;
  return loadDocWithBody(adapter, docRow);
}

export interface UpdateKbDocInput {
  bodyMd: string;
  authoredBy: string;
  commitMessage?: string;
  title?: string;
}

/**
 * Append a new version. Never overwrites; bumps `current_version_id`.
 */
export function updateKbDoc(
  adapter: WorkspaceAdapter,
  kbId: string,
  slug: string,
  input: UpdateKbDocInput,
): KbDocWithBody | undefined {
  const author = input.authoredBy?.trim();
  if (!author) throw new Error('updateKbDoc: authoredBy is required');
  if (typeof input.bodyMd !== 'string' || input.bodyMd.length === 0) {
    throw new Error('updateKbDoc: bodyMd is required');
  }
  if (input.title !== undefined && !input.title.trim()) {
    throw new Error('updateKbDoc: title cannot be empty');
  }

  const existing = adapter.getKbDocBySlug(kbId, slug);
  if (!existing) return undefined;

  const result = adapter.appendKbDocVersion({
    docId: existing.id,
    bodyMd: input.bodyMd,
    authoredBy: author,
    commitMessage: input.commitMessage ?? null,
    ...(input.title !== undefined ? { title: input.title.trim() } : {}),
  });
  if (!result) return undefined;
  return {
    ...rowToKbDoc(result.doc, result.version.version),
    body: rowToKbDocVersion(result.version),
  };
}

export function getKbDocVersionHistory(
  adapter: WorkspaceAdapter,
  docId: string,
): KbDocVersion[] {
  return adapter.listKbDocVersions(docId).map(rowToKbDocVersion);
}

export function getKbDocAtVersion(
  adapter: WorkspaceAdapter,
  docId: string,
  version: number,
): KbDocVersion | undefined {
  const row = adapter.getKbDocVersion(docId, version);
  return row ? rowToKbDocVersion(row) : undefined;
}
