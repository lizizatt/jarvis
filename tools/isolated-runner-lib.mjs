import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  cp,
  lstat,
  mkdir,
  opendir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const allowedRootFiles = new Set([
  '.env.sample',
  '.gitignore',
  'AGENTS.md',
  'README.md',
  'TODO-copilot-accessibility-audit.md',
  'TODO.md',
  'eslint.config.js',
  'jarvis.deployment.json',
  'package-lock.json',
  'package.json',
  'playwright.config.ts',
  'tsconfig.base.json',
  'tsconfig.json',
]);
const allowedTopLevelDirectories = new Set([
  'apps',
  'deploy',
  'docs',
  'packages',
  'scripts',
  'sigil-lib',
  'tools',
]);
const allowedExtensions = new Set([
  '.cjs',
  '.css',
  '.dockerignore',
  '.gif',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.mp3',
  '.png',
  '.sh',
  '.svg',
  '.template',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.webp',
  '.woff',
  '.woff2',
  '.yaml',
  '.yml',
]);
const allowedExtensionlessNames = new Set(['Containerfile', 'Dockerfile', 'LICENSE']);
const excludedSegments = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  '.vscode-test',
  'blob-report',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'test-results',
]);
const forbiddenOutputExtensions = new Set([
  '.db',
  '.gz',
  '.log',
  '.pid',
  '.sock',
  '.sqlite',
  '.sqlite3',
  '.tar',
  '.tgz',
  '.vsix',
  '.zip',
]);
const sensitiveName = /(?:credential|credentials|private[-_.]?key|secret|secrets|token|tokens)(?:\.[^/]*)?$/i;

export const containerContextManifestName = '.jarvis-container-context.json';

export const dependencyDirectories = [
  'node_modules',
  'apps/server/node_modules',
  'apps/web/node_modules',
  'apps/vscode-worker/node_modules',
  'packages/shared/node_modules',
  'sigil-lib/node_modules',
];

export function isAllowedSourcePath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) return false;
  const normalized = candidate.replaceAll('\\', '/');
  if (normalized !== candidate || normalized.startsWith('/') || normalized.endsWith('/')) return false;

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => excludedSegments.has(segment))) return false;

  const basename = segments.at(-1);
  if (basename === '.env.sample') return normalized === '.env.sample';
  if (basename === '.env' || basename.startsWith('.env.')) return false;
  if (sensitiveName.test(basename)) return false;
  if (forbiddenOutputExtensions.has(extname(basename).toLowerCase())) return false;

  if (segments.length === 1) return allowedRootFiles.has(normalized);
  if (!allowedTopLevelDirectories.has(segments[0])) return false;
  return allowedExtensions.has(extname(basename).toLowerCase()) || allowedExtensionlessNames.has(basename);
}

export async function listGitSourceInputs(repositoryRoot, { includeCandidates = false } = {}) {
  const tracked = await listGitPaths(repositoryRoot, ['--cached']);
  const candidates = includeCandidates
    ? await listGitPaths(repositoryRoot, ['--others', '--exclude-standard'])
    : [];
  return { tracked, candidates };
}

export async function listGitSourceCandidates(repositoryRoot) {
  const { tracked, candidates } = await listGitSourceInputs(repositoryRoot, { includeCandidates: true });
  return [...tracked, ...candidates];
}

export async function prepareContainerContext({
  repositoryRoot,
  destinationRoot,
  includeCandidates = false,
}) {
  await assertMissingDestination(destinationRoot);
  const inputs = await listGitSourceInputs(repositoryRoot, { includeCandidates });
  const trackedPaths = new Set(inputs.tracked);

  try {
    const result = await copySourceTree({
      sourceRoot: repositoryRoot,
      destinationRoot,
      candidates: [...inputs.tracked, ...inputs.candidates],
    });
    const splitByOrigin = (paths) => ({
      tracked: paths.filter((path) => trackedPaths.has(path)),
      candidates: paths.filter((path) => !trackedPaths.has(path)),
    });
    const manifest = {
      formatVersion: 1,
      candidateFilesIncluded: includeCandidates,
      copied: splitByOrigin(result.copied),
      excluded: splitByOrigin(result.excluded),
      missing: splitByOrigin(result.missing),
    };
    await writeFile(
      join(destinationRoot, containerContextManifestName),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return manifest;
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function copySourceTree({ sourceRoot, destinationRoot, candidates }) {
  const copied = [];
  const excluded = [];
  const missing = [];

  const canonicalSourceRoot = await assertSeparateTrees(sourceRoot, destinationRoot);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  for (const candidate of [...new Set(candidates)].sort()) {
    if (!isAllowedSourcePath(candidate)) {
      excluded.push(candidate);
      continue;
    }

    const sourcePath = resolve(sourceRoot, candidate);
    const destinationPath = resolve(destinationRoot, candidate);
    const canonicalSourcePath = await canonicalizeContainedSourcePath(
      canonicalSourceRoot,
      sourcePath,
      `Source candidate ${candidate}`,
    );
    if (!canonicalSourcePath) {
      missing.push(candidate);
      continue;
    }

    const sourceStat = await lstat(sourcePath);
    if (sourceStat.isSymbolicLink()) await assertSourceLink(sourceRoot, sourcePath);
    else if (!sourceStat.isFile()) throw new Error(`Refusing non-file source candidate: ${candidate}`);

    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    copied.push(candidate);
  }

  await assertInternalSymlinks(destinationRoot);
  return { copied, excluded, missing };
}

export async function copyDependencyTrees({
  sourceRoot,
  destinationRoot,
  directories = dependencyDirectories,
}) {
  const copied = [];
  const canonicalSourceRoot = await assertSeparateTrees(sourceRoot, destinationRoot);
  for (const directory of directories) {
    const sourcePath = resolve(sourceRoot, directory);
    const canonicalSourcePath = await canonicalizeContainedSourcePath(
      canonicalSourceRoot,
      sourcePath,
      `Dependency root ${directory}`,
    );
    if (!canonicalSourcePath) continue;

    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new Error(`Dependency root must be a real directory: ${directory}`);
    }

    const destinationPath = resolve(destinationRoot, directory);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, {
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    copied.push(directory);
  }

  if (!copied.includes('node_modules')) {
    throw new Error('Root node_modules is required; install dependencies before isolated validation');
  }
  await assertInternalSymlinks(destinationRoot);
  return copied;
}

export async function assertInternalSymlinks(root) {
  const canonicalRoot = await realpath(root);
  for await (const path of walk(root)) {
    const pathStat = await lstat(path);
    if (!pathStat.isSymbolicLink()) continue;

    const target = await readlink(path);
    if (isAbsolute(target)) throw new Error(`Absolute symlink is not allowed: ${relative(root, path)} -> ${target}`);

    const lexicalTarget = resolve(dirname(path), target);
    if (!isInside(root, lexicalTarget)) {
      throw new Error(`External symlink is not allowed: ${relative(root, path)} -> ${target}`);
    }

    let canonicalTarget;
    try {
      canonicalTarget = await realpath(path);
    } catch (error) {
      throw new Error(`Broken symlink is not allowed: ${relative(root, path)} -> ${target}`, { cause: error });
    }
    if (!isInside(canonicalRoot, canonicalTarget)) {
      throw new Error(`Resolved symlink leaves the isolated tree: ${relative(root, path)} -> ${canonicalTarget}`);
    }
  }
}

export async function findExecutable(name, pathValue = process.env.PATH ?? '') {
  for (const directory of pathValue.split(sep === '\\' ? ';' : ':').filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the current PATH only.
    }
  }
  throw new Error(`Required executable not found on PATH: ${name}`);
}

export async function runCleanupSteps(steps) {
  const errors = [];
  for (const { label, run } of steps) {
    try {
      await run();
    } catch (error) {
      errors.push(new Error(`Failed to clean up ${label}`, { cause: error }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'One or more cleanup steps failed');
}

async function assertSourceLink(sourceRoot, sourcePath) {
  const target = await readlink(sourcePath);
  if (isAbsolute(target)) throw new Error(`Absolute source symlink is not allowed: ${relative(sourceRoot, sourcePath)}`);
  const resolvedTarget = resolve(dirname(sourcePath), target);
  const candidateTarget = relative(sourceRoot, resolvedTarget).replaceAll('\\', '/');
  if (!isInside(sourceRoot, resolvedTarget) || !isAllowedSourcePath(candidateTarget)) {
    throw new Error(`Source symlink leaves the allowlist: ${relative(sourceRoot, sourcePath)} -> ${target}`);
  }
}

function isInside(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

async function assertSeparateTrees(sourceRoot, destinationRoot) {
  const canonicalSource = await realpath(sourceRoot);
  const canonicalDestination = await resolveProspectivePath(destinationRoot);
  if (isInside(canonicalSource, canonicalDestination) || isInside(canonicalDestination, canonicalSource)) {
    throw new Error(`Source and destination trees must not overlap: ${sourceRoot} and ${destinationRoot}`);
  }
  return canonicalSource;
}

async function canonicalizeContainedSourcePath(canonicalSourceRoot, sourcePath, description) {
  let canonicalSourcePath;
  try {
    canonicalSourcePath = await realpath(sourcePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try {
        await lstat(sourcePath);
      } catch (pathError) {
        if (pathError?.code === 'ENOENT') return undefined;
        throw pathError;
      }
    }
    throw new Error(`${description} does not resolve to a readable path`, { cause: error });
  }
  if (!isInside(canonicalSourceRoot, canonicalSourcePath)) {
    throw new Error(`${description} resolves outside checkout: ${canonicalSourcePath}`);
  }
  return canonicalSourcePath;
}

async function assertMissingDestination(destinationRoot) {
  try {
    await lstat(destinationRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Context destination must not already exist: ${destinationRoot}`);
}

async function resolveProspectivePath(path) {
  let candidate = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function* walk(root) {
  const directory = await opendir(root);
  for await (const entry of directory) {
    const path = resolve(root, entry.name);
    yield path;
    if (entry.isDirectory()) yield* walk(path);
  }
}

function collectCommandOutput(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'));
      else reject(new Error(`${command} failed (${signal ?? code}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
    });
  });
}

async function listGitPaths(repositoryRoot, selectors) {
  const output = await collectCommandOutput('git', [
    '-C',
    repositoryRoot,
    'ls-files',
    ...selectors,
    '-z',
  ]);
  return [...new Set(output.split('\0').filter(Boolean))].sort();
}
