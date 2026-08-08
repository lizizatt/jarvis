import * as assert from 'node:assert';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPathInside, resolveExistingPath, resolveWritablePath } from '../paths';

suite('path containment', () => {
	test('accepts contained paths and rejects traversal and symlink escapes', async () => {
		const base = await mkdtemp(path.join(tmpdir(), 'jarvis-worker-path-'));
		const root = path.join(base, 'repo');
		const outside = path.join(base, 'outside');
		await mkdir(root);
		await mkdir(outside);
		await writeFile(path.join(root, 'inside.txt'), 'inside');
		await writeFile(path.join(outside, 'outside.txt'), 'outside');
		await symlink(outside, path.join(root, 'escape'));
		await symlink(path.join(outside, 'outside.txt'), path.join(root, 'file-link'));
		await symlink(path.join(outside, 'missing.txt'), path.join(root, 'dangling-link'));

		assert.strictEqual(isPathInside(root, path.join(root, 'inside.txt')), true);
		assert.strictEqual(isPathInside(root, outside), false);
		assert.strictEqual(await resolveExistingPath(root, 'inside.txt'), path.join(root, 'inside.txt'));
		await assert.rejects(resolveExistingPath(root, '../outside/outside.txt'), /outside/);
		await assert.rejects(resolveExistingPath(root, 'escape/outside.txt'), /outside/);
		await assert.rejects(resolveWritablePath(root, 'escape/new.txt'), /outside/);
		await assert.rejects(resolveWritablePath(root, 'file-link'), /outside/);
		await assert.rejects(resolveWritablePath(root, 'dangling-link'), /symbolic link/);
	});
});
