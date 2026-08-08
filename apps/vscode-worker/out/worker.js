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
exports.WorkerClient = void 0;
exports.runCapabilityTest = runCapabilityTest;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const vscode = __importStar(require("vscode"));
const agent_1 = require("./agent");
const protocol_1 = require("./protocol");
const ENABLED_KEY = 'jarvis-copilot-worker.enabled';
class WorkerClient {
    context;
    instanceWorkerId = (0, node_crypto_1.randomUUID)();
    socket;
    reconnectTimer;
    reconnectAttempt = 0;
    models = [];
    workspaceRoots = [];
    runningTurns = new Map();
    disposed = false;
    constructor(context) {
        this.context = context;
    }
    async initialize() {
        await this.refreshWorkspaceRoots();
        if (this.isEnabled()) {
            await this.refreshModels();
            this.openSocket();
        }
    }
    async connectFromUserAction() {
        this.models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (this.models.length === 0) {
            throw new Error('No Copilot language models are available. Check your Copilot sign-in and subscription.');
        }
        await this.context.globalState.update(ENABLED_KEY, true);
        this.reconnectAttempt = 0;
        this.openSocket();
    }
    async disconnect() {
        await this.context.globalState.update(ENABLED_KEY, false);
        this.clearReconnect();
        for (const running of this.runningTurns.values()) {
            running.modelCancellation.cancel();
            running.toolCancellation.abort();
        }
        this.socket?.close(1000, 'Disconnected by user');
        this.socket = undefined;
    }
    async refreshModels() {
        this.models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendHello();
        }
    }
    async refreshWorkspaceRoots() {
        this.workspaceRoots = await getWorkspaceRoots();
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.sendHello();
        }
    }
    restartTransport() {
        if (!this.isEnabled()) {
            return;
        }
        this.clearReconnect();
        this.socket?.close(1000, 'Configuration changed');
        this.socket = undefined;
        this.reconnectAttempt = 0;
        this.openSocket();
    }
    status() {
        const connection = this.socket?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
        return `Jarvis Copilot Worker is ${this.isEnabled() ? 'enabled' : 'disabled'} and ${connection}. `
            + `${this.models.length} Copilot model(s), ${this.workspaceRoots.length} workspace root(s), `
            + `${this.runningTurns.size} active turn(s).`;
    }
    dispose() {
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
    openSocket() {
        if (this.disposed || !this.isEnabled()) {
            return;
        }
        this.clearReconnect();
        if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
            return;
        }
        const url = vscode.workspace.getConfiguration('jarvisCopilotWorker').get('serverUrl', 'ws://127.0.0.1:3210/ws/workers');
        let socket;
        try {
            socket = new WebSocket(url);
            this.socket = socket;
        }
        catch (error) {
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
    cancelRunningTurns() {
        for (const running of this.runningTurns.values()) {
            running.modelCancellation.cancel();
            running.toolCancellation.abort();
        }
    }
    async receiveMessage(data) {
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const message = (0, protocol_1.parseServerMessage)(raw);
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
    async startTurn(turn) {
        if (this.runningTurns.has(turn.taskId)) {
            this.sendTerminal({ type: 'failed', version: protocol_1.WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { error: 'Task is already running' } });
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
            const text = await (0, agent_1.runAgentTurn)(model, turn, {
                token: modelCancellation.token,
                signal: toolCancellation.signal,
            }, { emit: (kind, payload) => this.sendEvent(turn.taskId, kind, payload) });
            this.sendTerminal({ type: 'complete', version: protocol_1.WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { text } });
        }
        catch (error) {
            if (modelCancellation.token.isCancellationRequested || toolCancellation.signal.aborted) {
                this.sendTerminal({ type: 'stopped', version: protocol_1.WORKER_PROTOCOL_VERSION, taskId: turn.taskId });
            }
            else {
                this.sendTerminal({ type: 'failed', version: protocol_1.WORKER_PROTOCOL_VERSION, taskId: turn.taskId, payload: { error: errorMessage(error) } });
            }
        }
        finally {
            this.runningTurns.delete(turn.taskId);
            modelCancellation.dispose();
        }
    }
    sendHello() {
        this.send({
            type: 'hello',
            version: protocol_1.WORKER_PROTOCOL_VERSION,
            workerId: this.workerId(),
            windowName: vscode.workspace.name ?? vscode.env.appName,
            workspaceRoots: this.workspaceRoots,
            models: this.models.map(modelMetadata),
        });
    }
    sendEvent(taskId, kind, payload) {
        this.send({ type: 'event', version: protocol_1.WORKER_PROTOCOL_VERSION, taskId, kind, payload });
    }
    sendTerminal(message) {
        this.send(message);
    }
    send(message) {
        if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(message));
        }
    }
    workerId() {
        return this.instanceWorkerId;
    }
    isEnabled() {
        return this.context.globalState.get(ENABLED_KEY, false);
    }
    scheduleReconnect() {
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
    clearReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }
}
exports.WorkerClient = WorkerClient;
async function runCapabilityTest() {
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
function chooseModel(models) {
    const preferred = vscode.workspace.getConfiguration('jarvisCopilotWorker').get('preferredModel', '').trim().toLowerCase();
    if (!preferred) {
        return models.find(model => model.id === 'auto') ?? models[0];
    }
    return models.find(model => [model.id, model.family, model.name].some(value => value.toLowerCase() === preferred))
        ?? models.find(model => [model.id, model.family, model.name].some(value => value.toLowerCase().includes(preferred)))
        ?? models[0];
}
function modelMetadata(model) {
    return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
    };
}
async function getWorkspaceRoots() {
    return Promise.all((vscode.workspace.workspaceFolders ?? []).map(folder => (0, promises_1.realpath)(folder.uri.fsPath)));
}
async function canonicalPath(candidate) {
    try {
        return await (0, promises_1.realpath)(candidate);
    }
    catch {
        return undefined;
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function throwIfCancelled(model, tools) {
    if (model.token.isCancellationRequested || tools.signal.aborted) {
        throw new vscode.CancellationError();
    }
}
//# sourceMappingURL=worker.js.map