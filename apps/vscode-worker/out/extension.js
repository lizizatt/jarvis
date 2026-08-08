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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const worker_1 = require("./worker");
async function activate(context) {
    const worker = new worker_1.WorkerClient(context);
    context.subscriptions.push(worker, vscode.commands.registerCommand('jarvisCopilotWorker.connect', async () => {
        try {
            await worker.connectFromUserAction();
            void vscode.window.showInformationMessage('Jarvis Copilot Worker connected.');
        }
        catch (error) {
            void vscode.window.showErrorMessage(`Unable to connect Jarvis Copilot Worker: ${errorMessage(error)}`);
        }
    }), vscode.commands.registerCommand('jarvisCopilotWorker.disconnect', async () => {
        await worker.disconnect();
        void vscode.window.showInformationMessage('Jarvis Copilot Worker disconnected.');
    }), vscode.commands.registerCommand('jarvisCopilotWorker.showStatus', () => {
        void vscode.window.showInformationMessage(worker.status());
    }), vscode.commands.registerCommand('jarvisCopilotWorker.runCapabilityTest', async () => {
        try {
            void vscode.window.showInformationMessage(await (0, worker_1.runCapabilityTest)());
        }
        catch (error) {
            void vscode.window.showErrorMessage(`Copilot capability test failed: ${errorMessage(error)}`);
        }
    }), vscode.lm.onDidChangeChatModels(() => void worker.refreshModels()), vscode.workspace.onDidChangeWorkspaceFolders(() => void worker.refreshWorkspaceRoots()), vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('jarvisCopilotWorker.serverUrl')) {
            worker.restartTransport();
        }
    }));
    await worker.initialize();
}
function deactivate() { }
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=extension.js.map