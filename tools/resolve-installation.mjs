#!/usr/bin/env node
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

const CONFIG_KEYS = new Set([
  'JARVIS_ALLOW_INSECURE_NETWORK',
  'JARVIS_DEPLOYMENT_REGISTRY',
  'JARVIS_HOST',
  'JARVIS_PORT',
]);
const MANAGED_UNIT_PATTERN = /^jarvis-[a-z0-9]+(?:-[a-z0-9]+)*\.service$/;
const RESERVED_CORE_UNITS = new Set(['jarvis.service', 'jarvis-terminal-host.service']);
let temporaryFileCounter = 0;

try {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === 'resolve') await resolveInstallation(arguments_);
  else if (command === 'write') await writeInstallation(arguments_);
  else if (command === 'registry') await resolveRegistry(arguments_);
  else if (command === 'publish') await publishInstallation(arguments_);
  else if (command === 'recover') await recoverPublicationCommand(arguments_);
  else if (command === 'inventory') await emitInventory(arguments_);
  else if (command === 'retirement') await updateRetirement(arguments_);
  else fail('Usage: resolve-installation.mjs resolve|write|registry|publish|recover|inventory|retirement [OPTIONS]');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function resolveInstallation(arguments_) {
  const options = parseOptions(arguments_, new Set([
    '--default-registry', '--manifest', '--operator-env', '--previous-effective-env', '--selection',
  ]), new Set(['--manifest']));
  requireOptions(options, ['--default-registry', '--operator-env', '--previous-effective-env', '--selection']);
  if (!['preserve', 'replace'].includes(options['--selection'])) {
    throw new Error('--selection must be preserve or replace');
  }

  const environment = await parseEnvironmentFile(options['--operator-env']);
  const previousEnvironment = await parseEnvironmentFile(options['--previous-effective-env']);
  const host = effectiveValue('JARVIS_HOST', environment, previousEnvironment, '127.0.0.1');
  const port = validatePort(effectiveValue('JARVIS_PORT', environment, previousEnvironment, '3210'));
  const registry = effectiveValue('JARVIS_DEPLOYMENT_REGISTRY', environment, previousEnvironment, options['--default-registry']);
  const allowInsecure = effectiveValue('JARVIS_ALLOW_INSECURE_NETWORK', environment, previousEnvironment, 'false');
  validateConfiguration(host, registry, allowInsecure);
  const healthUrl = makeHealthUrl(host, port);
  const previousRegistry = await locatePreviousRegistry(
    previousEnvironment.get('JARVIS_DEPLOYMENT_REGISTRY'), registry, options['--default-registry'],
  );
  const manifests = options['--selection'] === 'replace'
    ? await validateManagedManifests(options['--manifest'] ?? [])
    : [];

  emit('HOST', host);
  emit('PORT', String(port));
  emit('REGISTRY', registry);
  emit('PREVIOUS_REGISTRY', previousRegistry);
  emit('HEALTH_URL', healthUrl);
  emit('ALLOW_INSECURE', allowInsecure === 'true' ? 'true' : 'false');
  for (const manifest of manifests) emit('MANIFEST', manifest);
}

async function writeInstallation(arguments_) {
  const options = parseOptions(arguments_, new Set([
    '--allow-insecure', '--effective-env', '--health-url', '--host', '--port', '--registry',
    '--self-output', '--self-template',
  ]));
  requireOptions(options, [
    '--allow-insecure', '--effective-env', '--health-url', '--host', '--port', '--registry',
    '--self-output', '--self-template',
  ]);
  const port = validatePort(options['--port']);
  validateConfiguration(options['--host'], options['--registry'], options['--allow-insecure']);
  if (options['--health-url'] !== makeHealthUrl(options['--host'], port)) {
    throw new Error('Health URL does not match the effective host and port');
  }

  const selfManifest = JSON.parse(await readFile(options['--self-template'], 'utf8'));
  if (selfManifest.version !== 1 || selfManifest.kind !== 'self') {
    throw new Error(`Invalid self deployment manifest: ${options['--self-template']}`);
  }
  const effectiveEnvironment = [
    `JARVIS_HOST=${quoteEnvironmentValue(options['--host'])}`,
    `JARVIS_PORT=${quoteEnvironmentValue(String(port))}`,
    `JARVIS_DEPLOYMENT_REGISTRY=${quoteEnvironmentValue(options['--registry'])}`,
    `JARVIS_ALLOW_INSECURE_NETWORK=${quoteEnvironmentValue(options['--allow-insecure'])}`,
    '',
  ].join('\n');
  await writeFile(options['--effective-env'], effectiveEnvironment, { mode: 0o600 });
  await chmod(options['--effective-env'], 0o600);
  await writeFile(options['--self-output'], `${JSON.stringify({
    ...selfManifest,
    healthUrl: options['--health-url'],
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(options['--self-output'], 0o600);
}

async function resolveRegistry(arguments_) {
  const options = parseOptions(arguments_, new Set([
    '--default-registry', '--operator-env', '--previous-effective-env',
  ]));
  requireOptions(options, ['--default-registry', '--operator-env', '--previous-effective-env']);
  const previousEnvironment = await parseEnvironmentFile(options['--previous-effective-env']);
  const installedRegistry = previousEnvironment.get('JARVIS_DEPLOYMENT_REGISTRY');
  let registry = installedRegistry;
  if (!registry) {
    const environment = await parseEnvironmentFile(options['--operator-env']);
    registry = process.env.JARVIS_DEPLOYMENT_REGISTRY
      || environment.get('JARVIS_DEPLOYMENT_REGISTRY') || options['--default-registry'];
  }
  if (!isSafeAbsolutePath(registry)) {
    throw new Error('JARVIS_DEPLOYMENT_REGISTRY must be an absolute path without control characters');
  }
  emit('REGISTRY', registry);
}

async function publishInstallation(arguments_) {
  const { recoveryFile, entries } = parsePublicationArguments(arguments_);
  const recoveryPaths = await canonicalRecoveryPaths(recoveryFile);
  await validateRecoveryContainers(recoveryFile);
  await validatePublicationEntries(entries, recoveryPaths);
  await recoverPublication(recoveryFile);

  const recoveryDirectory = `${recoveryFile}.d`;
  await rm(recoveryDirectory, { recursive: true, force: true });
  await mkdir(recoveryDirectory, { recursive: true });
  const journalEntries = [];
  for (const [index, entry] of entries.entries()) {
    let backup = null;
    try {
      const destinationStat = await lstat(entry.destination);
      backup = join(recoveryDirectory, String(index));
      await copyFile(entry.destination, backup);
      await chmod(backup, destinationStat.mode & 0o777);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    journalEntries.push({ destination: entry.destination, backup });
  }
  await writeJsonAtomically(recoveryFile, { version: 1, entries: journalEntries });
  try {
    for (const entry of entries) await copyFileAtomically(entry.source, entry.destination);
  } catch (error) {
    await recoverPublication(recoveryFile);
    throw error;
  }
  await rm(recoveryFile, { force: true });
  await rm(recoveryDirectory, { recursive: true, force: true });
}

async function recoverPublicationCommand(arguments_) {
  const options = parseOptions(arguments_, new Set(['--recovery-file']));
  requireOptions(options, ['--recovery-file']);
  await recoverPublication(options['--recovery-file']);
}

async function recoverPublication(recoveryFile) {
  let journal;
  try {
    journal = JSON.parse(await readFile(recoveryFile, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const recoveryDirectory = `${recoveryFile}.d`;
  if (journal.version !== 1 || !Array.isArray(journal.entries)
    || !journal.entries.every((entry, index) => (
      typeof entry === 'object' && entry !== null && isSafeAbsolutePath(entry.destination)
      && (entry.backup === null || entry.backup === join(recoveryDirectory, String(index)))
    ))) {
    throw new Error(`Invalid installation recovery metadata: ${recoveryFile}`);
  }
  const recoveryPaths = await canonicalRecoveryPaths(recoveryFile);
  await validateRecoveryContainers(recoveryFile);
  const destinations = [];
  for (const entry of journal.entries) {
    const destination = await canonicalizePotentialPath(entry.destination);
    rejectRecoveryOverlap(destination, recoveryPaths);
    rejectDestinationOverlap(destination, destinations);
    destinations.push(destination);
    if (entry.backup !== null) {
      const backupStat = await lstat(entry.backup);
      if (!backupStat.isFile()) throw new Error(`Publication backup must be a regular file: ${entry.backup}`);
    }
  }
  for (const entry of [...journal.entries].reverse()) {
    if (entry.backup === null) await rm(entry.destination, { force: true });
    else await copyFileAtomically(entry.backup, entry.destination);
  }
  await rm(recoveryFile, { force: true });
  await rm(recoveryDirectory, { recursive: true, force: true });
}

async function validatePublicationEntries(entries, recoveryPaths) {
  const destinations = [];
  for (const { source, destination } of entries) {
    if (!isSafeAbsolutePath(source) || !isSafeAbsolutePath(destination)) {
      throw new Error('Publication paths must be absolute paths without control characters');
    }
    const canonicalSource = await canonicalizePotentialPath(source);
    const canonicalDestination = await canonicalizePotentialPath(destination);
    if (pathsOverlap(canonicalSource, canonicalDestination)) {
      throw new Error(`Publication source and destination must differ: ${source}`);
    }
    rejectRecoveryOverlap(canonicalDestination, recoveryPaths);
    rejectDestinationOverlap(canonicalDestination, destinations);
    destinations.push(canonicalDestination);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) throw new Error(`Publication source must be a regular file: ${source}`);
    try {
      const destinationStat = await lstat(destination);
      if (!destinationStat.isFile()) throw new Error(`Publication destination must be a regular file: ${destination}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function canonicalRecoveryPaths(recoveryFile) {
  return {
    file: await canonicalizePotentialPath(recoveryFile),
    directory: await canonicalizePotentialPath(`${recoveryFile}.d`),
  };
}

async function validateRecoveryContainers(recoveryFile) {
  for (const [path, type] of [[recoveryFile, 'file'], [`${recoveryFile}.d`, 'directory']]) {
    try {
      const pathStat = await lstat(path);
      if ((type === 'file' && !pathStat.isFile()) || (type === 'directory' && !pathStat.isDirectory())) {
        throw new Error(`Publication recovery ${type} has an invalid type: ${path}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

async function canonicalizePotentialPath(path) {
  let existingPath = path;
  const missingSegments = [];
  while (true) {
    try {
      const canonical = await realpath(existingPath);
      return join(canonical, ...missingSegments);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      const parent = dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.unshift(basename(existingPath));
      existingPath = parent;
    }
  }
}

function rejectRecoveryOverlap(destination, recoveryPaths) {
  if (pathsOverlap(destination, recoveryPaths.file) || pathsOverlap(destination, recoveryPaths.directory)) {
    throw new Error(`Publication destination overlaps recovery state: ${destination}`);
  }
}

function rejectDestinationOverlap(destination, destinations) {
  if (destinations.some((existing) => pathsOverlap(destination, existing))) {
    throw new Error(`Publication destinations overlap: ${destination}`);
  }
}

function pathsOverlap(left, right) {
  return isContainedPath(relative(left, right)) || isContainedPath(relative(right, left));
}

function isContainedPath(path) {
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

async function emitInventory(arguments_) {
  const options = parseOptions(arguments_, new Set(['--legacy-index', '--registry']));
  requireOptions(options, ['--registry']);
  let registry;
  try {
    registry = JSON.parse(await readFile(options['--registry'], 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (registry.version === 1) {
    if (!Array.isArray(registry.manifests) || !registry.manifests.every(isSafeAbsolutePath)) {
      throw new Error(`Invalid existing deployment registry: ${options['--registry']}`);
    }
    const legacyManagedUnits = options['--legacy-index'] === undefined
      ? null
      : await loadLegacyManagedUnits(options['--legacy-index']);
    if (legacyManagedUnits !== null) {
      for (const unit of legacyManagedUnits) emit('MANAGED', unit);
      return;
    }
    for (const manifestPath of registry.manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (manifest.kind === 'managed') {
        validateManagedUnit(manifest.systemdUnit);
        emit('MANAGED', manifest.systemdUnit);
      }
    }
    return;
  }
  const installed = parseInstalledInventory(registry, options['--registry']);
  for (const unit of installed.managedUnits) emit('MANAGED', unit);
  for (const retirement of installed.retiringUnits) {
    emit(
      'RETIRING',
      retirement.systemdUnit,
      retirement.phase,
      retirement.wasActive === undefined ? 'unknown' : String(retirement.wasActive),
      retirement.replacementUnit ?? '-',
    );
  }
}

async function loadLegacyManagedUnits(path) {
  if (!isSafeAbsolutePath(path)) throw new Error(`Invalid legacy deployment index: ${path}`);
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
    if (columns.length !== 2 || !isManagedUnit(columns[0]) || !isLegacyHealthUrl(columns[1])) {
      throw new Error(`Invalid legacy deployment index: ${path}`);
    }
    units.push(columns[0]);
  }
  if (new Set(units).size !== units.length) {
    throw new Error(`Invalid legacy deployment index: ${path}`);
  }
  return units;
}

function isLegacyHealthUrl(value) {
  if (value === '') return true;
  if (/[\n\r\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

async function updateRetirement(arguments_) {
  const options = parseOptions(arguments_, new Set(['--phase', '--registry', '--unit', '--was-active']));
  requireOptions(options, ['--phase', '--registry', '--unit']);
  if (!['pending', 'disabled', 'complete'].includes(options['--phase'])) {
    throw new Error('--phase must be pending, disabled, or complete');
  }
  if (options['--was-active'] !== undefined && !['true', 'false'].includes(options['--was-active'])) {
    throw new Error('--was-active must be true or false');
  }
  validateManagedUnit(options['--unit']);
  const registry = JSON.parse(await readFile(options['--registry'], 'utf8'));
  parseInstalledInventory(registry, options['--registry']);
  const retirement = registry.retiringUnits.find(({ systemdUnit }) => systemdUnit === options['--unit']);
  if (!retirement) throw new Error(`Unit is not pending retirement: ${options['--unit']}`);
  if (options['--phase'] === 'complete') {
    registry.retiringUnits = registry.retiringUnits.filter(({ systemdUnit }) => systemdUnit !== options['--unit']);
  } else {
    retirement.phase = options['--phase'];
    if (options['--was-active'] !== undefined) retirement.wasActive = options['--was-active'] === 'true';
  }
  await writeJsonAtomically(options['--registry'], registry);
}

async function locatePreviousRegistry(configuredPreviousRegistry, registry, defaultRegistry) {
  const candidates = [...new Set([configuredPreviousRegistry, registry, defaultRegistry].filter(Boolean))];
  for (const candidate of candidates) {
    if (!isSafeAbsolutePath(candidate)) {
      throw new Error('Previous deployment registry must be an absolute path without control characters');
    }
  }
  for (const candidate of candidates) {
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isFile()) throw new Error(`Deployment registry must be a regular file: ${candidate}`);
      return candidate;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return configuredPreviousRegistry || registry;
}

function parsePublicationArguments(arguments_) {
  let recoveryFile;
  const entries = [];
  for (let index = 0; index < arguments_.length; index++) {
    const option = arguments_[index];
    if (option === '--recovery-file') {
      if (recoveryFile !== undefined) throw new Error('Option may only be specified once: --recovery-file');
      recoveryFile = arguments_[++index];
      if (recoveryFile === undefined) throw new Error('Missing value for --recovery-file');
    } else if (option === '--entry') {
      const source = arguments_[++index];
      const destination = arguments_[++index];
      if (source === undefined || destination === undefined) throw new Error('--entry requires source and destination paths');
      entries.push({ source, destination });
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!recoveryFile) throw new Error('Missing required option: --recovery-file');
  if (!isSafeAbsolutePath(recoveryFile)) throw new Error('Recovery path must be an absolute path without control characters');
  if (entries.length === 0) throw new Error('At least one publication entry is required');
  return { recoveryFile, entries };
}

function parseInstalledInventory(registry, path) {
  if (registry.version !== 2 || !Array.isArray(registry.deployments)
    || !registry.deployments.every((deployment) => (
      typeof deployment === 'object' && deployment !== null
      && typeof deployment.manifest === 'object' && deployment.manifest !== null
      && typeof deployment.provenance === 'object' && deployment.provenance !== null
      && isSafeAbsolutePath(deployment.provenance.manifestPath)
    ))
    || !Array.isArray(registry.managedUnits) || !registry.managedUnits.every(isManagedUnit)
    || !Array.isArray(registry.retiringUnits) || !registry.retiringUnits.every((retirement) => (
      typeof retirement === 'object' && retirement !== null && isManagedUnit(retirement.systemdUnit)
      && ['pending', 'disabled'].includes(retirement.phase)
      && (retirement.wasActive === undefined || typeof retirement.wasActive === 'boolean')
      && (retirement.replacementUnit === undefined
        || (isManagedUnit(retirement.replacementUnit) && retirement.replacementUnit !== retirement.systemdUnit))
    ))) {
    throw new Error(`Invalid installed deployment registry: ${path}`);
  }
  const snapshotManagedUnits = registry.deployments
    .filter(({ manifest }) => manifest.kind === 'managed')
    .map(({ manifest }) => manifest.systemdUnit);
  const retirementUnits = registry.retiringUnits.map(({ systemdUnit }) => systemdUnit);
  if (new Set(registry.managedUnits).size !== registry.managedUnits.length
    || new Set(retirementUnits).size !== retirementUnits.length
    || snapshotManagedUnits.length !== registry.managedUnits.length
    || snapshotManagedUnits.some((unit) => !registry.managedUnits.includes(unit))
    || retirementUnits.some((unit) => registry.managedUnits.includes(unit))) {
    throw new Error(`Invalid installed deployment registry: ${path}`);
  }
  return registry;
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.jarvis-new-${process.pid}-${temporaryFileCounter++}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function copyFileAtomically(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.jarvis-new-${process.pid}-${temporaryFileCounter++}`;
  try {
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) throw new Error(`Publication source must be a regular file: ${source}`);
    await copyFile(source, temporaryPath);
    await chmod(temporaryPath, sourceStat.mode & 0o777);
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isManagedUnit(value) {
  return typeof value === 'string' && MANAGED_UNIT_PATTERN.test(value) && !RESERVED_CORE_UNITS.has(value);
}

function validateManagedUnit(value) {
  if (!isManagedUnit(value)) throw new Error(`Invalid or reserved managed systemd unit: ${value}`);
}

function isSafeAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && !/[\n\r\0\t]/.test(value);
}

async function parseEnvironmentFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }

  const values = new Map();
  for (const [index, sourceLine] of text.split('\n').entries()) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!assignment) {
      for (const key of CONFIG_KEYS) {
        if (new RegExp(`(?:^|\\s)${key}\\s*=`).test(line)) {
          throw new Error(`Unsupported ${key} assignment at ${path}:${index + 1}`);
        }
      }
      continue;
    }
    const [, key, rawValue] = assignment;
    if (CONFIG_KEYS.has(key)) values.set(key, parseEnvironmentValue(rawValue, key, path, index + 1));
  }
  return values;
}

function parseEnvironmentValue(rawValue, key, path, lineNumber) {
  const value = rawValue.trim();
  if (!value) return '';
  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.length < 2 || value.at(-1) !== quote) unsupportedAssignment(key, path, lineNumber);
    const inner = value.slice(1, -1);
    if (quote === "'") {
      if (inner.includes("'")) unsupportedAssignment(key, path, lineNumber);
      return inner;
    }
    return decodeEscapes(inner, key, path, lineNumber, true);
  }
  if (value.includes("'") || value.includes('"')) unsupportedAssignment(key, path, lineNumber);
  return decodeEscapes(value, key, path, lineNumber, false);
}

function decodeEscapes(value, key, path, lineNumber, quoted) {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '"' && quoted) unsupportedAssignment(key, path, lineNumber);
    if (character !== '\\') {
      result += character;
      continue;
    }
    if (index + 1 >= value.length) unsupportedAssignment(key, path, lineNumber);
    const escaped = value[++index];
    if (quoted && !['"', '\\', '$', '`'].includes(escaped)) result += '\\';
    result += escaped;
  }
  return result;
}

function effectiveValue(key, environment, previousEnvironment, fallback) {
  const value = process.env[key] !== undefined
    ? process.env[key]
    : (environment.has(key) ? environment.get(key) : previousEnvironment.get(key));
  return value === undefined || value === '' ? fallback : value;
}

function validateConfiguration(host, registry, allowInsecure) {
  if (!host || /[\s/\0]/.test(host) || (!isIP(host) && host !== 'localhost' && !isHostname(host))) {
    throw new Error('JARVIS_HOST must be an IP address or hostname');
  }
  if (!['true', 'false', ''].includes(allowInsecure)) {
    throw new Error('JARVIS_ALLOW_INSECURE_NETWORK must be true or false');
  }
  if (!isLoopbackHost(host) && allowInsecure !== 'true') {
    throw new Error('JARVIS_HOST must remain loopback unless JARVIS_ALLOW_INSECURE_NETWORK=true');
  }
  if (!isAbsolute(registry) || /[\n\r\0\t]/.test(registry)) {
    throw new Error('JARVIS_DEPLOYMENT_REGISTRY must be an absolute path without control characters');
  }
}

function validatePort(value) {
  if (!/^\d+$/.test(value)) throw new Error('JARVIS_PORT must be an integer from 1 through 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('JARVIS_PORT must be an integer from 1 through 65535');
  }
  return port;
}

function makeHealthUrl(host, port) {
  let probeHost = host;
  if (host === '0.0.0.0') probeHost = '127.0.0.1';
  else if (host === '::') probeHost = '::1';
  if (isIP(probeHost) === 6) probeHost = `[${probeHost}]`;
  return `http://${probeHost}:${port}/api/health`;
}

async function validateManagedManifests(manifests) {
  const resolved = [];
  for (const manifestPath of manifests) {
    if (!isAbsolute(manifestPath)) throw new Error(`Manifest path must be absolute: ${manifestPath}`);
    const path = await realpath(manifestPath);
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.kind !== 'managed') throw new Error(`Optional deployment manifest must be managed: ${path}`);
    resolved.push(path);
  }
  return resolved;
}

function parseOptions(arguments_, allowed, repeated = new Set()) {
  const options = {};
  for (let index = 0; index < arguments_.length; index++) {
    const option = arguments_[index];
    if (!allowed.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = arguments_[++index];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (repeated.has(option)) (options[option] ??= []).push(value);
    else if (options[option] !== undefined) throw new Error(`Option may only be specified once: ${option}`);
    else options[option] = value;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (options[name] === undefined) throw new Error(`Missing required option: ${name}`);
  }
}

function quoteEnvironmentValue(value) {
  if (/[\n\r\0]/.test(value)) throw new Error('Environment values may not contain control characters');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isHostname(host) {
  return host.length <= 253 && host.split('.').every((label) => (
    label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function unsupportedAssignment(key, path, lineNumber) {
  throw new Error(`Unsupported ${key} assignment at ${path}:${lineNumber}`);
}

function emit(key, ...values) {
  if (values.some((value) => /[\n\r\0\t]/.test(value))) throw new Error(`${key} may not contain control characters`);
  process.stdout.write(`${[key, ...values].join('\t')}\n`);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}
