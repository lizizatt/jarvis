import * as vscode from 'vscode';
import { TurnMessage } from './protocol';
import { executeTool, WORKER_TOOLS } from './tools';

export const TOOL_ROUND_CHECKPOINT = 12;
export const MAX_IDENTICAL_TOOL_ROUNDS = 4;

export function isToolRoundCheckpoint(rounds: number): boolean {
	return rounds > 0 && rounds % TOOL_ROUND_CHECKPOINT === 0;
}

export function nextRepeatedToolRound(previousSignature: string, signature: string, previousCount: number): number {
	return previousSignature === signature ? previousCount + 1 : 1;
}

export function toolRoundSignature(outcomes: Array<{ name: string; input: unknown; output: string }>): string {
	return stableSerialize(outcomes);
}

export interface AgentEvents {
	emit(kind: string, payload: unknown): void;
}

export interface AgentCancellation {
	token: vscode.CancellationToken;
	signal: AbortSignal;
}

export async function runAgentTurn(
	model: vscode.LanguageModelChat,
	turn: TurnMessage,
	cancellation: AgentCancellation,
	events: AgentEvents,
): Promise<string> {
	const history = boundedHistory(turn.history, model.maxInputTokens, turn.prompt.length + turn.policy.length);
	const messages = history.map(entry => entry.role === 'user'
		? vscode.LanguageModelChatMessage.User(entry.content)
		: vscode.LanguageModelChatMessage.Assistant(entry.content));
	const policy = turn.policy.length > 0 ? `Policy:\n${turn.policy}\n\n` : '';
	messages.push(vscode.LanguageModelChatMessage.User(
		`${policy}Work only within this repository: ${turn.repositoryPath}\n\nTask:\n${turn.prompt}`,
	));
	const baseMessageCount = messages.length;
	let previousToolSignature = '';
	let repeatedToolRounds = 0;

	for (let round = 0; ; round += 1) {
		throwIfCancelled(cancellation);
		const response = await model.sendRequest(messages, {
			justification: 'Execute the Jarvis task requested by the user.',
			tools: WORKER_TOOLS,
			toolMode: vscode.LanguageModelChatToolMode.Auto,
		}, cancellation.token);
		const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		let finalText = '';

		for await (const part of response.stream) {
			throwIfCancelled(cancellation);
			if (part instanceof vscode.LanguageModelTextPart) {
				assistantParts.push(part);
				finalText += part.value;
				events.emit('text', { text: part.value });
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				assistantParts.push(part);
				toolCalls.push(part);
				events.emit('tool-call', { callId: part.callId, name: part.name, input: part.input });
			}
		}

		if (assistantParts.length > 0) {
			messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
		}
		if (toolCalls.length === 0) {
			return finalText;
		}
		const results: vscode.LanguageModelToolResultPart[] = [];
		const outcomes: Array<{ name: string; input: unknown; output: string }> = [];
		for (const call of toolCalls) {
			let output: string;
			try {
				output = await executeTool(call.name, call.input, {
					repositoryPath: turn.repositoryPath,
					signal: cancellation.signal,
					emit: events.emit,
				});
			} catch (error) {
				output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
			}
			outcomes.push({ name: call.name, input: call.input, output });
			results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(output)]));
			if (call.name === 'ask_user') {
				return finalText;
			}
		}
		messages.push(vscode.LanguageModelChatMessage.User(results));
		const toolSignature = toolRoundSignature(outcomes);
		repeatedToolRounds = nextRepeatedToolRound(previousToolSignature, toolSignature, repeatedToolRounds);
		previousToolSignature = toolSignature;
		if (repeatedToolRounds >= MAX_IDENTICAL_TOOL_ROUNDS) {
			throw new Error(`Agent repeated the same tool calls and results for ${MAX_IDENTICAL_TOOL_ROUNDS} rounds without progress`);
		}
		if (isToolRoundCheckpoint(round + 1)) {
			events.emit('tool-round-checkpoint', { rounds: round + 1 });
			const latestExchange = messages.slice(-2);
			messages.splice(baseMessageCount);
			messages.push(...latestExchange);
			messages.push(vscode.LanguageModelChatMessage.User(
				`Checkpoint after ${round + 1} tool rounds. The repository is the source of truth for completed work. Continue efficiently, re-read only what is needed, ask the user if blocked, and finish as soon as the task is satisfied.`,
			));
		}
	}
}

function stableSerialize(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableSerialize).join(',')}]`;
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function boundedHistory(history: TurnMessage['history'], maxInputTokens: number, reservedCharacters: number): TurnMessage['history'] {
	const budget = Math.max(8_000, maxInputTokens * 3 - reservedCharacters - 12_000);
	const selected: TurnMessage['history'] = [];
	let characters = 0;
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const entry = history[index];
		if (characters + entry.content.length > budget) {
			break;
		}
		selected.unshift(entry);
		characters += entry.content.length;
	}
	return selected;
}

function throwIfCancelled(cancellation: AgentCancellation): void {
	if (cancellation.token.isCancellationRequested || cancellation.signal.aborted) {
		throw new vscode.CancellationError();
	}
}
