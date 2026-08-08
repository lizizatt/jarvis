"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKER_TOOLS = void 0;
exports.executeTool = executeTool;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const vscode = __importStar(require("vscode"));
const command_1 = require("./command");
const paths_1 = require("./paths");
exports.WORKER_TOOLS = [
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
async function executeTool(name, input, context) {
    context.emit('tool-started', { name, input });
    try {
        const args = input;
        let result;
        switch (name) {
            case 'list_files': {
                const pattern = stringArg(args, 'pattern');
                const maxResults = Math.max(1, Math.min(numberArg(args, 'maxResults', 500), 2_000));
                const files = await vscode.workspace.findFiles(new vscode.RelativePattern(context.repositoryPath, pattern), '**/{.git,node_modules}/**', maxResults);
                result = files.map(uri => vscode.workspace.asRelativePath(uri, false));
                break;
            }
            case 'read_file': {
                const filePath = await (0, paths_1.resolveExistingPath)(context.repositoryPath, stringArg(args, 'path'));
                result = await (0, promises_1.readFile)(filePath, 'utf8');
                context.emit('file-read', { path: filePath });
                break;
            }
            case 'write_file': {
                const filePath = await (0, paths_1.resolveWritablePath)(context.repositoryPath, stringArg(args, 'path'));
                const content = stringArg(args, 'content', true);
                await (0, promises_1.writeFile)(filePath, content, 'utf8');
                context.emit('file-written', { path: filePath, bytes: Buffer.byteLength(content) });
                result = { path: filePath, bytes: Buffer.byteLength(content) };
                break;
            }
            case 'replace_text': {
                const filePath = await (0, paths_1.resolveExistingPath)(context.repositoryPath, stringArg(args, 'path'));
                const oldText = stringArg(args, 'oldText');
                const newText = stringArg(args, 'newText', true);
                const content = await (0, promises_1.readFile)(filePath, 'utf8');
                const first = content.indexOf(oldText);
                if (first < 0 || content.indexOf(oldText, first + oldText.length) >= 0) {
                    throw new Error('oldText must occur exactly once');
                }
                await (0, promises_1.writeFile)(filePath, content.slice(0, first) + newText + content.slice(first + oldText.length), 'utf8');
                context.emit('file-changed', { path: filePath });
                result = { path: filePath, replaced: true };
                break;
            }
            case 'run_command': {
                const command = stringArg(args, 'command');
                context.emit('command-started', { command, cwd: context.repositoryPath });
                result = await (0, command_1.runCommand)(command, context.repositoryPath, context.signal, {
                    onStdout: text => context.emit('command-output', { stream: 'stdout', text }),
                    onStderr: text => context.emit('command-output', { stream: 'stderr', text }),
                });
                context.emit('command-finished', result);
                break;
            }
            case 'ask_user': {
                const question = { type: 'question', questionId: (0, node_crypto_1.randomUUID)(), prompt: stringArg(args, 'prompt'),
                    choices: Array.isArray(args.choices) ? args.choices.filter((choice) => typeof choice === 'string') : [],
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
    }
    catch (error) {
        context.emit('tool-failed', { name, error: errorMessage(error) });
        throw error;
    }
}
function objectSchema(properties, required) {
    return { type: 'object', properties, required, additionalProperties: false };
}
function stringArg(args, name, allowEmpty = false) {
    const value = args[name];
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        throw new Error(`${name} must be a string`);
    }
    return value;
}
function numberArg(args, name, fallback) {
    const value = args[name];
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=tools.js.map