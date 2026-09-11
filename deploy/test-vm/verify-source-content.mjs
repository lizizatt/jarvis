#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contextManifestName = '.jarvis-container-context.json';

export async function verifySourceContent({ approvedRoot, imageWorkspaceRoot, reportPath }) {
  const approvedManifestPath = resolve(approvedRoot, contextManifestName);
  const imageManifestPath = resolve(imageWorkspaceRoot, contextManifestName);
  const [approvedManifestBytes, imageManifestBytes] = await Promise.all([
    readFile(approvedManifestPath),
    readFile(imageManifestPath),
  ]);
  if (!approvedManifestBytes.equals(imageManifestBytes)) {
    throw new Error('Image context manifest does not match the approved context-v2 manifest');
  }

  const manifest = JSON.parse(approvedManifestBytes.toString('utf8'));
  const tracked = manifest?.copied?.tracked;
  const candidates = manifest?.copied?.candidates;
  if (manifest?.formatVersion !== 1 || !Array.isArray(tracked) || !Array.isArray(candidates)) {
    throw new Error('Approved context-v2 manifest has an unsupported shape');
  }

  const paths = [...new Set([...tracked, ...candidates])].sort();
  const tested = [];
  const omitted = [];
  for (const path of paths) {
    assertRelativePath(path);
    const approvedPath = resolve(approvedRoot, path);
    const imagePath = resolve(imageWorkspaceRoot, path);
    const approvedBytes = await readContainedFile(approvedRoot, approvedPath, `Approved source ${path}`);
    if (!await pathExists(imagePath)) {
      omitted.push(path);
      continue;
    }
    const imageBytes = await readContainedFile(imageWorkspaceRoot, imagePath, `Image source ${path}`);
    const approvedSha256 = sha256(approvedBytes);
    const imageSha256 = sha256(imageBytes);
    if (approvedSha256 !== imageSha256) {
      throw new Error(`Image source content differs from approved context-v2: ${path}`);
    }
    tested.push({ path, sha256: imageSha256 });
  }
  if (tested.length === 0) throw new Error('Image contains no manifest-listed source files to attest');

  const contentHasher = createHash('sha256');
  for (const entry of tested) {
    contentHasher.update(entry.path);
    contentHasher.update('\0');
    contentHasher.update(entry.sha256);
    contentHasher.update('\n');
  }
  const report = {
    formatVersion: 1,
    approvedManifestSha256: sha256(approvedManifestBytes),
    testedSourceContentSha256: contentHasher.digest('hex'),
    tested,
    omitted,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

function assertRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\0')) {
    throw new Error(`Approved context contains an invalid source path: ${String(path)}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Approved context contains an unsafe source path: ${path}`);
  }
}

async function readContainedFile(root, path, label) {
  const [canonicalRoot, stat] = await Promise.all([realpath(root), lstat(path)]);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${label} is not a file`);
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error(`${label} resolves outside its root`);
  }
  return readFile(path);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [approvedRoot, imageWorkspaceRoot, reportPath] = process.argv.slice(2);
  if (!approvedRoot || !imageWorkspaceRoot || !reportPath) {
    console.error('Usage: verify-source-content.mjs <approved-context-root> <image-workspace-root> <report-path>');
    process.exitCode = 2;
  } else {
    verifySourceContent({ approvedRoot, imageWorkspaceRoot, reportPath }).catch((error) => {
      console.error(`Source content validation failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
