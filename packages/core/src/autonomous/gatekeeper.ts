export type GatekeeperSurface = 'package' | 'dashboard' | 'ui' | 'other';

export type GatekeeperFindingCode = 'missing-verifier-test';

export interface ClassifiedChangedFile {
  path: string;
  packageName?: string;
  surfaces: GatekeeperSurface[];
  isVerifierDiscoverableTest: boolean;
}

export interface GatekeeperReadinessClaims {
  package: boolean;
  dashboard: boolean;
  ui: boolean;
}

export interface GatekeeperFileClassification {
  files: ClassifiedChangedFile[];
  packageFiles: string[];
  dashboardFiles: string[];
  uiFiles: string[];
  verifierDiscoverableTests: string[];
}

export interface GatekeeperFinding {
  code: GatekeeperFindingCode;
  severity: 'failure';
  message: string;
  affectedFiles: string[];
}

export interface EvaluateGatekeeperPolicyOptions {
  itemText: string;
  changedFiles: string[];
}

export interface GatekeeperPolicyResult {
  ok: boolean;
  claims: GatekeeperReadinessClaims;
  classification: GatekeeperFileClassification;
  findings: GatekeeperFinding[];
}

const TEST_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const UI_EXTENSIONS = ['.svelte', '.css', '.scss', '.sass', '.less'];

function normalizePath(file: string): string {
  return file.split('\\').join('/').replace(/^\.\//, '').trim();
}

function uniqueSorted(files: string[]): string[] {
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

export function isVerifierDiscoverableTestPath(file: string): boolean {
  const normalized = normalizePath(file);
  return TEST_EXTENSIONS.some((ext) => normalized.endsWith('.test' + ext) || normalized.endsWith('.spec' + ext));
}

function packageNameForPath(file: string): string | undefined {
  const segments = normalizePath(file).split('/');
  if (segments[0] !== 'packages' || typeof segments[1] !== 'string' || segments[1].length === 0) {
    return undefined;
  }
  return segments[1];
}

function isDashboardPath(file: string): boolean {
  return normalizePath(file).startsWith('packages/dashboard/');
}

function isUiPath(file: string): boolean {
  const normalized = normalizePath(file);
  if (UI_EXTENSIONS.some((ext) => normalized.endsWith(ext))) return true;
  return normalized.includes('/components/') || normalized.includes('/routes/');
}

export function classifyChangedFiles(changedFiles: string[]): GatekeeperFileClassification {
  const files = uniqueSorted(changedFiles.map(normalizePath).filter((file) => file.length > 0)).map((file) => {
    const packageName = packageNameForPath(file);
    const surfaces: GatekeeperSurface[] = [];

    if (packageName !== undefined) surfaces.push('package');
    if (isDashboardPath(file)) surfaces.push('dashboard');
    if (isUiPath(file)) surfaces.push('ui');
    if (surfaces.length === 0) surfaces.push('other');

    return {
      path: file,
      ...(packageName !== undefined ? { packageName } : {}),
      surfaces,
      isVerifierDiscoverableTest: isVerifierDiscoverableTestPath(file),
    };
  });

  return {
    files,
    packageFiles: files.filter((file) => file.surfaces.includes('package')).map((file) => file.path),
    dashboardFiles: files.filter((file) => file.surfaces.includes('dashboard')).map((file) => file.path),
    uiFiles: files.filter((file) => file.surfaces.includes('ui')).map((file) => file.path),
    verifierDiscoverableTests: files.filter((file) => file.isVerifierDiscoverableTest).map((file) => file.path),
  };
}

export function identifyReadinessClaims(itemText: string): GatekeeperReadinessClaims {
  const text = itemText.toLowerCase();
  return {
    package: /\bpackages?\b|packages\/[a-z0-9_-]+|workspace package/.test(text),
    dashboard: /\bdashboard\b|svelte|cycle page/.test(text),
    ui: /\bui\b|\bux\b|front[- ]?end|\bcomponent\b|\bview\b|\bpage\b/.test(text),
  };
}

export function evaluateGatekeeperPolicy(options: EvaluateGatekeeperPolicyOptions): GatekeeperPolicyResult {
  const classification = classifyChangedFiles(options.changedFiles);
  const claims = identifyReadinessClaims(options.itemText);
  const findings: GatekeeperFinding[] = [];

  if (
    (classification.packageFiles.length > 0 || classification.dashboardFiles.length > 0) &&
    classification.verifierDiscoverableTests.length === 0
  ) {
    const affectedFiles = uniqueSorted([...classification.packageFiles, ...classification.dashboardFiles]);
    findings.push({
      code: 'missing-verifier-test',
      severity: 'failure',
      message:
        'Package or dashboard changes must include at least one verifier-discoverable test file (*.test.* or *.spec.*) before the child can be accepted.',
      affectedFiles,
    });
  }

  return {
    ok: findings.length === 0,
    claims,
    classification,
    findings,
  };
}
