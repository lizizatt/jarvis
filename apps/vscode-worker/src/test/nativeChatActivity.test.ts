import * as assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
const script = path.resolve(__dirname, '../../resources/native_chat_activity.py');

suite('native chat activity', () => {
	test('classifies only chat-scoped accessible controls', async () => {
		assert.strictEqual(await classify([{ role: 'push button', name: 'Stop', ancestors: ['Chat'] }]), 'thinking');
		assert.strictEqual(await classify([{ role: 'push button', name: 'Allow Once', ancestors: ['Chat'] }]), 'needs-input');
		assert.strictEqual(await classify([{ role: 'button', name: 'Cancel generation (Esc)', ancestors: ['Copilot Chat'] }]), 'thinking');
		assert.strictEqual(await classify([{ role: 'toggle button', name: 'Approve', ancestors: ['Agent'] }]), 'needs-input');
		assert.strictEqual(await classify([
			{ role: 'push button', name: 'Stop', ancestors: ['Debug Toolbar'] },
			{ role: 'text', name: 'Stop', ancestors: ['Chat'] },
		]), 'idle');
	});
	test('matches workspace names as exact title segments', async () => {
		assert.strictEqual(await matchesWindow('README.md - saildrone - Visual Studio Code', ['saildrone']), 'true');
		assert.strictEqual(await matchesWindow('saildrone-2 - Visual Studio Code', ['saildrone']), 'false');
		assert.strictEqual(await matchesWindow('saildrone-2 - Visual Studio Code', ['saildrone-2']), 'true');
	});
	test('matches the JSON window-name array used by the monitor', async () => {
		assert.strictEqual(await matchesMonitorWindow('README.md - saildrone - Visual Studio Code', JSON.stringify(['saildrone'])), 'true');
	});
});

async function classify(controls: Array<{ role: string; name: string; ancestors: string[] }>): Promise<string> {
	const result = await execFileAsync('/usr/bin/python3', [script, '--classify', JSON.stringify(controls)]);
	return result.stdout.trim();
}

async function matchesWindow(title: string, names: string[]): Promise<string> {
	const result = await execFileAsync('/usr/bin/python3', [script, '--match-window', JSON.stringify({ title, names })]);
	return result.stdout.trim();
}

async function matchesMonitorWindow(title: string, window: string): Promise<string> {
	const result = await execFileAsync('/usr/bin/python3', [script, '--match-monitor-window', JSON.stringify({ title, window })]);
	return result.stdout.trim();
}
