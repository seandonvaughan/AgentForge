// @ts-nocheck
/**
 * Dependency Mapper — Haiku-tier scanner module for AgentForge.
 *
 * Detects package managers, parses manifest files, categorizes every
 * dependency, and returns an aggregated {@link DependencyAnalysis}.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Metadata for a single project dependency. */
export interface DependencyInfo {
  /** Package name as it appears in the manifest. */
  name: string;
  /** Version string (semver range, pinned version, or "*" when unknown). */
  version: string;
  /** How the dependency is consumed. */
  type: "production" | "development" | "peer" | "optional";
  /**
   * Functional category of the dependency.
   * E.g. "framework", "testing", "build-tool", "database", "auth", "ui",
   * "utility", "linting", "bundler".
   */
  category: string;
}

/** Aggregated dependency analysis for an entire project. */
export interface DependencyAnalysis {
  /** Detected package manager (npm, yarn, pnpm, pip, cargo, go, composer, bundler, etc.). */
  package_manager: string;
  /** All parsed dependencies across every manifest. */
  dependencies: DependencyInfo[];
  /** Count of production dependencies. */
  total_production: number;
  /** Count of development dependencies. */
  total_development: number;
  /** Main framework packages detected (e.g. "react", "django"). */
  framework_dependencies: string[];
  /** Test framework packages detected (e.g. "jest", "vitest", "pytest"). */
  test_frameworks: string[];
  /** Build tool packages detected (e.g. "webpack", "vite", "esbuild"). */
  build_tools: string[];
  /** Linter / formatter packages detected (e.g. "eslint", "prettier", "ruff"). */
  linters: string[];
}

// ---------------------------------------------------------------------------
// Category map — top ~50+ packages per ecosystem
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, string> = {
  // ── npm / Node.js ──────────────────────────────────────────────────────
  // Frameworks
  react: "framework",
  "react-dom": "framework",
  "react-native": "framework",
  next: "framework",
  nuxt: "framework",
  vue: "framework",
  angular: "framework",
  "@angular/core": "framework",
  svelte: "framework",
  express: "framework",
  fastify: "framework",
  nestjs: "framework",
  "@nestjs/core": "framework",
  koa: "framework",
  hono: "framework",
  remix: "framework",
  gatsby: "framework",
  astro: "framework",

  // Testing
  jest: "testing",
  vitest: "testing",
  mocha: "testing",
  chai: "testing",
  cypress: "testing",
  playwright: "testing",
  "@playwright/test": "testing",
  "@testing-library/react": "testing",
  "@testing-library/jest-dom": "testing",
  supertest: "testing",
  sinon: "testing",
  nyc: "testing",
  c8: "testing",

  // Build tools / bundlers
  webpack: "bundler",
  "webpack-cli": "bundler",
  vite: "bundler",
  esbuild: "bundler",
  rollup: "bundler",
  parcel: "bundler",
  turbo: "bundler",
  tsup: "bundler",
  swc: "bundler",
  "@swc/core": "bundler",
  tsc: "bundler",

  // Linting / formatting
  eslint: "linting",
  prettier: "linting",
  "@typescript-eslint/parser": "linting",
  "@typescript-eslint/eslint-plugin": "linting",
  "eslint-config-prettier": "linting",
  stylelint: "linting",
  biome: "linting",
  "@biomejs/biome": "linting",
  oxlint: "linting",

  // Database
  prisma: "database",
  "@prisma/client": "database",
  typeorm: "database",
  sequelize: "database",
  mongoose: "database",
  knex: "database",
  drizzle: "database",
  "drizzle-orm": "database",
  pg: "database",
  mysql2: "database",
  redis: "database",
  ioredis: "database",

  // Auth
  passport: "auth",
  "next-auth": "auth",
  jsonwebtoken: "auth",
  bcrypt: "auth",
  "bcryptjs": "auth",

  // UI
  tailwindcss: "ui",
  "styled-components": "ui",
  "@emotion/react": "ui",
  "@mui/material": "ui",
  "@chakra-ui/react": "ui",
  "framer-motion": "ui",
  "shadcn-ui": "ui",
  radix: "ui",
  "@radix-ui/react-dialog": "ui",

  // Utility
  lodash: "utility",
  axios: "utility",
  zod: "utility",
  dayjs: "utility",
  "date-fns": "utility",
  uuid: "utility",
  dotenv: "utility",
  chalk: "utility",
  commander: "utility",
  yargs: "utility",
  debug: "utility",
  winston: "utility",
  pino: "utility",
  rxjs: "utility",
  typescript: "build-tool",

  // ── Python (pip / pyproject) ───────────────────────────────────────────
  django: "framework",
  flask: "framework",
  fastapi: "framework",
  starlette: "framework",
  tornado: "framework",
  sanic: "framework",
  pytest: "testing",
  "pytest-cov": "testing",
  unittest2: "testing",
  tox: "testing",
  nox: "testing",
  hypothesis: "testing",
  ruff: "linting",
  black: "linting",
  flake8: "linting",
  pylint: "linting",
  mypy: "linting",
  isort: "linting",
  setuptools: "build-tool",
  wheel: "build-tool",
  poetry: "build-tool",
  flit: "build-tool",
  hatch: "build-tool",
  maturin: "build-tool",
  sqlalchemy: "database",
  psycopg2: "database",
  "psycopg2-binary": "database",
  alembic: "database",
  pyjwt: "auth",
  passlib: "auth",
  requests: "utility",
  httpx: "utility",
  pydantic: "utility",
  celery: "utility",
  numpy: "utility",
  pandas: "utility",

  // ── Rust (Cargo) ───────────────────────────────────────────────────────
  tokio: "framework",
  actix: "framework",
  "actix-web": "framework",
  axum: "framework",
  rocket: "framework",
  warp: "framework",
  serde: "utility",
  serde_json: "utility",
  clap: "utility",
  reqwest: "utility",
  tracing: "utility",
  anyhow: "utility",
  thiserror: "utility",
  diesel: "database",
  sqlx: "database",
  sea_orm: "database",
  "sea-orm": "database",
  criterion: "testing",
  proptest: "testing",
  clippy: "linting",

  // ── Go ─────────────────────────────────────────────────────────────────
  gin: "framework",
  "github.com/gin-gonic/gin": "framework",
  echo: "framework",
  fiber: "framework",
  "github.com/gofiber/fiber": "framework",
  "github.com/stretchr/testify": "testing",
  testify: "testing",
  golangci: "linting",
  "gorm.io/gorm": "database",
  gorm: "database",
};

// ---------------------------------------------------------------------------
// categorizeDependency
// ---------------------------------------------------------------------------

/**
 * Map a package name to a human-readable category.
 *
 * Returns one of: "framework", "testing", "build-tool", "database", "auth",
 * "ui", "utility", "linting", "bundler".  Falls back to "utility" for
 * unknown packages.
 */
export function categorizeDependency(name: string): string {
  const normalized = name.trim().toLowerCase();

  // Direct lookup
  if (CATEGORY_MAP[normalized] !== undefined) {
    return CATEGORY_MAP[normalized];
  }

  // Scoped-package prefix matching (e.g. @angular/*, @testing-library/*)
  if (normalized.startsWith("@angular/")) return "framework";
  if (normalized.startsWith("@nestjs/")) return "framework";
  if (normalized.startsWith("@testing-library/")) return "testing";
  if (normalized.startsWith("@radix-ui/")) return "ui";
  if (normalized.startsWith("@mui/")) return "ui";
  if (normalized.startsWith("@chakra-ui/")) return "ui";
  if (normalized.startsWith("@typescript-eslint/")) return "linting";
  if (normalized.startsWith("@prisma/")) return "database";
  if (normalized.startsWith("eslint-plugin-") || normalized.startsWith("eslint-config-")) return "linting";

  // Keyword heuristics
  if (normalized.includes("lint") || normalized.includes("prettier")) return "linting";
  if (normalized.includes("test")) return "testing";
  if (normalized.includes("webpack") || normalized.includes("babel")) return "bundler";

  return "utility";
}

// ---------------------------------------------------------------------------
// File readers / parsers
// ---------------------------------------------------------------------------

/** Safely read a file; returns null when the file does not exist. */
async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** Build a DependencyInfo from a name, version, and type. */
function makeDep(
  name: string,
  version: string,
  type: DependencyInfo["type"],
): DependencyInfo {
  return { name, version, type, category: categorizeDependency(name) };
}

// ── package.json ─────────────────────────────────────────────────────────

async function parsePackageJson(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "package.json"));
  if (raw === null) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const results: DependencyInfo[] = [];

  const sections: [string, DependencyInfo["type"]][] = [
    ["dependencies", "production"],
    ["devDependencies", "development"],
    ["peerDependencies", "peer"],
    ["optionalDependencies", "optional"],
  ];

  for (const [key, depType] of sections) {
    const section = pkg[key];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const [name, version] of Object.entries(
        section as Record<string, string>,
      )) {
        results.push(makeDep(name, String(version), depType));
      }
    }
  }

  return results;
}

// ── requirements.txt ─────────────────────────────────────────────────────

async function parseRequirementsTxt(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "requirements.txt"));
  if (raw === null) return [];

  const results: DependencyInfo[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Skip blanks, comments, and flags like -r / --index-url
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    // Handles: package==1.0, package>=1.0, package~=1.0, package[extras]>=1.0
    const match = trimmed.match(
      /^([A-Za-z0-9_][A-Za-z0-9._-]*(?:\[[^\]]*\])?)(?:\s*([><=!~]+)\s*(.+))?$/,
    );
    if (match) {
      const name = match[1].replace(/\[.*\]/, ""); // strip extras
      const version = match[3] ?? "*";
      results.push(makeDep(name, version, "production"));
    }
  }

  return results;
}

// ── pyproject.toml (lightweight parser — no TOML library) ────────────────

async function parsePyprojectToml(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "pyproject.toml"));
  if (raw === null) return [];

  const results: DependencyInfo[] = [];

  // Extract [project.dependencies] array
  const depsMatch = raw.match(
    /\[project\]\s[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/,
  );
  if (depsMatch) {
    for (const entry of extractTomlStrings(depsMatch[1])) {
      const { name, version } = parsePepDep(entry);
      results.push(makeDep(name, version, "production"));
    }
  }

  // Extract [project.optional-dependencies.*] sections
  const optionalPattern =
    /\[project\.optional-dependencies(?:\.[^\]]+)?\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/g;
  let optMatch: RegExpExecArray | null;
  while ((optMatch = optionalPattern.exec(raw)) !== null) {
    // Lines may be key = [...] style
    const block = optMatch[1];
    const arrayPattern = /\w+\s*=\s*\[([\s\S]*?)\]/g;
    let arrMatch: RegExpExecArray | null;
    while ((arrMatch = arrayPattern.exec(block)) !== null) {
      for (const entry of extractTomlStrings(arrMatch[1])) {
        const { name, version } = parsePepDep(entry);
        results.push(makeDep(name, version, "optional"));
      }
    }
  }

  return results;
}

/** Extract quoted strings from a TOML inline array body. */
function extractTomlStrings(body: string): string[] {
  const strings: string[] = [];
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    strings.push(m[1]);
  }
  return strings;
}

/** Parse a PEP 508 dependency string into name + version. */
function parsePepDep(raw: string): { name: string; version: string } {
  const cleaned = raw.replace(/\[.*?\]/, "").trim();
  const match = cleaned.match(
    /^([A-Za-z0-9_][A-Za-z0-9._-]*)(?:\s*([><=!~]+)\s*(.+))?$/,
  );
  if (match) {
    return { name: match[1], version: match[3] ?? "*" };
  }
  return { name: cleaned, version: "*" };
}

// ── Cargo.toml ───────────────────────────────────────────────────────────

async function parseCargoToml(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "Cargo.toml"));
  if (raw === null) return [];

  const results: DependencyInfo[] = [];

  const extractSection = (
    sectionName: string,
    depType: DependencyInfo["type"],
  ) => {
    // Match [dependencies] or [dev-dependencies] block until next section
    const re = new RegExp(
      `\\[${sectionName}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\[|$)`,
    );
    const m = raw.match(re);
    if (!m) return;

    for (const line of m[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;

      // name = "version"  or  name = { version = "x", ... }
      const simple = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);
      if (simple) {
        results.push(makeDep(simple[1], simple[2], depType));
        continue;
      }
      const table = trimmed.match(
        /^([A-Za-z0-9_-]+)\s*=\s*\{.*?version\s*=\s*"([^"]+)"/,
      );
      if (table) {
        results.push(makeDep(table[1], table[2], depType));
      }
    }
  };

  extractSection("dependencies", "production");
  extractSection("dev-dependencies", "development");

  return results;
}

// ── go.mod ───────────────────────────────────────────────────────────────

async function parseGoMod(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "go.mod"));
  if (raw === null) return [];

  const results: DependencyInfo[] = [];

  // Match require ( ... ) blocks
  const blockPattern = /require\s*\(\s*([\s\S]*?)\)/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockPattern.exec(raw)) !== null) {
    for (const line of blockMatch[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const indirect = trimmed.includes("// indirect");
        results.push(makeDep(parts[0], parts[1], indirect ? "optional" : "production"));
      }
    }
  }

  // Single-line require statements
  const singlePattern = /^require\s+(\S+)\s+(\S+)/gm;
  let singleMatch: RegExpExecArray | null;
  while ((singleMatch = singlePattern.exec(raw)) !== null) {
    results.push(makeDep(singleMatch[1], singleMatch[2], "production"));
  }

  return results;
}

// ── composer.json ────────────────────────────────────────────────────────

async function parseComposerJson(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "composer.json"));
  if (raw === null) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const results: DependencyInfo[] = [];

  const sections: [string, DependencyInfo["type"]][] = [
    ["require", "production"],
    ["require-dev", "development"],
  ];

  for (const [key, depType] of sections) {
    const section = pkg[key];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      for (const [name, version] of Object.entries(
        section as Record<string, string>,
      )) {
        // Skip the PHP runtime constraint itself
        if (name === "php") continue;
        results.push(makeDep(name, String(version), depType));
      }
    }
  }

  return results;
}

// ── Gemfile ──────────────────────────────────────────────────────────────

async function parseGemfile(root: string): Promise<DependencyInfo[]> {
  const raw = await safeReadFile(join(root, "Gemfile"));
  if (raw === null) return [];

  const results: DependencyInfo[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // gem "name", "~> 1.0"  or  gem 'name'
    const match = trimmed.match(
      /gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/,
    );
    if (match) {
      results.push(makeDep(match[1], match[2] ?? "*", "production"));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Package-manager detection helpers
// ---------------------------------------------------------------------------

/** Refine npm -> yarn / pnpm by checking for lock files. */
async function refineNodeManager(root: string): Promise<string> {
  if (await safeReadFile(join(root, "pnpm-lock.yaml")) !== null) return "pnpm";
  if (await safeReadFile(join(root, "yarn.lock")) !== null) return "yarn";
  return "npm";
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Scan a project root and return a complete {@link DependencyAnalysis}.
 *
 * Detects the package manager, parses every supported manifest file, and
 * categorizes each dependency.
 */
export async function mapDependencies(
  projectRoot: string,
): Promise<DependencyAnalysis> {
  // Run all parsers in parallel
  const [
    packageJsonDeps,
    requirementsTxtDeps,
    pyprojectTomlDeps,
    cargoTomlDeps,
    goModDeps,
    composerJsonDeps,
    gemfileDeps,
  ] = await Promise.all([
    parsePackageJson(projectRoot),
    parseRequirementsTxt(projectRoot),
    parsePyprojectToml(projectRoot),
    parseCargoToml(projectRoot),
    parseGoMod(projectRoot),
    parseComposerJson(projectRoot),
    parseGemfile(projectRoot),
  ]);

  // Determine the primary package manager
  let packageManager = "unknown";
  const depSources: { deps: DependencyInfo[]; manager: string }[] = [
    { deps: packageJsonDeps, manager: "npm" },
    { deps: requirementsTxtDeps, manager: "pip" },
    { deps: pyprojectTomlDeps, manager: "pip" },
    { deps: cargoTomlDeps, manager: "cargo" },
    { deps: goModDeps, manager: "go" },
    { deps: composerJsonDeps, manager: "composer" },
    { deps: gemfileDeps, manager: "bundler" },
  ];

  // Pick the first manager that produced results, biased by manifest order
  for (const source of depSources) {
    if (source.deps.length > 0) {
      packageManager = source.manager;
      break;
    }
  }

  // For Node projects, refine npm vs yarn vs pnpm
  if (packageManager === "npm") {
    packageManager = await refineNodeManager(projectRoot);
  }

  // Merge all dependencies
  const dependencies = [
    ...packageJsonDeps,
    ...requirementsTxtDeps,
    ...pyprojectTomlDeps,
    ...cargoTomlDeps,
    ...goModDeps,
    ...composerJsonDeps,
    ...gemfileDeps,
  ];

  // Aggregate counts and lists
  let totalProduction = 0;
  let totalDevelopment = 0;
  const frameworkDependencies: string[] = [];
  const testFrameworks: string[] = [];
  const buildTools: string[] = [];
  const linters: string[] = [];

  for (const d of dependencies) {
    if (d.type === "production" || d.type === "peer") totalProduction++;
    if (d.type === "development") totalDevelopment++;

    if (d.category === "framework" && !frameworkDependencies.includes(d.name)) {
      frameworkDependencies.push(d.name);
    }
    if (d.category === "testing" && !testFrameworks.includes(d.name)) {
      testFrameworks.push(d.name);
    }
    if (
      (d.category === "bundler" || d.category === "build-tool") &&
      !buildTools.includes(d.name)
    ) {
      buildTools.push(d.name);
    }
    if (d.category === "linting" && !linters.includes(d.name)) {
      linters.push(d.name);
    }
  }

  return {
    package_manager: packageManager,
    dependencies,
    total_production: totalProduction,
    total_development: totalDevelopment,
    framework_dependencies: frameworkDependencies,
    test_frameworks: testFrameworks,
    build_tools: buildTools,
    linters,
  };
}
