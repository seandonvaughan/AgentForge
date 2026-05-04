#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';

const root = process.cwd();
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const outputPath = args[0] ?? 'artifacts/sbom/cyclonedx.json';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const sha256File = async (path) => {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
};

const parsePackageKey = (key) => {
  const base = key.replace(/\(.+\)$/, '');
  const versionSeparator = base.lastIndexOf('@');

  if (versionSeparator <= 0) {
    return null;
  }

  return {
    name: base.slice(0, versionSeparator),
    version: base.slice(versionSeparator + 1),
  };
};

const purlName = (name) => {
  if (!name.startsWith('@')) {
    return encodeURIComponent(name);
  }

  const [scope, packageName] = name.split('/');
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
};

const purlFor = (name, version) => `pkg:npm/${purlName(name)}@${encodeURIComponent(version)}`;

const componentRef = (name, version) => purlFor(name, version);

const integrityHashes = (integrity) => {
  if (typeof integrity !== 'string') {
    return undefined;
  }

  const hashes = integrity
    .split(/\s+/)
    .map((entry) => {
      const [algorithm, content] = entry.split('-', 2);
      if (!algorithm || !content) {
        return null;
      }

      return {
        alg: algorithm.toUpperCase().replace('SHA', 'SHA-'),
        content,
      };
    })
    .filter(Boolean);

  return hashes.length > 0 ? hashes : undefined;
};

const packageComponent = (name, version, details = {}) => {
  const purl = purlFor(name, version);
  const component = {
    type: 'library',
    'bom-ref': purl,
    name,
    version,
    purl,
  };

  const hashes = integrityHashes(details.resolution?.integrity);
  if (hashes) {
    component.hashes = hashes;
  }

  return component;
};

const workspaceManifestPaths = async (manifest) => {
  const patterns = manifest.workspaces ?? [];
  const paths = ['package.json'];

  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      continue;
    }

    const workspaceDir = pattern.slice(0, -2);
    let entries = [];

    try {
      entries = await readdir(join(root, workspaceDir), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(join(workspaceDir, entry.name, 'package.json'));
      }
    }
  }

  return paths;
};

const addUnique = (components, component) => {
  if (!components.has(component['bom-ref'])) {
    components.set(component['bom-ref'], component);
  }
};

const main = async () => {
  const rootManifest = await readJson(join(root, 'package.json'));
  const lockfilePath = join(root, 'pnpm-lock.yaml');
  const lockfile = yaml.load(await readFile(lockfilePath, 'utf8'));
  const components = new Map();
  const dependencies = [];

  const rootRef = `pkg:npm/${purlName(rootManifest.name)}@${encodeURIComponent(rootManifest.version)}`;
  const rootComponent = {
    type: 'application',
    'bom-ref': rootRef,
    name: rootManifest.name,
    version: rootManifest.version,
    purl: rootRef,
  };

  for (const manifestPath of await workspaceManifestPaths(rootManifest)) {
    const manifest = await readJson(join(root, manifestPath));
    if (manifest.name === rootManifest.name && manifest.version === rootManifest.version) {
      continue;
    }

    addUnique(components, {
      type: 'library',
      'bom-ref': `workspace:${manifest.name}`,
      name: manifest.name,
      version: manifest.version ?? '0.0.0',
    });
  }

  for (const [key, details] of Object.entries(lockfile.packages ?? {})) {
    const parsed = parsePackageKey(key);
    if (!parsed) {
      continue;
    }

    addUnique(components, packageComponent(parsed.name, parsed.version, details));
  }

  const directDependencyRefs = [];
  const rootImporter = lockfile.importers?.['.'] ?? {};

  for (const dependencySet of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, details] of Object.entries(rootImporter[dependencySet] ?? {})) {
      if (typeof details.version === 'string' && details.version.startsWith('link:')) {
        directDependencyRefs.push(`workspace:${name}`);
        continue;
      }

      if (typeof details.version === 'string') {
        directDependencyRefs.push(componentRef(name, details.version.replace(/\(.+\)$/, '')));
      }
    }
  }

  dependencies.push({
    ref: rootRef,
    dependsOn: [...new Set(directDependencyRefs)].sort(),
  });

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [
        {
          vendor: 'AgentForge',
          name: 'scripts/generate-sbom.mjs',
          version: rootManifest.version,
        },
      ],
      component: rootComponent,
      properties: [
        {
          name: 'pnpm-lock.yaml:sha256',
          value: await sha256File(lockfilePath),
        },
      ],
    },
    components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version))),
    dependencies,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`Wrote CycloneDX SBOM with ${sbom.components.length} components to ${outputPath}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
