import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PortForwarder, validatePort } from '../src/port-forwarding.js';

describe('PortForwarder', () => {
  it('exposes a loopback port and returns its Tailnet HTTPS URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-tailscale-'));
    const executable = join(directory, 'tailscale');
    const calls = join(directory, 'calls');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
if [ "$1" = status ]; then printf '%s' '{"Self":{"DNSName":"jarvis.example.ts.net."}}'; fi
`);
    await chmod(executable, 0o700);

    await expect(new PortForwarder(executable).expose(8080)).resolves.toEqual({
      port: 8080,
      url: 'https://jarvis.example.ts.net:8080/',
    });
    expect(await readFile(calls, 'utf8')).toBe([
      'status --json',
      'serve --bg --yes --https=8080 http://127.0.0.1:8080',
      '',
    ].join('\n'));
  });

  it('rejects invalid ports', () => {
    for (const port of [0, 65_536, 1.5, Number.NaN]) expect(() => validatePort(port)).toThrow('port must be an integer');
  });

  it('turns off a previously exposed port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-tailscale-'));
    const executable = join(directory, 'tailscale');
    const calls = join(directory, 'calls');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
`);
    await chmod(executable, 0o700);

    await new PortForwarder(executable).close(8080);
    expect(await readFile(calls, 'utf8')).toBe('serve --yes --https=8080 off\n');
  });

  it('lists self-mapped forwards while excluding the primary Jarvis binding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-tailscale-'));
    const executable = join(directory, 'tailscale');
    await writeFile(executable, `#!/bin/sh
if [ "$1" = serve ] && [ "$2" = status ]; then printf '%s' '{"Web":{"jarvis.example.ts.net:8080":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8080/"}}},"jarvis.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3210/"}}}}}'; fi
`);
    await chmod(executable, 0o700);

    await expect(new PortForwarder(executable).list()).resolves.toEqual([
      { port: 8080, url: 'https://jarvis.example.ts.net:8080/' },
    ]);
  });
});
