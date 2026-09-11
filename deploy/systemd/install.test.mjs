import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const requiredCheckoutFiles = [
  'deploy/systemd/install.sh',
  'deploy/systemd/uninstall.sh',
  'deploy/systemd/jarvis.service.template',
  'deploy/systemd/jarvis-terminal-host.service.template',
  'deploy/systemd/managed-deployment.service.template',
  'deploy/systemd/terminal-host.sh.template',
  'jarvis.deployment.json',
  'tools/reconcile-deployments.mjs',
  'tools/resolve-installation.mjs',
];
const safeToolNames = ['chmod', 'cp', 'dirname', 'ls', 'mkdir', 'mktemp', 'rm', 'sed', 'seq'];
const safeTools = Object.fromEntries(await Promise.all(
  safeToolNames.map(async (name) => [name, await findExecutable(name)]),
));
const bashExecutable = await findExecutable('bash');

test('installer accepts explicit managed deployment manifest arguments', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkoutBefore = await snapshotFiles(fixture.checkout);

  const result = runInstaller(fixture, {
    arguments: [fixture.jam.manifest, fixture.alesis.manifest],
  });

  assert.equal(result.status, 0, formatFailure(result));
  assert.match(result.stdout, /=== Installation Complete ===/);
  assert.deepEqual(await snapshotFiles(fixture.checkout), checkoutBefore);
  assert.deepEqual(await listFiles(fixture.home), [
    '.config/jarvis/deployments.json',
    '.config/jarvis/deployments.tsv',
    '.config/jarvis/effective.env',
    '.config/jarvis/run-terminal-host.sh',
    '.config/jarvis/self.deployment.json',
    '.config/systemd/user/jarvis-alesis.service',
    '.config/systemd/user/jarvis-jam.service',
    '.config/systemd/user/jarvis-terminal-host.service',
    '.config/systemd/user/jarvis.service',
  ]);

  const configDirectory = join(fixture.home, '.config/jarvis');
  const systemdDirectory = join(fixture.home, '.config/systemd/user');
  const registryPath = join(configDirectory, 'deployments.json');
  const indexPath = join(configDirectory, 'deployments.tsv');
  const terminalRunnerPath = join(configDirectory, 'run-terminal-host.sh');
  assert.deepEqual(await readRegistry(registryPath), await expectedRegistry(fixture, [fixture.jam, fixture.alesis]));
  assert.equal(await readFile(indexPath, 'utf8'), [
    `jarvis-jam.service\t${fixture.jam.healthUrl}`,
    `jarvis-alesis.service\t${fixture.alesis.healthUrl}`,
    '',
  ].join('\n'));
  assert.equal((await stat(registryPath)).mode & 0o777, 0o600);
  assert.equal((await stat(terminalRunnerPath)).mode & 0o777, 0o700);

  const jarvisUnit = await readFile(join(systemdDirectory, 'jarvis.service'), 'utf8');
  assert.match(jarvisUnit, new RegExp(`WorkingDirectory=${escapeRegExp(fixture.checkout)}`));
  assert.match(jarvisUnit, new RegExp(`ExecStart=${escapeRegExp(join(fixture.bin, 'node'))} `));
  assert.match(jarvisUnit, new RegExp(`EnvironmentFile=-${escapeRegExp(configDirectory)}/\\.env`));
  assert.match(jarvisUnit, new RegExp(`EnvironmentFile=${escapeRegExp(fixture.effectiveEnvironment)}`));
  assert.doesNotMatch(jarvisUnit, /@@[A-Z_]+@@|%h/);
  assertAbsoluteServicePath(jarvisUnit);

  const terminalUnit = await readFile(join(systemdDirectory, 'jarvis-terminal-host.service'), 'utf8');
  assert.match(terminalUnit, new RegExp(`EnvironmentFile=${escapeRegExp(fixture.effectiveEnvironment)}`));

  const terminalRunner = await readFile(terminalRunnerPath, 'utf8');
  assert.match(terminalRunner, new RegExp(`exec "${escapeRegExp(join(fixture.bin, 'node'))}"`));
  assert.match(terminalRunner, new RegExp(escapeRegExp(fixture.checkout)));
  assert.doesNotMatch(terminalRunner, /@@[A-Z_]+@@/);

  for (const deployment of [fixture.jam, fixture.alesis]) {
    const unit = await readFile(join(systemdDirectory, deployment.unit), 'utf8');
    assert.match(unit, new RegExp(`WorkingDirectory=${escapeRegExp(deployment.root)}`));
    assert.match(unit, new RegExp(`ExecStart="${escapeRegExp(deployment.runner)}"`));
    assert.doesNotMatch(unit, /@@[A-Z_]+@@/);
    assertAbsoluteServicePath(unit);
  }

  const commands = await readCommandLog(fixture.commandLog);
  const writeCommand = commands.find((command) => command[0] === 'node' && command[2] === 'write');
  assert.ok(writeCommand);
  const stageDirectory = dirname(dirname(writeCommand[writeCommand.indexOf('--effective-env') + 1]));
  assert.deepEqual(commands, expectedSuccessfulCommands(fixture, stageDirectory));
});

test('installer reports the required unit that remains inactive after bounded fake waits', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    failedSystemctl: 'is-active:jarvis-terminal-host',
  });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stdout, /Required unit is not active: jarvis-terminal-host/);
  const commands = await readCommandLog(fixture.commandLog);
  const unitChecks = commands.filter(([, , verb]) => verb === 'is-active');
  assert.equal(unitChecks.every((command) => command.length === 4), true);
  assert.equal(commands.filter(([command]) => command === 'sleep').length, 60);
});

for (const scenario of [
  {
    name: 'missing web entry',
    detail: 'Web entry file is missing: /fixture/web/index.html',
  },
  {
    name: 'unavailable terminal socket',
    detail: 'Terminal host socket is unavailable: /fixture/terminal-host.sock',
  },
]) {
  test(`installer preserves actionable readiness detail for ${scenario.name}`, async (context) => {
    const fixture = await createInstallerFixture();
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const readinessUrl = 'http://127.0.0.1:3210/api/readiness';

    const result = runInstaller(fixture, {
      failedProbeUrl: readinessUrl,
      probeFailureDetail: JSON.stringify({ ok: false, detail: scenario.detail }),
    });

    assert.equal(result.status, 1, formatFailure(result));
    assert.match(result.stdout, new RegExp(`Jarvis readiness failed: ${escapeRegExp(readinessUrl)}`));
    assert.match(result.stdout, new RegExp(escapeRegExp(scenario.detail)));
    assert.equal((await readCommandLog(fixture.commandLog)).filter(([command]) => command === 'sleep').length, 60);
  });
}

test('installer reports a missing served PWA entry separately from API readiness', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const pwaUrl = 'http://127.0.0.1:3210/';

  const result = runInstaller(fixture, { failedProbeUrl: pwaUrl });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stdout, new RegExp(`PWA entry failed: ${escapeRegExp(pwaUrl)}`));
});

test('installer readiness probing does not require curl --fail-with-body', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runInstaller(fixture, { arguments: ['--core-only'] });

  assert.equal(result.status, 0, formatFailure(result));
  const curlCommands = (await readCommandLog(fixture.commandLog))
    .filter(([command]) => command === 'curl');
  assert.equal(curlCommands.some((command) => command.includes('--fail-with-body')), false);
  assert.equal(curlCommands.some((command) => command.includes('--write-out')), true);
});

test('installer defaults to core services without optional tools or managed deployments', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkoutBefore = await snapshotFiles(fixture.checkout);
  await Promise.all([
    rm(join(fixture.bin, 'copilot')),
    rm(join(fixture.bin, 'tailscale')),
  ]);

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, formatFailure(result));
  assert.match(result.stdout, /Installed Jarvis and 0 managed deployment units/);
  assert.deepEqual(await snapshotFiles(fixture.checkout), checkoutBefore);
  assert.deepEqual(await listFiles(join(fixture.home, '.config/systemd/user')), [
    'jarvis-terminal-host.service',
    'jarvis.service',
  ]);
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture));
  assert.equal(await readFile(fixture.index, 'utf8'), '\n');
  assertAbsoluteServicePath(await readFile(join(fixture.systemdDirectory, 'jarvis.service'), 'utf8'));
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(commands.some(([command]) => command === 'tailscale' || command === 'copilot'), false);
  for (const [command, userFlag, verb, ...units] of commands) {
    if (command === 'systemctl' && userFlag === '--user' && ['enable', 'restart', 'is-active'].includes(verb)) {
      assert.notEqual(units.length, 0, `systemctl ${verb} must name at least one unit`);
    }
  }
});

test('installer persists shell-only endpoint and registry overrides for both services', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registry = join(fixture.root, 'custom-state', 'deployments.json');
  const healthUrl = 'http://[::1]:4321/api/health';

  const result = runInstaller(fixture, {
    arguments: ['--core-only'],
    environment: {
      JARVIS_DEPLOYMENT_REGISTRY: registry,
      JARVIS_HOST: '::1',
      JARVIS_PORT: '4321',
    },
    healthUrls: [healthUrl],
  });

  assert.equal(result.status, 0, formatFailure(result));
  assert.equal(await pathExists(fixture.registry), false);
  assert.deepEqual(await readRegistry(registry), await expectedRegistry(fixture, [], healthUrl));
  assert.deepEqual(JSON.parse(await readFile(fixture.installedSelfManifest, 'utf8')), {
    ...JSON.parse(await readFile(fixture.selfManifest, 'utf8')),
    healthUrl,
  });
  const effectiveEnvironment = await readFile(fixture.effectiveEnvironment, 'utf8');
  assert.match(effectiveEnvironment, /^JARVIS_HOST="::1"$/m);
  assert.match(effectiveEnvironment, /^JARVIS_PORT="4321"$/m);
  assert.match(effectiveEnvironment, new RegExp(`^JARVIS_DEPLOYMENT_REGISTRY="${escapeRegExp(registry)}"$`, 'm'));
  await assertSharedEffectiveEnvironment(fixture);
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(commands.some((command) => command.at(-1) === healthUrl), true);
  assert.equal(commands.some((command) => command.at(-1) === 'http://[::1]:4321/api/readiness'), true);
  assert.equal(commands.some((command) => command.at(-1) === 'http://[::1]:4321/'), true);
  assert.equal(commands.some((command) => command.at(-1) === 'http://127.0.0.1:3210/api/health'), false);
  assert.equal(commands.some((command) => command.at(-1) === 'http://127.0.0.1:3210/api/readiness'), false);
});

test('installer derives effective configuration from .env without rewriting it', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registry = join(fixture.root, 'env-state', 'deployments.json');
  const healthUrl = 'http://localhost:4322/api/health';
  const environmentFile = [
    '# Operator-owned configuration',
    'JARVIS_HOST=localhost',
    "JARVIS_PORT='4322'",
    `JARVIS_DEPLOYMENT_REGISTRY="${registry}"`,
    `JARVIS_DATA_DIR=${join(fixture.root, 'operator-data')}`,
    '',
  ].join('\n');
  await mkdir(fixture.configDirectory, { recursive: true });
  await writeFile(fixture.operatorEnvironment, environmentFile);

  const result = runInstaller(fixture, {
    arguments: ['--core-only'],
    healthUrls: [healthUrl],
  });

  assert.equal(result.status, 0, formatFailure(result));
  assert.equal(await readFile(fixture.operatorEnvironment, 'utf8'), environmentFile);
  assert.equal(await pathExists(registry), true);
  assert.equal(JSON.parse(await readFile(fixture.installedSelfManifest, 'utf8')).healthUrl, healthUrl);
  await assertSharedEffectiveEnvironment(fixture);
});

test('installer reuses the prior effective registry and applies newer .env endpoint values', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const registry = join(fixture.root, 'persisted-state', 'deployments.json');
  const initialHealthUrl = 'http://localhost:4324/api/health';
  const updatedHealthUrl = 'http://localhost:4325/api/health';

  const initial = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    environment: {
      JARVIS_DEPLOYMENT_REGISTRY: registry,
      JARVIS_HOST: 'localhost',
      JARVIS_PORT: '4324',
    },
    healthUrls: [initialHealthUrl],
  });
  assert.equal(initial.status, 0, formatFailure(initial));
  await writeFile(fixture.commandLog, '');
  await writeFile(fixture.operatorEnvironment, 'JARVIS_PORT=4325\n');

  const update = runInstaller(fixture, { healthUrls: [updatedHealthUrl] });

  assert.equal(update.status, 0, formatFailure(update));
  assert.deepEqual(await readRegistry(registry), await expectedRegistry(fixture, [fixture.jam], updatedHealthUrl));
  assert.equal(JSON.parse(await readFile(fixture.installedSelfManifest, 'utf8')).healthUrl, updatedHealthUrl);
  assert.match(await readFile(fixture.effectiveEnvironment, 'utf8'), /^JARVIS_PORT="4325"$/m);
});

test('installer preserves managed integrations when the registry path changes', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const originalRegistry = join(fixture.root, 'original-state', 'deployments.json');
  const movedRegistry = join(fixture.root, 'moved-state', 'deployments.json');

  const initial = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    environment: { JARVIS_DEPLOYMENT_REGISTRY: originalRegistry },
  });
  assert.equal(initial.status, 0, formatFailure(initial));
  await writeFile(fixture.operatorEnvironment, `JARVIS_DEPLOYMENT_REGISTRY=${movedRegistry}\n`);

  const update = runInstaller(fixture);

  assert.equal(update.status, 0, formatFailure(update));
  assert.deepEqual(await readRegistry(movedRegistry), await expectedRegistry(fixture, [fixture.jam]));
});

test('installer rejects unsupported effective .env syntax instead of silently diverging', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(fixture.configDirectory, { recursive: true });
  await writeFile(fixture.operatorEnvironment, 'export JARVIS_PORT=4323\n');

  const result = runInstaller(fixture, { arguments: ['--core-only'] });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stderr, /Unsupported JARVIS_PORT assignment/);
  assert.equal(await readFile(fixture.operatorEnvironment, 'utf8'), 'export JARVIS_PORT=4323\n');
  assert.equal(await pathExists(fixture.effectiveEnvironment), false);
  assert.equal(await pathExists(fixture.registry), false);
});

test('installer preserves the installed managed manifest selection by default', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, formatFailure(result));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.alesis.unit)), false);
});

test('--core-only explicitly replaces a preserved managed manifest selection', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);

  const result = runInstaller(fixture, { arguments: ['--core-only'] });

  assert.equal(result.status, 0, formatFailure(result));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture));
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), false);
});

test('explicit legacy manifest environment variables remain supported without personal defaults', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runInstaller(fixture, {
    environment: { JARVIS_JAM_ASSISTANT_MANIFEST: fixture.jam.manifest },
  });

  assert.equal(result.status, 0, formatFailure(result));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
});

test('installer migrates a v1 registry to durable snapshots and tracked units', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);

  const result = runInstaller(fixture);

  assert.equal(result.status, 0, formatFailure(result));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
});

test('v1 migration retires only the unit recorded in the installed legacy index', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const installedUnit = fixture.jam.unit;
  const renamedUnit = 'jarvis-jam-renamed.service';
  const untrackedUnit = 'jarvis-untracked.service';
  await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);
  await mkdir(fixture.systemdDirectory, { recursive: true });
  await writeFile(fixture.index, `${installedUnit}\t${fixture.jam.healthUrl}\n`);
  await writeFile(join(fixture.systemdDirectory, installedUnit), 'installed old unit\n');
  await writeFile(join(fixture.systemdDirectory, untrackedUnit), 'untracked unit\n');
  const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
  await writeFile(fixture.jam.manifest, `${JSON.stringify({
    ...manifest,
    systemdUnit: renamedUnit,
  }, null, 2)}\n`);
  fixture.jam.unit = renamedUnit;

  const interrupted = runInstaller(fixture, { failedSystemctl: `restart:${renamedUnit}` });

  assert.equal(interrupted.status, 31, formatFailure(interrupted));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam], undefined, [
    { systemdUnit: installedUnit, phase: 'pending', replacementUnit: renamedUnit, wasActive: true },
  ]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, installedUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, untrackedUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, 'jarvis.service')), true);
  const retiredUnits = (await readCommandLog(fixture.commandLog))
    .filter(([, , verb]) => verb === 'stop' || verb === 'disable')
    .map((command) => command.at(-1));
  assert.equal(retiredUnits.includes(installedUnit), true);
  assert.equal(retiredUnits.includes(renamedUnit), true);
  assert.equal(retiredUnits.includes(untrackedUnit), false);
  assert.equal(retiredUnits.includes('jarvis.service'), false);
});

test('v1 migration rejects core units in the legacy index before installed state changes', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);
  await mkdir(fixture.systemdDirectory, { recursive: true });
  const coreUnitPath = join(fixture.systemdDirectory, 'jarvis.service');
  await writeFile(coreUnitPath, 'existing core unit\n');
  await writeFile(fixture.index, `jarvis.service\thttp://127.0.0.1:3210/api/health\n`);

  const result = runInstaller(fixture);

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stderr, /Invalid legacy deployment index/);
  assert.equal(await readFile(coreUnitPath, 'utf8'), 'existing core unit\n');
  assert.equal(await pathExists(fixture.effectiveEnvironment), false);
  assert.equal((await readCommandLog(fixture.commandLog)).some(([command]) => command === 'systemctl'), false);
});

test('a failed later managed build preserves every previously published install file', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  const installedBefore = await snapshotFiles(fixture.home);
  await writeFile(fixture.commandLog, '');

  const update = runInstaller(fixture, {
    arguments: [fixture.jam.manifest, fixture.alesis.manifest],
    failedManagedBuild: 'alesis',
  });

  assert.equal(update.status, 1, formatFailure(update));
  assert.match(update.stderr, /Build failed for Alesis fixture/);
  assert.deepEqual(await snapshotFiles(fixture.home), installedBefore);
  const commands = await readCommandLog(fixture.commandLog);
  assert.deepEqual(commands.filter(([command]) => command === 'fixture-build'), [
    ['fixture-build', fixture.jam.root, 'jam'],
    ['fixture-build', fixture.alesis.root, 'alesis'],
  ]);
  assert.equal(commands.some(([command]) => command === 'systemctl'), false);
});

test('managed builds use a separate caller PATH without contaminating service PATH', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const builderDirectory = join(fixture.root, 'builder-bin');
  await mkdir(builderDirectory);
  await copyFile(join(fixture.bin, 'fixture-build'), join(builderDirectory, 'fixture-build'));
  await chmod(join(builderDirectory, 'fixture-build'), 0o700);
  await rm(join(fixture.bin, 'fixture-build'));

  const result = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    environment: { JARVIS_BUILD_PATH: `${fixture.bin}:${builderDirectory}` },
  });

  assert.equal(result.status, 0, formatFailure(result));
  const managedUnit = await readFile(join(fixture.systemdDirectory, fixture.jam.unit), 'utf8');
  assertAbsoluteServicePath(managedUnit);
  assert.doesNotMatch(managedUnit, new RegExp(escapeRegExp(builderDirectory)));
  assert.equal((await readCommandLog(fixture.commandLog))
    .some((command) => command.join(' ') === `fixture-build ${fixture.jam.root} jam`), true);
});

test('a failed publication restores earlier files and clears recovery metadata', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  const blockedParent = join(fixture.root, 'blocked-registry-parent');
  const blockedRegistry = join(blockedParent, 'deployments.json');
  await writeFile(blockedParent, 'not a directory\n');
  await writeFile(fixture.operatorEnvironment, `JARVIS_DEPLOYMENT_REGISTRY=${blockedRegistry}\n`);
  const serviceTemplate = join(fixture.checkout, 'deploy/systemd/jarvis.service.template');
  await writeFile(serviceTemplate, `${await readFile(serviceTemplate, 'utf8')}\n# staged update\n`);
  const installedBefore = await snapshotFiles(fixture.home);
  await writeFile(fixture.commandLog, '');

  const update = runInstaller(fixture);

  assert.equal(update.status, 1, formatFailure(update));
  assert.deepEqual(await snapshotFiles(fixture.home), installedBefore);
  assert.equal(await pathExists(join(fixture.configDirectory, 'install-publication.json')), false);
  assert.equal((await readCommandLog(fixture.commandLog)).some(([command]) => command === 'systemctl'), false);
});

for (const scenario of [
  {
    name: 'the recovery journal',
    registryPath: async (fixture) => join(fixture.configDirectory, 'install-publication.json'),
  },
  {
    name: 'a symlink-aliased child of the recovery backup directory',
    registryPath: async (fixture) => {
      await mkdir(fixture.configDirectory, { recursive: true });
      const alias = join(fixture.root, 'config-alias');
      await symlink(fixture.configDirectory, alias, 'dir');
      return join(alias, 'install-publication.json.d', 'registry.json');
    },
  },
]) {
  test(`installer rejects a registry destination overlapping ${scenario.name} before publication`, async (context) => {
    const fixture = await createInstallerFixture();
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    const registry = await scenario.registryPath(fixture);

    const result = runInstaller(fixture, {
      arguments: ['--core-only'],
      environment: { JARVIS_DEPLOYMENT_REGISTRY: registry },
    });

    assert.equal(result.status, 1, formatFailure(result));
    assert.match(result.stderr, /Publication destination overlaps recovery state/);
    assert.equal(await pathExists(fixture.effectiveEnvironment), false);
    assert.equal(await pathExists(join(fixture.systemdDirectory, 'jarvis.service')), false);
    assert.equal((await readCommandLog(fixture.commandLog)).some(([command]) => command === 'systemctl'), false);
  });
}

test('a renamed deployment retains recovery inventory until only its tracked old unit is retired', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  const oldUnit = fixture.jam.unit;
  const renamedUnit = 'jarvis-jam-renamed.service';
  const untrackedUnit = 'jarvis-untracked.service';
  await writeFile(join(fixture.systemdDirectory, untrackedUnit), 'untracked\n');
  const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
  await writeFile(fixture.jam.manifest, `${JSON.stringify({ ...manifest, systemdUnit: renamedUnit }, null, 2)}\n`);
  fixture.jam.unit = renamedUnit;
  await writeFile(fixture.commandLog, '');

  const interrupted = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    failedSystemctl: `disable:${oldUnit}`,
  });

  assert.equal(interrupted.status, 31, formatFailure(interrupted));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam], undefined, [
    { systemdUnit: oldUnit, phase: 'pending', replacementUnit: renamedUnit, wasActive: true },
  ]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, renamedUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, untrackedUnit)), true);

  await writeFile(fixture.commandLog, '');
  const recovered = runInstaller(fixture, { arguments: [fixture.jam.manifest] });

  assert.equal(recovered.status, 0, formatFailure(recovered));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), false);
  assert.equal(await pathExists(join(fixture.systemdDirectory, renamedUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, untrackedUnit)), true);
  const retirementCommands = (await readCommandLog(fixture.commandLog))
    .filter(([, , verb]) => verb === 'stop' || verb === 'disable');
  assert.deepEqual(retirementCommands, [
    ['systemctl', '--user', 'stop', oldUnit],
    ['systemctl', '--user', 'disable', oldUnit],
  ]);
});

test('a failed replacement restores its previously active old unit and retries retirement', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  const oldUnit = fixture.jam.unit;
  const replacementUnit = 'jarvis-jam-renamed.service';
  const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
  await writeFile(fixture.jam.manifest, `${JSON.stringify({
    ...manifest,
    systemdUnit: replacementUnit,
  }, null, 2)}\n`);
  fixture.jam.unit = replacementUnit;
  await writeFile(fixture.commandLog, '');

  const failed = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    failedSystemctl: `restart:${replacementUnit}`,
  });

  assert.equal(failed.status, 31, formatFailure(failed));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam], undefined, [
    { systemdUnit: oldUnit, phase: 'pending', replacementUnit, wasActive: true },
  ]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, replacementUnit)), true);
  const failedCommands = (await readCommandLog(fixture.commandLog))
    .filter(([, , verb, unit]) => unit === oldUnit && ['is-active', 'stop', 'disable', 'enable', 'restart'].includes(verb));
  assert.deepEqual(failedCommands, [
    ['systemctl', '--user', 'is-active', oldUnit],
    ['systemctl', '--user', 'stop', oldUnit],
    ['systemctl', '--user', 'disable', oldUnit],
    ['systemctl', '--user', 'enable', oldUnit],
    ['systemctl', '--user', 'restart', oldUnit],
  ]);

  await writeFile(fixture.commandLog, '');
  const recovered = runInstaller(fixture, { arguments: [fixture.jam.manifest] });

  assert.equal(recovered.status, 0, formatFailure(recovered));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), false);
  assert.equal(await pathExists(join(fixture.systemdDirectory, replacementUnit)), true);
});

test('a readiness failure restores an active retiring unit and stops its healthy replacement', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  const oldUnit = fixture.jam.unit;
  const replacementUnit = 'jarvis-jam-renamed.service';
  const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
  await writeFile(fixture.jam.manifest, `${JSON.stringify({
    ...manifest,
    systemdUnit: replacementUnit,
  }, null, 2)}\n`);
  fixture.jam.unit = replacementUnit;
  await writeFile(fixture.commandLog, '');

  const failed = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    failedProbeUrl: 'http://127.0.0.1:3210/api/readiness',
  });

  assert.equal(failed.status, 1, formatFailure(failed));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam], undefined, [
    { systemdUnit: oldUnit, phase: 'pending', replacementUnit, wasActive: true },
  ]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), true);
  assert.equal(await pathExists(join(fixture.systemdDirectory, replacementUnit)), true);
  const failedCommands = await readCommandLog(fixture.commandLog);
  const retirementVerbs = new Set(['stop', 'disable', 'enable', 'restart']);
  assert.deepEqual(failedCommands
    .filter(([, , verb, unit]) => unit === oldUnit && retirementVerbs.has(verb)), [
    ['systemctl', '--user', 'stop', oldUnit],
    ['systemctl', '--user', 'disable', oldUnit],
    ['systemctl', '--user', 'enable', oldUnit],
    ['systemctl', '--user', 'restart', oldUnit],
  ]);
  assert.deepEqual(failedCommands
    .filter(([, , verb, unit]) => unit === replacementUnit && retirementVerbs.has(verb)), [
    ['systemctl', '--user', 'enable', replacementUnit],
    ['systemctl', '--user', 'restart', replacementUnit],
    ['systemctl', '--user', 'stop', replacementUnit],
    ['systemctl', '--user', 'disable', replacementUnit],
  ]);

  await writeFile(fixture.commandLog, '');
  const recovered = runInstaller(fixture, { arguments: [fixture.jam.manifest] });

  assert.equal(recovered.status, 0, formatFailure(recovered));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture, [fixture.jam]));
  assert.equal(await pathExists(join(fixture.systemdDirectory, oldUnit)), false);
  assert.equal(await pathExists(join(fixture.systemdDirectory, replacementUnit)), true);
});

test('--core-only retires a previously installed managed unit', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  await writeFile(fixture.commandLog, '');

  const removal = runInstaller(fixture, { arguments: ['--core-only'] });

  assert.equal(removal.status, 0, formatFailure(removal));
  assert.deepEqual(await readRegistry(fixture.registry), await expectedRegistry(fixture));
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), false);
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(commands.some((command) => command.join(' ') === `systemctl --user stop ${fixture.jam.unit}`), true);
  assert.equal(commands.some((command) => command.join(' ') === `systemctl --user disable ${fixture.jam.unit}`), true);
});

for (const scenario of [
  {
    name: 'deleted source manifest',
    changeSource: async (fixture) => rm(fixture.jam.manifest),
  },
  {
    name: 'renamed source unit',
    changeSource: async (fixture) => {
      const renamedUnit = 'jarvis-jam-renamed.service';
      const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
      await writeFile(fixture.jam.manifest, `${JSON.stringify({
        ...manifest,
        systemdUnit: renamedUnit,
      }, null, 2)}\n`);
      await writeFile(join(fixture.systemdDirectory, renamedUnit), 'not installed by the v1 deployment\n');
      return renamedUnit;
    },
  },
]) {
  test(`direct v1 uninstall uses the legacy index with a ${scenario.name}`, async (context) => {
    const fixture = await createInstallerFixture();
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);
    await mkdir(fixture.systemdDirectory, { recursive: true });
    await writeFile(join(fixture.systemdDirectory, 'jarvis.service'), 'installed core unit\n');
    await writeFile(join(fixture.systemdDirectory, fixture.jam.unit), 'installed managed unit\n');
    await writeFile(fixture.index, `${fixture.jam.unit}\t${fixture.jam.healthUrl}\n`);
    const untouchedUnit = await scenario.changeSource(fixture);
    await writeFile(fixture.commandLog, '');

    const result = runUninstaller(fixture);

    assert.equal(result.status, 0, formatFailure(result));
    assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), false);
    if (untouchedUnit) assert.equal(await pathExists(join(fixture.systemdDirectory, untouchedUnit)), true);
    const commands = await readCommandLog(fixture.commandLog);
    assert.equal(commands.some((command) => command.join(' ') === `systemctl --user stop ${fixture.jam.unit}`), true);
    assert.equal(commands.some((command) => command.join(' ') === `systemctl --user disable ${fixture.jam.unit}`), true);
    if (untouchedUnit) {
      assert.equal(commands.some((command) => command.includes(untouchedUnit)), false);
    }
  });
}

for (const invalidUnit of ['jarvis.service', 'unrelated.service']) {
  test(`direct v1 uninstall rejects legacy index unit ${invalidUnit}`, async (context) => {
    const fixture = await createInstallerFixture();
    context.after(() => rm(fixture.root, { recursive: true, force: true }));
    await writeExistingRegistry(fixture, [fixture.selfManifest, fixture.jam.manifest]);
    await mkdir(fixture.systemdDirectory, { recursive: true });
    const coreUnit = join(fixture.systemdDirectory, 'jarvis.service');
    await writeFile(coreUnit, 'installed core unit\n');
    await writeFile(fixture.index, `${invalidUnit}\t${fixture.jam.healthUrl}\n`);
    await writeFile(fixture.commandLog, '');

    const result = runUninstaller(fixture);

    assert.equal(result.status, 1, formatFailure(result));
    assert.match(result.stderr, /Invalid legacy deployment index/);
    assert.equal(await readFile(coreUnit, 'utf8'), 'installed core unit\n');
    assert.equal((await readCommandLog(fixture.commandLog)).some(([command]) => command === 'systemctl'), false);
  });
}

test('uninstall uses the v2 inventory after managed source files disappear', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const initial = runInstaller(fixture, { arguments: [fixture.jam.manifest] });
  assert.equal(initial.status, 0, formatFailure(initial));
  await rm(fixture.jam.root, { recursive: true });
  await writeFile(fixture.commandLog, '');

  const result = runUninstaller(fixture);

  assert.equal(result.status, 0, formatFailure(result));
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), false);
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(commands.some((command) => command.join(' ') === `systemctl --user stop ${fixture.jam.unit}`), true);
  assert.equal(commands.some((command) => command.join(' ') === `systemctl --user disable ${fixture.jam.unit}`), true);
});

test('uninstall uses the installed effective registry instead of pending .env settings', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const installedRegistry = join(fixture.root, 'installed-state', 'deployments.json');
  const pendingRegistry = join(fixture.root, 'pending-state', 'deployments.json');
  const initial = runInstaller(fixture, {
    arguments: [fixture.jam.manifest],
    environment: { JARVIS_DEPLOYMENT_REGISTRY: installedRegistry },
  });
  assert.equal(initial.status, 0, formatFailure(initial));
  await mkdir(dirname(pendingRegistry), { recursive: true });
  await writeFile(pendingRegistry, `${JSON.stringify(await expectedRegistry(fixture, [fixture.alesis]), null, 2)}\n`);
  await writeFile(fixture.operatorEnvironment, `export JARVIS_DEPLOYMENT_REGISTRY=${pendingRegistry}\n`);
  await writeFile(join(fixture.systemdDirectory, fixture.alesis.unit), 'pending uninstalled unit\n');
  await writeFile(fixture.commandLog, '');

  const result = runUninstaller(fixture, {
    JARVIS_DEPLOYMENT_REGISTRY: pendingRegistry,
  });

  assert.equal(result.status, 0, formatFailure(result));
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.jam.unit)), false);
  assert.equal(await pathExists(join(fixture.systemdDirectory, fixture.alesis.unit)), true);
  const managedStops = (await readCommandLog(fixture.commandLog))
    .filter(([, , verb]) => verb === 'stop')
    .flatMap((command) => command.slice(3));
  assert.equal(managedStops.includes(fixture.jam.unit), true);
  assert.equal(managedStops.includes(fixture.alesis.unit), false);
});

test('installer rejects a missing explicit manifest before build or publication', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const missingManifest = join(fixture.root, 'missing', 'jarvis.deployment.json');

  const result = runInstaller(fixture, { arguments: [missingManifest] });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stdout, new RegExp(`Deployment manifest not found at ${escapeRegExp(missingManifest)}`));
  assert.deepEqual(await readCommandLog(fixture.commandLog), []);
  assert.deepEqual(await listFiles(fixture.home), []);
});

test('installer rejects managed use of a reserved core unit before managed builds or service actions', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(fixture.jam.manifest, 'utf8'));
  await writeFile(fixture.jam.manifest, `${JSON.stringify({
    ...manifest,
    systemdUnit: 'jarvis-terminal-host.service',
  }, null, 2)}\n`);

  const result = runInstaller(fixture, { arguments: [fixture.jam.manifest] });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stderr, /uses a reserved or invalid unit/);
  const commands = await readCommandLog(fixture.commandLog);
  assert.equal(commands.some(([command]) => command === 'fixture-build' || command === 'systemctl'), false);
  assert.deepEqual(await listFiles(fixture.home), []);
});

test('installer stops before publishing state when the project build fails', async (context) => {
  const fixture = await createInstallerFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const checkoutBefore = await snapshotFiles(fixture.checkout);

  const result = runInstaller(fixture, { npmBuildStatus: 23 });

  assert.equal(result.status, 1, formatFailure(result));
  assert.match(result.stdout, /ERROR: Build failed\. Check 'npm run build' output\./);
  assert.deepEqual(await snapshotFiles(fixture.checkout), checkoutBefore);
  assert.deepEqual(await listFiles(fixture.home), []);
  assert.deepEqual(await readCommandLog(fixture.commandLog), [
    [
      'node',
      fixture.configTool,
      'resolve',
      '--operator-env',
      fixture.operatorEnvironment,
      '--previous-effective-env',
      fixture.effectiveEnvironment,
      '--default-registry',
      fixture.registry,
      '--selection',
      'preserve',
    ],
    ['node', '--version'],
    ['npm', '--version'],
    ['npm', 'run', 'build'],
  ]);
});

async function createInstallerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-installer-'));
  try {
    const checkout = join(root, 'checkout');
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    const commandLog = join(root, 'commands.tsv');
    await Promise.all([mkdir(checkout), mkdir(home), mkdir(bin), writeFile(commandLog, '')]);

    for (const sourcePath of requiredCheckoutFiles) {
      const destination = join(checkout, sourcePath);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(repositoryRoot, sourcePath), destination);
    }

    for (const [name, executable] of Object.entries(safeTools)) {
      await symlink(executable, join(bin, name));
    }
    await createCommandStubs(bin);

    const jam = await createManagedDeployment(root, 'jam', 4101);
    const alesis = await createManagedDeployment(root, 'alesis', 4102);
    const configDirectory = join(home, '.config/jarvis');
    const systemdDirectory = join(home, '.config/systemd/user');
    return {
      root,
      checkout,
      home,
      bin,
      commandLog,
      jam,
      alesis,
      installer: join(checkout, 'deploy/systemd/install.sh'),
      uninstaller: join(checkout, 'deploy/systemd/uninstall.sh'),
      configTool: join(checkout, 'tools/resolve-installation.mjs'),
      reconcileTool: join(checkout, 'tools/reconcile-deployments.mjs'),
      selfManifest: join(checkout, 'jarvis.deployment.json'),
      configDirectory,
      systemdDirectory,
      registry: join(configDirectory, 'deployments.json'),
      index: join(configDirectory, 'deployments.tsv'),
      operatorEnvironment: join(configDirectory, '.env'),
      effectiveEnvironment: join(configDirectory, 'effective.env'),
      installedSelfManifest: join(configDirectory, 'self.deployment.json'),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function createManagedDeployment(root, id, port) {
  const projectRoot = join(root, 'managed', id);
  const runner = join(projectRoot, 'run.sh');
  const manifest = join(projectRoot, 'jarvis.deployment.json');
  const unit = `jarvis-${id}.service`;
  const healthUrl = `http://127.0.0.1:${port}/health`;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(runner, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(manifest, `${JSON.stringify({
    version: 1,
    id,
    name: `${id[0].toUpperCase()}${id.slice(1)} fixture`,
    kind: 'managed',
    systemdUnit: unit,
    runner: 'run.sh',
    build: ['fixture-build', id],
    healthUrl,
    actions: ['start', 'stop', 'restart'],
  }, null, 2)}\n`);
  return { root: projectRoot, runner, manifest, unit, healthUrl };
}

async function createCommandStubs(bin) {
  await Promise.all([
    writeCommandStub(bin, 'node', [
      'record node "$@"',
      'if [[ "$#" -eq 1 && "$1" == "--version" ]]; then',
      '  echo "v20.19.0"',
      '  exit 0',
      'fi',
      'if [[ "$#" -ge 1 && ( "$1" == "$JARVIS_INSTALL_TEST_CONFIG_TOOL" || "$1" == "$JARVIS_INSTALL_TEST_RECONCILE_TOOL" ) ]]; then',
      '  exec "$JARVIS_INSTALL_TEST_REAL_NODE" "$@"',
      'fi',
      'fail "node $*"',
    ]),
    writeCommandStub(bin, 'npm', [
      'record npm "$@"',
      'if [[ "$#" -eq 1 && "$1" == "--version" ]]; then',
      '  echo "10.8.2"',
      '  exit 0',
      'fi',
      'if [[ "$#" -eq 2 && "$1" == "run" && "$2" == "build" ]]; then',
      '  exit "${JARVIS_INSTALL_TEST_NPM_BUILD_STATUS:-0}"',
      'fi',
      'fail "npm $*"',
    ]),
    writeCommandStub(bin, 'fixture-build', [
      'record fixture-build "$PWD" "$@"',
      'if [[ "$#" -eq 1 && ( "$1" == "jam" || "$1" == "alesis" ) ]]; then',
      '  [[ "$1" != "${JARVIS_INSTALL_TEST_FAIL_MANAGED_BUILD:-}" ]] || exit 29',
      '  exit 0',
      'fi',
      'fail "fixture-build $*"',
    ]),
    writeCommandStub(bin, 'systemctl', [
      'record systemctl "$@"',
      '[[ "$#" -ge 2 && "$1" == "--user" ]] || fail "systemctl $*"',
      'verb="$2"',
      'shift 2',
      'case "$verb" in',
      '  daemon-reload)',
      '    [[ "$#" -eq 0 ]] || fail "systemctl daemon-reload $*"',
      '    ;;',
      '  enable|restart|is-active|stop|disable)',
      '    [[ "$#" -gt 0 ]] || fail "systemctl $verb without units"',
      '    for unit in "$@"; do',
      '      case "$unit" in',
      '        jarvis|jarvis-terminal-host|jarvis-jam.service|jarvis-jam-renamed.service|jarvis-alesis.service) ;;',
      '        *) fail "systemctl $verb $unit" ;;',
      '      esac',
      '      [[ "${JARVIS_INSTALL_TEST_FAIL_SYSTEMCTL:-}" != "$verb:$unit" ]] || exit 31',
      '    done',
      '    ;;',
      '  *) fail "systemctl $verb $*" ;;',
      'esac',
    ]),
    writeCommandStub(bin, 'curl', [
      'record curl "$@"',
      'if [[ "$#" -eq 6 && "$1" == "--fail" && "$2" == "--silent" && "$3" == "--show-error" && "$4" == "--max-time" && "$5" == "1" ]]; then',
      '  url="$6"',
      '  case "|$JARVIS_INSTALL_TEST_HEALTH_URLS|" in',
      '    *"|$url|"*) ;;',
      '    *) fail "curl $*" ;;',
      '  esac',
      '  [[ "$url" != "${JARVIS_INSTALL_TEST_FAIL_PROBE_URL:-}" ]] || exit 22',
      '  exit 0',
      'fi',
      'if [[ "$#" -eq 9 && "$1" == "--silent" && "$2" == "--show-error" && "$3" == "--max-time" && "$4" == "1" && "$5" == "--output" && "$7" == "--write-out" && "$8" == "%{http_code}" ]]; then',
      '  url="$9"',
      '  case "|$JARVIS_INSTALL_TEST_HEALTH_URLS|" in',
      '    *"|$url|"*) ;;',
      '    *) fail "curl $*" ;;',
      '  esac',
      '  if [[ "$url" == "${JARVIS_INSTALL_TEST_FAIL_PROBE_URL:-}" ]]; then',
      '    printf \'%s\\n\' "${JARVIS_INSTALL_TEST_PROBE_FAILURE_DETAIL:-probe failed}" > "$6"',
      '    printf \'503\'' ,
      '  else',
      '    printf \'{"ok":true}\\n\' > "$6"',
      '    printf \'200\'' ,
      '  fi',
      '  exit 0',
      'fi',
      'fail "curl $*"',
    ]),
    writeCommandStub(bin, 'sleep', [
      'record sleep "$@"',
      '[[ "$#" -eq 1 && "$1" == "1" ]] || fail "sleep $*"',
    ]),
    writeCommandStub(bin, 'tailscale', [
      'record tailscale "$@"',
      'fail "tailscale must not be executed"',
    ]),
    writeCommandStub(bin, 'copilot', [
      'record copilot "$@"',
      'fail "copilot must not be executed"',
    ]),
  ]);
}

async function writeCommandStub(bin, name, body) {
  const preamble = [
    '#!/bin/bash',
    'set -euo pipefail',
    '',
    'record() {',
    '  local command_name="$1"',
    '  shift',
    '  printf \'%s\' "$command_name" >> "$JARVIS_INSTALL_TEST_COMMAND_LOG"',
    '  for argument in "$@"; do',
    '    printf \'\\t%s\' "$argument" >> "$JARVIS_INSTALL_TEST_COMMAND_LOG"',
    '  done',
    '  printf \'\\n\' >> "$JARVIS_INSTALL_TEST_COMMAND_LOG"',
    '}',
    '',
    'fail() {',
    '  printf \'fixture command rejected: %s\\n\' "$*" >&2',
    '  exit 97',
    '}',
    '',
    'if [[ -n "${DBUS_SESSION_BUS_ADDRESS+x}" || -n "${XDG_RUNTIME_DIR+x}" ]]; then',
    '  fail "live session variables are set"',
    'fi',
    '',
  ];
  const path = join(bin, name);
  await writeFile(path, `${[...preamble, ...body, ''].join('\n')}`, { mode: 0o700 });
  await chmod(path, 0o700);
}

function runInstaller(fixture, {
  arguments: installerArguments = [],
  environment: environmentOverrides = {},
  healthUrls = [],
  failedManagedBuild = '',
  failedSystemctl = '',
  failedProbeUrl = '',
  probeFailureDetail = '',
  npmBuildStatus = 0,
} = {}) {
  const permittedHealthUrls = [
    'http://127.0.0.1:3210/api/health',
    fixture.jam.healthUrl,
    fixture.alesis.healthUrl,
    ...healthUrls,
  ];
  const capabilityUrls = permittedHealthUrls
    .filter((url) => url.endsWith('/api/health'))
    .flatMap((url) => [url.replace(/\/api\/health$/, '/api/readiness'), url.replace(/api\/health$/, '')]);
  const environment = {
    HOME: fixture.home,
    PATH: fixture.bin,
    LANG: 'C',
    LC_ALL: 'C',
    JARVIS_INSTALL_TEST_COMMAND_LOG: fixture.commandLog,
    JARVIS_INSTALL_TEST_CONFIG_TOOL: fixture.configTool,
    JARVIS_INSTALL_TEST_HEALTH_URLS: [...permittedHealthUrls, ...capabilityUrls].join('|'),
    JARVIS_INSTALL_TEST_FAIL_MANAGED_BUILD: failedManagedBuild,
    JARVIS_INSTALL_TEST_FAIL_SYSTEMCTL: failedSystemctl,
    JARVIS_INSTALL_TEST_FAIL_PROBE_URL: failedProbeUrl,
    JARVIS_INSTALL_TEST_PROBE_FAILURE_DETAIL: probeFailureDetail,
    JARVIS_INSTALL_TEST_NPM_BUILD_STATUS: String(npmBuildStatus),
    JARVIS_INSTALL_TEST_REAL_NODE: process.execPath,
    JARVIS_INSTALL_TEST_RECONCILE_TOOL: fixture.reconcileTool,
    ...environmentOverrides,
  };
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(environment.XDG_RUNTIME_DIR, undefined);
  return spawnSync(bashExecutable, [fixture.installer, ...installerArguments], {
    cwd: fixture.checkout,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function runUninstaller(fixture, environmentOverrides = {}) {
  return spawnSync(bashExecutable, [fixture.uninstaller], {
    cwd: fixture.checkout,
    env: {
      HOME: fixture.home,
      PATH: fixture.bin,
      LANG: 'C',
      LC_ALL: 'C',
      JARVIS_INSTALL_TEST_COMMAND_LOG: fixture.commandLog,
      JARVIS_INSTALL_TEST_CONFIG_TOOL: fixture.configTool,
      JARVIS_INSTALL_TEST_REAL_NODE: process.execPath,
      JARVIS_INSTALL_TEST_RECONCILE_TOOL: fixture.reconcileTool,
      ...environmentOverrides,
    },
    input: 'y\n',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

async function writeExistingRegistry(fixture, manifests) {
  await mkdir(fixture.configDirectory, { recursive: true });
  await writeFile(fixture.registry, `${JSON.stringify({ version: 1, manifests }, null, 2)}\n`);
}

async function readRegistry(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function expectedRegistry(fixture, managed = [], healthUrl = undefined, retiringUnits = []) {
  const selfManifest = JSON.parse(await readFile(fixture.selfManifest, 'utf8'));
  const effectiveSelfManifest = { ...selfManifest, healthUrl: healthUrl ?? selfManifest.healthUrl };
  const managedDeployments = await Promise.all(managed.map(async (deployment) => ({
    manifest: JSON.parse(await readFile(deployment.manifest, 'utf8')),
    provenance: { manifestPath: deployment.manifest },
  })));
  return {
    version: 2,
    deployments: [
      { manifest: effectiveSelfManifest, provenance: { manifestPath: fixture.selfManifest } },
      ...managedDeployments,
    ],
    managedUnits: managed.map(({ unit }) => unit),
    retiringUnits,
  };
}

async function assertSharedEffectiveEnvironment(fixture) {
  const expected = new RegExp(`EnvironmentFile=${escapeRegExp(fixture.effectiveEnvironment)}`);
  assert.match(await readFile(join(fixture.systemdDirectory, 'jarvis.service'), 'utf8'), expected);
  assert.match(await readFile(join(fixture.systemdDirectory, 'jarvis-terminal-host.service'), 'utf8'), expected);
}

function assertAbsoluteServicePath(unit) {
  const match = unit.match(/^Environment="PATH=([^"]+)"$/m);
  assert.ok(match, 'service must define PATH');
  const entries = match[1].split(':');
  assert.equal(entries.every((entry) => entry !== '' && entry !== '.' && entry.startsWith('/')), true,
    `service PATH must contain only absolute entries: ${match[1]}`);
}

function expectedSuccessfulCommands(fixture, stageDirectory) {
  const configDirectory = join(fixture.home, '.config/jarvis');
  const systemdDirectory = join(fixture.home, '.config/systemd/user');
  const stageConfigDirectory = join(stageDirectory, 'config');
  const stageSystemdDirectory = join(stageDirectory, 'systemd');
  return [
    [
      'node',
      fixture.configTool,
      'resolve',
      '--operator-env',
      fixture.operatorEnvironment,
      '--previous-effective-env',
      fixture.effectiveEnvironment,
      '--default-registry',
      fixture.registry,
      '--selection',
      'replace',
      '--manifest',
      fixture.jam.manifest,
      '--manifest',
      fixture.alesis.manifest,
    ],
    ['node', '--version'],
    ['npm', '--version'],
    ['npm', 'run', 'build'],
    [
      'node',
      fixture.configTool,
      'write',
      '--effective-env',
      join(stageConfigDirectory, 'effective.env'),
      '--self-output',
      join(stageConfigDirectory, 'self.deployment.json'),
      '--self-template',
      fixture.selfManifest,
      '--host',
      '127.0.0.1',
      '--port',
      '3210',
      '--registry',
      fixture.registry,
      '--health-url',
      'http://127.0.0.1:3210/api/health',
      '--allow-insecure',
      'false',
    ],
    [
      'node',
      fixture.reconcileTool,
      '--build',
      '--build-path',
      fixture.bin,
      '--output',
      join(stageConfigDirectory, 'deployments.tsv'),
      '--registry',
      join(stageConfigDirectory, 'deployments.json'),
      '--systemd-dir',
      stageSystemdDirectory,
      '--template',
      join(fixture.checkout, 'deploy/systemd/managed-deployment.service.template'),
      '--previous-registry',
      fixture.registry,
      '--previous-index',
      fixture.index,
      '--selection',
      'replace',
      '--self-manifest',
      join(stageConfigDirectory, 'self.deployment.json'),
      '--self-provenance',
      fixture.selfManifest,
      fixture.jam.manifest,
      fixture.alesis.manifest,
    ],
    ['fixture-build', fixture.jam.root, 'jam'],
    ['fixture-build', fixture.alesis.root, 'alesis'],
    [
      'node',
      fixture.configTool,
      'publish',
      '--recovery-file',
      join(configDirectory, 'install-publication.json'),
      '--entry',
      join(stageConfigDirectory, 'run-terminal-host.sh'),
      join(configDirectory, 'run-terminal-host.sh'),
      '--entry',
      join(stageSystemdDirectory, 'jarvis.service'),
      join(systemdDirectory, 'jarvis.service'),
      '--entry',
      join(stageSystemdDirectory, 'jarvis-terminal-host.service'),
      join(systemdDirectory, 'jarvis-terminal-host.service'),
      '--entry',
      join(stageSystemdDirectory, fixture.jam.unit),
      join(systemdDirectory, fixture.jam.unit),
      '--entry',
      join(stageSystemdDirectory, fixture.alesis.unit),
      join(systemdDirectory, fixture.alesis.unit),
      '--entry',
      join(stageConfigDirectory, 'self.deployment.json'),
      fixture.installedSelfManifest,
      '--entry',
      join(stageConfigDirectory, 'deployments.tsv'),
      fixture.index,
      '--entry',
      join(stageConfigDirectory, 'deployments.json'),
      fixture.registry,
      '--entry',
      join(stageConfigDirectory, 'effective.env'),
      fixture.effectiveEnvironment,
    ],
    ['node', fixture.configTool, 'inventory', '--registry', fixture.registry],
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', 'jarvis-terminal-host'],
    ['systemctl', '--user', 'enable', 'jarvis'],
    ['systemctl', '--user', 'enable', fixture.jam.unit, fixture.alesis.unit],
    ['systemctl', '--user', 'restart', 'jarvis-terminal-host'],
    ['systemctl', '--user', 'restart', fixture.jam.unit, fixture.alesis.unit],
    ['systemctl', '--user', 'restart', 'jarvis'],
    ['systemctl', '--user', 'is-active', 'jarvis'],
    ['systemctl', '--user', 'is-active', 'jarvis-terminal-host'],
    ['systemctl', '--user', 'is-active', fixture.jam.unit],
    ['systemctl', '--user', 'is-active', fixture.alesis.unit],
    ['curl', '--fail', '--silent', '--show-error', '--max-time', '1', 'http://127.0.0.1:3210/api/health'],
    [
      'curl',
      '--silent',
      '--show-error',
      '--max-time',
      '1',
      '--output',
      join(stageDirectory, 'readiness-body'),
      '--write-out',
      '%{http_code}',
      'http://127.0.0.1:3210/api/readiness',
    ],
    ['curl', '--fail', '--silent', '--show-error', '--max-time', '1', 'http://127.0.0.1:3210/'],
    ['curl', '--fail', '--silent', '--show-error', '--max-time', '1', fixture.jam.healthUrl],
    ['curl', '--fail', '--silent', '--show-error', '--max-time', '1', fixture.alesis.healthUrl],
  ];
}

async function readCommandLog(path) {
  const contents = await readFile(path, 'utf8');
  return contents.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

async function snapshotFiles(root) {
  const files = await listFiles(root);
  return Object.fromEntries(await Promise.all(files.map(async (path) => [
    path,
    (await readFile(join(root, path))).toString('base64'),
  ])));
}

async function listFiles(root) {
  if (!await pathExists(root)) return [];
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(relative(root, path));
    }
  };
  await visit(root);
  return files.sort();
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the inherited PATH before the fixture environment is scrubbed.
    }
  }
  throw new Error(`Required test executable not found: ${name}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatFailure(result) {
  return [
    `status: ${result.status}`,
    `signal: ${result.signal ?? 'none'}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`,
    result.error ? `error: ${result.error.stack ?? result.error.message}` : '',
  ].filter(Boolean).join('\n');
}
