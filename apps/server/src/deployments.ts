import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const STATUS_EXEC_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };
export const DEFAULT_DEPLOYMENT_ACTION_TIMEOUT_MS = 45_000;
const UNIT_PATTERN = /^jarvis(?:-[a-z0-9-]+)?\.service$/;
const MANAGED_UNIT_PATTERN = /^jarvis-[a-z0-9]+(?:-[a-z0-9]+)*\.service$/;
const RESERVED_CORE_UNITS = new Set(['jarvis.service', 'jarvis-terminal-host.service']);
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DeploymentAction = 'start' | 'stop' | 'restart';
export type DeploymentState = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unavailable';

export interface DeploymentManifest {
  version: 1;
  id: string;
  name: string;
  kind: 'managed' | 'self';
  systemdUnit: string;
  runner?: string;
  build?: string[];
  healthUrl?: string;
  actions: DeploymentAction[];
  homeUrl?: string;
  warning?: string;
}

export interface DeploymentStatus {
  id: string;
  name: string;
  kind: DeploymentManifest['kind'];
  state: DeploymentState;
  enabled: boolean;
  healthy: boolean | null;
  actions: DeploymentAction[];
  warning?: string;
  detail?: string;
}

interface DeploymentRegistryV1 { version: 1; manifests: string[] }
interface InstalledDeployment {
  manifest: DeploymentManifest;
  provenance: { manifestPath: string };
}
interface DeploymentRegistryV2 {
  version: 2;
  deployments: InstalledDeployment[];
  managedUnits: string[];
  retiringUnits: Array<{ systemdUnit: string; phase: 'pending' | 'disabled' }>;
}
type DeploymentRegistry = DeploymentRegistryV1 | DeploymentRegistryV2;

export class DeploymentError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class DeploymentManager {
  constructor(
    private readonly registryFile: string,
    private readonly systemctlExecutable = 'systemctl',
    private readonly systemdRunExecutable = 'systemd-run',
    private readonly tailscaleExecutable = 'tailscale',
    private readonly actionTimeoutMs = DEFAULT_DEPLOYMENT_ACTION_TIMEOUT_MS,
  ) {}

  async list(): Promise<DeploymentStatus[]> {
    const manifests = await this.loadManifests();
    const homeUrls = await this.homeUrls();
    return Promise.all(manifests.map((manifest) => this.status(manifest, homeUrls)));
  }

  async act(id: string, action: DeploymentAction): Promise<{ accepted: true; scheduled: boolean }> {
    const manifest = (await this.loadManifests()).find((candidate) => candidate.id === id);
    if (!manifest) throw new DeploymentError('Deployment not found', 404);
    if (!manifest.actions.includes(action)) throw new DeploymentError(`Action ${action} is not allowed for ${manifest.name}`, 409);
    if (manifest.kind === 'self') {
      if (action !== 'restart') throw new DeploymentError('Jarvis can only be restarted', 409);
      const transientUnit = `jarvis-self-restart-${Date.now()}`;
      await execFileAsync(this.systemdRunExecutable, [
        '--user', `--unit=${transientUnit}`, '--on-active=1s',
        this.systemctlExecutable, '--user', 'restart', manifest.systemdUnit,
      ], STATUS_EXEC_OPTIONS);
      return { accepted: true, scheduled: true };
    }
    try {
      await execFileAsync(this.systemctlExecutable, ['--user', action, manifest.systemdUnit], {
        ...STATUS_EXEC_OPTIONS,
        timeout: this.actionTimeoutMs,
      });
    } catch (error) {
      if (isCommandTimeout(error)) {
        throw new DeploymentError(`Managed action ${action} for ${manifest.name} timed out after ${this.actionTimeoutMs} ms`, 504);
      }
      throw error;
    }
    return { accepted: true, scheduled: false };
  }

  private async status(manifest: DeploymentManifest, homeUrls: Map<number, string>): Promise<DeploymentStatus> {
    const homeUrl = manifest.healthUrl ? homeUrls.get(Number(new URL(manifest.healthUrl).port)) : undefined;
    try {
      const { stdout } = await execFileAsync(this.systemctlExecutable, [
        '--user', 'show', manifest.systemdUnit, '--no-pager',
        '--property=LoadState,ActiveState,SubState,UnitFileState',
      ], STATUS_EXEC_OPTIONS);
      const properties = parseProperties(stdout);
      const state = deploymentState(properties.LoadState, properties.ActiveState);
      const healthy = state === 'running' && manifest.healthUrl ? await probe(manifest.healthUrl) : null;
      return { id: manifest.id, name: manifest.name, kind: manifest.kind, state,
        enabled: properties.UnitFileState === 'enabled', healthy, actions: [...manifest.actions],
        ...(homeUrl ? { homeUrl } : {}),
        ...(manifest.warning ? { warning: manifest.warning } : {}) };
    } catch (error) {
      return { id: manifest.id, name: manifest.name, kind: manifest.kind, state: 'unavailable',
        enabled: false, healthy: null, actions: [...manifest.actions],
        ...(homeUrl ? { homeUrl } : {}),
        ...(manifest.warning ? { warning: manifest.warning } : {}), detail: errorMessage(error) };
    }
  }

  private async homeUrls(): Promise<Map<number, string>> {
    try {
      const { stdout } = await execFileAsync(this.tailscaleExecutable, ['serve', 'status', '--json'], STATUS_EXEC_OPTIONS);
      return parseServeHomeUrls(stdout);
    } catch { return new Map(); }
  }

  private async loadManifests(): Promise<DeploymentManifest[]> {
    let registryText: string;
    try { registryText = await readFile(this.registryFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const registry = parseRegistry(registryText);
    const manifests = registry.version === 1
      ? await Promise.all(registry.manifests.map(async (manifestPath) => {
        if (!isAbsolute(manifestPath)) throw new DeploymentError('Deployment manifest paths must be absolute', 500);
        return parseManifest(await readFile(manifestPath, 'utf8'), manifestPath);
      }))
      : registry.deployments.map(({ manifest, provenance }) => validateManifest(manifest, provenance.manifestPath));
    if (new Set(manifests.map(({ id }) => id)).size !== manifests.length) throw new DeploymentError('Deployment IDs must be unique', 500);
    if (new Set(manifests.map(({ systemdUnit }) => systemdUnit)).size !== manifests.length) throw new DeploymentError('Deployment units must be unique', 500);
    return manifests;
  }
}

function parseRegistry(text: string): DeploymentRegistry {
  const value = JSON.parse(text) as {
    version?: unknown;
    manifests?: unknown;
    deployments?: unknown;
    managedUnits?: unknown;
    retiringUnits?: unknown;
  };
  if (value.version === 1 && Array.isArray(value.manifests)
    && value.manifests.every((path) => typeof path === 'string')) {
    return value as DeploymentRegistryV1;
  }
  if (value.version !== 2 || !Array.isArray(value.deployments)
    || !value.deployments.every((deployment) => isInstalledDeployment(deployment))
    || !Array.isArray(value.managedUnits) || !value.managedUnits.every(isManagedUnit)
    || new Set(value.managedUnits).size !== value.managedUnits.length
    || !Array.isArray(value.retiringUnits) || !value.retiringUnits.every((retirement) => (
      typeof retirement === 'object' && retirement !== null
      && isManagedUnit((retirement as { systemdUnit?: unknown }).systemdUnit)
      && ['pending', 'disabled'].includes(String((retirement as { phase?: unknown }).phase))
    ))) {
    throw new DeploymentError('Invalid deployment registry', 500);
  }
  const registry = value as DeploymentRegistryV2;
  const managedUnits = registry.deployments
    .filter(({ manifest }) => manifest.kind === 'managed')
    .map(({ manifest }) => manifest.systemdUnit);
  if (managedUnits.length !== registry.managedUnits.length
    || managedUnits.some((unit) => !registry.managedUnits.includes(unit))
    || registry.retiringUnits.some(({ systemdUnit }) => registry.managedUnits.includes(systemdUnit))) {
    throw new DeploymentError('Invalid deployment registry', 500);
  }
  return registry;
}

function parseManifest(text: string, path: string): DeploymentManifest {
  return validateManifest(JSON.parse(text) as Partial<DeploymentManifest>, path);
}

function validateManifest(value: Partial<DeploymentManifest>, path: string): DeploymentManifest {
  if (value.version !== 1 || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || !['managed', 'self'].includes(value.kind ?? '')
    || typeof value.systemdUnit !== 'string' || !UNIT_PATTERN.test(value.systemdUnit)
    || !Array.isArray(value.actions) || !value.actions.every((action) => ['start', 'stop', 'restart'].includes(action))) {
    throw new DeploymentError(`Invalid deployment manifest: ${path}`, 500);
  }
  if (value.kind === 'managed' && (typeof value.runner !== 'string' || !value.runner)) {
    throw new DeploymentError(`Managed deployment ${value.id} requires a runner`, 500);
  }
  if (value.kind === 'managed' && !isManagedUnit(value.systemdUnit)) {
    throw new DeploymentError(`Managed deployment ${value.id} uses a reserved or invalid unit`, 500);
  }
  if (value.kind === 'self' && (value.actions.length !== 1 || value.actions[0] !== 'restart')) {
    throw new DeploymentError(`Self deployment ${value.id} may only allow restart`, 500);
  }
  if (value.healthUrl) {
    const url = new URL(value.healthUrl);
    if (url.protocol !== 'http:' || (value.kind === 'managed' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new DeploymentError(`Health URL for ${value.id} must use loopback HTTP`, 500);
    }
  }
  const manifest = value as DeploymentManifest;
  if (manifest.runner) {
    const runnerPath = resolve(dirname(path), manifest.runner);
    const pathFromRoot = relative(dirname(path), runnerPath);
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      throw new DeploymentError(`Runner for ${manifest.id} must stay inside its project`, 500);
    }
  }
  return manifest;
}

function isInstalledDeployment(value: unknown): value is InstalledDeployment {
  if (typeof value !== 'object' || value === null) return false;
  const deployment = value as Partial<InstalledDeployment>;
  return typeof deployment.manifest === 'object' && deployment.manifest !== null
    && typeof deployment.provenance === 'object' && deployment.provenance !== null
    && typeof deployment.provenance.manifestPath === 'string'
    && isAbsolute(deployment.provenance.manifestPath);
}

function isManagedUnit(value: unknown): value is string {
  return typeof value === 'string' && MANAGED_UNIT_PATTERN.test(value) && !RESERVED_CORE_UNITS.has(value);
}

function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function parseServeHomeUrls(output: string): Map<number, string> {
  const status = JSON.parse(output) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
  const urls = new Map<number, string>();
  for (const [hostPort, entry] of Object.entries(status.Web ?? {})) {
    const proxy = entry.Handlers?.['/']?.Proxy;
    if (!proxy) continue;
    const target = new URL(proxy);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || !target.port) continue;
    urls.set(Number(target.port), new URL(`https://${hostPort}/`).toString());
  }
  return urls;
}

function deploymentState(loadState: string, activeState: string): DeploymentState {
  if (loadState !== 'loaded') return 'unavailable';
  if (activeState === 'active') return 'running';
  if (activeState === 'activating') return 'starting';
  if (activeState === 'deactivating') return 'stopping';
  if (activeState === 'failed') return 'failed';
  return 'stopped';
}

async function probe(url: string): Promise<boolean> {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok; }
  catch { return false; }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isCommandTimeout(error: unknown): boolean {
  const commandError = error as { killed?: unknown; signal?: unknown };
  return commandError?.killed === true && commandError.signal === 'SIGTERM';
}
