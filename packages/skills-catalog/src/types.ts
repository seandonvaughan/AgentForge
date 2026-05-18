import { z } from 'zod';

/**
 * Zod schema for skill frontmatter (YAML header in each .md skill file).
 */
export const SkillFrontmatterSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  version: z.string().min(1),
  upstream: z.string().optional(),
  upstream_ref: z.string().optional(),
  tags: z.array(z.string()),
  applies_to: z.array(z.string()),
  mandatory_for: z.array(z.string()).optional(),
  max_tokens: z.number().int().positive(),
  requires_tools: z.array(z.string()).optional(),
  applies_to_tasks: z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * A fully loaded skill: frontmatter + the markdown body text.
 */
export interface Skill {
  frontmatter: SkillFrontmatter;
  /** Raw markdown body (everything after the YAML front-matter block). */
  body: string;
  /** Absolute path to the source .md file. */
  filePath: string;
}
