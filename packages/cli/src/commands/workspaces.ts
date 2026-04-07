// packages/cli/src/commands/workspaces.ts
//
// v6.6.0 Agent B — `agentforge workspaces` subcommand group.
//
// Manages the global ~/.agentforge/workspaces.json registry from the
// command line. Lazy-imports @agentforge/core inside the action handlers
// so `agentforge --help` stays cheap.

import type { Command } from 'commander';

export function registerWorkspacesCommand(program: Command): void {
  const ws = program
    .command('workspaces')
    .description('Manage AgentForge workspace registry (~/.agentforge/workspaces.json)');

  ws
    .command('list')
    .description('List all registered workspaces')
    .action(async () => {
      const { loadWorkspaceRegistry } = await import('@agentforge/core');
      const reg = loadWorkspaceRegistry();
      if (reg.workspaces.length === 0) {
        console.log('(no workspaces registered)');
        return;
      }
      const def = reg.defaultWorkspaceId;
      for (const w of reg.workspaces) {
        const star = w.id === def ? '*' : ' ';
        console.log(`${star} ${w.id.padEnd(20)} ${w.name.padEnd(24)} ${w.path}`);
      }
      if (def) console.log(`\n(* = default)`);
    });

  ws
    .command('add <name> <path>')
    .description('Register a new workspace')
    .action(async (name: string, path: string) => {
      const { addWorkspace } = await import('@agentforge/core');
      const created = addWorkspace(name, path);
      console.log(`Added workspace: id=${created.id} name=${created.name} path=${created.path}`);
    });

  ws
    .command('remove <id>')
    .description('Remove a workspace by id')
    .action(async (id: string) => {
      const { removeWorkspace } = await import('@agentforge/core');
      const ok = removeWorkspace(id);
      if (!ok) {
        console.error(`workspace not found: ${id}`);
        process.exit(1);
      }
      console.log(`Removed workspace: ${id}`);
    });

  ws
    .command('default <id>')
    .description('Set the default workspace')
    .action(async (id: string) => {
      const { setDefaultWorkspace } = await import('@agentforge/core');
      const ok = setDefaultWorkspace(id);
      if (!ok) {
        console.error(`workspace not found: ${id}`);
        process.exit(1);
      }
      console.log(`Default workspace set to: ${id}`);
    });
}
