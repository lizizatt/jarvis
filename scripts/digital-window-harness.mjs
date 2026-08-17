import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const phase = process.argv.includes('--phase')
  ? process.argv[process.argv.indexOf('--phase') + 1]
  : 'before';
const iteration = process.argv.includes('--iteration')
  ? process.argv[process.argv.indexOf('--iteration') + 1]
  : 'digital-window';
const port = Number(process.env.E2E_PORT ?? 3211);
const externalBase = process.env.PLAYWRIGHT_BASE_URL;
const baseUrl = externalBase ?? `http://127.0.0.1:${port}`;
const outputDir = path.resolve('test-results', 'digital-window', iteration);
const referenceDir = path.resolve('docs/design/look-and-feel-library');
const viewports = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 }
};

if (!['before', 'after'].includes(phase)) {
  throw new Error(`Unknown phase "${phase}". Use --phase before or --phase after.`);
}

await fs.mkdir(outputDir, { recursive: true });

let server;
if (!externalBase) {
  server = spawn(path.resolve('node_modules/.bin/tsx'), ['apps/server/e2e-server.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, E2E_PORT: String(port) }
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The fixture server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function capture(browser, name, viewport) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  try {
    await page.goto(`${baseUrl}/?digitalWindowHarness=${encodeURIComponent(iteration)}`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(1_500);
    const rendererReady = await page.evaluate(async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (document.querySelector('.virtual-window-canvas')?.dataset.ready === 'true') return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    });
    if (!rendererReady) throw new Error('Timed out waiting for the digital window renderer.');
    await page.waitForTimeout(1_200);
    const outputPath = path.join(outputDir, `${phase}-${name}.png`);
    await page.screenshot({ path: outputPath, timeout: 60_000 });
    return outputPath;
  } finally {
    await page.close();
  }
}

try {
  await waitForHealth();
  const browser = await chromium.launch();
  const screenshots = {};
  try {
    for (const [name, viewport] of Object.entries(viewports)) {
      screenshots[name] = await capture(browser, name, viewport);
    }
  } finally {
    await browser.close();
  }

  if (phase === 'after') {
    const beforePaths = Object.fromEntries(
      Object.keys(viewports).map((name) => [name, path.join(outputDir, `before-${name}.png`)])
    );
    for (const beforePath of Object.values(beforePaths)) {
      await fs.access(beforePath);
    }
    const references = (await fs.readdir(referenceDir))
      .filter((file) => /\.(jpe?g)$/i.test(file))
      .sort()
      .map((file) => path.relative(root, path.join(referenceDir, file)));
    const manifest = {
      iteration,
      capturedAt: new Date().toISOString(),
      before: Object.fromEntries(Object.entries(beforePaths).map(([name, file]) => [name, path.relative(root, file)])),
      after: Object.fromEntries(Object.entries(screenshots).map(([name, file]) => [name, path.relative(root, file)])),
      references,
      reviewPrompt: path.relative(root, path.join(outputDir, 'review-prompt.md'))
    };
    await fs.writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(outputDir, 'review-prompt.md'), `# Digital Window Review: ${iteration}

Compare the after screenshots against the before screenshots and every reference in ${path.relative(root, referenceDir)}. Inspect the actual images, then inspect the changed shader source when judging behavior that a still image cannot prove.

Review these dimensions:

- intricate, legible sigil geometry rather than undifferentiated noise
- a visible middle channel that communicates distance and scale through rails, ticks, and nested detail
- an orbital earth marker that remains seated in that channel and has a 600-second full-circle period
- coherent hierarchy, contrast, color, and density across desktop and mobile
- no clipping, accidental overlap, or responsive layout damage

Reply with exactly one status: SATISFIED only when there is no material mismatch, or ITERATE followed by the highest-value concrete change. Do not call a timing behavior satisfied from one still image alone; verify it in source or with a targeted browser probe.
`);
    console.log(`Review manifest: ${path.relative(root, path.join(outputDir, 'manifest.json'))}`);
    console.log(`Review prompt: ${path.relative(root, path.join(outputDir, 'review-prompt.md'))}`);
  }
  console.log(`${phase} screenshots written to ${path.relative(root, outputDir)}`);
} finally {
  server?.kill('SIGTERM');
}
