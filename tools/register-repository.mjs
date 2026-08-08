#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const [pathArgument, nameArgument, branchArgument] = process.argv.slice(2);

if (!pathArgument) {
  console.error('Usage: npm run repo:add -- <path> [display-name] [main-branch]');
  process.exit(2);
}

const requestedPath = resolve(pathArgument);
const { stdout: rootOutput } = await execFileAsync('git', ['-C', requestedPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
const repositoryPath = rootOutput.trim();
if (repositoryPath !== requestedPath) throw new Error(`Path must be the checkout root: ${repositoryPath}`);

let detectedBranch = '';
try {
  const result = await execFileAsync('git', ['-C', repositoryPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
  detectedBranch = result.stdout.trim();
} catch { /* An unborn or detached checkout needs an explicit branch. */ }

const payload = {
  name: nameArgument?.trim() || basename(repositoryPath),
  path: repositoryPath,
  defaultBranch: branchArgument?.trim() || detectedBranch || 'main',
};
const serverUrl = process.env.JARVIS_SERVER_URL || 'http://127.0.0.1:3210';
const response = await fetch(`${serverUrl}/api/repositories`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});
const body = await response.text();
if (!response.ok) throw new Error(`Jarvis rejected repository registration (${response.status}): ${body}`);
console.log(JSON.stringify(JSON.parse(body), null, 2));
