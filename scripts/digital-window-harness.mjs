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
const deviceScaleFactor = Number(process.env.DIGITAL_WINDOW_DEVICE_SCALE ?? 0.75);
const rendererReadyTimeout = Number(process.env.DIGITAL_WINDOW_RENDERER_TIMEOUT_MS ?? 30_000);
const captureMode = process.env.DIGITAL_WINDOW_CAPTURE ?? 'canvas';
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
  const startedAt = Date.now();
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  const requestFailures = [];
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown error'}`);
  });
  try {
    console.log(`[harness] ${phase}/${name}: navigating`);
    await page.goto(`${baseUrl}/?digitalWindowHarness=${encodeURIComponent(iteration)}`, {
      waitUntil: 'domcontentloaded'
    });
    await page.waitForTimeout(1_500);
    const rendererReady = await page.evaluate(async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (document.querySelector('.virtual-window-canvas')?.dataset.ready === 'true') return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, rendererReadyTimeout);
    if (!rendererReady) {
      const canvasSize = await page.evaluate(() => {
        const canvas = document.querySelector('.virtual-window-canvas');
        return canvas ? `${canvas.width}x${canvas.height}` : 'missing';
      }).catch(() => 'page-unavailable');
      throw new Error(`Timed out waiting for the digital window renderer after ${rendererReadyTimeout}ms (canvas ${canvasSize}; request failures: ${requestFailures.join('; ') || 'none'}).`);
    }
    console.log(`[harness] ${phase}/${name}: renderer ready after ${Date.now() - startedAt}ms`);
    await page.waitForTimeout(1_200);
    const outputPath = path.join(outputDir, `${phase}-${name}.png`);
    if (captureMode === 'canvas') {
      const dataUrl = await page.evaluate(() => {
        const canvas = document.querySelector('.virtual-window-canvas');
        return canvas?.toDataURL('image/png') ?? null;
      });
      if (!dataUrl?.startsWith('data:image/png;base64,')) throw new Error('Digital window canvas could not be encoded.');
      await fs.writeFile(outputPath, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
    } else if (captureMode === 'viewport') {
      await page.screenshot({ path: outputPath, timeout: 30_000 });
    } else {
      throw new Error(`Unknown DIGITAL_WINDOW_CAPTURE mode "${captureMode}". Use canvas or viewport.`);
    }
    console.log(`[harness] ${phase}/${name}: screenshot complete after ${Date.now() - startedAt}ms`);
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
  if (server && server.exitCode === null) {
    await new Promise((resolve) => {
      const cleanupTimer = setTimeout(() => {
        server.kill('SIGKILL');
        resolve();
      }, 5_000);
      server.once('exit', () => {
        clearTimeout(cleanupTimer);
        resolve();
      });
      server.kill('SIGTERM');
    });
  }
}
