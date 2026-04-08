# Autonomous Loop Manual Smoke Test

**Purpose:** Prove the autonomous cycle works end-to-end against the real AgentForge repository before declaring the feature shipped.

**What is the Autonomous Loop:** A self-directed agent pipeline that identifies TODO markers in the codebase, scores them by priority, and autonomously resolves them through a 9-phase execution cycle (audit → score → plan → implement → test → commit → PR) without human intervention.

**Prerequisites:**
- `npm install` complete, `npm run build` passes with 0 errors
- All unit + integration tests green: `cd packages/core && npx vitest run`
- `gh auth status` shows authenticated
- `ANTHROPIC_API_KEY` exported in shell
- Working tree is clean: `git status` shows nothing
- On branch `main` (or a throwaway branch)

**Cost estimate:** ~$5 against real Anthropic API for this smoke test.

## Procedure

1. **Create throwaway branch for the smoke test**
   ```bash
   git checkout -b smoke-test/autonomous-v1
   ```

2. **Override autonomous.yaml for cheap smoke**
   ```bash
   cp .agentforge/autonomous.yaml .agentforge/autonomous.yaml.backup
   cat > .agentforge/autonomous.yaml <<'EOF'
   budget:
     perCycleUsd: 5
     perItemUsd: 2
   limits:
     maxItemsPerSprint: 2
     maxDurationMinutes: 30
   quality:
     testPassRateFloor: 0.95
     allowRegression: false
   git:
     branchPrefix: "smoke-test/autonomous-"
     baseBranch: "smoke-test/autonomous-v1"
     refuseCommitToBaseBranch: true
   pr:
     draft: true
     labels: ["smoke-test"]
   EOF
   ```

3. **Add an obviously-autonomous-friendly TODO marker**

   Pick a README or docs file and append:
   ```
   <!-- TODO(autonomous): add a one-sentence description of the autonomous loop to this file -->
   ```
   Commit this seed change to the smoke-test branch so the cycle has a clear target.

4. **Stage the seed TODO**
   ```bash
   git add <file> .agentforge/autonomous.yaml
   git commit -m "chore: seed smoke test"
   ```

5. **Run the cycle**
   ```bash
   npm run autonomous:cycle
   ```

6. **Observe expected behavior**
   - Scoring agent is invoked (real Anthropic API call)
   - Sprint JSON written to `.agentforge/sprints/vX.Y.Z.json`
   - Phase scheduler advances through 9 phases
   - Real vitest runs and produces JSON output
   - Git branch `smoke-test/autonomous-vX.Y.Z` created
   - Commit created with expected message format
   - PR opened as DRAFT with body containing scoring rationale, test results, cost
   - CLI prints PR URL and exits 0

7. **Verify cycle log directory**
   ```bash
   ls -la .agentforge/cycles/<cycleId>/
   ```

   Expected files:
   - cycle.json
   - scoring.json
   - tests.json
   - git.json
   - pr.json
   - events.jsonl
   - phases/audit.json (and other 8 phases)

8. **Inspect the PR**
   Open the PR URL in the browser. Verify:
   - Title: "autonomous(vX.Y.Z): ..."
   - Body contains: cycle ID, cost summary, test results, scoring rationale, files changed
   - Labels applied: "smoke-test"
   - Reviewer assigned: seandonvaughan
   - Status: DRAFT

9. **Clean up**
   ```bash
   gh pr close <number> --delete-branch
   git checkout main
   git branch -D smoke-test/autonomous-v1
   mv .agentforge/autonomous.yaml.backup .agentforge/autonomous.yaml
   ```

## Acceptance criteria

The smoke test passes if and only if:

- [ ] Cycle completes with exit code 0
- [ ] Real Anthropic API was called at least once (scoring agent)
- [ ] Real vitest ran and produced a JSON report
- [ ] Real git branch and commit were created
- [ ] PR was opened (as draft) with structured body
- [ ] No secrets leaked in the diff (spot-check the committed files)
- [ ] Total cost < $5 (within smoke budget)
- [ ] `.agentforge/cycles/<cycleId>/` contains all expected log files

If any of these fail, debug using the cycle log files, fix, and re-run.
