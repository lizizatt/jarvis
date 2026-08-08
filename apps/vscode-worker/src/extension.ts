import * as vscode from 'vscode';
import { runCapabilityTest, WorkerClient } from './worker';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const worker = new WorkerClient(context);
	context.subscriptions.push(
		worker,
		vscode.commands.registerCommand('jarvisCopilotWorker.connect', async () => {
			try {
				await worker.connectFromUserAction();
				void vscode.window.showInformationMessage('Jarvis Copilot Worker connected.');
			} catch (error) {
				void vscode.window.showErrorMessage(`Unable to connect Jarvis Copilot Worker: ${errorMessage(error)}`);
			}
		}),
		vscode.commands.registerCommand('jarvisCopilotWorker.disconnect', async () => {
			await worker.disconnect();
			void vscode.window.showInformationMessage('Jarvis Copilot Worker disconnected.');
		}),
		vscode.commands.registerCommand('jarvisCopilotWorker.showStatus', () => {
			void vscode.window.showInformationMessage(worker.status());
		}),
		vscode.commands.registerCommand('jarvisCopilotWorker.runCapabilityTest', async () => {
			try {
				void vscode.window.showInformationMessage(await runCapabilityTest());
			} catch (error) {
				void vscode.window.showErrorMessage(`Copilot capability test failed: ${errorMessage(error)}`);
			}
		}),
		vscode.lm.onDidChangeChatModels(() => void worker.refreshModels()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => void worker.refreshWorkspaceRoots()),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('jarvisCopilotWorker.serverUrl')) {
				worker.restartTransport();
			}
		}),
	);
	await worker.initialize();
}

export function deactivate(): void {}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
