import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../command';

suite('command execution', () => {
	test('captures output and exit status in the requested cwd', async () => {
		const cwd = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-command-'));
		const result = await runCommand('printf output; printf error >&2; exit 7', cwd, new AbortController().signal);
		assert.strictEqual(result.stdout, 'output');
		assert.strictEqual(result.stderr, 'error');
		assert.strictEqual(result.exitCode, 7);
	});

	test('cancels the spawned process group', async () => {
		const controller = new AbortController();
		let childPid: number | undefined;
		const pending = runCommand('sleep 30 & child=$!; printf "$child"; wait', process.cwd(), controller.signal, {
			onStdout: text => {
				childPid = Number.parseInt(text, 10);
				controller.abort();
			},
		});
		await assert.rejects(pending, /cancelled/);
		if (childPid === undefined) {
			assert.fail('Child PID was not emitted');
		}
		assert.strictEqual(isProcessRunning(childPid), false);
	});
});

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (process.platform !== 'linux') {
			return true;
		}
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
		return state !== 'Z';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH' || (error as NodeJS.ErrnoException).code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}
