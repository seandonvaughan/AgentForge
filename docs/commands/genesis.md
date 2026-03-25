# genesis

Start from an idea and build an optimized agent team.

## Overview

The `genesis` command is the entry point for new projects. It conducts an interactive interview to understand your project context, then generates an optimized agent team composition.

When the project is empty (no source code or documentation found), the command automatically runs an interview by default. For projects with existing files, you can force an interview with the `--interview` flag.

## Behavior

### Discovery State

The command first scans the project directory to determine what exists:

- **empty**: No source code or documentation detected
- **codebase**: Source code found but no documentation
- **documents**: Documentation found but no source code
- **full**: Both source code and documentation detected

### Interview Flow

When an interview is triggered (automatic for empty projects, or explicit via `--interview`):

1. Core questions are asked (project name, primary goal)
2. State-specific questions fill in gaps based on what was discovered
3. **Research branching**: If the user selects "Research project" as their project type, three additional research-specific questions are asked:
   - What best describes your research process? (literature review, experimentation, data analysis, ML training, or mixed methods)
   - What is the primary deliverable? (academic paper, dataset, trained model, internal memo, or dashboard)
   - Does this research involve sensitive or proprietary data? (optional constraint description)

### Team Summary and Approval

After the interview (if any) and analysis, the command displays a formatted team summary table showing:

- Team name
- Activated domains
- Agents organized by tier (Strategic/Opus, Implementation/Sonnet, Utility/Haiku, Quality)
- Total agent count and model distribution

The user is then prompted to approve the team with a y/n gate:
- `y` or `yes`: Accept and write the team to `.agentforge/`
- `n` or `no`: Cancel without writing any files

## Flags

- `--interview` — Force interactive interview mode even if project files exist
- `--domains <domains>` — Comma-separated list of domains to activate (e.g., `software,business`)
- `--yes` — Skip the approval gate and write immediately (useful for CI/CD pipelines)

## Examples

### Start a new project with automatic interview
```bash
agentforge genesis
```

### Force interview on an existing project
```bash
agentforge genesis --interview
```

### Specify domains and skip approval
```bash
agentforge genesis --domains software,business --yes
```

### Explicit interview with domain restriction
```bash
agentforge genesis --interview --domains research
```

## Output Files

On approval, the command writes:

- `.agentforge/team.yaml` — Team manifest with agent assignments and model routing
- `.agentforge/agents/{agent-name}.yaml` — Individual agent configurations

## Exit Codes

- `0` — Success
- `1` — Error during discovery, interview, team generation, or approval rejection
