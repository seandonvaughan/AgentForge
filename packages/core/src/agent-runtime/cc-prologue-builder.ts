/**
 * CC Prologue Builder — T3.3 (Memory Loading Parity)
 *
 * When an agent is invoked via Claude Code's native `Agent` tool, it receives
 * a static `.claude/agents/<id>.md` file as its system prompt (emitted by
 * Workstream U at forge time). That file cannot be updated on every cycle, so
 * fresh memory context would go stale between forges.
 *
 * Strategy B (per the T3.3 spec): instead of re-emitting the static file, the
 * outer CC session prepends a "prologue" to the agent's task at invocation
 * time. The prologue carries:
 *
 *   1. A "Fresh context (this cycle)" block — the same memory snippet that
 *      `injectFreshContext` would append to a system prompt in the CLI path.
 *   2. A "Pending DMs" block — undelivered direct messages (when `adapter` is
 *      provided), mirroring the comms layer behaviour in `inject-agent-dms.ts`.
 *   3. The original user task, under a "# Your task" heading.
 *
 * The prologue is capped at `MAX_PROLOGUE_CHARS` (~16 000 chars ≈ 4 000
 * tokens). When memory entries would push past the cap they are truncated
 * most-recent-first — the most recent entries survive; older ones are dropped.
 *
 * Call `prepareCcAgentTask()` for the full `{prologue, fullTask}` shape that
 * the `invoke.md` command uses.
 */

import { join } from 'node:path';
import type { WorkspaceAdapter } from '@agentforge/db';
import { buildFreshContextBlock, type FreshContextOptions } from './fresh-context.js';
import { buildAgentDmsBlock, type InjectAgentDmsOptions } from '../comms/inject-agent-dms.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on the prologue length in characters.  ~4 000 tokens assuming 4
 * chars/token on average — keeps the CC context budget predictable.
 */
export const MAX_PROLOGUE_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CcAgentPrologueOptions {
  /** Override memory loading options forwarded to `buildFreshContextBlock`. */
  freshContextOptions?: FreshContextOptions;
  /** Override DM-injection options forwarded to `buildAgentDmsBlock`. */
  dmOptions?: InjectAgentDmsOptions;
  /**
   * When true (default), mark injected DMs as delivered so they are not
   * re-injected on the next invocation. Pass false for preview/dry-run paths.
   */
  markDmsDelivered?: boolean;
  /**
   * Character cap for the entire prologue block (excluding the task body).
   * Defaults to `MAX_PROLOGUE_CHARS`.
   */
  maxPrologueChars?: number;
}

export interface CcAgentTaskResult {
  /** The prologue block alone (without the task). Empty string if no context. */
  prologue: string;
  /** The complete string to pass as `prompt` to the CC Agent tool. */
  fullTask: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Trim the memory block so the overall prologue stays within `charBudget`.
 * Strategy: keep the header lines; then append bullets one-by-one from the
 * top (most-recent-first as ranked by `buildFreshContextBlock`) until adding
 * the next bullet would breach the budget.  A truncation notice is appended
 * when bullets had to be dropped.
 */
function truncateMemoryBlock(block: string, charBudget: number): string {
  if (block.length <= charBudget) return block;

  const lines = block.split('\n');
  // Lines 0-3 are the header (heading + two description lines + blank line).
  // Line 4+ are the bullet items.
  const HEADER_LINE_COUNT = 4;
  const headerLines = lines.slice(0, HEADER_LINE_COUNT);
  const bulletLines = lines.slice(HEADER_LINE_COUNT);

  const headerText = headerLines.join('\n') + '\n';
  const truncationNotice = '- _(older entries omitted to stay within token budget)_';

  // Budget remaining for bullets + truncation notice.
  const bulletBudget = charBudget - headerText.length - truncationNotice.length - 2; // 2 = two \n
  const kept: string[] = [];
  let used = 0;
  for (const line of bulletLines) {
    if (!line.trim()) continue;
    if (used + line.length + 1 > bulletBudget) break;
    kept.push(line);
    used += line.length + 1;
  }

  if (kept.length === bulletLines.filter((l) => l.trim()).length) return block;

  return headerText + kept.join('\n') + '\n' + truncationNotice;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the fresh-context + DM prologue for a CC-invoked agent.
 *
 * Returns a markdown string ready to be prepended to the agent's task before
 * passing it to CC's `Agent` tool. Returns an empty string when neither
 * memory nor DMs are available — callers should handle that gracefully.
 *
 * @param opts.agentId      - Agent identifier (matches YAML filename).
 * @param opts.projectRoot  - Workspace root containing `.agentforge/`.
 * @param opts.adapter      - Optional workspace adapter; enables DM injection.
 */
export async function buildCcAgentPrologue(opts: {
  agentId: string;
  projectRoot: string;
  adapter?: WorkspaceAdapter;
  options?: CcAgentPrologueOptions;
}): Promise<string> {
  const { agentId, projectRoot, adapter } = opts;
  const prologueOptions = opts.options ?? {};
  const charCap = prologueOptions.maxPrologueChars ?? MAX_PROLOGUE_CHARS;

  const agentforgeDir = join(projectRoot, '.agentforge');

  // 1. Memory block — always attempted; returns '' when empty/stale.
  const rawMemoryBlock = buildFreshContextBlock(
    agentId,
    agentforgeDir,
    prologueOptions.freshContextOptions ?? {},
  );

  // 2. DM block — only when adapter is provided.
  let dmBlock = '';
  if (adapter) {
    const { block, messages } = buildAgentDmsBlock(
      adapter,
      agentId,
      prologueOptions.dmOptions ?? {},
    );
    dmBlock = block;
    // Mark delivered unless caller explicitly opts out.
    if (block && prologueOptions.markDmsDelivered !== false) {
      adapter.markDirectMessagesDelivered(messages.map((m) => m.id));
    }
  }

  if (!rawMemoryBlock && !dmBlock) return '';

  // 3. Apply token budget.  DMs are always kept intact (they're ephemeral and
  //    small); the memory block absorbs any over-budget truncation.
  const dmSection = dmBlock ? `\n# Pending DMs\n\n${dmBlock}\n` : '';
  const dmSectionLen = dmSection.length;
  const memBudget = Math.max(0, charCap - dmSectionLen - 10); // 10 = separator

  const memorySection = rawMemoryBlock
    ? `# Fresh context (this cycle)\n\n${truncateMemoryBlock(rawMemoryBlock, memBudget)}\n`
    : '';

  return (memorySection + dmSection).trim();
}

/**
 * Compose the full task string for the CC `Agent` tool, prepending the
 * prologue when one exists.
 *
 * Returns both pieces so the caller can reference them independently (e.g.
 * to log the prologue length or skip it in dry-run mode).
 *
 * @param agentId     - Agent identifier.
 * @param projectRoot - Workspace root.
 * @param userTask    - The original task the user wants the agent to perform.
 * @param adapter     - Optional workspace adapter for DM injection.
 * @param options     - Prologue construction options.
 */
export async function prepareCcAgentTask(
  agentId: string,
  projectRoot: string,
  userTask: string,
  adapter?: WorkspaceAdapter,
  options?: CcAgentPrologueOptions,
): Promise<CcAgentTaskResult> {
  const prologue = await buildCcAgentPrologue({
    agentId,
    projectRoot,
    ...(adapter !== undefined ? { adapter } : {}),
    ...(options !== undefined ? { options } : {}),
  });

  if (!prologue) {
    return { prologue: '', fullTask: userTask };
  }

  const fullTask = `${prologue}\n\n---\n\n# Your task\n\n${userTask}`;
  return { prologue, fullTask };
}
