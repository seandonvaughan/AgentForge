---
description: Launch the v6.5+ Autonomous Command Center dashboard in your browser
argument-hint: Optional --restart to kill and re-launch the dev servers
---

# AgentForge Dashboard

Launch the **v6.5+ Autonomous Command Center** — the SvelteKit dashboard with the full autonomous loop UI (cycles, sprints, kanban, workspaces, daemon controls).

## What to Do

1. **Check whether the Fastify v5 server is running on port 4750:**
   - Run `lsof -i :4750 -P -n -sTCP:LISTEN | head -5`
   - If output is empty, the server is NOT running. If `--restart` was passed, also kill any running instance first.

2. **If the server is not running, build it and start it in the background:**
   - Build: `cd /Users/seandonvaughan/Projects/AgentForge/packages/server && npx tsc 2>&1 | tail -3 && cd ../..`
   - Start: spawn `node packages/server/dist/main.js` as a background task. Use `run_in_background: true` on the Bash tool.
   - Wait ~2 seconds, then verify with `curl -sSf http://localhost:4750/api/v1/health 2>&1 | head -3`

3. **Check whether Vite dev server is running on port 4751:**
   - Run `lsof -i :4751 -P -n -sTCP:LISTEN | head -5`
   - If output is empty, Vite is NOT running.

4. **If Vite is not running, start it in the background:**
   - Spawn `cd /Users/seandonvaughan/Projects/AgentForge/packages/dashboard && npx vite --port 4751 --host` as a background task.
   - Wait ~3 seconds for Vite to print its ready message.

5. **Open the dashboard in the default browser:**
   - Run `open http://localhost:4751`

6. **Report the URL to the user** along with a one-line summary of what's running.

## Dashboard Sections (v6.5+)

- **Home (`/`)** — Autonomous loop hero card, current cycle status, recent cycles list, agent stats
- **Cycles (`/cycles`)** — History browser with stage badges, cost bars, auto-refresh
- **Cycle Detail (`/cycles/[id]`)** — 5-tab view: Overview, Scoring, Events (live SSE), Phases, Files
- **Launch Cycle (`/cycles/new`)** — Config form + cost preview + 6-stage live progress
- **Sprints (`/sprints/[version]`)** — Kanban view + sprint detail
- **Workspaces (`/workspaces`)** — Multi-workspace registry management
- **Agents, Approvals, Branches, Cost, Flywheel, Health, Knowledge, Live, Memory, Org, Plugins, Runner, Search, Sessions, Settings**

## Quick Access

```
/agentforge:dashboard            # Launch dashboard (no-op if already running)
/agentforge:dashboard --restart  # Kill running instances and re-launch
```

## Notes

- The legacy v4-era HTML dashboard at `dashboard/index.html` is **deprecated** and shows stale v6.2 version info. Do not open it.
- The SvelteKit dashboard is the canonical UI from v6.5 onward.
- If port 4750 or 4751 is taken by something else, this command will fail. Use `lsof -i :PORT` to diagnose.
- The Fastify server reads `.agentforge/cycles/` from its launch directory — make sure it's started from the project root.
- The Vite dev server proxies `/api/*` to the Fastify server via the config in `packages/dashboard/vite.config.ts`.
