import * as assert from 'node:assert';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeTool } from '../tools';

suite('repository tools', () => {
	test('writes, reads, and exactly replaces repository text while emitting file events', async () => {
		const repositoryPath = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-tools-'));
		const events: string[] = [];
		const context = {
			repositoryPath,
			signal: new AbortController().signal,
			emit: (kind: string) => events.push(kind),
		};

		await executeTool('write_file', { path: 'file.txt', content: 'before' }, context);
		assert.strictEqual(await executeTool('read_file', { path: 'file.txt' }, context), 'before');
		await executeTool('replace_text', { path: 'file.txt', oldText: 'before', newText: 'after' }, context);
		assert.strictEqual(await readFile(path.join(repositoryPath, 'file.txt'), 'utf8'), 'after');
		assert.ok(events.includes('file-written'));
		assert.ok(events.includes('file-read'));
		assert.ok(events.includes('file-changed'));
	});

	test('rejects non-exact text replacement', async () => {
		const repositoryPath = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-tools-'));
		const context = {
			repositoryPath,
			signal: new AbortController().signal,
			emit: () => undefined,
		};
		await executeTool('write_file', { path: 'file.txt', content: 'same same' }, context);
		await assert.rejects(
			executeTool('replace_text', { path: 'file.txt', oldText: 'same', newText: 'new' }, context),
			/exactly once/,
		);
	});

	test('emits structured questions for phone approval', async () => {
		const repositoryPath = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-tools-'));
		const events: Array<{ kind: string; payload: unknown }> = [];
		await executeTool('ask_user', { prompt: 'Push this branch?', choices: ['Yes', 'No'], requiresApproval: true }, {
			repositoryPath,
			signal: new AbortController().signal,
			emit: (kind, payload) => events.push({ kind, payload }),
		});
		assert.ok(events.some(event => event.kind === 'question'
			&& (event.payload as { prompt?: string }).prompt === 'Push this branch?'));
	});
});
