/**
 * Server-side load for /agents/[id].
 *
 * Reads .agentforge/agents/<id>.yaml directly so the detail page renders
 * with full agent data on first load — no dependency on the external backend.
 *
 * Uses a built-in minimal YAML parser instead of js-yaml to avoid adding a
 * dependency that isn't available in this package's node_modules.
 */
import type { PageServerLoad, PageServerLoadEvent } from './$types';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { error } from '@sveltejs/kit';

/** Walk up from CWD until we find a directory that contains .agentforge/agents/. */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, '.agentforge', 'agents'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

interface ParsedAgent {
  strings: Record<string, string>;
  arrays: Record<string, string[]>;
  sections: Record<string, { strings: Record<string, string>; arrays: Record<string, string[]> }>;
}

/**
 * Minimal YAML parser for agent definition files.
 *
 * Handles the patterns that appear in .agentforge/agents/*.yaml:
 *   - Top-level scalar:  key: value
 *   - Quoted scalar:     key: "value" or key: 'value'
 *   - Block scalars:     key: >   or   key: |   (followed by indented lines)
 *   - Inline arrays:     key: [item1, item2, item3]
 *   - One-level nesting: sectionKey:\n  subKey: value
 *
 * This is intentionally narrow — it only covers the patterns present in
 * agent YAML files and avoids a js-yaml dependency in the dashboard package.
 */
function parseAgentYaml(content: string): ParsedAgent {
  const result: ParsedAgent = { strings: {}, arrays: {}, sections: {} };
  const lines = content.split('\n');
  let i = 0;
  let section: string | null = null;

  /** Parse an inline YAML array string "[a, b, c]" into string[]. */
  function parseInlineArray(raw: string): string[] {
    const inner = raw.replace(/^\[|\]$/g, '').trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }

  while (i < lines.length) {
    const line = lines[i];

    // Detect a top-level key (no leading whitespace)
    const topMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (topMatch) {
      const key = topMatch[1];
      const rest = topMatch[2].trim();

      if (rest === '') {
        // Possibly a section header — peek at next line for indentation
        const nextLine = lines[i + 1] ?? '';
        if (/^[ \t]/.test(nextLine)) {
          section = key;
          result.sections[key] = { strings: {}, arrays: {} };
          i++;
          continue;
        }
        // Empty value with no indented children
        section = null;
        i++;
        continue;
      }

      // Entering a new top-level key exits any active section
      section = null;

      if (rest === '>' || rest === '|') {
        // Block scalar
        const scalar = rest;
        const parts: string[] = [];
        i++;
        while (i < lines.length && /^[ \t]/.test(lines[i])) {
          parts.push(lines[i].trim());
          i++;
        }
        result.strings[key] = scalar === '>' ? parts.join(' ') : parts.join('\n');
        continue;
      }

      if (rest.startsWith('[')) {
        result.arrays[key] = parseInlineArray(rest);
        i++;
        continue;
      }

      // Plain or quoted scalar
      result.strings[key] = rest.replace(/^["']|["']$/g, '');
      i++;
      continue;
    }

    // Detect an indented key under the current section
    const indentMatch = line.match(/^[ \t]+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)/);
    if (indentMatch && section && result.sections[section]) {
      const subKey = indentMatch[1];
      const subRest = indentMatch[2].trim();
      if (subRest.startsWith('[')) {
        result.sections[section].arrays[subKey] = parseInlineArray(subRest);
      } else if (subRest !== '') {
        result.sections[section].strings[subKey] = subRest.replace(/^["']|["']$/g, '');
      }
      i++;
      continue;
    }

    // Blank line or comment — preserve section context
    i++;
  }

  return result;
}

export interface AgentDetail {
  agentId: string;
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  description: string | null;
  role: string | null;
  systemPrompt: string | null;
  skills: string[];
  version: string | null;
  seniority: string | null;
  layer: string | null;
  reportsTo: string | null;
  canDelegateTo: string[];
}

export const load: PageServerLoad = ({ params }: PageServerLoadEvent) => {
  const { id } = params;
  const root = findProjectRoot();
  const filePath = join(root, '.agentforge', 'agents', `${id}.yaml`);

  if (!existsSync(filePath)) {
    error(404, `Agent "${id}" not found`);
  }

  let parsed: ParsedAgent;
  try {
    parsed = parseAgentYaml(readFileSync(filePath, 'utf-8'));
  } catch {
    error(500, `Failed to parse agent "${id}"`);
  }

  const { strings, arrays, sections } = parsed;
  const collab = sections['collaboration'] ?? { strings: {}, arrays: {} };

  const modelRaw = strings['model'] ?? 'sonnet';
  const model: 'opus' | 'sonnet' | 'haiku' =
    modelRaw === 'opus' || modelRaw === 'haiku' ? modelRaw : 'sonnet';

  const agent: AgentDetail = {
    agentId: id,
    name: strings['name'] ?? id,
    model,
    description: strings['description']?.trim() ?? null,
    role: strings['role'] ?? null,
    systemPrompt: strings['system_prompt'] ?? null,
    skills: arrays['skills'] ?? [],
    version: strings['version'] ?? null,
    seniority: strings['seniority'] ?? null,
    layer: strings['layer'] ?? null,
    reportsTo: collab.strings['reports_to'] ?? null,
    canDelegateTo: collab.arrays['can_delegate_to'] ?? [],
  };

  return { agent };
};
