/**
 * CI/CD Configuration Auditor — Sonnet-tier scanner module.
 *
 * Detects and analyzes CI/CD pipeline configurations across
 * multiple providers (GitHub Actions, GitLab CI, Jenkins, etc.).
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join, basename } from "node:path";
import yaml from "js-yaml";

/** Recognized CI provider identifiers. */
export type CIProvider =
  | "github-actions"
  | "gitlab-ci"
  | "jenkins"
  | "circleci"
  | "travis"
  | "azure-pipelines"
  | "none";

/** A single CI/CD pipeline extracted from configuration. */
export interface CIPipeline {
  name: string;
  triggers: string[];
  steps: string[];
}

/** Complete CI/CD analysis result. */
export interface CIAnalysis {
  ci_provider: CIProvider;
  config_files: string[];
  pipelines: CIPipeline[];
  test_commands: string[];
  build_commands: string[];
  deploy_targets: string[];
  has_linting: boolean;
  has_type_checking: boolean;
  has_security_scanning: boolean;
  has_docker: boolean;
  dockerfile_count: number;
}

// ---------------------------------------------------------------------------
// Pattern constants
// ---------------------------------------------------------------------------

const TEST_PATTERNS = [
  "npm test",
  "npm run test",
  "yarn test",
  "pnpm test",
  "npx vitest",
  "npx jest",
  "pytest",
  "python -m pytest",
  "cargo test",
  "go test",
  "dotnet test",
  "mvn test",
  "gradle test",
  "phpunit",
  "rspec",
  "bundle exec rspec",
];

const BUILD_PATTERNS = [
  "npm run build",
  "yarn build",
  "pnpm build",
  "docker build",
  "docker compose build",
  "docker-compose build",
  "cargo build",
  "go build",
  "dotnet build",
  "mvn package",
  "gradle build",
  "make build",
  "make all",
  "tsc",
  "npx tsc",
];

const LINT_PATTERNS = [
  "eslint",
  "prettier",
  "npm run lint",
  "yarn lint",
  "pnpm lint",
  "rubocop",
  "flake8",
  "pylint",
  "ruff",
  "clippy",
  "golangci-lint",
  "stylelint",
  "biome",
];

const TYPE_CHECK_PATTERNS = [
  "tsc --noEmit",
  "npx tsc --noEmit",
  "mypy",
  "pyright",
  "type-check",
  "typecheck",
];

const SECURITY_PATTERNS = [
  "snyk",
  "trivy",
  "dependabot",
  "codeql",
  "semgrep",
  "bandit",
  "brakeman",
  "npm audit",
  "yarn audit",
  "safety check",
  "grype",
  "anchore",
  "sonarqube",
  "sonar-scanner",
];

const DEPLOY_PATTERNS = [
  "deploy",
  "aws ",
  "gcloud ",
  "az ",
  "kubectl",
  "helm ",
  "terraform",
  "pulumi",
  "heroku",
  "netlify",
  "vercel",
  "firebase deploy",
  "serverless deploy",
  "flyctl deploy",
  "ssh ",
  "rsync ",
  "scp ",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function matchesAny(text: string, patterns: string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function extractMatching(text: string, patterns: string[]): string[] {
  const lower = text.toLowerCase();
  return patterns.filter((p) => lower.includes(p.toLowerCase()));
}

/** Flatten a nested YAML value into an array of strings for text searching. */
function flattenToStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenToStrings);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(
      flattenToStrings,
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// Provider-specific parsers
// ---------------------------------------------------------------------------

function parseGitHubWorkflow(
  content: string,
  fileName: string,
): CIPipeline | null {
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;

  const name =
    typeof doc.name === "string" ? doc.name : basename(fileName, ".yml");

  // Triggers
  const triggers: string[] = [];
  const on = doc.on ?? doc.true; // YAML parses bare `on:` as `true:` sometimes
  if (on) {
    if (typeof on === "string") {
      triggers.push(on);
    } else if (Array.isArray(on)) {
      triggers.push(...on.map(String));
    } else if (typeof on === "object" && on !== null) {
      triggers.push(...Object.keys(on as Record<string, unknown>));
    }
  }

  // Steps
  const steps: string[] = [];
  const jobs = doc.jobs;
  if (jobs && typeof jobs === "object") {
    for (const job of Object.values(jobs as Record<string, unknown>)) {
      if (job && typeof job === "object") {
        const jobObj = job as Record<string, unknown>;
        const jobSteps = jobObj.steps;
        if (Array.isArray(jobSteps)) {
          for (const step of jobSteps) {
            if (step && typeof step === "object") {
              const s = step as Record<string, unknown>;
              if (typeof s.name === "string") steps.push(s.name);
              if (typeof s.run === "string") steps.push(s.run);
              if (typeof s.uses === "string") steps.push(s.uses);
            }
          }
        }
      }
    }
  }

  return { name, triggers, steps };
}

function parseGitLabCI(content: string): CIPipeline[] {
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];

  const pipelines: CIPipeline[] = [];
  const reserved = new Set([
    "stages",
    "variables",
    "image",
    "services",
    "before_script",
    "after_script",
    "cache",
    "default",
    "include",
    "workflow",
  ]);

  for (const [key, value] of Object.entries(doc)) {
    if (reserved.has(key) || key.startsWith(".")) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const jobObj = value as Record<string, unknown>;
      const steps = flattenToStrings(jobObj.script ?? []);
      const triggers: string[] = [];
      if (jobObj.only) triggers.push(...flattenToStrings(jobObj.only));
      if (jobObj.rules) triggers.push(...flattenToStrings(jobObj.rules));
      if (jobObj.stage && typeof jobObj.stage === "string") {
        triggers.push(jobObj.stage);
      }
      pipelines.push({ name: key, triggers, steps });
    }
  }

  return pipelines;
}

function parseCircleCI(content: string): CIPipeline[] {
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];

  const pipelines: CIPipeline[] = [];
  const jobs = doc.jobs as Record<string, unknown> | undefined;
  if (jobs && typeof jobs === "object") {
    for (const [name, job] of Object.entries(jobs)) {
      if (job && typeof job === "object") {
        const jobObj = job as Record<string, unknown>;
        const stepsRaw = jobObj.steps;
        const steps: string[] = [];
        if (Array.isArray(stepsRaw)) {
          for (const s of stepsRaw) {
            if (typeof s === "string") {
              steps.push(s);
            } else if (s && typeof s === "object") {
              const stepObj = s as Record<string, unknown>;
              if (stepObj.run && typeof stepObj.run === "object") {
                const runObj = stepObj.run as Record<string, unknown>;
                if (typeof runObj.command === "string") {
                  steps.push(runObj.command);
                }
              } else if (typeof stepObj.run === "string") {
                steps.push(stepObj.run);
              }
              // Also capture step type names like checkout, restore_cache, etc.
              for (const key of Object.keys(stepObj)) {
                if (key !== "run") steps.push(key);
              }
            }
          }
        }
        pipelines.push({ name, triggers: [], steps });
      }
    }
  }

  // Extract triggers from workflows
  const workflows = doc.workflows as Record<string, unknown> | undefined;
  if (workflows && typeof workflows === "object") {
    for (const wf of Object.values(workflows)) {
      if (wf && typeof wf === "object") {
        const wfObj = wf as Record<string, unknown>;
        const triggers = flattenToStrings(wfObj.triggers ?? []);
        const wfJobs = wfObj.jobs;
        if (Array.isArray(wfJobs)) {
          for (const j of wfJobs) {
            if (j && typeof j === "object") {
              const jObj = j as Record<string, unknown>;
              for (const jobName of Object.keys(jObj)) {
                const match = pipelines.find((p) => p.name === jobName);
                if (match) match.triggers.push(...triggers);
              }
            }
          }
        }
      }
    }
  }

  return pipelines;
}

function parseTravisCI(content: string): CIPipeline[] {
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];

  const steps: string[] = [];
  for (const phase of [
    "before_install",
    "install",
    "before_script",
    "script",
    "after_script",
    "deploy",
  ]) {
    const val = doc[phase];
    if (val) steps.push(...flattenToStrings(val));
  }

  const triggers: string[] = [];
  if (doc.branches) triggers.push(...flattenToStrings(doc.branches));
  if (doc.on) triggers.push(...flattenToStrings(doc.on));

  return [{ name: "travis-build", triggers, steps }];
}

function parseAzurePipelines(content: string): CIPipeline[] {
  let doc: Record<string, unknown>;
  try {
    doc = yaml.load(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];

  const name =
    typeof doc.name === "string" ? doc.name : "azure-pipeline";

  const triggers: string[] = [];
  if (doc.trigger) triggers.push(...flattenToStrings(doc.trigger));
  if (doc.pr) triggers.push("pull_request");

  const steps: string[] = [];
  const stagesRaw = doc.stages ?? doc.steps ?? doc.jobs;
  if (stagesRaw) steps.push(...flattenToStrings(stagesRaw));

  return [{ name, triggers, steps }];
}

function parseJenkinsfile(content: string): CIPipeline {
  // Jenkinsfile is Groovy, not YAML — do basic text extraction.
  const steps: string[] = [];
  const triggers: string[] = [];

  // Extract stage names
  const stageRegex = /stage\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = stageRegex.exec(content)) !== null) {
    const stageName = match[1];
    if (stageName) {
      steps.push(`stage: ${stageName}`);
    }
  }

  // Extract sh/bat commands
  const shRegex = /(?:sh|bat)\s+['"]([^'"]+)['"]/g;
  while ((match = shRegex.exec(content)) !== null) {
    const command = match[1];
    if (command) {
      steps.push(command);
    }
  }

  // Multi-line sh blocks
  const shBlockRegex = /sh\s+'''([\s\S]*?)'''/g;
  while ((match = shBlockRegex.exec(content)) !== null) {
    const commandBlock = match[1];
    if (commandBlock) {
      steps.push(commandBlock.trim());
    }
  }

  // Triggers
  const triggerRegex = /triggers\s*\{([\s\S]*?)\}/;
  const triggerMatch = triggerRegex.exec(content);
  const triggerBody = triggerMatch?.[1];
  if (triggerBody) {
    triggers.push(...flattenToStrings(triggerBody.trim()));
  }

  return { name: "Jenkinsfile", triggers, steps };
}

// ---------------------------------------------------------------------------
// Docker detection
// ---------------------------------------------------------------------------

async function detectDocker(
  projectRoot: string,
): Promise<{ has_docker: boolean; dockerfile_count: number }> {
  let dockerfileCount = 0;

  // Check root-level Dockerfile
  if (await fileExists(join(projectRoot, "Dockerfile"))) {
    dockerfileCount++;
  }

  // Look for Dockerfile.* variants and Dockerfiles in subdirectories (one level)
  try {
    const entries = await readdir(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.startsWith("Dockerfile.")
      ) {
        dockerfileCount++;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        try {
          const subEntries = await readdir(join(projectRoot, entry.name));
          for (const sub of subEntries) {
            if (sub === "Dockerfile" || sub.startsWith("Dockerfile.")) {
              dockerfileCount++;
            }
          }
        } catch {
          // Skip directories we cannot read.
        }
      }
    }
  } catch {
    // Directory listing failed; proceed with what we have.
  }

  const hasDocker =
    dockerfileCount > 0 ||
    (await fileExists(join(projectRoot, "docker-compose.yml"))) ||
    (await fileExists(join(projectRoot, "docker-compose.yaml")));

  return { has_docker: hasDocker, dockerfile_count: dockerfileCount };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Audit the CI/CD configuration of a project.
 *
 * Scans for configuration files from major CI providers, parses them,
 * and extracts structured information about pipelines, tests, builds,
 * deployments, and quality tooling.
 */
export async function auditCI(projectRoot: string): Promise<CIAnalysis> {
  const configFiles: string[] = [];
  const allPipelines: CIPipeline[] = [];
  let provider: CIProvider = "none";

  // --- GitHub Actions ---
  const ghWorkflowDir = join(projectRoot, ".github", "workflows");
  try {
    const ghFiles = await readdir(ghWorkflowDir);
    const ymlFiles = ghFiles.filter(
      (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
    );
    if (ymlFiles.length > 0) {
      provider = "github-actions";
      for (const file of ymlFiles) {
        const fullPath = join(ghWorkflowDir, file);
        configFiles.push(`.github/workflows/${file}`);
        const content = await safeReadFile(fullPath);
        if (content) {
          const pipeline = parseGitHubWorkflow(content, file);
          if (pipeline) allPipelines.push(pipeline);
        }
      }
    }
  } catch {
    // No .github/workflows directory.
  }

  // --- GitLab CI ---
  const gitlabPath = join(projectRoot, ".gitlab-ci.yml");
  const gitlabContent = await safeReadFile(gitlabPath);
  if (gitlabContent) {
    if (provider === "none") provider = "gitlab-ci";
    configFiles.push(".gitlab-ci.yml");
    allPipelines.push(...parseGitLabCI(gitlabContent));
  }

  // --- Jenkinsfile ---
  const jenkinsPath = join(projectRoot, "Jenkinsfile");
  const jenkinsContent = await safeReadFile(jenkinsPath);
  if (jenkinsContent) {
    if (provider === "none") provider = "jenkins";
    configFiles.push("Jenkinsfile");
    allPipelines.push(parseJenkinsfile(jenkinsContent));
  }

  // --- CircleCI ---
  const circlePath = join(projectRoot, ".circleci", "config.yml");
  const circleContent = await safeReadFile(circlePath);
  if (circleContent) {
    if (provider === "none") provider = "circleci";
    configFiles.push(".circleci/config.yml");
    allPipelines.push(...parseCircleCI(circleContent));
  }

  // --- Travis CI ---
  const travisPath = join(projectRoot, ".travis.yml");
  const travisContent = await safeReadFile(travisPath);
  if (travisContent) {
    if (provider === "none") provider = "travis";
    configFiles.push(".travis.yml");
    allPipelines.push(...parseTravisCI(travisContent));
  }

  // --- Azure Pipelines ---
  const azurePath = join(projectRoot, "azure-pipelines.yml");
  const azureContent = await safeReadFile(azurePath);
  if (azureContent) {
    if (provider === "none") provider = "azure-pipelines";
    configFiles.push("azure-pipelines.yml");
    allPipelines.push(...parseAzurePipelines(azureContent));
  }

  // --- Aggregate all step text for pattern matching ---
  const allStepText = allPipelines
    .flatMap((p) => p.steps)
    .join("\n");

  const testCommands = extractMatching(allStepText, TEST_PATTERNS);
  const buildCommands = extractMatching(allStepText, BUILD_PATTERNS);

  // Deploy targets: extract unique identifiers from matching commands
  const deployTargets: string[] = [];
  for (const pipeline of allPipelines) {
    for (const step of pipeline.steps) {
      if (matchesAny(step, DEPLOY_PATTERNS)) {
        const target = step
          .replace(/\n/g, " ")
          .trim()
          .slice(0, 120);
        if (target && !deployTargets.includes(target)) {
          deployTargets.push(target);
        }
      }
    }
    // Also check pipeline names for deploy-like phases
    if (matchesAny(pipeline.name, ["deploy", "release", "publish"])) {
      if (!deployTargets.includes(pipeline.name)) {
        deployTargets.push(pipeline.name);
      }
    }
  }

  const hasLinting = matchesAny(allStepText, LINT_PATTERNS);
  const hasTypeChecking = matchesAny(allStepText, TYPE_CHECK_PATTERNS);
  const hasSecurityScanning = matchesAny(allStepText, SECURITY_PATTERNS);

  const docker = await detectDocker(projectRoot);

  return {
    ci_provider: provider,
    config_files: configFiles,
    pipelines: allPipelines,
    test_commands: testCommands,
    build_commands: buildCommands,
    deploy_targets: deployTargets,
    has_linting: hasLinting,
    has_type_checking: hasTypeChecking,
    has_security_scanning: hasSecurityScanning,
    has_docker: docker.has_docker,
    dockerfile_count: docker.dockerfile_count,
  };
}
