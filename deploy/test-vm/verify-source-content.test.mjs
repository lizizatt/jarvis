import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySourceContent } from './verify-source-content.mjs';

test('attests present image sources and explicitly reports approved omissions', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-vm-source-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const approvedRoot = join(root, 'approved');
  const imageRoot = join(root, 'image');
  const reportPath = join(root, 'report.json');
  await Promise.all([
    mkdir(join(approvedRoot, 'docs'), { recursive: true }),
    mkdir(join(imageRoot, 'docs'), { recursive: true }),
  ]);
  const manifest = `${JSON.stringify({
    formatVersion: 1,
    copied: { tracked: ['package.json', 'docs/in-image.md', 'docs/omitted.md'], candidates: [] },
  }, null, 2)}\n`;
  await Promise.all([
    writeFile(join(approvedRoot, '.jarvis-container-context.json'), manifest),
    writeFile(join(imageRoot, '.jarvis-container-context.json'), manifest),
    writeFile(join(approvedRoot, 'package.json'), '{"name":"fixture"}\n'),
    writeFile(join(imageRoot, 'package.json'), '{"name":"fixture"}\n'),
    writeFile(join(approvedRoot, 'docs/in-image.md'), 'tested\n'),
    writeFile(join(imageRoot, 'docs/in-image.md'), 'tested\n'),
    writeFile(join(approvedRoot, 'docs/omitted.md'), 'not copied by the image build\n'),
  ]);

  const report = await verifySourceContent({ approvedRoot, imageWorkspaceRoot: imageRoot, reportPath });

  assert.deepEqual(report.tested.map(({ path }) => path), ['docs/in-image.md', 'package.json']);
  assert.deepEqual(report.omitted, ['docs/omitted.md']);
  assert.match(report.testedSourceContentSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
});

test('rejects source bytes that differ from the approved context', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-vm-source-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const approvedRoot = join(root, 'approved');
  const imageRoot = join(root, 'image');
  await Promise.all([mkdir(approvedRoot), mkdir(imageRoot)]);
  const manifest = `${JSON.stringify({
    formatVersion: 1,
    copied: { tracked: ['package.json'], candidates: [] },
  })}\n`;
  await Promise.all([
    writeFile(join(approvedRoot, '.jarvis-container-context.json'), manifest),
    writeFile(join(imageRoot, '.jarvis-container-context.json'), manifest),
    writeFile(join(approvedRoot, 'package.json'), 'approved\n'),
    writeFile(join(imageRoot, 'package.json'), 'different\n'),
  ]);

  await assert.rejects(
    verifySourceContent({ approvedRoot, imageWorkspaceRoot: imageRoot, reportPath: join(root, 'report.json') }),
    /differs from approved context-v2: package\.json/,
  );
});
