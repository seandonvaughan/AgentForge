# AgentForge Dashboard V1 — Designer Reference Package

This package is a complete reference export of the AgentForge dashboard V1 for use in designing V2.

**Prepared by:** Sean Vaughan  
**Date:** May 2026  
**Dashboard version:** v10.5.1  
**Contact:** sean.vaughan@allworthfinancial.com  

---

## Package contents

```
dashboard-v1-export/
├── README.md                     ← You are here
├── DESIGN_BRIEF.md               ← What we love, what to change, V2 constraints
├── source/                       ← Full SvelteKit source code
│   ├── routes/                   ← Every page (mirrors src/routes/)
│   ├── lib/                      ← Reusable components and stores
│   ├── app.html                  ← HTML shell
│   ├── app.css                   ← Global styles (utility classes, design tokens)
│   └── package.json              ← Project dependencies
├── screenshots/                  ← Live screenshots of every page
├── design-tokens/
│   ├── colors.md                 ← Color token reference table
│   ├── spacing.md                ← Spacing, radius, shadow, layout tokens
│   ├── typography.md             ← Font families, sizes, weight patterns
│   └── theme.css                 ← Original raw CSS token file
└── api-reference/
    └── endpoints.md              ← Every API endpoint each page calls
```

---

## How to view the source

The dashboard is SvelteKit + Svelte 5 + TypeScript + Vite. To run it locally:

```bash
# Requires Node 20+
cd source/
npm install
npx vite --port 4751 --host
```

The dashboard requires the AgentForge API server on port 4750. Without it, pages will show loading/error states — this is expected and still useful for reviewing component structure.

---

## Screenshots

The `screenshots/` directory contains full-page PNG screenshots of every route, captured from a live instance with real data.

| File | Route | Notes |
|---|---|---|
| `home.png` | `/` | Command center home with stat grid and recent cycles |
| `cycles.png` | `/cycles` | Cycle list with stage bars |
| `cycle-detail-items.png` | `/cycles/[id]` → Items tab | Sprint item list (4/5 complete) |
| `cycle-detail-agents.png` | `/cycles/[id]` → Agents tab | Agent invocation table |
| `cycle-detail-overview-tab.png` | `/cycles/[id]` → Overview tab | Sprint plan and summary |
| `cycle-detail-overview.png` | `/cycles/[id]` | Default view on page load (Items tab) |
| `cycle-detail-scoring.png` | `/cycles/[id]` → Scoring tab | Quality / velocity metrics |
| `cycle-detail-events.png` | `/cycles/[id]` → Events tab | Raw event list (39 events) |
| `cycle-detail-phases.png` | `/cycles/[id]` → Phases tab | Phase accordion |
| `cycle-detail-files.png` | `/cycles/[id]` → Files tab | Cycle output files |
| `cycle-detail-logs.png` | `/cycles/[id]` → Logs tab | Log viewer with SSE tail |
| `launch-form.png` | `/cycles/new` | Cycle launch form |
| `agents.png` | `/agents` | Agent registry table |
| `branches.png` | `/branches` | Autonomous branch list |
| `cost.png` | `/cost` | Cost analytics |
| `flywheel.png` | `/flywheel` | Flywheel metrics |
| `health.png` | `/health` | System health dashboard |
| `live.png` | `/live` | Live SSE event feed |
| `memory.png` | `/memory` | Memory registry |
| `org.png` | `/org` | Org chart |
| `sessions.png` | `/sessions` | Session list |
| `settings.png` | `/settings` | Settings form |
| `workspaces.png` | `/workspaces` | Workspace manager |
| `jobs.png` | `/jobs` | Runtime jobs queue |
| `runner.png` | `/runner` | Direct agent runner |
| `plugins.png` | `/plugins` | Plugin manager |
| `knowledge.png` | `/knowledge` | Knowledge graph |
| `search.png` | `/search` | Cross-system search |
| `approvals.png` | `/approvals` | Approval queue |
| `sprints.png` | `/sprints` | Sprint history |

The cycle detail screenshots use cycle ID `b555cca4-5697-46ae-9b4d-49b97e871124` — a terminal-failed cycle with data in all tabs.

---

## Design brief

See `DESIGN_BRIEF.md` for:
- What's working well in V1 (preserve in V2)
- Eight specific areas that need redesign
- V2 constraints (Svelte 5, dark-mode-first, SSE-safe)
- Inspiration references (Linear, Grafana, Vercel, Sentry, Raycast)

---

## API data shapes

See `api-reference/endpoints.md` for a complete table of every endpoint each page calls, including method, purpose, and query parameters. This is the canonical reference for understanding what data V2 designs can work with.

---

## Questions / deliverables

Send V2 mockups (Figma or component screenshots) to **Sean Vaughan** at sean.vaughan@allworthfinancial.com for alignment before full implementation. The preferred deliverable is working Svelte 5 component files.
