#!/usr/bin/env node
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANAGED_UNIT_PATTERN = /^jarvis-[a-z0-9]+(?:-[a-z0-9]+)*\.service$/;
const RESERVED_CORE_UNITS = new Set(['jarvis.service', 'jarvis-terminal-host.service']);
const ACTIONS = new Set(['start', 'stop', 'restart']);

const options = parseArguments(process.argv.slice(2));
const template = await readFile(options.template, 'utf8');
const selfDeployment = await loadManifest(options.selfManifest, {
  provenancePath: options.selfProvenance,
  requireRunner: false,
  needsBuild: false,
});
if (selfDeployment.manifest.kind !== 'self') fail(`Self deployment manifest must have kind self: ${options.selfManifest}`);
const previous = await loadPreviousRegistry(
  options.previousRegistry,
  options.previousIndex,
  options.selection === 'preserve',
);
const managedDeployments = options.selection === 'replace'
  ? await Promise.all(options.manifests.map((path) => loadManifest(path, { requireRunner: true, needsBuild: true })))
  : previous.deployments.filter(({ manifest }) => manifest.kind === 'managed');
const deployments = [selfDeployment, ...managedDeployments];
validateUnique(deployments.map(({ manifest }) => manifest), 'id', 'deployment ID');
validateUnique(deployments.map(({ manifest }) => manifest), 'systemdUnit', 'systemd unit');

await mkdir(dirname(options.registry), { recursive: true });
await mkdir(options.systemdDir, { recursive: true });
for (const deployment of managedDeployments) {
  if (options.build && deployment.needsBuild && deployment.manifest.build) runBuild(deployment, options.buildPath);
}

const deploymentIndex = [];
for (const deployment of managedDeployments) {
  const { manifest } = deployment;
  const unit = template
    .replaceAll('@@DISPLAY_NAME@@', escapeUnitValue(manifest.name))
    .replaceAll('@@MANIFEST_PATH@@', escapeUnitValue(deployment.provenance.manifestPath))
    .replaceAll('@@PROJECT_ROOT@@', escapeUnitValue(deployment.root))
    .replaceAll('@@RUNNER_PATH@@', escapeUnitValue(deployment.runnerPath))
    .replaceAll('@@TOOL_PATH@@', escapeUnitValue(process.env.PATH ?? ''));
  await writeFile(join(options.systemdDir, manifest.systemdUnit), unit);
  deploymentIndex.push(`${manifest.systemdUnit}\t${manifest.healthUrl ?? ''}`);
}

const managedUnits = managedDeployments.map(({ manifest }) => manifest.systemdUnit);
const desiredUnits = new Set(managedUnits);
const desiredById = new Map(managedDeployments.map((deployment) => [deployment.manifest.id, deployment]));
const retirements = new Map(previous.retiringUnits.map((retirement) => [retirement.systemdUnit, retirement]));
for (const systemdUnit of previous.managedUnits) {
  if (!desiredUnits.has(systemdUnit) && !retirements.has(systemdUnit)) {
    const retirement = { systemdUnit, phase: 'pending' };
    const previousDeploymentId = previous.deploymentIdsByUnit.get(systemdUnit);
    const replacementUnit = previousDeploymentId
      ? desiredById.get(previousDeploymentId)?.manifest.systemdUnit
      : undefined;
    if (replacementUnit && replacementUnit !== systemdUnit) retirement.replacementUnit = replacementUnit;
    retirements.set(systemdUnit, retirement);
  }
}
for (const systemdUnit of desiredUnits) retirements.delete(systemdUnit);
const registry = {
  version: 2,
  deployments: deployments.map(({ manifest, provenance }) => ({ manifest, provenance })),
  managedUnits,
  retiringUnits: [...retirements.values()],
};
await writeFile(options.registry, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
const indexText = `${deploymentIndex.join('\n')}\n`;
if (options.output) await writeFile(options.output, indexText);
else process.stdout.write(indexText);

async function loadPreviousRegistry(path, previousIndex, requireRunner) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { deployments: [], managedUnits: [], retiringUnits: [], deploymentIdsByUnit: new Map() };
    }
    throw error;
  }
  if (value.version === 1) {
    if (!Array.isArray(value.manifests) || !value.manifests.every((manifestPath) => isSafeAbsolutePath(manifestPath))) {
      fail(`Invalid existing deployment registry: ${path}`);
    }
    const deployments = await Promise.all(value.manifests.map((manifestPath) => loadManifest(manifestPath, {
      requireRunner,
      needsBuild: requireRunner,
    })));
    validateUnique(deployments.map(({ manifest }) => manifest), 'id', 'deployment ID');
    validateUnique(deployments.map(({ manifest }) => manifest), 'systemdUnit', 'systemd unit');
    const managedDeployments = deployments.filter(({ manifest }) => manifest.kind === 'managed');
    const legacyManagedUnits = await loadLegacyManagedUnits(previousIndex);
    if (legacyManagedUnits !== null && legacyManagedUnits.length !== managedDeployments.length) {
      fail(`Legacy deployment index does not match the v1 registry: ${previousIndex}`);
    }
    const managedUnits = legacyManagedUnits
      ?? managedDeployments.map(({ manifest }) => manifest.systemdUnit);
    return {
      deployments,
      managedUnits,
      retiringUnits: [],
      deploymentIdsByUnit: new Map(managedUnits.map((unit, index) => [unit, managedDeployments[index].manifest.id])),
    };
  }
  if (value.version !== 2 || !Array.isArray(value.deployments)
    || !Array.isArray(value.managedUnits) || !value.managedUnits.every(isManagedUnit)
    || !Array.isArray(value.retiringUnits) || !value.retiringUnits.every(isRetirement)) {
    fail(`Invalid existing deployment registry: ${path}`);
  }
  const deployments = value.deployments.map((deployment) => loadSnapshot(deployment, path));
  validateUnique(deployments.map(({ manifest }) => manifest), 'id', 'deployment ID');
  validateUnique(deployments.map(({ manifest }) => manifest), 'systemdUnit', 'systemd unit');
  const snapshotManagedUnits = deployments.filter(({ manifest }) => manifest.kind === 'managed')
    .map(({ manifest }) => manifest.systemdUnit);
  const retiringUnits = value.retiringUnits.map(({ systemdUnit }) => systemdUnit);
  if (new Set(value.managedUnits).size !== value.managedUnits.length
    || new Set(retiringUnits).size !== retiringUnits.length
    || snapshotManagedUnits.length !== value.managedUnits.length
    || snapshotManagedUnits.some((unit) => !value.managedUnits.includes(unit))
    || retiringUnits.some((unit) => value.managedUnits.includes(unit))) {
    fail(`Invalid existing deployment registry: ${path}`);
  }
  return {
    deployments,
    managedUnits: value.managedUnits,
    retiringUnits: value.retiringUnits,
    deploymentIdsByUnit: new Map(deployments
      .filter(({ manifest }) => manifest.kind === 'managed')
      .map(({ manifest }) => [manifest.systemdUnit, manifest.id])),
  };
}

async function loadLegacyManagedUnits(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const units = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const columns = line.split('\t');
    if (columns.length !== 2 || !isManagedUnit(columns[0]) || /[\n\r\0]/.test(columns[1])) {
      fail(`Invalid legacy deployment index: ${path}`);
    }
    if (columns[1]) validateHealthUrl(columns[0], 'managed', columns[1]);
    units.push(columns[0]);
  }
  if (new Set(units).size !== units.length) fail(`Invalid legacy deployment index: ${path}`);
  return units;
}

async function loadManifest(inputPath, { provenancePath = inputPath, requireRunner, needsBuild }) {
  if (!isAbsolute(inputPath)) fail(`Manifest path must be absolute: ${inputPath}`);
  const path = await realpath(inputPath);
  const provenance = await realpath(provenancePath);
  const value = JSON.parse(await readFile(path, 'utf8'));
  return hydrateManifest(value, provenance, { requireRunner, needsBuild });
}

function loadSnapshot(value, registryPath) {
  if (typeof value !== 'object' || value === null || typeof value.provenance !== 'object'
    || value.provenance === null || !isSafeAbsolutePath(value.provenance.manifestPath)) {
    fail(`Invalid deployment snapshot in ${registryPath}`);
  }
  return hydrateManifest(value.manifest, value.provenance.manifestPath, { requireRunner: false, needsBuild: false });
}

function hydrateManifest(value, provenancePath, { requireRunner, needsBuild }) {
  if (typeof value !== 'object' || value === null) fail(`Invalid deployment manifest: ${provenancePath}`);
  const root = dirname(provenancePath);
  if (/\s/.test(root)) fail(`Deployment project paths may not contain whitespace: ${root}`);
  if (value.version !== 1 || !ID_PATTERN.test(value.id ?? '') || typeof value.name !== 'string' || !value.name.trim()
    || !['managed', 'self'].includes(value.kind) || typeof value.systemdUnit !== 'string'
    || !Array.isArray(value.actions) || !value.actions.every((action) => ACTIONS.has(action))) {
    fail(`Invalid deployment manifest: ${provenancePath}`);
  }
  if (value.kind === 'self') {
    if (value.systemdUnit !== 'jarvis.service' || value.actions.length !== 1 || value.actions[0] !== 'restart') {
      fail(`Self deployment ${value.id} must use jarvis.service and may only allow restart`);
    }
    return { manifest: value, provenance: { manifestPath: provenancePath }, root, needsBuild };
  }
  if (!isManagedUnit(value.systemdUnit)) fail(`Managed deployment ${value.id} uses a reserved or invalid unit`);
  if (typeof value.runner !== 'string' || !value.runner) fail(`Managed deployment ${value.id} requires a runner`);
  const runnerPath = resolveContained(root, value.runner, `Runner for ${value.id}`);
  if (requireRunner) requireExecutable(runnerPath);
  if (value.build !== undefined && (!Array.isArray(value.build) || value.build.length === 0 || !value.build.every((argument) => typeof argument === 'string' && argument))) {
    fail(`Build for ${value.id} must be a non-empty argv array`);
  }
  if (value.healthUrl !== undefined) validateHealthUrl(value.id, value.kind, value.healthUrl);
  return { manifest: value, provenance: { manifestPath: provenancePath }, root, runnerPath, needsBuild };
}

function parseArguments(arguments_) {
  const values = { manifests: [], build: false };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--build') values.build = true;
    else if (argument === '--build-path') values.buildPath = arguments_[++index];
    else if (argument === '--registry') values.registry = arguments_[++index];
    else if (argument === '--systemd-dir') values.systemdDir = arguments_[++index];
    else if (argument === '--template') values.template = arguments_[++index];
    else if (argument === '--output') values.output = arguments_[++index];
    else if (argument === '--previous-registry') values.previousRegistry = arguments_[++index];
    else if (argument === '--previous-index') values.previousIndex = arguments_[++index];
    else if (argument === '--selection') values.selection = arguments_[++index];
    else if (argument === '--self-manifest') values.selfManifest = arguments_[++index];
    else if (argument === '--self-provenance') values.selfProvenance = arguments_[++index];
    else if (argument.startsWith('--')) fail(`Unknown option: ${argument}`);
    else values.manifests.push(argument);
  }
  if (!values.registry || !values.systemdDir || !values.template || !values.previousRegistry || !values.previousIndex
    || !values.selfManifest || !values.selfProvenance || !['preserve', 'replace'].includes(values.selection)) {
    fail('Usage: reconcile-deployments [--build --build-path PATH] [--output PATH] --registry PATH --systemd-dir PATH --template PATH --previous-registry PATH --previous-index PATH --selection preserve|replace --self-manifest PATH --self-provenance PATH [MANAGED_MANIFEST...]');
  }
  if (values.build && !isSafeExecutablePath(values.buildPath)) {
    fail('--build-path must contain only non-empty absolute directory entries');
  }
  if (!values.build && values.buildPath !== undefined) fail('--build-path requires --build');
  if (values.selection === 'preserve' && values.manifests.length > 0) fail('Preserve selection may not include managed manifests');
  return values;
}

function resolveContained(root, path, label) {
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) fail(`${label} must stay inside its project`);
  return resolved;
}

function validateHealthUrl(id, kind, value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || (kind === 'managed' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    fail(`Health URL for ${id} must use loopback HTTP`);
  }
}

function validateUnique(manifests, field, label) {
  if (new Set(manifests.map((manifest) => manifest[field])).size !== manifests.length) fail(`Each ${label} must be unique`);
}

function runBuild(deployment, buildPath) {
  const { manifest } = deployment;
  const result = spawnSync(manifest.build[0], manifest.build.slice(1), {
    cwd: deployment.root,
    env: { ...process.env, PATH: buildPath },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Build failed for ${manifest.name}`);
}

function requireExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    fail(`Runner is not executable: ${path}: ${error.message}`);
  }
}

function isRetirement(value) {
  return typeof value === 'object' && value !== null && isManagedUnit(value.systemdUnit)
    && ['pending', 'disabled'].includes(value.phase)
    && (value.wasActive === undefined || typeof value.wasActive === 'boolean')
    && (value.replacementUnit === undefined
      || (isManagedUnit(value.replacementUnit) && value.replacementUnit !== value.systemdUnit));
}

function isManagedUnit(value) {
  return typeof value === 'string' && MANAGED_UNIT_PATTERN.test(value) && !RESERVED_CORE_UNITS.has(value);
}

function isSafeAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && !/[\n\r\0\t]/.test(value);
}

function isSafeExecutablePath(value) {
  return typeof value === 'string' && value.length > 0
    && value.split(delimiter).every((entry) => isSafeAbsolutePath(entry));
}

function escapeUnitValue(value) {
  if (/[\n\r\0]/.test(value)) fail('Systemd values may not contain control characters');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function fail(message) { console.error(`ERROR: ${message}`); process.exit(1); }
