# Autonomous Loop Troubleshooting

Common issues and solutions for autonomous cycles.

---

## Cycle Won't Start

### Error: "No team manifest found"

**Cause:** `.agentforge/team.yaml` doesn't exist or is unreadable

**Solution:**
```bash
npm run forge  # Generate team from codebase
# or
npm run genesis  # Interactive team building
```

Verify the file exists:
```bash
cat .agentforge/team.yaml | head -20
```

---

### Error: "Authentication required" or "Not logged in"

**Cause:** Claude Code OAuth session is not active

**Solution:**

Option 1: Verify Claude Code login
```bash
claude auth status
# Should show: Authenticated: yes, Plan: Max
```

Option 2: Log in to Claude Code
```bash
claude auth login
# Opens browser to authenticate with your Claude account
```

Option 3: For CI/CD, set session token
```bash
export CLAUDE_SESSION_TOKEN="your_token_here"
npm run autonomous:cycle
```

See **[API Reference § 1 — Authentication](../api-reference.md#-1--authentication)** for complete setup instructions.

---

### Error: "gh: not found" or "gh: not authenticated"

**Cause:** GitHub CLI is not installed or not authenticated

**Solution:**

Install GitHub CLI:
```bash
brew install gh  # macOS
# or download from https://cli.github.com
```

Authenticate:
```bash
gh auth login
# Follow prompts to authenticate with GitHub
```

Verify:
```bash
gh auth status
```

---

### Error: "Working tree is dirty"

**Cause:** Uncommitted changes prevent cycle start

**Solution:**

Commit or stash changes:
```bash
git add .
git commit -m "WIP: pending changes"
# or
git stash  # Save changes temporarily
```

---

## Cycle Stops Early

### Killed at PLAN Stage: "Budget exceeded before any work selected"

**Cause:** Scoring overhead is too high, or backlog is too large

**Symptoms:**
- Cycle spends $20+ just ranking proposals
- No work items selected

**Solutions:**

1. **Reduce proposal scope:**
   ```yaml
   sourcing:
     lookbackDays: 3      # Scan fewer logs
     minProposalConfidence: 0.7  # Filter weak candidates
   ```

2. **Reduce backlog size:**
   - Delete vague `TODO(autonomous)` markers
   - Archive old test failures
   - Set `includeTodoMarkers: false` temporarily

3. **Use faster scoring:**
   - Set `quality.testPassRateFloor: 0.9` (relaxed)
   - Reduce `limits.maxItemsPerSprint: 3` (smaller sprints)

---

### Killed at EXECUTE Stage: "Agent call failed"

**Cause:** Agent encountered an error or timed out

**Symptoms:**
- Error message in `.agentforge/cycles/{id}/exec.log`
- `maxConsecutiveFailures` threshold exceeded

**Examples:**

**"Context window exceeded"**
- Agent tried to read too much code at once
- Solution: Simplify the task, break into smaller pieces

**"Rate limit exceeded"**
- Too many API calls in short time
- Solution: Increase `maxDurationMinutes` to slow down, or split into multiple cycles

**"Model returned invalid JSON"**
- Agent output couldn't be parsed
- Solution: Check agent's system prompt for malformed JSON requirements

**Debug steps:**

1. Check the full error:
   ```bash
   cat .agentforge/cycles/{cycleId}/exec.log | grep -A 5 "ERROR"
   ```

2. Check which agent failed:
   ```bash
   cat .agentforge/cycles/{cycleId}/exec.log | grep "agent:"
   ```

3. Try running that agent manually:
   ```bash
   npm run invoke --agent "{agentName}" --task "{taskDescription}"
   ```

---

### Killed at VERIFY Stage: "Test floor breached"

**Cause:** Tests failed after execution

**Symptoms:**
- Test pass rate < `quality.testPassRateFloor`
- Diagnostic branch created: `autonomous/vX.Y.Z-failed`
- Working tree rolled back

**Solutions:**

1. **Inspect the failure:**
   ```bash
   git checkout autonomous/vX.Y.Z-failed
   npm test  # Run tests locally
   ```

2. **Identify the breaking change:**
   ```bash
   git diff autonomous/vX.Y.Z-failed..main -- src/
   # Shows what changed
   ```

3. **Fix the issue:**
   - File a bug report if this is agent code
   - Fix manually if it's a simple error
   - Mark as `TODO(strategic)` if it needs human review

4. **Clean up:**
   ```bash
   git checkout main
   git branch -D autonomous/vX.Y.Z-failed
   ```

5. **Adjust configuration:**
   ```yaml
   quality:
     testPassRateFloor: 0.93  # Slightly relaxed
     allowRegression: false   # Still prevent new failures
   ```

---

### Killed at COMMIT Stage: "Branch already exists"

**Cause:** A branch with this version already exists

**Symptoms:**
- Error message: `fatal: a branch named 'autonomous/v6.4.2' already exists`
- Cycle stops before creating PR

**Solutions:**

1. **Delete the old branch:**
   ```bash
   git branch -D autonomous/v6.4.2  # Local
   git push -d origin autonomous/v6.4.2  # Remote
   ```

2. **Or wait for version bump:** Next cycle will use v6.4.3

3. **Or use a different branch prefix:**
   ```yaml
   git:
     branchPrefix: 'auto-bot'  # Will create auto-bot/v6.4.2
   ```

---

### Killed at REVIEW Stage: "PR creation failed"

**Cause:** GitHub API error or permission issue

**Symptoms:**
- Error message from `gh pr create`
- Working tree has commits, but PR doesn't exist

**Solutions:**

1. **Check GitHub permissions:**
   ```bash
   gh repo view  # Verify you can access the repo
   gh auth status  # Verify you're authenticated
   ```

2. **Create PR manually:**
   ```bash
   # Get branch name from cycle log
   git push -u origin autonomous/v6.4.2
   gh pr create --title "v6.4.2: Sprint" \
     --body "$(cat .agentforge/cycles/{cycleId}/cycle.log)"
   ```

3. **Check rate limits:**
   ```bash
   gh api rate-limit  # Show API usage
   ```

4. **Verify base branch:**
   ```bash
   git ls-remote origin main  # Ensure main exists
   ```

---

## High Costs

### Cycle costs $40+ for small changes

**Cause:** Multiple factors can increase costs:
- Large files being read repeatedly
- Many retries on failures
- Expensive agents assigned to simple tasks
- Streaming overhead

**Solutions:**

1. **Check which phase is expensive:**
   ```bash
   cat .agentforge/cycles/{cycleId}/cost-report.json | jq '.byPhase'
   ```

2. **If PLAN is expensive:**
   ```yaml
   sourcing:
     lookbackDays: 1      # Scan less history
     minProposalConfidence: 0.8  # Skip low-confidence items
   ```

3. **If EXECUTE is expensive:**
   - Use smaller work items (split large TODOs)
   - Assign Sonnet instead of Opus to implementation tasks
   - Reduce item complexity

4. **If VERIFY is expensive:**
   - Cache test results if possible
   - Consider skipping type check: `typeCheck: ''`
   - Run tests in parallel

5. **Monitor per-item costs:**
   ```bash
   cat .agentforge/cycles/{cycleId}/cost-report.json | jq '.byItem'
   ```

---

## Unexpected Behavior

### Cycle selects wrong work items

**Cause:** Scorer prioritized differently than expected

**Symptoms:**
- High-priority items deferred
- Vague items selected
- Items that seem wrong are included

**Solutions:**

1. **Make TODOs more specific:**
   ```typescript
   // Before: vague
   // TODO(autonomous): improve performance

   // After: specific
   // TODO(autonomous): cache database queries to reduce latency from 500ms to <100ms
   ```

2. **Add context comments:**
   ```typescript
   // TODO(autonomous): migrate workspace-adapter to postgres
   // Estimate: 2 days
   // Blocks: multi-tenant feature (critical path)
   // Related: issue #1234
   ```

3. **Adjust confidence threshold:**
   ```yaml
   sourcing:
     minProposalConfidence: 0.7  # Only high-confidence items
   ```

4. **Review scorer's assessment:**
   ```bash
   cat .agentforge/cycles/{cycleId}/plan.json | jq '.ranking'
   # Shows how each item was scored
   ```

---

### Tests pass locally but fail in cycle

**Cause:** Different environment or test isolation issues

**Symptoms:**
- `npm test` works fine at terminal
- Same command fails in cycle
- Error doesn't reproduce locally

**Solutions:**

1. **Check test isolation:**
   ```bash
   # Run tests multiple times
   npm test && npm test && npm test
   ```

2. **Check for global state:**
   - Look for tests that depend on execution order
   - Check for file system mutations
   - Look for cached state

3. **Run with exact cycle command:**
   ```bash
   # Match the cycle's environment
   npm test -- --reporter json > results.json
   ```

4. **Check for timing issues:**
   ```bash
   # Run with timeout disabled
   npm test -- --testTimeout=10000
   ```

---

### PR opens but shows wrong changes

**Cause:** Working tree had uncommitted changes

**Symptoms:**
- PR includes files you didn't intend
- Cycle's commit mixes with previous work

**Solution:**

Start with clean working tree:
```bash
git status  # Must be clean
git stash  # Temporarily save any changes
npm run autonomous:cycle
git stash pop  # Restore your changes after
```

---

### Agent keeps retrying same task

**Cause:** Task is ambiguous or dependencies are missing

**Symptoms:**
- Agent fails 3x on same work item
- Same error repeated in logs
- Cycle reaches `maxConsecutiveFailures`

**Solutions:**

1. **Make task more explicit:**
   ```typescript
   // Before: open-ended
   // TODO(autonomous): refactor auth module

   // After: specific
   // TODO(autonomous): refactor auth module to support OAuth2
   // Replace existing JWT logic with OAuth flows in src/auth/
   // Tests: src/tests/auth/ must pass
   // Success: new integration test passes for Google OAuth
   ```

2. **Add example code:**
   ```typescript
   // TODO(autonomous): migrate to new API
   // Example endpoint: https://docs.example.com/oauth
   // Migration guide: see #1234
   ```

3. **Reduce scope:**
   - Split into smaller TODO items
   - Mark as `TODO(strategy)` if it's too big
   - Get human input first

---

## Performance Issues

### Cycle takes >120 minutes

**Cause:** One phase is slow

**Solutions:**

1. **Identify slow phase:**
   ```bash
   cat .agentforge/cycles/{cycleId}/cycle.log | grep "stage:"
   # Shows duration per stage
   ```

2. **If EXECUTE is slow:**
   - Reduce `maxItemsPerSprint: 3`
   - Simplify work items
   - Check for API rate limits

3. **If VERIFY is slow:**
   - Check test suite size: `npm test -- --listTests | wc -l`
   - Consider splitting: `npm test -- --testPathPattern="unit|integration"`
   - Cache results if possible

4. **Set timeout higher if expected:**
   ```yaml
   limits:
     maxDurationMinutes: 180  # 3 hours for large sprints
   ```

---

## Git Issues

### "fatal: reference not a tree" when committing

**Cause:** Branch or file state is corrupted

**Solution:**
```bash
git status  # Check state
git reset --hard HEAD  # Reset to last commit
# Re-run cycle
```

---

### "merge conflict" when pushing

**Cause:** Base branch changed since cycle started

**Solution:**
```bash
# Delete the failed cycle's branch
git push -d origin autonomous/v6.4.2

# Sync base branch and re-run
git checkout main && git pull
npm run autonomous:cycle
```

---

### "permission denied" when pushing

**Cause:** GitHub token expired or insufficient permissions

**Solution:**
```bash
gh auth logout
gh auth login  # Re-authenticate
npm run autonomous:cycle
```

---

## Silent Failures

### Cycle completed but PR not found

**Cause:** PR was created but URL wasn't captured

**Solution:**
```bash
# Check cycle manifest
cat .agentforge/cycles/{cycleId}/manifest.json | jq '.stages.review'

# Or search manually on GitHub
gh pr list --state all --limit 100 | grep "autonomous/v"
```

---

### Files changed but no commit

**Cause:** Commit failed silently

**Solution:**
```bash
# Check cycle logs
tail -50 .agentforge/cycles/{cycleId}/cycle.log | grep -i "commit\|error"

# Check git state
git status
git log --oneline | head

# Try committing manually
git add .
git commit -m "$(cat .agentforge/cycles/{cycleId}/commit-message.txt)"
git push -u origin autonomous/v6.4.2
```

---

## Getting Help

### Collect diagnostic information

When reporting a bug, gather:

```bash
# Cycle manifest
cat .agentforge/cycles/{cycleId}/manifest.json

# Full cycle log
cat .agentforge/cycles/{cycleId}/cycle.log

# Execution transcript
cat .agentforge/cycles/{cycleId}/exec.log | tail -100

# Cost breakdown
cat .agentforge/cycles/{cycleId}/cost-report.json

# Test results
cat .agentforge/cycles/{cycleId}/test-results.json

# Configuration
cat .agentforge/autonomous.yaml

# Git state
git log --oneline | head -10
git branch | grep autonomous
```

### File a bug report

Include:
1. Cycle ID
2. Configuration (redacted if sensitive)
3. Error message or unexpected behavior
4. Steps to reproduce
5. Diagnostic files from above

---

## See Also

- **[Autonomous Loop Guide](./autonomous-loop.md)** — Full user guide
- **[Configuration Reference](./autonomous-config-reference.md)** — All config options
