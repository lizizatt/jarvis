import * as assert from 'node:assert';
import { parseServerMessage } from '../protocol';

suite('worker protocol', () => {
	test('parses version-two turn and cancel messages', () => {
		const turn = parseServerMessage(JSON.stringify({
			version: 2, type: 'turn', taskId: 'task', sessionId: 'session', repositoryPath: '/repo', modelId: 'auto', clientConversationId: 'chat-key',
			policy: '', prompt: 'Fix it', history: [{ role: 'user', content: 'Earlier' }],
		}));
		assert.strictEqual(turn.type, 'turn');
		assert.strictEqual(turn.taskId, 'task');
		assert.strictEqual(turn.clientConversationId, 'chat-key');
		assert.deepStrictEqual(parseServerMessage('{"version":2,"type":"cancel","taskId":"task"}'), {
			version: 2, type: 'cancel', taskId: 'task',
		});
		assert.deepStrictEqual(parseServerMessage('{"version":2,"type":"ready","workerId":"worker"}'), {
			version: 2, type: 'ready', workerId: 'worker',
		});
	});

	test('rejects malformed and unsupported messages', () => {
		assert.throws(() => parseServerMessage('nope'), /valid JSON/);
		assert.throws(() => parseServerMessage('{"version":2,"type":"turn"}'), /history/);
		assert.throws(() => parseServerMessage('{"version":2,"type":"other"}'), /Unsupported/);
		assert.throws(() => parseServerMessage('{"version":1,"type":"cancel","taskId":"task"}'), /version/);
	});
});
