#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
process.stdout.write(`${JSON.stringify({ type: 'fixture_start', args })}\n`);

if (prompt.includes('DENY')) process.stderr.write('permission denied by policy\n');
if (prompt.includes('ASK')) process.stdout.write(`${JSON.stringify({ type: 'question', text: 'Choose one' })}\n`);

if (prompt.includes('HANG')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.stdout.write(`${JSON.stringify({ type: 'child', pid: child.pid })}\n`);
  setInterval(() => process.stdout.write(`${JSON.stringify({ type: 'tick' })}\n`), 1000);
} else {
  process.stdout.write('plain output\n');
  setTimeout(() => process.exit(prompt.includes('FAIL') ? 2 : 0), 30);
}
