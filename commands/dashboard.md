---
description: Open the V4 Command Center dashboard in your browser
argument-hint: Optional --refresh to force reload
---

# AgentForge Dashboard

Open the AgentForge V4 Command Center — a real-time monitoring dashboard.

## What to Do

1. Open `dashboard/index.html` in the default browser
2. If `--refresh` flag is set, also reload the page

## Dashboard Sections

- **Team Overview** — 24 agent cards with model tier and status indicators
- **Org Graph** — Visual delegation hierarchy
- **Flywheel Health** — 4 component gauges (meta-learning, autonomy, inheritance, velocity)
- **V4 Feature Coverage** — 20-feature test matrix
- **Message Bus Monitor** — Live feed with priority filters and topic search
- **Session Timeline** — Active/persisted/completed sessions with progress
- **Cost Dashboard** — Real-time spend tracking vs budget with model breakdown

## Quick Access

```
/agentforge:dashboard          # Open dashboard
/agentforge:dashboard --refresh # Force reload
```
