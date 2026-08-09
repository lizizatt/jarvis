import * as assert from 'node:assert';
import { boundedHistory, isToolRoundCheckpoint, nextRepeatedToolRound, toolRoundSignature } from '../agent';

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

suite('boundedHistory', () => {
	const entry = (content: string) => ({ role: 'user' as const, content });

	test('returns empty array when the only entry exceeds the budget', () => {
		// With maxInputTokens=100 and reservedCharacters=0, budget = max(8000, 100*3 - 0 - 12000) = max(8000, -11700) = 8000
		// Use a tiny budget via absurdly small maxInputTokens to force the entry over budget
		const big = entry('x'.repeat(10_000));
		const result = boundedHistory([big], 1, 0);
		assert.deepStrictEqual(result, []);
	});

	test('includes all entries that fit within the budget', () => {
		// budget = max(8000, 10000*3 - 0 - 12000) = max(8000, 18000) = 18000
		const small = entry('x'.repeat(100));
		const result = boundedHistory([small, small, small], 10_000, 0);
		assert.strictEqual(result.length, 3);
	});

	test('excludes oldest entries when total exceeds budget', () => {
		// budget = max(8000, 10000*3 - 0 - 12000) = 18000
		// 200 entries × 100 chars = 20000 > 18000; most recent ones fit
		const small = entry('x'.repeat(100));
		const history = Array.from({ length: 200 }, () => small);
		const result = boundedHistory(history, 10_000, 0);
		assert.ok(result.length < 200, 'oldest entries should be trimmed');
		assert.ok(result.length > 0, 'recent entries should be included');
	});
});
