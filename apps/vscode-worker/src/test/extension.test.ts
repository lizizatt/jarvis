import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('extension activation', () => {
	test('registers Jarvis worker commands', async () => {
		const extension = vscode.extensions.all.find(candidate => candidate.packageJSON.name === 'jarvis-copilot-worker');
		assert.ok(extension, 'Jarvis Copilot Worker extension was not loaded');
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('jarvisCopilotWorker.connect'));
		assert.ok(commands.includes('jarvisCopilotWorker.disconnect'));
		assert.ok(commands.includes('jarvisCopilotWorker.showStatus'));
		assert.ok(commands.includes('jarvisCopilotWorker.runCapabilityTest'));
	});
});
