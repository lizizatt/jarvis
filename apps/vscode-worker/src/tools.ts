import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { runCommand } from './command';
import { resolveExistingPath, resolveWritablePath } from './paths';

export const WORKER_TOOLS: vscode.LanguageModelChatTool[] = [
	{
		name: 'list_files',
		description: 'List files in the repository matching a glob pattern.',
		inputSchema: objectSchema({ pattern: { type: 'string' }, maxResults: { type: 'number' } }, ['pattern']),
	},
	{
		name: 'read_file',
		description: 'Read a UTF-8 text file in the repository.',
		inputSchema: objectSchema({ path: { type: 'string' } }, ['path']),
	},
	{
		name: 'write_file',
		description: 'Write complete UTF-8 content to a file in an existing repository directory.',
		inputSchema: objectSchema({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
	},
	{
		name: 'replace_text',
		description: 'Replace text that occurs exactly once in a repository file.',
		inputSchema: objectSchema({ path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, ['path', 'oldText', 'newText']),
	},
	{
		name: 'run_command',
		description: 'Run a shell command in the repository and return its output and exit status.',
		inputSchema: objectSchema({ command: { type: 'string' } }, ['command']),
	},
	{
		name: 'ask_user',
		description: 'Pause for user input or approval. Use before commit, push, pull request, or whenever a decision is required.',
		inputSchema: objectSchema({ prompt: { type: 'string' }, choices: { type: 'array', items: { type: 'string' } }, requiresApproval: { type: 'boolean' } }, ['prompt']),
	},
];

export interface ToolExecutionContext {
	repositoryPath: string;
	signal: AbortSignal;
	emit(kind: string, payload: unknown): void;
}

export async function executeTool(name: string, input: object, context: ToolExecutionContext): Promise<string> {
	context.emit('tool-started', { name, input });
	try {
		const args = input as Record<string, unknown>;
		let result: unknown;
		switch (name) {
			case 'list_files': {
				const pattern = stringArg(args, 'pattern');
				const maxResults = Math.max(1, Math.min(numberArg(args, 'maxResults', 500), 2_000));
				const files = await vscode.workspace.findFiles(
					new vscode.RelativePattern(context.repositoryPath, pattern),
					'**/{.git,node_modules}/**',
					maxResults,
				);
				result = files.map(uri => vscode.workspace.asRelativePath(uri, false));
				break;
			}
			case 'read_file': {
				const filePath = await resolveExistingPath(context.repositoryPath, stringArg(args, 'path'));
				result = await readFile(filePath, 'utf8');
				context.emit('file-read', { path: filePath });
				break;
			}
			case 'write_file': {
				const filePath = await resolveWritablePath(context.repositoryPath, stringArg(args, 'path'));
				const content = stringArg(args, 'content', true);
				await writeFile(filePath, content, 'utf8');
				context.emit('file-written', { path: filePath, bytes: Buffer.byteLength(content) });
				result = { path: filePath, bytes: Buffer.byteLength(content) };
				break;
			}
			case 'replace_text': {
				const filePath = await resolveExistingPath(context.repositoryPath, stringArg(args, 'path'));
				const oldText = stringArg(args, 'oldText');
				const newText = stringArg(args, 'newText', true);
				const content = await readFile(filePath, 'utf8');
				const first = content.indexOf(oldText);
				if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) {
					throw new Error('oldText must occur exactly once');
				}
				await writeFile(filePath, content.slice(0, first) + newText + content.slice(first + oldText.length), 'utf8');
				context.emit('file-changed', { path: filePath });
				result = { path: filePath, replaced: true };
				break;
			}
			case 'run_command': {
				const command = stringArg(args, 'command');
				context.emit('command-started', { command, cwd: context.repositoryPath });
				result = await runCommand(command, context.repositoryPath, context.signal, {
					onStdout: text => context.emit('command-output', { stream: 'stdout', text }),
					onStderr: text => context.emit('command-output', { stream: 'stderr', text }),
				});
				context.emit('command-finished', result);
				break;
			}
			case 'ask_user': {
				const question = { type: 'question', questionId: randomUUID(), prompt: stringArg(args, 'prompt'),
					choices: Array.isArray(args.choices) ? args.choices.filter((choice): choice is string => typeof choice === 'string') : [],
					requiresApproval: args.requiresApproval === true };
				context.emit('question', question);
				result = 'Waiting for the user. End this turn; their answer will arrive as the next turn.';
				break;
			}
			default:
				throw new Error(`Unknown tool: ${name}`);
		}
		const serialized = typeof result === 'string' ? result : JSON.stringify(result);
		context.emit('tool-completed', { name });
		return serialized;
	} catch (error) {
		context.emit('tool-failed', { name, error: errorMessage(error) });
		throw error;
	}
}

function objectSchema(properties: Record<string, object>, required: string[]): object {
	return { type: 'object', properties, required, additionalProperties: false };
}

function stringArg(args: Record<string, unknown>, name: string, allowEmpty = false): string {
	const value = args[name];
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
		throw new Error(`${name} must be a string`);
	}
	return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
	const value = args[name];
	return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
