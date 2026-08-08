import * as assert from 'node:assert';
import { isToolRoundCheckpoint, nextRepeatedToolRound, toolRoundSignature } from '../agent';

suite('agent tool rounds', () => {
	test('continues past twelve rounds with periodic checkpoints', () => {
		assert.strictEqual(isToolRoundCheckpoint(11), false);
		assert.strictEqual(isToolRoundCheckpoint(12), true);
		assert.strictEqual(isToolRoundCheckpoint(13), false);
		assert.strictEqual(isToolRoundCheckpoint(24), true);
	});

	test('detects identical tool rounds while resetting on progress', () => {
		assert.strictEqual(nextRepeatedToolRound('', 'read:a', 0), 1);
		assert.strictEqual(nextRepeatedToolRound('read:a', 'read:a', 1), 2);
		assert.strictEqual(nextRepeatedToolRound('read:a', 'read:b', 2), 1);
	});

	test('compares tool rounds canonically and includes results', () => {
		const first = toolRoundSignature([{ name: 'read_file', input: { path: 'a', line: 1 }, output: 'one' }]);
		const reordered = toolRoundSignature([{ name: 'read_file', input: { line: 1, path: 'a' }, output: 'one' }]);
		const progressed = toolRoundSignature([{ name: 'read_file', input: { path: 'a', line: 1 }, output: 'two' }]);
		assert.strictEqual(first, reordered);
		assert.notStrictEqual(first, progressed);
	});
});
