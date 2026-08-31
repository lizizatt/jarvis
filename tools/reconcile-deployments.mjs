#!/usr/bin/env node
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNIT_PATTERN = /^jarvis(?:-[a-z0-9-]+)?\.service$/;
const ACTIONS = new Set(['start', 'stop', 'restart']);

const options = parseArguments(process.argv.slice(2));
const template = await readFile(options.template, 'utf8');
const manifests = await Promise.all(options.manifests.map(loadManifest));
validateUnique(manifests, 'id', 'deployment ID');
validateUnique(manifests, 'systemdUnit', 'systemd unit');
const deploymentIndex = [];

await mkdir(dirname(options.registry), { recursive: true });
await mkdir(options.systemdDir, { recursive: true });
await writeFile(options.registry, `${JSON.stringify({ version: 1, manifests: manifests.map(({ path }) => path) }, null, 2)}\n`, { mode: 0o600 });

for (const manifest of manifests) {
  if (manifest.kind === 'self') continue;
  if (options.build && manifest.build) runBuild(manifest);
  const unit = template
    .replaceAll('@@DISPLAY_NAME@@', escapeUnitValue(manifest.name))
    .replaceAll('@@MANIFEST_PATH@@', escapeUnitValue(manifest.path))
    .replaceAll('@@PROJECT_ROOT@@', escapeUnitValue(manifest.root))
    .replaceAll('@@RUNNER_PATH@@', escapeUnitValue(manifest.runnerPath))
    .replaceAll('@@TOOL_PATH@@', escapeUnitValue(process.env.PATH ?? ''));
  await writeFile(join(options.systemdDir, manifest.systemdUnit), unit);
  deploymentIndex.push(`${manifest.systemdUnit}\t${manifest.healthUrl ?? ''}`);
}
const indexText = `${deploymentIndex.join('\n')}\n`;
if (options.output) await writeFile(options.output, indexText);
else process.stdout.write(indexText);

async function loadManifest(inputPath) {
  if (!isAbsolute(inputPath)) fail(`Manifest path must be absolute: ${inputPath}`);
  const path = await realpath(inputPath);
  const root = dirname(path);
  if (/\s/.test(root)) fail(`Deployment project paths may not contain whitespace: ${root}`);
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value.version !== 1 || !ID_PATTERN.test(value.id ?? '') || typeof value.name !== 'string' || !value.name.trim()
    || !['managed', 'self'].includes(value.kind) || !UNIT_PATTERN.test(value.systemdUnit ?? '')
    || !Array.isArray(value.actions) || !value.actions.every((action) => ACTIONS.has(action))) {
    fail(`Invalid deployment manifest: ${path}`);
  }
  if (value.kind === 'self') {
    if (value.actions.length !== 1 || value.actions[0] !== 'restart') fail(`Self deployment ${value.id} may only allow restart`);
    return { ...value, path, root };
  }
  if (typeof value.runner !== 'string' || !value.runner) fail(`Managed deployment ${value.id} requires a runner`);
  const runnerPath = resolveContained(root, value.runner, `Runner for ${value.id}`);
  await access(runnerPath, constants.X_OK);
  if (value.build !== undefined && (!Array.isArray(value.build) || value.build.length === 0 || !value.build.every((argument) => typeof argument === 'string' && argument))) {
    fail(`Build for ${value.id} must be a non-empty argv array`);
  }
  if (value.healthUrl !== undefined) validateHealthUrl(value.id, value.healthUrl);
  return { ...value, path, root, runnerPath };
}

function parseArguments(arguments_) {
  const values = { manifests: [], build: false };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === '--build') values.build = true;
    else if (argument === '--registry') values.registry = arguments_[++index];
    else if (argument === '--systemd-dir') values.systemdDir = arguments_[++index];
    else if (argument === '--template') values.template = arguments_[++index];
    else if (argument === '--output') values.output = arguments_[++index];
    else values.manifests.push(argument);
  }
  if (!values.registry || !values.systemdDir || !values.template || values.manifests.length === 0) {
    fail('Usage: reconcile-deployments [--build] [--output PATH] --registry PATH --systemd-dir PATH --template PATH MANIFEST...');
  }
  return values;
}

function resolveContained(root, path, label) {
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) fail(`${label} must stay inside its project`);
  return resolved;
}

function validateHealthUrl(id, value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    fail(`Health URL for ${id} must use loopback HTTP`);
  }
}

function validateUnique(manifests, field, label) {
  if (new Set(manifests.map((manifest) => manifest[field])).size !== manifests.length) fail(`Each ${label} must be unique`);
}

function runBuild(manifest) {
  const result = spawnSync(manifest.build[0], manifest.build.slice(1), { cwd: manifest.root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`Build failed for ${manifest.name}`);
}

function escapeUnitValue(value) {
  if (/[\n\r\0]/.test(value)) fail('Systemd values may not contain control characters');
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function fail(message) { console.error(`ERROR: ${message}`); process.exit(1); }
