# External Project Troubleshooting

Companion to [quickstart-external-project.md](quickstart-external-project.md). Covers scenarios that come up specifically when running AgentForge against a project it hasn't seen before.

---

## "My forge produced generic agents"

**Symptom:** After `agentforge team forge`, the team contains agents named `coder`, `frontend-dev`, `backend-dev`, `dba`, `test-runner` with vague system prompts that mention frameworks not present in your project.

**Root cause:** The agent-driven forge (introduced in v18.0.0) uses `.agentforge/memory/` to specialize agents. On a brand-new project there is no cycle history — the recon agents have nothing to summarize beyond the static file scan, so the synthesis falls back to conservative generic templates.

**What to do:**

1. Run 2-3 full cycles. The `learning-curator` (introduced in v19.0.0) writes per-cycle outcomes to `.agentforge/memory/cycle-outcome.jsonl` and `gate-verdict.jsonl`.
2. After the third cycle, re-run forge:
   ```bash
   agentforge team forge --project-root /path/to/your-project --verbose
   ```
3. The synthesis phase now has real history and will emit roles like `react-component-engineer` or `vitest-regression-author` with project-specific system prompts.

**Expectation:** Generic agents improve automatically. No manual intervention needed beyond running cycles.

---

## "Auto-reforge created bad learnings"

**Symptom:** After `agentforge cycle run --auto-reforge`, an agent's system prompt changed and the next cycle behaved incorrectly. The agent is now less effective than before.

**Root cause:** The `learning-curator` proposed a learning that introduced a contradiction or a misleading assumption. The mutator gate checks for duplicates and semantic hash conflicts, but it can still accept a plausible-looking but wrong lesson.

**How to revert a single agent:**

```bash
# List pending proposals and active overrides
agentforge team reforge list --project-root /path/to/your-project

# Roll back the problematic agent override
agentforge team reforge rollback <agent-id> --project-root /path/to/your-project
```

Example:

```bash
agentforge team reforge rollback react-component-engineer --project-root ~/Projects/my-app
```

This restores the agent's previous YAML from git history. The override is marked as rolled back and excluded from future auto-reforge runs until you explicitly re-enable it.

**Check the current override status:**

```bash
agentforge team reforge status --project-root /path/to/your-project
```

**Prevent bad learnings in the future:**

Set a stricter semantic deduplication threshold in `.agentforge/autonomous.yaml`:

```yaml
scoring:
  agentId: backlog-scorer
  fallbackToStatic: true
```

If you observe consistent over-fitting, open the relevant `gate-verdict.jsonl` entry and add a `// TODO(autonomous): do not propagate — this learning was context-specific` marker near the finding that produced it. The `learning-curator` skips entries with that annotation.

---

## "Worktrees fill my disk"

**Symptom:** After running several cycles with parallel agents, `.agentforge/worktrees/` has grown to many gigabytes. Disk usage alerts fire or `agentforge cycle run` fails with a disk-full error.

**Root cause:** Each parallel agent runs in its own `git worktree` under `.agentforge/worktrees/agent-<id>-<sessionId>/`. These are cleaned up after each cycle, but the GC runs on a best-effort basis and can accumulate if cycles are interrupted mid-run.

**Immediate cleanup:**

```bash
# List all worktrees
git worktree list

# Prune stale worktrees (safe — only removes worktrees whose branches no longer exist)
git worktree prune
```

**Tune the parallelism cap** to reduce peak worktree count:

```bash
export MAX_PARALLEL_AGENTS=4   # default 8; lower this to reduce concurrent worktrees
agentforge cycle run --project-root /path/to/your-project
```

**Tune the disk GC limit** so the GC is more aggressive. The `maxDiskMb` option (default 5000 MB = 5 GB) controls how much worktree disk the GC allows before it starts pruning the oldest worktrees:

```yaml
# .agentforge/autonomous.yaml
# Note: maxDiskMb is a runtime option passed to WorktreeGC — set it via env for now.
# Full YAML key is planned for v22+.
```

```bash
export WORKTREE_MAX_DISK_MB=2000   # prune aggressively at 2 GB
```

**Keep forensic worktrees shorter:** The GC retains the last N worktrees for post-cycle inspection. If you don't need them:

```bash
# Manually remove completed cycle worktrees
rm -rf .agentforge/worktrees/agent-*-completed-*
git worktree prune
```

---

## "PR queue stuck on conflicts"

**Symptom:** The `pr-merge-manager` has opened several draft PRs but they are marked as conflicting with each other. The queue is not progressing. The PR body contains a comment like:

```
⚠️ Non-trivial conflict detected in <file>. Manual resolution required.
The pr-merge-manager cannot auto-resolve changes to shared logic in this file.
Resolution steps: ...
```

**Root cause:** Multiple parallel agents edited the same file in ways the merge manager cannot auto-resolve. The `pr-merge-manager` auto-resolves only three conflict types: `.jsonl` append-only files, `audit.db` WAL files, and lock files (`pnpm-lock.yaml`, `package-lock.json`). Any other conflict is flagged as non-trivial and requires human resolution.

**Resolution steps:**

1. Open the conflicting PR on GitHub.
2. Read the structured comment left by `pr-merge-manager` — it lists the exact conflicting sections.
3. Check out the branch locally:
   ```bash
   git fetch origin
   git checkout autonomous/<branch-name>
   git rebase origin/main
   # resolve conflicts in your editor
   git add .
   git rebase --continue
   git push --force-with-lease origin autonomous/<branch-name>
   ```
4. The `pr-merge-manager` will re-evaluate the PR after the force-push and attempt to re-sequence it into the merge queue.

**Prevent frequent conflicts:**

- Add clear `owns_subsystems` tags to your agents in their YAML files. The assign-phase router avoids dispatching two agents to the same subsystem in the same cycle.
- Reduce `maxItemsPerSprint` temporarily while you establish subsystem ownership:
  ```yaml
  limits:
    maxItemsPerSprint: 3
  ```

---

## Related docs

- [Quickstart](quickstart-external-project.md) — Installation and first cycle
- [Autonomous Loop Guide](guides/autonomous-loop.md) — How the 9-phase cycle works
- [Configuration Reference](guides/autonomous-config-reference.md) — All `autonomous.yaml` options
- [Plugin Manifest Audit](plugin-manifest-audit-2026-05-17.md) — Cross-project portability audit
