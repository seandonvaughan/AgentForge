# v4.6 Expanded Team Roster — New Hires by Domain

## Current State (v4.5): ~37 agents, flat structure under C-suite

## Proposed v4.6 Organization: ~55 agents, 4 divisions, management layers

---

## Division 1: R&D (Reports to CTO)

### New Hires
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **vp-research** | opus | cto | Owns research agenda, allocates R&D budget, reviews experiment results |
| **research-scientist** | sonnet | vp-research | Designs experiments, writes research proposals, validates hypotheses |
| **ml-engineer** | sonnet | vp-research | Builds embedding models, trains routing classifiers, implements ML pipelines |
| **experiment-runner** | sonnet | vp-research | Executes research experiments, collects metrics, produces reports |

### Existing (Reassigned)
- **rd-lead** -> reports to vp-research (was floating)
- **researcher** -> reports to vp-research (was utility)

---

## Division 2: Engineering (Reports to VP-Engineering)

### Sub-Team: Frontend
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **engineering-manager-frontend** | sonnet | vp-engineering | Owns frontend sprint items, reviews PRs, manages frontend team |
| **frontend-dev** | sonnet | em-frontend | Implements UI components, dashboard features |
| **ui-ux-designer** | sonnet | em-frontend | Design systems, interaction patterns, accessibility |
| **dashboard-architect** | sonnet | em-frontend | Dashboard architecture, data flow, real-time updates |

### Sub-Team: Backend
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **engineering-manager-backend** | sonnet | vp-engineering | Owns backend sprint items, API reviews, manages backend team |
| **coder** | sonnet | em-backend | Core implementation, module development |
| **api-specialist** | sonnet | em-backend | API design, integration contracts, versioning |
| **dba** | sonnet | em-backend | Data models, persistence layer, query optimization |

### Sub-Team: Infrastructure
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **engineering-manager-infra** | sonnet | vp-engineering | Owns infra sprint items, deployment reviews, manages infra team |
| **devops-engineer** | sonnet | em-infra | CI/CD, build pipelines, deployment automation |
| **performance-engineer** | sonnet | em-infra | Benchmarking, profiling, optimization |
| **build-release-lead** | sonnet | em-infra | Release packaging, version management, changelog |

### Sub-Team: ML Engineering
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **ml-ops-engineer** (NEW) | sonnet | vp-engineering | ML model deployment, monitoring, A/B testing infrastructure |
| **data-viz-specialist** | sonnet | vp-engineering | Data visualization, dashboard charts, metric displays |

---

## Division 3: Quality & Operations (Reports to COO)

### New Hires
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **qa-manager** (NEW) | sonnet | coo | Owns quality standards, test strategy, reviews test coverage |
| **feedback-analyst** | sonnet | coo | Aggregates agent feedback, produces insight reports, identifies patterns |

### Existing (Reassigned)
- **qa-automation-engineer** -> reports to qa-manager
- **linter** -> reports to qa-manager
- **debugger** -> reports to qa-manager
- **test-runner** -> reports to qa-manager

---

## Division 4: Strategy & Intelligence (Reports to CEO)

### Existing (Formalized)
| Role | Model | Reports To | Responsibility |
|------|-------|-----------|---------------|
| **genesis** | opus | ceo | Team composition, org-graph management |
| **meta-architect** | opus | ceo | Self-improvement proposals, REFORGE engine |
| **intelligence-lead** | opus | cto | Agent mentorship, capability assessment |

---

## New Roles Summary (7 net-new hires)

1. **vp-research** (opus) — R&D division head
2. **engineering-manager-frontend** (sonnet) — Frontend team lead
3. **engineering-manager-backend** (sonnet) — Backend team lead
4. **engineering-manager-infra** (sonnet) — Infrastructure team lead
5. **ml-ops-engineer** (sonnet) — ML deployment and monitoring
6. **qa-manager** (sonnet) — Quality assurance lead
7. **feedback-analyst** (sonnet) — Continuous improvement analyst

## Model Allocation Impact
- Opus: +1 (vp-research) = 7 total Opus agents
- Sonnet: +6 (managers + ml-ops + qa-mgr + feedback-analyst) = ~28 total Sonnet agents
- Haiku: +0 = ~5 total Haiku agents
- Estimated additional cost per sprint: ~$4-6 for new Sonnet agents, ~$2-3 for vp-research

## Delegation Graph Additions
```
cto -> vp-research -> [rd-lead, research-scientist, ml-engineer, experiment-runner, researcher]
vp-engineering -> engineering-manager-frontend -> [frontend-dev, ui-ux-designer, dashboard-architect]
vp-engineering -> engineering-manager-backend -> [coder, api-specialist, dba]
vp-engineering -> engineering-manager-infra -> [devops-engineer, performance-engineer, build-release-lead]
vp-engineering -> ml-ops-engineer
vp-engineering -> data-viz-specialist
coo -> qa-manager -> [qa-automation-engineer, linter, debugger, test-runner]
coo -> feedback-analyst
```
