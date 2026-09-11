#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  copyDependencyTrees,
  copySourceTree,
  findExecutable,
  listGitSourceCandidates,
} from './isolated-runner-lib.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const handledSignals = ['SIGINT', 'SIGTERM'];
let runRoot;
let activeChild;
let activeChildKillTimer;
let interruptedSignal;

for (const signal of handledSignals) process.on(signal, () => interrupt(signal));

try {
  const temporaryRoot = await realpath(tmpdir());
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  if (isInside(canonicalRepositoryRoot, temporaryRoot)) {
    throw new Error(`Temporary directory must be outside the source checkout: ${temporaryRoot}`);
  }
  runRoot = await mkdtemp(join(temporaryRoot, 'jarvis-isolated-validation-'));
  const copyRoot = join(runRoot, 'source');
  const candidates = await listGitSourceCandidates(repositoryRoot);
  throwIfInterrupted();
  const sourceResult = await copySourceTree({ sourceRoot: repositoryRoot, destinationRoot: copyRoot, candidates });
  throwIfInterrupted();
  const dependencyResult = await copyDependencyTrees({ sourceRoot: repositoryRoot, destinationRoot: copyRoot });
  throwIfInterrupted();
  const { environment, executables } = await createIsolatedEnvironment(runRoot);

  console.log(`[isolated] copied ${sourceResult.copied.length} source files and ${dependencyResult.length} dependency trees`);
  if (sourceResult.missing.length > 0) {
    console.log(`[isolated] ignored ${sourceResult.missing.length} tracked files absent from the working tree`);
  }

  if (options.mode === 'full') {
    await run(executables.npm, ['run', 'lint'], copyRoot, environment, 'lint');
    await run(executables.npm, ['run', 'typecheck'], copyRoot, environment, 'typecheck');
    await run(executables.npm, [
      'test',
      '--workspace',
      '@jarvis/server',
      '--workspace',
      '@jarvis/web',
    ], copyRoot, environment, 'npm test (non-GUI workspaces)');
    await run(executables.npm, ['run', 'test:deployment'], copyRoot, environment, 'deployment tests');
    await run(process.execPath, ['--test', 'tools/isolated-runner.test.mjs'], copyRoot, environment, 'runner boundary tests');
    console.log('[isolated] UNAVAILABLE worker extension-host tests: the isolated tree excludes .vscode-test downloads and the runner does not fetch a replacement');
  }

  await run(executables.npm, ['run', 'build'], copyRoot, environment, 'build');
  await run(process.execPath, ['tools/isolated-smoke.mjs'], copyRoot, environment, 'API/PWA/worker/terminal smoke');
  throwIfInterrupted();
  console.log(`[isolated] PASS (${options.mode})`);
  if (options.keep) console.log(`[isolated] retained copied tree at ${runRoot}`);
} catch (error) {
  console.error(`[isolated] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (runRoot && !options.keep) await rm(runRoot, { recursive: true, force: true });
  for (const signal of handledSignals) process.removeAllListeners(signal);
  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143;
}

function parseArguments(arguments_) {
  if (arguments_.includes('--help')) {
    console.log('Usage: node tools/isolated-runner.mjs [--smoke | --full] [--keep]');
    process.exit(0);
  }
  const supported = new Set(['--smoke', '--full', '--keep']);
  const unsupported = arguments_.filter((argument) => !supported.has(argument));
  if (unsupported.length > 0) throw new Error(`Unsupported argument: ${unsupported[0]}`);
  if (arguments_.includes('--smoke') && arguments_.includes('--full')) {
    throw new Error('--smoke and --full are mutually exclusive');
  }
  return { mode: arguments_.includes('--full') ? 'full' : 'smoke', keep: arguments_.includes('--keep') };
}

async function createIsolatedEnvironment(root) {
  const home = join(root, 'home');
  const temporaryDirectory = join(root, 'tmp');
  const xdgRoot = join(root, 'xdg');
  const xdgRuntime = join(xdgRoot, 'runtime');
  await Promise.all([
    mkdir(home, { recursive: true, mode: 0o700 }),
    mkdir(temporaryDirectory, { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, 'cache'), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, 'config'), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, 'data'), { recursive: true, mode: 0o700 }),
    mkdir(join(xdgRoot, 'state'), { recursive: true, mode: 0o700 }),
    mkdir(xdgRuntime, { recursive: true, mode: 0o700 }),
  ]);

  const npm = await findExecutable('npm');
  const git = await findExecutable('git');
  const shell = await findExecutable('bash').catch(() => findExecutable('sh'));
  const executableDirectories = [...new Set([
    dirname(process.execPath),
    dirname(npm),
    dirname(git),
    dirname(shell),
  ])];
  const environment = {
    CI: 'true',
    COREPACK_HOME: join(xdgRoot, 'cache/corepack'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
    JARVIS_ALLOW_INSECURE_NETWORK: 'false',
    JARVIS_HOST: '127.0.0.1',
    JARVIS_PORT: '0',
    JARVIS_TERMINAL_HOST_EXTERNAL: 'false',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_PROXY: '127.0.0.1,localhost,::1',
    PATH: executableDirectories.join(':'),
    PLAYWRIGHT_ALLOW_EXTERNAL: 'false',
    SHELL: shell,
    TEMP: temporaryDirectory,
    TERM: 'dumb',
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    TZ: 'UTC',
    XDG_CACHE_HOME: join(xdgRoot, 'cache'),
    XDG_CONFIG_HOME: join(xdgRoot, 'config'),
    XDG_DATA_HOME: join(xdgRoot, 'data'),
    XDG_RUNTIME_DIR: xdgRuntime,
    XDG_STATE_HOME: join(xdgRoot, 'state'),
    npm_config_audit: 'false',
    npm_config_cache: join(xdgRoot, 'cache/npm'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: '/dev/null',
  };
  return { environment, executables: { git, npm, shell } };
}

function run(command, arguments_, cwd, environment, label) {
  throwIfInterrupted();
  console.log(`[isolated] ${label}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      detached: process.platform !== 'win32',
      env: environment,
      stdio: 'inherit',
    });
    activeChild = child;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = undefined;
      clearTimeout(activeChildKillTimer);
      activeChildKillTimer = undefined;
      if (code === 0) resolvePromise();
      else reject(new Error(`${label} exited with ${signal ?? code}`));
    });
  });
}

function interrupt(signal) {
  interruptedSignal ??= signal;
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
  try {
    if (process.platform === 'win32' || !activeChild.pid) activeChild.kill(signal);
    else process.kill(-activeChild.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
  activeChildKillTimer = setTimeout(() => {
    if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) return;
    try {
      if (process.platform === 'win32' || !activeChild.pid) activeChild.kill('SIGKILL');
      else process.kill(-activeChild.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }, 2_000);
  activeChildKillTimer.unref();
}

function throwIfInterrupted() {
  if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}`);
}

function isInside(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}
