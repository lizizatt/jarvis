"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCommand = runCommand;
const node_child_process_1 = require("node:child_process");
const MAX_RETAINED_OUTPUT = 1024 * 1024;
function runCommand(command, cwd, signal, callbacks = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)(command, {
            cwd,
            shell: true,
            detached: process.platform !== 'win32',
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        let stdoutTruncated = false;
        let stderrTruncated = false;
        let cancelled = false;
        let forceKillTimer;
        const stop = () => {
            cancelled = true;
            if (child.pid === undefined || child.killed) {
                return;
            }
            try {
                const target = process.platform === 'win32' ? child.pid : -child.pid;
                process.kill(target, 'SIGTERM');
                forceKillTimer = setTimeout(() => {
                    try {
                        process.kill(target, 'SIGKILL');
                    }
                    catch (error) {
                        if (error.code !== 'ESRCH') {
                            reject(error);
                        }
                    }
                }, 1_500);
            }
            catch (error) {
                if (error.code !== 'ESRCH') {
                    reject(error);
                }
            }
        };
        if (signal.aborted) {
            stop();
        }
        else {
            signal.addEventListener('abort', stop, { once: true });
        }
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            ({ value: stdout, truncated: stdoutTruncated } = appendBounded(stdout, text, stdoutTruncated));
            callbacks.onStdout?.(text);
        });
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            ({ value: stderr, truncated: stderrTruncated } = appendBounded(stderr, text, stderrTruncated));
            callbacks.onStderr?.(text);
        });
        child.once('error', reject);
        child.once('close', (exitCode, childSignal) => {
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
            }
            signal.removeEventListener('abort', stop);
            if (cancelled) {
                reject(new Error('Command cancelled'));
                return;
            }
            resolve({ command, exitCode, signal: childSignal, stdout, stderr });
        });
    });
}
function appendBounded(current, chunk, wasTruncated) {
    if (current.length >= MAX_RETAINED_OUTPUT) {
        return { value: current, truncated: true };
    }
    const remaining = MAX_RETAINED_OUTPUT - current.length;
    if (chunk.length <= remaining) {
        return { value: current + chunk, truncated: wasTruncated };
    }
    return { value: `${current}${chunk.slice(0, remaining)}\n[output truncated]`, truncated: true };
}
//# sourceMappingURL=command.js.map