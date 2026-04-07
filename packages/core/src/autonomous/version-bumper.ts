// packages/core/src/autonomous/version-bumper.ts

export type VersionBumpTier = 'major' | 'minor' | 'patch';

const MAJOR_TAGS = new Set(['breaking', 'architecture', 'platform', 'major-ui', 'rewrite']);
const MINOR_TAGS = new Set(['feature', 'capability', 'enhancement', 'new']);
const PATCH_TAGS = new Set(['fix', 'bug', 'security', 'patch', 'chore', 'docs', 'refactor']);

/**
 * Bump a semver version based on sprint item tags.
 * Rules:
 *   - breaking/architecture/platform/major-ui/rewrite → major (6.4.0 → 7.0.0)
 *   - feature/capability/enhancement/new → minor (6.4.0 → 6.5.0)
 *   - fix/bug/security/patch/chore/docs/refactor → patch (6.4.0 → 6.4.1)
 *   - none → minor (autonomous default)
 *   - explicit override → always wins
 */
export function bumpVersion(
  current: string,
  itemTags: string[],
  override?: VersionBumpTier,
): string {
  const { major, minor, patch } = parseSemver(current);
  const tier = override ?? determineTier(itemTags);

  switch (tier) {
    case 'major': return `${major + 1}.0.0`;
    case 'minor': return `${major}.${minor + 1}.0`;
    case 'patch': return `${major}.${minor}.${patch + 1}`;
  }
}

export function determineVersionTier(tags: string[]): VersionBumpTier {
  return determineTier(tags);
}

function determineTier(tags: string[]): VersionBumpTier {
  if (tags.some(t => MAJOR_TAGS.has(t))) return 'major';
  if (tags.some(t => MINOR_TAGS.has(t))) return 'minor';
  if (tags.some(t => PATCH_TAGS.has(t))) return 'patch';
  return 'minor'; // autonomous default
}

function parseSemver(v: string): { major: number; minor: number; patch: number } {
  const cleaned = v.replace(/^v/, '');
  const parts = cleaned.split('.').map(Number);

  if (parts.some(isNaN)) {
    throw new Error(`Invalid semver: ${v}`);
  }

  while (parts.length < 3) parts.push(0);

  return {
    major: parts[0]!,
    minor: parts[1]!,
    patch: parts[2]!,
  };
}
