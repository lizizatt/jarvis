import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { runAgentTurn } from './agent';
import {
	EventMessage,
	HelloMessage,
	ModelMetadata,
	parseServerMessage,
	TerminalMessage,
	TurnMessage,
	WORKER_PROTOCOL_VERSION,
} from './protocol';

const ENABLED_KEY = 'jarvis-copilot-worker.enabled';

interface RunningTurn {
	modelCancellation: vscode.CancellationTokenSource;
	toolCancellation: AbortController;
}

export class WorkerClient implements vscode.Disposable {
	private readonly instanceWorkerId = randomUUID();
	private socket: WebSocket | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private reconnectAttempt = 0;
	private models: vscode.LanguageModelChat[] = [];
	private workspaceRoots: string[] = [];
	private readonly runningTurns = new Map<string, RunningTurn>();
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	async initialize(): Promise<void> {
		await this.refreshWorkspaceRoots();
		if (this.isEnabled()) {
			await this.refreshModels();
			this.openSocket();
		}
	}

	async connectFromUserAction(): Promise<void> {
		this.models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		if (this.models.length === 0) {
			throw new Error('No Copilot language models are available. Check your Copilot sign-in and subscription.');
		}
		await this.context.globalState.update(ENABLED_KEY, true);
		this.reconnectAttempt = 0;
		this.openSocket();
	}

	async disconnect(): Promise<void> {
		await this.context.globalState.update(ENABLED_KEY, false);
		this.clearReconnect();
		for (const running of this.runningTurns.values()) {
			running.modelCancellation.cancel();
			running.toolCancellation.abort();
		}
		this.socket?.close(1000, 'Disconnected by user');
		this.socket = undefined;
	}

	async refreshModels(): Promise<void> {
		this.models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.sendHello();
		}
	}

	async refreshWorkspaceRoots(): Promise<void> {
		this.workspaceRoots = await getWorkspaceRoots();
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.sendHello();
		}
	}

	restartTransport(): void {
		if (!this.isEnabled()) {
			return;
		}
		this.clearReconnect();
		this.socket?.close(1000, 'Configuration changed');
		this.socket = undefined;
		this.reconnectAttempt = 0;
		this.openSocket();
	}

	status(): string {
		const connection = this.socket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
		return `Jarvis Copilot Worker is ${this.isEnabled() ? 'enabled' : 'disabled'} and ${connection}. `
			+ `${this.models.length} Copilot model(s), ${this.workspaceRoots.length} workspace root(s), `
			+ `${this.runningTurns.size} active turn(s).`;
	}

	dispose(): void {
		this.disposed = true;
		this.clearReconnect();
		this.socket?.close();
		for (const running of this.runningTurns.values()) {
			running.modelCancellation.cancel();
			running.toolCancellation.abort();
			running.modelCancellation.dispose();
		}
		this.runningTurns.clear();
	}

	private openSocket(): void {
		if (this.disposed || !this.isEnabled()) {
			return;
		}
		this.clearReconnect();
		if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
			return;
		}

		const url = vscode.workspace.getConfiguration('jarvisCopilotWorker').get<string>(
			'serverUrl', 'ws://127.0.0.1:3210/ws/workers',
		);
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
			this.socket = socket;
		} catch (error) {
			this.scheduleReconnect();
			void vscode.window.showErrorMessage(`Jarvis worker connection failed: ${errorMessage(error)}`);
			return;
		}
		socket.addEventListener('open', () => {
			this.reconnectAttempt = 0;
			this.sendHello();
		});
		socket.addEventListener('message', event => {
			void this.receiveMessage(event.data).catch(error => {
				void vscode.window.showErrorMessage(`Jarvis worker message failed: ${errorMessage(error)}`);
			});
		});
		socket.addEventListener('close', () => {
			this.cancelRunningTurns();
			if (this.socket === socket) {
				this.socket = undefined;
			}
			this.scheduleReconnect();
		});
		socket.addEventListener('error', () => socket.close());
	}

	private cancelRunningTurns(): void {
		for (const running of this.runningTurns.values()) {
			running.modelCancellation.cancel();
			running.toolCancellation.abort();
		}
	}

	private async receiveMessage(data: unknown): Promise<void> {
		const raw = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
		const message = parseServerMessage(raw);
		if (message.type === 'ready') {
			return;
		}
		if (message.type === 'cancel') {
			const running = this.runningTurns.get(message.taskId);
			running?.modelCancellation.cancel();
			running?.toolCancellation.abort();
			return;
		}
		void this.startTurn(message);
	}

	private async startTurn(turn: TurnMessage): Promise<void> {
		if (this.runningTurns.has(turn.taskId)) {
			this.sendTerminal({ type: 'failed', version: WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { error: 'Task is already running' } });
			return;
		}
		const modelCancellation = new vscode.CancellationTokenSource();
		const toolCancellation = new AbortController();
		this.runningTurns.set(turn.taskId, { modelCancellation, toolCancellation });
		try {
			const repositoryPath = await canonicalPath(turn.repositoryPath);
			throwIfCancelled(modelCancellation, toolCancellation);
			if (!repositoryPath || !this.workspaceRoots.includes(repositoryPath)) {
				throw new Error('Repository is not an exact open workspace root');
			}
			turn.repositoryPath = repositoryPath;
			const model = chooseModel(this.models);
			if (!model) {
				throw new Error('No Copilot model is available');
			}
			this.sendEvent(turn.taskId, 'turn-started', { sessionId: turn.sessionId, model: modelMetadata(model) });
			const text = await runAgentTurn(model, turn, {
				token: modelCancellation.token,
				signal: toolCancellation.signal,
			}, { emit: (kind, payload) => this.sendEvent(turn.taskId, kind, payload) });
			this.sendTerminal({ type: 'complete', version: WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { text } });
		} catch (error) {
			if (modelCancellation.token.isCancellationRequested || toolCancellation.signal.aborted) {
				this.sendTerminal({ type: 'stopped', version: WORKER_PROTOCOL_VERSION, taskId: turn.taskId });
			} else {
				this.sendTerminal({ type: 'failed', version: WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { error: errorMessage(error) } });
			}
		} finally {
			this.runningTurns.delete(turn.taskId);
			modelCancellation.dispose();
		}
	}

	private sendHello(): void {
		this.send({
			type: 'hello',
			version: WORKER_PROTOCOL_VERSION,
			workerId: this.workerId(),
			windowName: vscode.workspace.name ?? vscode.env.appName,
			workspaceRoots: this.workspaceRoots,
			models: this.models.map(modelMetadata),
		});
	}

	private sendEvent(taskId: string, kind: string, payload: unknown): void {
		this.send({ type: 'event', version: WORKER_PROTOCOL_VERSION, taskId, kind, payload });
	}

	private sendTerminal(message: TerminalMessage): void {
		this.send(message);
	}

	private send(message: HelloMessage | EventMessage | TerminalMessage): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	private workerId(): string {
		return this.instanceWorkerId;
	}

	private isEnabled(): boolean {
		return this.context.globalState.get<boolean>(ENABLED_KEY, false);
	}

	private scheduleReconnect(): void {
		if (this.disposed || !this.isEnabled() || this.reconnectTimer) {
			return;
		}
		const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
		this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.openSocket();
		}, delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}
}

export async function runCapabilityTest(): Promise<string> {
	const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
	const model = chooseModel(models);
	if (!model) {
		throw new Error('No Copilot language model is available');
	}
	const response = await model.sendRequest([
		vscode.LanguageModelChatMessage.User('Reply with exactly: Jarvis Copilot capability available'),
	], { justification: 'Manually verify Jarvis access to a Copilot language model.' });
	let text = '';
	for await (const chunk of response.text) {
		text += chunk;
	}
	return `${model.name}: ${text}`;
}

function chooseModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat | undefined {
	const preferred = vscode.workspace.getConfiguration('jarvisCopilotWorker').get<string>('preferredModel', '').trim().toLowerCase();
	if (!preferred) {
		return models.find(model => model.id === 'auto') ?? models[0];
	}
	return models.find(model => [model.id, model.family, model.name].some(value => value.toLowerCase() === preferred))
		?? models.find(model => [model.id, model.family, model.name].some(value => value.toLowerCase().includes(preferred)))
		?? models[0];
}

function modelMetadata(model: vscode.LanguageModelChat): ModelMetadata {
	return {
		id: model.id,
		name: model.name,
		vendor: model.vendor,
		family: model.family,
		version: model.version,
		maxInputTokens: model.maxInputTokens,
	};
}

async function getWorkspaceRoots(): Promise<string[]> {
	return Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => realpath(folder.uri.fsPath)));
}

async function canonicalPath(candidate: string): Promise<string | undefined> {
	try {
		return await realpath(candidate);
	} catch {
		return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function throwIfCancelled(model: vscode.CancellationTokenSource, tools: AbortController): void {
	if (model.token.isCancellationRequested || tools.signal.aborted) {
		throw new vscode.CancellationError();
	}
}
