import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import yaml from 'js-yaml';

interface RootBuilderModule {
  forgeTeam(projectRoot: string): Promise<TeamManifest>;
}

interface RootScannerModule {
  runFullScan(projectRoot: string): Promise<FullScanResult>;
}

interface RootTeamComposerModule {
  composeTeam(scan: FullScanResult): TeamComposition;
}

interface RootGenesisModule {
  discover(projectRoot: string): Promise<DiscoveryResult>;
  getInterviewQuestions(
    state: DiscoveryState,
    answers?: Record<string, string>,
  ): InterviewQuestion[];
  buildBrief(params: {
    scan?: FullScanResult;
    answers?: Record<string, string>;
  }): ProjectBrief;
  designTeam(
    brief: ProjectBrief,
    activeDomains: string[],
    domainPacks: Map<string, DomainPack>,
    templates: Map<string, Map<string, AgentTemplate>>,
  ): TeamManifest;
}

interface RootDomainsModule {
  getDefaultDomainsDir(): string;
  loadAllDomains(domainsDir: string): Promise<Map<string, DomainPack>>;
  activateDomains(
    scan: FullScanResult,
    domainPacks: Map<string, DomainPack>,
  ): string[];
}

interface RootBuilderUtilityModule {
  loadDomainTemplates(
    domainsDir: string,
  ): Promise<Map<string, Map<string, AgentTemplate>>>;
  customizeTemplate(
    template: AgentTemplate,
    scan: FullScanResult,
    projectName: string,
  ): AgentTemplate;
  writeTeam(
    projectRoot: string,
    manifest: TeamManifest,
    agents: Map<string, AgentTemplate>,
    scanResult: FullScanResult,
  ): Promise<void>;
}

interface RootInterviewRunnerModule {
  runInteractiveInterview(
    questions: InterviewQuestion[],
  ): Promise<Record<string, string>>;
}

interface RootReforgeModule {
  reforgeTeam(projectRoot: string): Promise<TeamDiff>;
  applyDiff(projectRoot: string, diff: TeamDiff): Promise<void>;
  logReforge(projectRoot: string, diff: TeamDiff): Promise<void>;
  migrateV1ToV2(projectRoot: string): Promise<void>;
}

interface DiscoveryResult {
  state: DiscoveryState;
  signals: string[];
}

type DiscoveryState = 'empty' | 'codebase' | 'documents' | 'full';

interface InterviewQuestion {
  id: string;
  question: string;
  type: 'text' | 'choice' | 'confirm';
  choices?: string[];
  condition?: (answers: Record<string, string>) => boolean;
}

interface TeamAgents {
  strategic: string[];
  implementation: string[];
  quality: string[];
  utility: string[];
  [category: string]: string[];
}

interface TeamManifest {
  name: string;
  forged_at: string;
  forged_by?: string;
  project_hash: string;
  agents: TeamAgents;
  model_routing: {
    opus: string[];
    sonnet: string[];
    haiku: string[];
  };
  delegation_graph: Record<string, string[]>;
}

interface DomainPack {
  name: string;
  version: string;
  description: string;
  agents: Record<string, string[]>;
}

interface ProjectBrief {
  project: {
    name: string;
    type: string;
    stage: 'early' | 'growth' | 'mature' | 'pivot';
  };
  goals: {
    primary: string;
    secondary: string[];
  };
  domains: string[];
  constraints: Record<string, string>;
  context: {
    codebase?: unknown;
    documents?: unknown[];
    research?: Record<string, unknown>;
    integrations?: Array<{ type: string; ref: string }>;
  };
}

interface AgentTemplate {
  name: string;
  model: 'opus' | 'sonnet' | 'haiku';
  version: string;
  description?: string;
  skills: string[];
  collaboration: {
    can_delegate_to: string[];
    reports_to: string | null;
  };
}

interface TeamComposition {
  agents: string[];
  custom_agents: Array<{ name: string }>;
  model_assignments: Record<string, string>;
}

interface FullScanResult {
  files: {
    files: Array<{
      file_path: string;
      patterns: string[];
    }>;
    total_files: number;
    total_loc: number;
    languages: Record<string, number>;
    frameworks_detected: string[];
    directory_structure: string[];
  };
  ci: {
    ci_provider: string;
    config_files: string[];
    pipelines: unknown[];
    test_commands: string[];
    build_commands: string[];
    deploy_targets: string[];
    has_linting: boolean;
    has_type_checking: boolean;
    has_security_scanning: boolean;
    has_docker: boolean;
    dockerfile_count: number;
  };
  dependencies: {
    package_manager: string;
    dependencies: unknown[];
    total_production: number;
    total_development: number;
    framework_dependencies: string[];
    test_frameworks: string[];
    build_tools: string[];
    linters: string[];
  };
  git: {
    total_commits: number;
    contributors: string[];
    active_files: unknown[];
    branch_count: number;
    branch_strategy: string;
    churn_rate: unknown[];
    commit_frequency: unknown[];
    age_days: number;
  };
}

interface TeamDiff {
  agents_added: string[];
  agents_removed: string[];
  agents_modified: Array<{
    name: string;
    changes: string[];
  }>;
  model_changes: Array<{
    agent: string;
    from: string;
    to: string;
  }>;
  skill_updates: Array<{
    agent: string;
    added: string[];
    removed: string[];
  }>;
  summary: string;
}

interface AgentMutation {
  type: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface AgentOverride {
  version: number;
  appliedAt: string;
  sessionId: string;
  mutations: AgentMutation[];
  previousVersion?: AgentOverride;
  systemPromptPreamble?: string;
  modelTierOverride?: string;
  effortOverride?: string;
}

interface ParsedOptions {
  flags: Set<string>;
  values: Map<string, string>;
}

export interface LegacyForgeOptions {
  dryRun?: boolean;
  verbose?: boolean;
  domains?: string;
}

export interface LegacyGenesisOptions {
  interview?: boolean;
  domains?: string;
  yes?: boolean;
}

export interface LegacyRebuildOptions {
  autoApply?: boolean;
  upgrade?: boolean;
}

export interface LegacyReforgeApplyOptions {
  yes?: boolean;
}

function getRepositoryRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function getRootDistPath(...segments: string[]): string {
  return join(getRepositoryRoot(), 'dist', ...segments);
}

async function importRootModule<T>(...segments: string[]): Promise<T> {
  const modulePath = getRootDistPath(...segments);

  try {
    await access(modulePath, constants.F_OK);
  } catch {
    throw new Error(
      `Required root module is not built at ${modulePath}. Run \`corepack pnpm build\` first.`,
    );
  }

  return import(pathToFileURL(modulePath).href) as Promise<T>;
}

function createParsedOptions(config: {
  flags?: string[];
  values?: Record<string, string | undefined>;
} = {}): ParsedOptions {
  const flags = new Set<string>((config.flags ?? []).filter(Boolean));
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(config.values ?? {})) {
    if (typeof value === 'string' && value.length > 0) {
      values.set(key, value);
    }
  }

  return {
    flags,
    values,
  };
}

function hasFlag(options: ParsedOptions, name: string): boolean {
  return options.flags.has(name);
}

function optionValue(options: ParsedOptions, name: string): string | undefined {
  return options.values.get(name);
}

function parseDomains(raw: string | undefined): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function allAgents(manifest: TeamManifest): string[] {
  return [
    ...(manifest.agents.strategic ?? []),
    ...(manifest.agents.implementation ?? []),
    ...(manifest.agents.quality ?? []),
    ...(manifest.agents.utility ?? []),
  ];
}

async function forgeTeamCommand(
  projectRoot: string,
  options: ParsedOptions,
): Promise<number> {
  console.log('Forging agent team...');

  try {
    const [{ forgeTeam }, { runFullScan }] = await Promise.all([
      importRootModule<RootBuilderModule>('builder', 'index.js'),
      importRootModule<RootScannerModule>('scanner', 'index.js'),
    ]);

    if (hasFlag(options, '--verbose')) {
      console.log('\nRunning project scan...');
      const scan = await runFullScan(projectRoot);
      console.log('\n--- Scan Results ---');
      console.log(`  Files scanned: ${scan.files.total_files}`);
      console.log(`  Lines of code: ${scan.files.total_loc}`);
      console.log(
        `  Languages: ${Object.keys(scan.files.languages).join(', ') || 'none detected'}`,
      );
      console.log(
        `  Frameworks: ${scan.files.frameworks_detected.join(', ') || 'none detected'}`,
      );
      console.log(`  CI provider: ${scan.ci.ci_provider}`);
      console.log(`  Package manager: ${scan.dependencies.package_manager}`);
      console.log(`  Production deps: ${scan.dependencies.total_production}`);
      console.log(`  Dev deps: ${scan.dependencies.total_development}`);
      console.log(
        `  Test frameworks: ${scan.dependencies.test_frameworks.join(', ') || 'none'}`,
      );
      console.log(`  Git commits: ${scan.git.total_commits}`);
      console.log(`  Contributors: ${scan.git.contributors.length}`);
    }

    if (hasFlag(options, '--dry-run')) {
      console.log('\n[dry-run] Scanning project without writing files...');
      const [scan, composer] = await Promise.all([
        runFullScan(projectRoot),
        importRootModule<RootTeamComposerModule>('builder', 'team-composer.js'),
      ]);
      const composition = composer.composeTeam(scan);
      console.log('\n[dry-run] Would generate team with:');
      console.log(`  Agents: ${composition.agents.join(', ')}`);
      if (composition.custom_agents.length > 0) {
        console.log(
          `  Custom agents: ${composition.custom_agents.map((agent) => agent.name).join(', ')}`,
        );
      }
      console.log('\n  Model assignments:');
      for (const [agent, model] of Object.entries(composition.model_assignments)) {
        console.log(`    ${agent}: ${model}`);
      }
      return 0;
    }

    const manifest = await forgeTeam(projectRoot);

    console.log('\nAgent team forged successfully.');
    console.log('\n--- Team Manifest ---');
    console.log(`  Name: ${manifest.name}`);
    console.log(`  Project hash: ${manifest.project_hash}`);
    console.log(`  Total agents: ${allAgents(manifest).length}`);

    for (const category of ['strategic', 'implementation', 'quality', 'utility']) {
      const categoryAgents = manifest.agents[category] ?? [];
      if (categoryAgents.length > 0) {
        console.log(`  ${category}: ${categoryAgents.join(', ')}`);
      }
    }

    console.log('\n--- Model Assignments ---');
    if (manifest.model_routing.opus.length > 0) {
      console.log(`  Opus:   ${manifest.model_routing.opus.join(', ')}`);
    }
    if (manifest.model_routing.sonnet.length > 0) {
      console.log(`  Sonnet: ${manifest.model_routing.sonnet.join(', ')}`);
    }
    if (manifest.model_routing.haiku.length > 0) {
      console.log(`  Haiku:  ${manifest.model_routing.haiku.join(', ')}`);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error forging team: ${message}`);
    return 1;
  }
}

function printGenesisTeamSummary(manifest: TeamManifest, domains: string[]): void {
  const opusCount = manifest.model_routing.opus.length;
  const sonnetCount = manifest.model_routing.sonnet.length;
  const haikuCount = manifest.model_routing.haiku.length;
  const totalAgents = opusCount + sonnetCount + haikuCount;

  console.log(`  PROPOSED TEAM — ${manifest.name}`);
  console.log('  ───────────────────────────────────\n');
  console.log(`  Domains activated: ${domains.join(', ')}\n`);

  if ((manifest.agents.strategic ?? []).length > 0) {
    console.log('  STRATEGIC (Opus)');
    for (const agent of manifest.agents.strategic ?? []) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if ((manifest.agents.implementation ?? []).length > 0) {
    console.log('  IMPLEMENTATION (Sonnet)');
    for (const agent of manifest.agents.implementation ?? []) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if ((manifest.agents.utility ?? []).length > 0) {
    console.log('  UTILITY (Haiku)');
    for (const agent of manifest.agents.utility ?? []) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  if ((manifest.agents.quality ?? []).length > 0) {
    console.log('  QUALITY');
    for (const agent of manifest.agents.quality ?? []) {
      console.log(`    ${agent}   —`);
    }
    console.log();
  }

  console.log(
    `  ${totalAgents} agents total  |  ${opusCount} Opus · ${sonnetCount} Sonnet · ${haikuCount} Haiku\n`,
  );
}

function createEmptyScanResult(): FullScanResult {
  return {
    files: {
      files: [],
      languages: {},
      frameworks_detected: [],
      total_files: 0,
      total_loc: 0,
      directory_structure: [],
    },
    git: {
      total_commits: 0,
      contributors: [],
      active_files: [],
      branch_count: 0,
      branch_strategy: 'unknown',
      churn_rate: [],
      commit_frequency: [],
      age_days: 0,
    },
    dependencies: {
      package_manager: 'unknown',
      dependencies: [],
      total_production: 0,
      total_development: 0,
      framework_dependencies: [],
      test_frameworks: [],
      build_tools: [],
      linters: [],
    },
    ci: {
      ci_provider: 'none',
      config_files: [],
      pipelines: [],
      test_commands: [],
      build_commands: [],
      deploy_targets: [],
      has_linting: false,
      has_type_checking: false,
      has_security_scanning: false,
      has_docker: false,
      dockerfile_count: 0,
    },
  };
}

async function requestApproval(): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    console.log('  Write this team to .agentforge/?');
    console.log('    y  Accept and write');
    console.log('    n  Cancel (nothing is written)');
    const answer = await rl.question('  > ');
    const normalized = answer.toLowerCase().trim();
    return normalized === 'y' || normalized === 'yes';
  } finally {
    rl.close();
  }
}

async function genesisTeamCommand(
  projectRoot: string,
  options: ParsedOptions,
): Promise<number> {
  console.log('Starting Genesis workflow...\n');

  try {
    const [
      { discover, getInterviewQuestions, buildBrief, designTeam },
      interviewRunner,
      { runFullScan },
      { getDefaultDomainsDir, loadAllDomains, activateDomains },
      { loadDomainTemplates, customizeTemplate, writeTeam },
    ] = await Promise.all([
      importRootModule<RootGenesisModule>('genesis', 'index.js'),
      importRootModule<RootInterviewRunnerModule>('genesis', 'interview-runner.js'),
      importRootModule<RootScannerModule>('scanner', 'index.js'),
      importRootModule<RootDomainsModule>('domains', 'index.js'),
      importRootModule<RootBuilderUtilityModule>('builder', 'index.js'),
    ]);

    const discoveryResult = await discover(projectRoot);
    const forceInterview = hasFlag(options, '--interview');
    const shouldInterview = forceInterview || discoveryResult.state === 'empty';
    const parsedDomains = parseDomains(optionValue(options, '--domains'));

    let interviewAnswers: Record<string, string> = {};
    if (shouldInterview) {
      console.log('Running project interview...\n');
      const questions = getInterviewQuestions(discoveryResult.state);
      interviewAnswers = await interviewRunner.runInteractiveInterview(questions);
      console.log('\n');
    }

    let scan: FullScanResult | undefined;
    try {
      scan = await runFullScan(projectRoot);
    } catch {
      scan = undefined;
    }

    const domainsDir = getDefaultDomainsDir();
    let domainPacks = new Map<string, DomainPack>();
    try {
      domainPacks = await loadAllDomains(domainsDir);
    } catch {
      domainPacks = new Map<string, DomainPack>();
    }

    let templates = new Map<string, Map<string, AgentTemplate>>();
    try {
      templates = await loadDomainTemplates(domainsDir);
    } catch {
      templates = new Map<string, Map<string, AgentTemplate>>();
    }

    const brief = buildBrief({
      ...(scan ? { scan } : {}),
      ...(Object.keys(interviewAnswers).length > 0 ? { answers: interviewAnswers } : {}),
    });

    const domains =
      parsedDomains && parsedDomains.length > 0
        ? [...new Set(['core', ...parsedDomains])].sort()
        : scan
          ? activateDomains(scan, domainPacks)
          : brief.domains;

    if (parsedDomains && parsedDomains.length > 0) {
      brief.domains = domains;
    }

    const manifest = designTeam(brief, domains, domainPacks, templates);

    printGenesisTeamSummary(manifest, domains);

    if (!hasFlag(options, '--yes')) {
      const approved = await requestApproval();
      if (!approved) {
        console.log('Cancelled. No files written.');
        return 0;
      }
    }

    const templatesByName = new Map<string, AgentTemplate>();
    for (const domainTemplates of templates.values()) {
      for (const [agentName, template] of domainTemplates) {
        templatesByName.set(agentName, template);
      }
    }

    const effectiveScan = scan ?? createEmptyScanResult();
    const customizedAgents = new Map<string, AgentTemplate>();
    for (const agentName of allAgents(manifest)) {
      const template = templatesByName.get(agentName);
      if (!template) {
        continue;
      }
      customizedAgents.set(
        agentName,
        customizeTemplate(template, effectiveScan, brief.project.name),
      );
    }

    await writeTeam(projectRoot, manifest, customizedAgents, effectiveScan);

    console.log('\nGenesis complete. Team written to .agentforge/team.yaml');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error during genesis: ${message}`);
    return 1;
  }
}

async function rebuildTeamCommand(
  projectRoot: string,
  options: ParsedOptions,
): Promise<number> {
  const { reforgeTeam, applyDiff, logReforge, migrateV1ToV2 } =
    await importRootModule<RootReforgeModule>('reforge', 'index.js');

  if (hasFlag(options, '--upgrade')) {
    console.log('Upgrading team to v2 format...');
    try {
      await migrateV1ToV2(projectRoot);
      console.log('Team upgraded to v2 format successfully.');
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error upgrading team: ${message}`);
      return 1;
    }
  }

  console.log('Re-analyzing project for changes...\n');

  try {
    const diff = await reforgeTeam(projectRoot);
    console.log(`Summary: ${diff.summary}`);

    const hasChanges =
      diff.agents_added.length > 0 ||
      diff.agents_removed.length > 0 ||
      diff.agents_modified.length > 0 ||
      diff.model_changes.length > 0;

    if (!hasChanges) {
      console.log('\nYour team is up to date. No rebuild needed.');
      return 0;
    }

    if (diff.agents_added.length > 0) {
      console.log('\nAgents to add:');
      for (const agent of diff.agents_added) {
        console.log(`  + ${agent}`);
      }
    }

    if (diff.agents_removed.length > 0) {
      console.log('\nAgents to remove:');
      for (const agent of diff.agents_removed) {
        console.log(`  - ${agent}`);
      }
    }

    if (diff.agents_modified.length > 0) {
      console.log('\nAgents modified:');
      for (const modification of diff.agents_modified) {
        console.log(`  ~ ${modification.name}`);
        for (const change of modification.changes) {
          console.log(`      ${change}`);
        }
      }
    }

    if (diff.model_changes.length > 0) {
      console.log('\nModel tier changes:');
      for (const change of diff.model_changes) {
        console.log(`  ${change.agent}: ${change.from} -> ${change.to}`);
      }
    }

    if (diff.skill_updates.length > 0) {
      console.log('\nSkill updates:');
      for (const update of diff.skill_updates) {
        if (update.added.length > 0) {
          console.log(`  ${update.agent} gained: ${update.added.join(', ')}`);
        }
        if (update.removed.length > 0) {
          console.log(`  ${update.agent} lost: ${update.removed.join(', ')}`);
        }
      }
    }

    if (hasFlag(options, '--auto-apply')) {
      console.log('\nApplying changes...');
      await applyDiff(projectRoot, diff);
      await logReforge(projectRoot, diff);
      console.log('Rebuild complete.');
    } else {
      console.log('\nRun with --auto-apply to apply these changes.');
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error during rebuild: ${message}`);
    return 1;
  }
}

async function applyReforgeProposal(
  projectRoot: string,
  proposalId: string,
  options: ParsedOptions,
): Promise<number> {
  const proposalsDir = join(projectRoot, '.agentforge', 'reforge-proposals');

  try {
    const files = await readdir(proposalsDir);
    const match = files.find((file) => file.includes(proposalId));

    if (!match) {
      console.error(`No proposal found matching ID "${proposalId}".`);
      console.log(`\nAvailable proposals in ${proposalsDir}:`);
      for (const file of files.filter((entry) => entry.endsWith('.md'))) {
        console.log(`  ${file}`);
      }
      return 1;
    }

    const content = await readFile(join(proposalsDir, match), 'utf-8');
    console.log('=== Structural Reforge Proposal ===\n');
    console.log(content);

    if (!hasFlag(options, '--yes')) {
      console.log('\nTo apply this proposal, re-run with --yes flag:');
      console.log(`  agentforge reforge apply ${proposalId} --yes`);
      return 0;
    }

    const appliedName = match.replace('.md', '.applied.md');
    await rename(join(proposalsDir, match), join(proposalsDir, appliedName));
    console.log(`\nProposal applied and archived as: ${appliedName}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ENOENT')) {
      console.log('No reforge proposals found. Directory does not exist yet.');
      return 0;
    }

    console.error(`Error: ${message}`);
    return 1;
  }
}

async function loadStoredOverride(
  projectRoot: string,
  agentName: string,
): Promise<AgentOverride | null> {
  const overridePath = join(
    projectRoot,
    '.agentforge',
    'agent-overrides',
    `${agentName}.json`,
  );

  try {
    const raw = await readFile(overridePath, 'utf-8');
    return JSON.parse(raw) as AgentOverride;
  } catch {
    return null;
  }
}

async function writeStoredOverride(
  projectRoot: string,
  agentName: string,
  override: AgentOverride,
): Promise<void> {
  const overridesDir = join(projectRoot, '.agentforge', 'agent-overrides');
  await access(overridesDir, constants.F_OK).catch(async () => {
    await mkdir(overridesDir, { recursive: true });
  });
  await writeFile(
    join(overridesDir, `${agentName}.json`),
    JSON.stringify(override, null, 2),
    'utf-8',
  );
}

async function listReforgeState(projectRoot: string): Promise<number> {
  const proposalsDir = join(projectRoot, '.agentforge', 'reforge-proposals');
  const overridesDir = join(projectRoot, '.agentforge', 'agent-overrides');

  console.log('=== Structural Proposals ===\n');
  try {
    const proposals = await readdir(proposalsDir);
    const pending = proposals.filter((entry) => entry.endsWith('.md') && !entry.includes('.applied'));
    const applied = proposals.filter((entry) => entry.includes('.applied'));

    if (pending.length === 0 && applied.length === 0) {
      console.log('  (none)\n');
    } else {
      for (const file of pending) {
        console.log(`  [PENDING] ${file}`);
      }
      for (const file of applied) {
        console.log(`  [APPLIED] ${file}`);
      }
      console.log();
    }
  } catch {
    console.log('  (no proposals directory)\n');
  }

  console.log('=== Active Agent Overrides ===\n');
  try {
    const overrides = await readdir(overridesDir);
    const jsonFiles = overrides.filter((entry) => entry.endsWith('.json'));

    if (jsonFiles.length === 0) {
      console.log('  (none)\n');
      return 0;
    }

    for (const file of jsonFiles) {
      const agentName = file.replace('.json', '');
      const override = await loadStoredOverride(projectRoot, agentName);
      if (!override) {
        continue;
      }

      const mutationTypes = override.mutations.map((mutation) => mutation.type).join(', ');
      console.log(
        `  ${agentName} v${override.version} — ${mutationTypes} (${override.appliedAt})`,
      );
    }
    console.log();
    return 0;
  } catch {
    console.log('  (no overrides directory)\n');
    return 0;
  }
}

async function rollbackReforgeOverride(
  projectRoot: string,
  agentName: string,
): Promise<number> {
  try {
    const current = await loadStoredOverride(projectRoot, agentName);
    if (!current) {
      console.error(`No override found for agent "${agentName}".`);
      return 1;
    }
    if (!current.previousVersion) {
      console.error(
        `Rollback failed: Agent "${agentName}" is at version 1 with no previous version to roll back to.`,
      );
      return 1;
    }

    console.log(`Current override for ${agentName}: v${current.version}`);
    await writeStoredOverride(projectRoot, agentName, current.previousVersion);
    const after = await loadStoredOverride(projectRoot, agentName);
    console.log(`Rolled back to: v${after?.version ?? 0}`);
    console.log('Rollback complete.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Rollback failed: ${message}`);
    return 1;
  }
}

async function showReforgeStatus(projectRoot: string): Promise<number> {
  const overridesDir = join(projectRoot, '.agentforge', 'agent-overrides');

  console.log('=== Reforge Status ===\n');

  try {
    const files = await readdir(overridesDir);
    const jsonFiles = files.filter((entry) => entry.endsWith('.json'));
    if (jsonFiles.length === 0) {
      console.log('No agent overrides active. System is running base templates.');
      return 0;
    }

    let totalMutations = 0;

    for (const file of jsonFiles) {
      const agentName = file.replace('.json', '');
      const override = await loadStoredOverride(projectRoot, agentName);
      if (!override) {
        continue;
      }

      totalMutations += override.mutations.length;
      console.log(`${agentName}:`);
      console.log(`  Version:    ${override.version}/5`);
      console.log(`  Applied:    ${override.appliedAt}`);
      console.log(`  Session:    ${override.sessionId}`);
      console.log(`  Rollback:   ${override.previousVersion ? 'available' : 'none'}`);
      console.log('  Mutations:');
      for (const mutation of override.mutations) {
        console.log(
          `    - [${mutation.type}] ${mutation.field}: ${JSON.stringify(mutation.oldValue)} -> ${JSON.stringify(mutation.newValue)}`,
        );
      }
      if (override.systemPromptPreamble) {
        const preview = override.systemPromptPreamble.slice(0, 80);
        console.log(
          `  Preamble:   "${preview}${override.systemPromptPreamble.length > 80 ? '...' : ''}"`,
        );
      }
      if (override.modelTierOverride) {
        console.log(`  Model:      -> ${override.modelTierOverride}`);
      }
      if (override.effortOverride) {
        console.log(`  Effort:     -> ${override.effortOverride}`);
      }
      console.log();
    }

    console.log(
      `Total: ${jsonFiles.length} agent(s) with ${totalMutations} mutation(s) active.`,
    );
    return 0;
  } catch {
    console.log('No agent overrides directory found. System is running base templates.');
    return 0;
  }
}

export async function forgeTeamWithLegacyEngine(
  projectRoot: string,
  options: LegacyForgeOptions = {},
): Promise<number> {
  return forgeTeamCommand(
    projectRoot,
    createParsedOptions({
      flags: [
        ...(options.dryRun ? ['--dry-run'] : []),
        ...(options.verbose ? ['--verbose'] : []),
      ],
      values: {
        '--domains': options.domains,
      },
    }),
  );
}

export async function genesisTeamWithLegacyEngine(
  projectRoot: string,
  options: LegacyGenesisOptions = {},
): Promise<number> {
  return genesisTeamCommand(
    projectRoot,
    createParsedOptions({
      flags: [
        ...(options.interview ? ['--interview'] : []),
        ...(options.yes ? ['--yes'] : []),
      ],
      values: {
        '--domains': options.domains,
      },
    }),
  );
}

export async function rebuildTeamWithLegacyEngine(
  projectRoot: string,
  options: LegacyRebuildOptions = {},
): Promise<number> {
  return rebuildTeamCommand(
    projectRoot,
    createParsedOptions({
      flags: [
        ...(options.autoApply ? ['--auto-apply'] : []),
        ...(options.upgrade ? ['--upgrade'] : []),
      ],
    }),
  );
}

export async function applyLegacyReforgeProposal(
  projectRoot: string,
  proposalId: string,
  options: LegacyReforgeApplyOptions = {},
): Promise<number> {
  return applyReforgeProposal(
    projectRoot,
    proposalId,
    createParsedOptions({
      flags: [...(options.yes ? ['--yes'] : [])],
    }),
  );
}

export async function listLegacyReforgeState(projectRoot: string): Promise<number> {
  return listReforgeState(projectRoot);
}

export async function rollbackLegacyReforgeOverride(
  projectRoot: string,
  agentName: string,
): Promise<number> {
  return rollbackReforgeOverride(projectRoot, agentName);
}

export async function showLegacyReforgeStatus(projectRoot: string): Promise<number> {
  return showReforgeStatus(projectRoot);
}
