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
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun, fixture.tailscale);

    await expect(manager.list()).resolves.toEqual([
      { id: 'alesis', name: 'Alesis', kind: 'managed', state: 'running', enabled: true,
        healthy: false, actions: ['start', 'stop', 'restart'], homeUrl: 'https://jarvis.example.ts.net:8787/' },
      { id: 'jarvis', name: 'Jarvis', kind: 'self', state: 'running', enabled: true,
        healthy: null, actions: ['restart'], warning: 'May interrupt active work.' },
    ]);

    await expect(manager.act('alesis', 'stop')).resolves.toEqual({ accepted: true, scheduled: false });
    expect(await readFile(fixture.calls, 'utf8')).toContain('--user stop jarvis-alesis.service');
  });

  it('uses v2 snapshots when provenance source manifests are unavailable', async () => {
    const fixture = await makeFixture();
    const alesisManifest = JSON.parse(await readFile(fixture.alesis, 'utf8'));
    const jarvisManifest = JSON.parse(await readFile(fixture.jarvis, 'utf8'));
    await writeFile(fixture.registry, JSON.stringify({
      version: 2,
      deployments: [
        { manifest: alesisManifest, provenance: { manifestPath: fixture.alesis } },
        { manifest: jarvisManifest, provenance: { manifestPath: fixture.jarvis } },
      ],
      managedUnits: ['jarvis-alesis.service'],
      retiringUnits: [],
    }));
    await Promise.all([rm(fixture.alesis), rm(fixture.jarvis)]);
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun, fixture.tailscale);

    await expect(manager.list()).resolves.toEqual([
      { id: 'alesis', name: 'Alesis', kind: 'managed', state: 'running', enabled: true,
        healthy: false, actions: ['start', 'stop', 'restart'], homeUrl: 'https://jarvis.example.ts.net:8787/' },
      { id: 'jarvis', name: 'Jarvis', kind: 'self', state: 'running', enabled: true,
        healthy: null, actions: ['restart'], warning: 'May interrupt active work.' },
    ]);
    await expect(manager.act('alesis', 'restart')).resolves.toEqual({ accepted: true, scheduled: false });
    expect(await readFile(fixture.calls, 'utf8')).toContain('--user restart jarvis-alesis.service');
  });

  it('rejects unknown deployments and forbidden actions without invoking systemd', async () => {
    const fixture = await makeFixture();
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun, fixture.tailscale);

    await expect(manager.act('missing', 'restart')).rejects.toMatchObject({ statusCode: 404 });
    await expect(manager.act('jarvis', 'stop')).rejects.toMatchObject({ statusCode: 409 });
    await expect(readFile(fixture.calls, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('schedules Jarvis restart outside the server process', async () => {
    const fixture = await makeFixture();
    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun, fixture.tailscale);

    await expect(manager.act('jarvis', 'restart')).resolves.toEqual({ accepted: true, scheduled: true });
    const calls = await readFile(fixture.calls, 'utf8');
    expect(calls).toMatch(/^systemd-run --user --unit=jarvis-self-restart-\d+ --on-active=1s .*systemctl --user restart jarvis\.service$/m);
    expect(calls).not.toMatch(/^systemctl .*restart jarvis\.service$/m);
  });

  it('accepts a configured non-loopback health URL for the self deployment', async () => {
    const fixture = await makeFixture();
    const manifest = JSON.parse(await readFile(fixture.jarvis, 'utf8'));
    await writeFile(fixture.jarvis, JSON.stringify({ ...manifest, healthUrl: 'http://192.0.2.10:4321/api/health' }));

    const manager = new DeploymentManager(fixture.registry, fixture.systemctl, fixture.systemdRun, fixture.tailscale);

    await expect(manager.act('jarvis', 'restart')).resolves.toEqual({ accepted: true, scheduled: true });
  });

  it('requires absolute allowlisted manifest paths', async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.registry, JSON.stringify({ version: 1, manifests: ['alesis.json'] }));

    await expect(new DeploymentManager(fixture.registry).list()).rejects.toMatchObject({
      statusCode: 500, message: 'Deployment manifest paths must be absolute',
    });
  });
});

async function makeFixture(): Promise<{ root: string; registry: string; systemctl: string; systemdRun: string; tailscale: string; calls: string; alesis: string; jarvis: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-deployments-'));
  roots.push(root);
  const calls = join(root, 'calls.log');
  const systemctl = join(root, 'systemctl');
  const systemdRun = join(root, 'systemd-run');
  const tailscale = join(root, 'tailscale');
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
  await writeFile(tailscale, `#!/bin/sh
printf '%s' '{"Web":{"jarvis.example.ts.net:8787":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:29999"}}}}}'
`);
  await chmod(systemctl, 0o700);
  await chmod(systemdRun, 0o700);
  await chmod(tailscale, 0o700);
  await writeFile(alesis, JSON.stringify({ version: 1, id: 'alesis', name: 'Alesis', kind: 'managed',
    systemdUnit: 'jarvis-alesis.service', runner: 'deploy/run-jarvis.sh', healthUrl: 'http://127.0.0.1:29999/health', actions: ['start', 'stop', 'restart'] }));
  await writeFile(jarvis, JSON.stringify({ version: 1, id: 'jarvis', name: 'Jarvis', kind: 'self',
    systemdUnit: 'jarvis.service', actions: ['restart'], warning: 'May interrupt active work.' }));
  await writeFile(registry, JSON.stringify({ version: 1, manifests: [alesis, jarvis] }));
  return { root, registry, systemctl, systemdRun, tailscale, calls, alesis, jarvis };
}
