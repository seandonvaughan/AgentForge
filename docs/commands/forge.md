# forge

Analyze project and generate optimized agent team.

## Overview

The `forge` command performs a full project scan and generates an optimized team manifest. It analyzes your codebase structure, dependencies, frameworks, CI/CD configuration, git history, and documentation to compose a team suited to your project.

This is typically used after `genesis` to create a production-ready team, or when you want a fresh analysis without an interactive interview.

## Flags

- `--dry-run` — Show what would be generated without writing files
- `--verbose` — Display detailed analysis output from the scanner
- `--domains <domains>` — Comma-separated list of domains to activate (e.g., `software,business`)

## Examples

### Standard forge (generate and write team)
```bash
agentforge forge
```

### Dry-run to preview team composition
```bash
agentforge forge --dry-run
```

### Verbose output with full scan details
```bash
agentforge forge --verbose
```

### Activate specific domains
```bash
agentforge forge --domains software,business
```

### Combine flags
```bash
agentforge forge --verbose --dry-run --domains research
```

## Analysis Details

When `--verbose` is enabled, the command displays:

- **File scan**: Total files, lines of code, languages detected, frameworks
- **CI/CD**: Detected CI provider
- **Dependencies**: Package manager, production and dev dependency counts, test frameworks
- **Git history**: Commit count, contributor list

Example verbose output:
```
--- Scan Results ---
  Files scanned: 342
  Lines of code: 15,284
  Languages: typescript, python, yaml
  Frameworks: react, fastapi, jest
  CI provider: github-actions
  Package manager: npm
  Production deps: 24
  Dev deps: 18
  Test frameworks: jest, pytest
  Git commits: 487
  Contributors: 8
```

## Dry-Run Output

With `--dry-run`, shows what would be generated:

- Team name
- Agent list (by category)
- Custom agents (if any)
- Model assignments per agent

No files are written.

## Output Files

On successful execution (without `--dry-run`):

- `.agentforge/team.yaml` — Team manifest with agent composition and model routing
- `.agentforge/agents/{agent-name}.yaml` — Individual agent configurations (one per agent)
- `.agentforge/manifest.json` — Metadata and scan results

## Team Manifest Structure

The generated `team.yaml` contains:

- **name**: Team identifier
- **project_hash**: Hash of project state for change detection
- **agents**: Agents organized by category (strategic, implementation, quality, utility)
- **model_routing**: Model tier assignments (opus, sonnet, haiku)
- **domains**: Activated domains
- **metadata**: Scan timestamps and tool versions

## Notes

- `forge` reads project state directly; use `genesis` for an interactive workflow
- Agents are automatically assigned to Opus (strategic), Sonnet (implementation), or Haiku (utility/quality) tiers
- Review the team manifest before deployment; adjust agent assignments as needed

## Exit Codes

- `0` — Success
- `1` — Error during scan or team generation
