import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeploymentManager } from '../src/deployments.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DeploymentManager', () => {
  it('lists live systemd state and invokes only a declared unit', async () => {
    const fixture = await makeFixture();
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun);

    await expect(manager.list()).resolves.toEqual([
      { id: 'alesis', name: 'Alesis', kind: 'managed', state: 'running', enabled: true,
        healthy: null, actions: ['start', 'stop', 'restart'] },
      { id: 'jarvis', name: 'Jarvis', kind: 'self', state: 'running', enabled: true,
        healthy: null, actions: ['restart'], warning: 'May interrupt active work.' },
    ]);

    await expect(manager.act('alesis', 'stop')).resolves.toEqual({ accepted: true, scheduled: false });
    expect(await readFile(fixture.calls, 'utf8')).toContain('--user stop jarvis-alesis.service');
  });

  it('rejects unknown deployments and forbidden actions without invoking systemd', async () => {
    const fixture = await makeFixture();
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun);

    await expect(manager.act('missing', 'restart')).rejects.toMatchObject({ statusCode: 404 });
    await expect(manager.act('jarvis', 'stop')).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(fixture.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('schedules Jarvis restart outside the server process', async () => {
    const fixture = await makeFixture();
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun);

    await expect(manager.act('jarvis', 'restart')).resolves.toEqual({ accepted: true, scheduled: true });
    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls).toMatch(/^systemd-run --user --unit=jarvis-self-restart-\d+ --on-active=1s .*systemctl --user restart jarvis\.service$/m);
    expect(calls).not.toMatch(/^systemctl .*restart jarvis\.service$/m);
  });

  it('requires absolute allowlisted manifest paths', async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.registry, JSON.stringify({ version: 1, manifests: ['alesis.json'] }));

    await expect(new DeploymentManager(fixture.registry).list()).rejects.toMatchObject({
      statusCode: 500, message: 'Deployment manifest paths must be absolute',
    });
  });
});

async function makeFixture(): Promise<{ root: string; registry: string; systemctl: string; systemdRun: string; calls: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-deployments-'));
  roots.push(root);
  const calls = join(root, 'calls.log');
  const systemctl = join(root, 'systemctl');
  const systemdRun = join(root, 'systemd-run');
  const alesis = join(root, 'alesis.json');
  const jarvis = join(root, 'jarvis.json');
  const registry = join(root, 'registry.json');
  await writeFile(systemctl, `#!/bin/sh
if [ "$2" = show ]; then
  printf '%s\n' 'LoadState=loaded' 'ActiveState=active' 'SubState=running' 'UnitFileState=enabled'
else
  printf 'systemctl %s\n' "$*" >> '${calls}'
fi
`);
  await writeFile(systemdRun, `#!/bin/sh
printf 'systemd-run %s\n' "$*" >> '${calls}'
`);
  await chmod(systemctl, 0o700);
  await chmod(systemdRun, 0o700);
  await writeFile(alesis, JSON.stringify({ version: 1, id: 'alesis', name: 'Alesis', kind: 'managed',
    systemdUnit: 'jarvis-alesis.service', runner: 'deploy/run-jarvis.sh', actions: ['start', 'stop', 'restart'] }));
  await writeFile(jarvis, JSON.stringify({ version: 1, id: 'jarvis', name: 'Jarvis', kind: 'self',
    systemdUnit: 'jarvis.service', actions: ['restart'], warning: 'May interrupt active work.' }));
  await writeFile(registry, JSON.stringify({ version: 1, manifests: [alesis, jarvis] }));
  return { root, registry, systemctl, systemdRun, calls };
}
