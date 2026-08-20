import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as vscode from 'vscode';
import type { WorkerActivity } from './protocol';

export class NativeChatActivityMonitor implements vscode.Disposable {
	private child: ChildProcessWithoutNullStreams | undefined;
	private output = '';
	private activity: WorkerActivity = 'idle';
	private disposed = false;

	constructor(private readonly context: vscode.ExtensionContext) {}

	start(windowNames: string | string[], onDidChange: (activity: WorkerActivity) => void,
		onError?: (error: Error) => void): void {
		if (process.platform !== 'linux' || this.child || this.disposed) {
			return;
		}
		const script = this.context.asAbsolutePath('resources/native_chat_activity.py');
		const names = typeof windowNames === 'string' ? [windowNames] : windowNames;
		const child = spawn('/usr/bin/python3', ['-u', script, '--window', JSON.stringify(names)], {
			env: { ...process.env, JARVIS_PARENT_PID: String(process.pid) },
		});
		this.child = child;
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			this.output += chunk;
			const lines = this.output.split('\n');
			this.output = lines.pop() ?? '';
			for (const line of lines) {
				const activity = parseActivity(line);
				if (activity && activity !== this.activity) {
					this.activity = activity;
					onDidChange(activity);
				}
			}
		});
		let errorReported = false;
		const reportError = (error: Error) => {
			if (errorReported || this.disposed) { return; }
			errorReported = true;
			onError?.(error);
		};
		const reset = () => {
			if (this.child === child) {
				this.child = undefined;
			}
			if (!this.disposed && this.activity !== 'idle') {
				this.activity = 'idle';
				onDidChange('idle');
			}
		};
		child.on('error', error => { reportError(error); reset(); });
		child.on('close', (code, signal) => {
			if (code !== 0 && !signal) { reportError(new Error(`Native chat activity observer exited with code ${code ?? 'unknown'}`)); }
			reset();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.child?.kill();
		this.child = undefined;
	}
}

function parseActivity(value: string): WorkerActivity | undefined {
	const activity = value.trim();
	return activity === 'idle' || activity === 'thinking' || activity === 'needs-input' ? activity : undefined;
}
