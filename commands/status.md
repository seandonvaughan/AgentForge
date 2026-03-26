---
description: Print a concise live summary of the AgentForge workspace
---

# AgentForge Status

Print a concise live summary of the current AgentForge workspace by reading real files.

## What to Do

1. **Read `.agentforge/team.yaml`** (if it exists):
   - Extract `team_size` field (fall back to counting all agents listed under `agents:` if `team_size` is absent)
   - Extract `version` field (fall back to `"4.4"` if absent)
   - If the file does not exist, show `—` for team size and version

2. **Read `.agentforge/sessions/index.json`** (if it exists):
   - Count the total number of entries → `Sessions: <N> total`
   - Find the entry with the most recent `completedAt` timestamp → `Last: <agentId> (<time ago>)`
   - Express "time ago" as a human-friendly string (e.g. `4m ago`, `2h ago`, `just now`)
   - If the file does not exist or is empty, show `Sessions: — total  │  Last: —`

3. **Read `.agentforge/sprints/` directory** (if it exists):
   - Find the newest sprint JSON file by filename (lexicographic sort, last wins)
   - Parse it and extract the latest sprint's `version`, `phase`, and item completion:
     - Count items where `status === "completed"` vs total `items` array length
     - Find the latest result entry (last in `results[]`) for `gateVerdict` — if verdict is `"approved"` show `APPROVED`, otherwise show `phase` name
   - Format as: `Sprint <version>: <completed>/<total> items <APPROVED|<phase>>`
   - If no sprint files exist, show `Sprint: —`

4. **Read `.agentforge/data/bus-events.json`** (if it exists):
   - Count the number of events (array length, or number of JSON lines if newline-delimited)
   - Show `Bus: <N> events`
   - If the file does not exist, show `Bus: —`

5. **Read `.agentforge/data/cost-analytics.json`** (if it exists):
   - Extract `currentSprint.spent` and `currentSprint.budget`
   - Format as: `Budget: $<spent>/$<budget>`
   - If the file does not exist or fields are missing, show `Budget: —`

6. **Print the status block** in this exact format:

```
AgentForge v<version>  │  <teamSize> agents  │  Autonomous
Sprint <version>: <completed>/<total> items <APPROVED|phase>  │  Budget: $<spent>/$<budget>
Sessions: <N> total  │  Last: <agentId> (<time ago>)
Bus: <N> events  │  Dashboard: npm run dashboard
```

## Graceful Degradation

- Any file that does not exist → show `—` for that field; never throw or crash
- If a JSON file cannot be parsed → show `—` for that section
- If `.agentforge/` directory does not exist at all → print:
  ```
  AgentForge — workspace not initialized. Run /agentforge:forge to get started.
  ```

## Example Output

```
AgentForge v4.4  │  37 agents  │  Autonomous
Sprint 4.4: 13/13 items APPROVED  │  Budget: $320/$450
Sessions: 12 total  │  Last: cto (4m ago)
Bus: 847 events  │  Dashboard: npm run dashboard
```
