export const WORKER_PROTOCOL_VERSION = 2 as const;

export interface ModelMetadata {
	id: string;
	name: string;
	vendor: string;
	family: string;
	version: string;
	maxInputTokens: number;
}

export interface HelloMessage {
	type: 'hello';
	version: typeof WORKER_PROTOCOL_VERSION;
	workerId: string;
	windowName: string;
	windowPid?: number;
	workspaceRoots: string[];
	models: ModelMetadata[];
	presence: WorkerPresence;
}

export interface WorkerPresence {
	focused: boolean;
	active: boolean;
	updatedAt: string;
}

export interface TurnHistoryEntry {
	role: 'user' | 'assistant';
	content: string;
}

export interface TurnMessage {
	type: 'turn';
	version: typeof WORKER_PROTOCOL_VERSION;
	taskId: string;
	sessionId: string;
	repositoryPath: string;
	modelId: string;
	clientConversationId?: string;
	policy: string;
	prompt: string;
	history: TurnHistoryEntry[];
}

export interface CancelMessage {
	type: 'cancel';
	version: typeof WORKER_PROTOCOL_VERSION;
	taskId: string;
}

export interface ReadyMessage {
	type: 'ready';
	version: typeof WORKER_PROTOCOL_VERSION;
	workerId: string;
}

export type ServerMessage = TurnMessage | CancelMessage | ReadyMessage;

export interface EventMessage {
	type: 'event';
	version: typeof WORKER_PROTOCOL_VERSION;
	taskId: string;
	kind: string;
	payload: unknown;
}

export interface TerminalFailurePayload {
	error: string;
	code?: string;
	retriable?: boolean;
}

export interface TerminalSuccessPayload {
	text?: string;
}

export interface TerminalMessage {
	type: 'complete' | 'failed' | 'stopped';
	version: typeof WORKER_PROTOCOL_VERSION;
	taskId: string;
	payload?: TerminalSuccessPayload | TerminalFailurePayload;
}

export type WorkerMessage = HelloMessage | EventMessage | TerminalMessage;

export function parseServerMessage(raw: string): ServerMessage {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('Worker message is not valid JSON');
	}

	if (!isRecord(value) || typeof value.type !== 'string') {
		throw new Error('Worker message must be an object with a type');
	}
	if (value.version !== WORKER_PROTOCOL_VERSION) {
		throw new Error('Unsupported worker protocol version');
	}

	if (value.type === 'ready') {
		return { type: 'ready', version: WORKER_PROTOCOL_VERSION, workerId: requiredString(value, 'workerId') };
	}

	if (value.type === 'cancel') {
		return {
			type: 'cancel',
			version: WORKER_PROTOCOL_VERSION,
			taskId: requiredString(value, 'taskId'),
		};
	}

	if (value.type === 'turn') {
		if (!Array.isArray(value.history) || !value.history.every(isHistoryEntry)) {
			throw new Error('Turn history must contain user or assistant text entries');
		}
		return {
			type: 'turn',
			version: WORKER_PROTOCOL_VERSION,
			taskId: requiredString(value, 'taskId'),
			sessionId: requiredString(value, 'sessionId'),
			repositoryPath: requiredString(value, 'repositoryPath'),
			modelId: requiredString(value, 'modelId'),
			clientConversationId: optionalString(value, 'clientConversationId'),
			policy: requiredString(value, 'policy', true),
			prompt: requiredString(value, 'prompt'),
			history: value.history,
		};
	}

	throw new Error(`Unsupported worker message type: ${value.type}`);
}

function requiredString(value: Record<string, unknown>, key: string, allowEmpty = false): string {
	const field = value[key];
	if (typeof field !== 'string' || (!allowEmpty && field.length === 0)) {
		throw new Error(`Worker message field ${key} must be a string`);
	}
	return field;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
	if (value[key] === undefined) { return undefined; }
	return requiredString(value, key);
}

function isHistoryEntry(value: unknown): value is TurnHistoryEntry {
	return isRecord(value)
		&& (value.role === 'user' || value.role === 'assistant')
		&& typeof value.content === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
