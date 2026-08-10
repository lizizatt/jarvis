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

	test('returns empty array when the only entry exceeds a small model budget', () => {
		const big = entry('x'.repeat(289));
		const result = boundedHistory([big], 4_096, 0);
		assert.deepStrictEqual(result, []);
	});

	test('includes all entries that fit within the budget', () => {
		// budget = max(8000, 10000*3 - 0 - 12000) = max(8000, 18000) = 18000
		const small = entry('x'.repeat(100));
		const result = boundedHistory([small, small, small], 10_000, 0);
		assert.strictEqual(result.length, 3);
	});

	test('trims leading assistant entries left by a budget cut mid-history', () => {
		// budget = max(8000, 10000*3 - 0 - 12000) = 18000
		// history: user(100) + assistant(17901) + user(100) — last two fit (18001 > 18000), so only user(100) fits
		// After budget cut, if assistant were retained as first entry it must be dropped
		const user = { role: 'user' as const, content: 'u'.repeat(100) };
		const bigAssistant = { role: 'assistant' as const, content: 'a'.repeat(17_901) };
		const history = [user, bigAssistant, user];
		const result = boundedHistory(history, 10_000, 0);
		assert.ok(result.length === 0 || result[0].role === 'user', 'history must not start with assistant');
	});

	test('excludes oldest entries when total exceeds budget', () => {
		// budget = max(8000, 10000*3 - 0 - 12000) = 18000; 200 × 100 = 20000 > 18000
		const small = entry('x'.repeat(100));
		const history = Array.from({ length: 200 }, () => small);
		const result = boundedHistory(history, 10_000, 0);
		assert.ok(result.length < 200, 'oldest entries should be trimmed');
		assert.ok(result.length > 0, 'recent entries should be included');
	});
});
