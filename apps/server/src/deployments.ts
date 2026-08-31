import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };
const UNIT_PATTERN = /^jarvis(?:-[a-z0-9-]+)?\.service$/;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DeploymentAction = 'start' | 'stop' | 'restart';
export type DeploymentState = 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'unavailable';

export interface DeploymentManifest {
  version: 1;
  id: string;
  name: string;
  kind: 'managed' | 'self';
  unit: string;
  runner?: string;
  healthUrl?: string;
  actions: DeploymentAction[];
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

interface DeploymentRegistry { version: 1; manifests: string[] }

export class DeploymentError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

export class DeploymentManager {
  constructor(
    private readonly registryFile: string,
    private readonly systemctlExecutable = 'systemctl',
    private readonly systemdRunExecutable = 'systemd-run',
  ) {}

  async list(): Promise<DeploymentStatus[]> {
    const manifests = await this.loadManifests();
    return Promise.all(manifests.map((manifest) => this.status(manifest)));
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
        this.systemctlExecutable, '--user', 'restart', manifest.unit,
      ], EXEC_OPTIONS);
      return { accepted: true, scheduled: true };
    }
    await execFileAsync(this.systemctlExecutable, ['--user', action, manifest.unit], EXEC_OPTIONS);
    return { accepted: true, scheduled: false };
  }

  private async status(manifest: DeploymentManifest): Promise<DeploymentStatus> {
    try {
      const { stdout } = await execFileAsync(this.systemctlExecutable, [
        '--user', 'show', manifest.unit, '--no-pager',
        '--property=LoadState,ActiveState,SubState,UnitFileState',
      ], EXEC_OPTIONS);
      const properties = parseProperties(stdout);
      const state = deploymentState(properties.LoadState, properties.ActiveState);
      const healthy = state === 'running' && manifest.healthUrl ? await probe(manifest.healthUrl) : null;
      return { id: manifest.id, name: manifest.name, kind: manifest.kind, state,
        enabled: properties.UnitFileState === 'enabled', healthy, actions: [...manifest.actions],
        ...(manifest.warning ? { warning: manifest.warning } : {}) };
    } catch (error) {
      return { id: manifest.id, name: manifest.name, kind: manifest.kind, state: 'unavailable',
        enabled: false, healthy: null, actions: [...manifest.actions],
        ...(manifest.warning ? { warning: manifest.warning } : {}), detail: errorMessage(error) };
    }
  }

  private async loadManifests(): Promise<DeploymentManifest[]> {
    let registryText: string;
    try { registryText = await readFile(this.registryFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const registry = parseRegistry(registryText);
    const manifests = await Promise.all(registry.manifests.map(async (manifestPath) => {
      if (!isAbsolute(manifestPath)) throw new DeploymentError('Deployment manifest paths must be absolute', 500);
      const manifest = parseManifest(await readFile(manifestPath, 'utf8'), manifestPath);
      if (manifest.runner) {
        const runnerPath = resolve(dirname(manifestPath), manifest.runner);
        const pathFromRoot = relative(dirname(manifestPath), runnerPath);
        if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
          throw new DeploymentError(`Runner for ${manifest.id} must stay inside its project`, 500);
        }
      }
      return manifest;
    }));
    if (new Set(manifests.map(({ id }) => id)).size !== manifests.length) throw new DeploymentError('Deployment IDs must be unique', 500);
    if (new Set(manifests.map(({ unit }) => unit)).size !== manifests.length) throw new DeploymentError('Deployment units must be unique', 500);
    return manifests;
  }
}

function parseRegistry(text: string): DeploymentRegistry {
  const value = JSON.parse(text) as Partial<DeploymentRegistry>;
  if (value.version !== 1 || !Array.isArray(value.manifests) || !value.manifests.every((path) => typeof path === 'string')) {
    throw new DeploymentError('Invalid deployment registry', 500);
  }
  return value as DeploymentRegistry;
}

function parseManifest(text: string, path: string): DeploymentManifest {
  const value = JSON.parse(text) as Partial<DeploymentManifest>;
  if (value.version !== 1 || typeof value.id !== 'string' || !ID_PATTERN.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || !['managed', 'self'].includes(value.kind ?? '')
    || typeof value.unit !== 'string' || !UNIT_PATTERN.test(value.unit)
    || !Array.isArray(value.actions) || !value.actions.every((action) => ['start', 'stop', 'restart'].includes(action))) {
    throw new DeploymentError(`Invalid deployment manifest: ${path}`, 500);
  }
  if (value.kind === 'managed' && (typeof value.runner !== 'string' || !value.runner)) {
    throw new DeploymentError(`Managed deployment ${value.id} requires a runner`, 500);
  }
  if (value.kind === 'self' && (value.actions.length !== 1 || value.actions[0] !== 'restart')) {
    throw new DeploymentError(`Self deployment ${value.id} may only allow restart`, 500);
  }
  if (value.healthUrl) {
    const url = new URL(value.healthUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new DeploymentError(`Health URL for ${value.id} must use loopback HTTP`, 500);
    }
  }
  return value as DeploymentManifest;
}

function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
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