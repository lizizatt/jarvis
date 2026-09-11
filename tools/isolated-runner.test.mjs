import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  containerContextManifestName,
  copyDependencyTrees,
  copySourceTree,
  isAllowedSourcePath,
  prepareContainerContext,
  runCleanupSteps,
} from './isolated-runner-lib.mjs';

const execFile = promisify(execFileCallback);

test('source allowlist accepts build inputs and rejects state, outputs, and secrets', () => {
  for (const path of [
    '.env.sample',
    'package.json',
    'apps/server/src/index.ts',
    'apps/web/public/icon.png',
    'deploy/test-container/Containerfile',
    'deploy/test-container/Containerfile.dockerignore',
    'docs/TESTING.md',
  ]) assert.equal(isAllowedSourcePath(path), true, path);

  for (const path of [
    '.env',
    '.env.production',
    '.git/config',
    'apps/server/.env.sample',
    'apps/server/dist/index.js',
    'apps/server/private-token.txt',
    'apps/vscode-worker/.vscode-test/Code',
    'node_modules/pkg/index.js',
    'playwright-report/index.html',
    'test-results/result.json',
    '../outside.ts',
  ]) assert.equal(isAllowedSourcePath(path), false, path);
});

test('source copy includes tracked candidates only through the allowlist', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-source-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const destinationRoot = join(root, 'destination');
  await writeFixture(sourceRoot, 'package.json', '{}\n');
  await writeFixture(sourceRoot, '.env.sample', 'JARVIS_PORT=3210\n');
  await writeFixture(sourceRoot, '.env', 'API_TOKEN=do-not-copy\n');
  await writeFixture(sourceRoot, 'apps/server/src/index.ts', 'export {};\n');
  await writeFixture(sourceRoot, 'apps/server/dist/index.js', 'generated\n');

  const result = await copySourceTree({
    sourceRoot,
    destinationRoot,
    candidates: [
      'package.json',
      '.env.sample',
      '.env',
      'apps/server/src/index.ts',
      'apps/server/dist/index.js',
    ],
  });

  assert.deepEqual(result.copied, ['.env.sample', 'apps/server/src/index.ts', 'package.json']);
  assert.deepEqual(result.excluded, ['.env', 'apps/server/dist/index.js']);
  assert.equal(await readFile(join(destinationRoot, 'apps/server/src/index.ts'), 'utf8'), 'export {};\n');
  await assert.rejects(readFile(join(destinationRoot, '.env'), 'utf8'), { code: 'ENOENT' });
});

test('source copy rejects symlinks whose targets leave the allowlist', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-source-link-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, 'apps/server/src'), { recursive: true });
  await symlink('/etc/passwd', join(sourceRoot, 'apps/server/src/linked.ts'));

  await assert.rejects(
    copySourceTree({
      sourceRoot,
      destinationRoot: join(root, 'destination'),
      candidates: ['apps/server/src/linked.ts'],
    }),
    /Source candidate apps\/server\/src\/linked\.ts resolves outside checkout/,
  );
});

test('source copy rejects files reached through an external ancestor symlink', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-source-ancestor-link-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const outsideRoot = join(root, 'outside');
  await mkdir(join(sourceRoot, 'apps/server'), { recursive: true });
  await writeFixture(outsideRoot, 'index.ts', 'export const outside = true;\n');
  await symlink(outsideRoot, join(sourceRoot, 'apps/server/src'));

  await assert.rejects(
    copySourceTree({
      sourceRoot,
      destinationRoot: join(root, 'destination'),
      candidates: ['apps/server/src/index.ts'],
    }),
    /Source candidate apps\/server\/src\/index\.ts resolves outside checkout/,
  );
});

test('source copy rejects a destination inside the live source tree', async (context) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'jarvis-copy-overlap-test-'));
  context.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await writeFixture(sourceRoot, 'package.json', '{}\n');

  await assert.rejects(
    copySourceTree({
      sourceRoot,
      destinationRoot: join(sourceRoot, 'test-results/copied-source'),
      candidates: ['package.json'],
    }),
    /Source and destination trees must not overlap/,
  );
});

test('container context copies tracked files and includes candidates only when requested', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-container-context-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await writeFixture(sourceRoot, 'package.json', '{}\n');
  await writeFixture(sourceRoot, 'apps/server/src/index.ts', 'export {};\n');
  await execFile('git', ['-C', sourceRoot, 'init', '--quiet']);
  await execFile('git', ['-C', sourceRoot, 'add', 'package.json', 'apps/server/src/index.ts']);
  await writeFixture(sourceRoot, 'apps/server/src/candidate.ts', 'export const candidate = true;\n');
  await writeFixture(sourceRoot, 'private-token.txt', 'do not copy\n');

  const trackedContext = join(root, 'tracked-context');
  const trackedManifest = await prepareContainerContext({
    repositoryRoot: sourceRoot,
    destinationRoot: trackedContext,
  });
  assert.deepEqual(trackedManifest.copied, {
    tracked: ['apps/server/src/index.ts', 'package.json'],
    candidates: [],
  });
  assert.equal(trackedManifest.candidateFilesIncluded, false);
  await assert.rejects(readFile(join(trackedContext, 'apps/server/src/candidate.ts')), { code: 'ENOENT' });

  const candidateContext = join(root, 'candidate-context');
  const candidateManifest = await prepareContainerContext({
    repositoryRoot: sourceRoot,
    destinationRoot: candidateContext,
    includeCandidates: true,
  });
  assert.deepEqual(candidateManifest.copied.candidates, ['apps/server/src/candidate.ts']);
  assert.deepEqual(candidateManifest.excluded.candidates, ['private-token.txt']);
  assert.deepEqual(
    JSON.parse(await readFile(join(candidateContext, containerContextManifestName), 'utf8')),
    candidateManifest,
  );
  assert.equal(
    await readFile(join(candidateContext, 'apps/server/src/candidate.ts'), 'utf8'),
    'export const candidate = true;\n',
  );
  await assert.rejects(
    prepareContainerContext({ repositoryRoot: sourceRoot, destinationRoot: candidateContext }),
    /Context destination must not already exist/,
  );
});

test('container recipe requires a generated context and validates without network access', async () => {
  const containerfile = await readFile(new URL('../deploy/test-container/Containerfile', import.meta.url), 'utf8');
  assert.match(containerfile, /COPY --chown=node:node \.jarvis-container-context\.json/);

  const installPosition = containerfile.indexOf('RUN npm ci');
  const environmentPosition = containerfile.indexOf('ENV CI=true');
  const validationPosition = containerfile.indexOf('RUN --network=none npm run lint');
  assert.ok(installPosition >= 0, 'dependency installation layer is present');
  assert.ok(installPosition < environmentPosition, 'safety environment follows dependency installation');
  assert.ok(environmentPosition < validationPosition, 'safety environment precedes validation');
});

test('cleanup attempts every step and reports failures after teardown', async () => {
  const completed = [];
  await assert.rejects(
    runCleanupSteps([
      { label: 'first resource', run: () => { completed.push('first'); throw new Error('expected failure'); } },
      { label: 'second resource', run: () => { completed.push('second'); } },
    ]),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.errors[0].message, /first resource/);
      return true;
    },
  );
  assert.deepEqual(completed, ['first', 'second']);
});

test('dependency copy preserves only relative links that resolve inside the copied tree', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-dependency-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const destinationRoot = join(root, 'destination');
  await writeFixture(sourceRoot, 'apps/server/package.json', '{"name":"@jarvis/server"}\n');
  await writeFixture(sourceRoot, 'node_modules/pkg/cli.js', 'export {};\n');
  await mkdir(join(sourceRoot, 'node_modules/.bin'), { recursive: true });
  await mkdir(join(sourceRoot, 'node_modules/@jarvis'), { recursive: true });
  await symlink('../pkg/cli.js', join(sourceRoot, 'node_modules/.bin/pkg'));
  await symlink('../../apps/server', join(sourceRoot, 'node_modules/@jarvis/server'));
  await writeFixture(destinationRoot, 'apps/server/package.json', '{"name":"@jarvis/server"}\n');

  await copyDependencyTrees({ sourceRoot, destinationRoot, directories: ['node_modules'] });

  assert.equal(
    await realpath(join(destinationRoot, 'node_modules/@jarvis/server')),
    await realpath(join(destinationRoot, 'apps/server')),
  );
  assert.equal(
    await realpath(join(destinationRoot, 'node_modules/.bin/pkg')),
    await realpath(join(destinationRoot, 'node_modules/pkg/cli.js')),
  );
  const sourceFile = await stat(join(sourceRoot, 'node_modules/pkg/cli.js'));
  const copiedFile = await stat(join(destinationRoot, 'node_modules/pkg/cli.js'));
  assert.notEqual(copiedFile.ino, sourceFile.ino);
});

test('dependency copy rejects relative links that escape the copied tree', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-external-link-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, 'node_modules/pkg'), { recursive: true });
  await symlink('../../../outside', join(sourceRoot, 'node_modules/pkg/external'));

  await assert.rejects(
    copyDependencyTrees({
      sourceRoot,
      destinationRoot: join(root, 'destination'),
      directories: ['node_modules'],
    }),
    /External symlink is not allowed/,
  );
});

test('dependency copy rejects roots reached through an external ancestor symlink', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-copy-dependency-ancestor-link-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const outsideRoot = join(root, 'outside');
  await writeFixture(sourceRoot, 'node_modules/root-package/index.js', 'export {};\n');
  await mkdir(join(sourceRoot, 'apps'), { recursive: true });
  await writeFixture(outsideRoot, 'server/node_modules/nested-package/index.js', 'export {};\n');
  await symlink(join(outsideRoot, 'server'), join(sourceRoot, 'apps/server'));

  await assert.rejects(
    copyDependencyTrees({
      sourceRoot,
      destinationRoot: join(root, 'destination'),
      directories: ['node_modules', 'apps/server/node_modules'],
    }),
    /Dependency root apps\/server\/node_modules resolves outside checkout/,
  );
});

async function writeFixture(root, path, contents) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}
