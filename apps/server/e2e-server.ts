/**
 * Self-contained e2e test server: fixture agent, fresh database, pre-registered "Jarvis Sandbox" repo.
 * Run with tsx; serve the built web dist from apps/web/dist.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from './src/app.js';
import type { ServerConfig } from './src/types.js';

const execFileAsync = promisify(execFile);
const currentDir = dirname(fileURLToPath(import.meta.url));
const fixtureAgent = resolve(currentDir, 'test/fixtures/agent.mjs');
const terminalHostScript = resolve(currentDir, 'src/terminal-host.ts');
const webRoot = resolve(currentDir, '../../apps/web/dist');

const PORT = Number(process.env.E2E_PORT ?? 3211);

async function main(): Promise<void> {
  await chmod(fixtureAgent, 0o755);

  const root = await mkdtemp(join(tmpdir(), 'jarvis-e2e-'));
  const repository = join(root, 'sandbox');
  const dataDir = join(root, 'data');

  await mkdir(repository, { recursive: true });
  await execFileAsync('git', ['-C', repository, 'init', '--initial-branch=main']);
  await execFileAsync('git', ['-C', repository, 'config', 'user.email', 'e2e@jarvis.test']);
  await execFileAsync('git', ['-C', repository, 'config', 'user.name', 'E2E']);
  await writeFile(join(repository, 'README.md'), '# Jarvis Sandbox\n');
  await execFileAsync('git', ['-C', repository, 'add', 'README.md']);
  await execFileAsync('git', ['-C', repository, 'commit', '-m', 'initial']);
  // Unstaged edit so the diff tab has content to display.
  await writeFile(join(repository, 'README.md'), '# Jarvis Sandbox\n\nuncommitted sandbox change\n');

  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: PORT,
    agentExecutable: fixtureAgent,
    agentBackend: 'cli',
    policy: 'E2E TEST POLICY',
    webRoot,
    readinessWebRequired: true,
    terminalHostScript,
    maxJsonLineBytes: 1024 * 1024,
    maxStderrChunkBytes: 64 * 1024,
  };

  const app = await createApp(config);

  const reg = await app.inject({
    method: 'POST',
    url: '/api/repositories',
    payload: { name: 'Jarvis Sandbox', path: repository },
  });
  if (reg.statusCode !== 201) throw new Error(`Repository registration failed: ${reg.body}`);
  const repo = reg.json() as { id: string };

  // Pre-create a terminal session so the terminal panel shows XtermSession immediately.
  await app.inject({ method: 'POST', url: `/api/repositories/${repo.id}/terminals`, payload: { name: 'shell' } });

  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`E2E server ready at http://127.0.0.1:${PORT}`);

  const cleanup = async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  };
  process.once('SIGTERM', () => void cleanup().then(() => process.exit(0)));
  process.once('SIGINT', () => void cleanup().then(() => process.exit(0)));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
