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
exports.runAgentTurn = runAgentTurn;
const vscode = __importStar(require("vscode"));
const tools_1 = require("./tools");
const MAX_TOOL_ROUNDS = 12;
async function runAgentTurn(model, turn, cancellation, events) {
    const history = boundedHistory(turn.history, model.maxInputTokens, turn.prompt.length + turn.policy.length);
    const messages = history.map(entry => entry.role === 'user'
        ? vscode.LanguageModelChatMessage.User(entry.content)
        : vscode.LanguageModelChatMessage.Assistant(entry.content));
    const policy = turn.policy.length > 0 ? `Policy:\n${turn.policy}\n\n` : '';
    messages.push(vscode.LanguageModelChatMessage.User(`${policy}Work only within this repository: ${turn.repositoryPath}\n\nTask:\n${turn.prompt}`));
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        throwIfCancelled(cancellation);
        const response = await model.sendRequest(messages, {
            justification: 'Execute the Jarvis task requested by the user.',
            tools: tools_1.WORKER_TOOLS,
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, cancellation.token);
        const assistantParts = [];
        const toolCalls = [];
        let finalText = '';
        for await (const part of response.stream) {
            throwIfCancelled(cancellation);
            if (part instanceof vscode.LanguageModelTextPart) {
                assistantParts.push(part);
                finalText += part.value;
                events.emit('text', { text: part.value });
            }
            else if (part instanceof vscode.LanguageModelToolCallPart) {
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
        const results = [];
        for (const call of toolCalls) {
            let output;
            try {
                output = await (0, tools_1.executeTool)(call.name, call.input, {
                    repositoryPath: turn.repositoryPath,
                    signal: cancellation.signal,
                    emit: events.emit,
                });
            }
            catch (error) {
                output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
            }
            results.push(new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(output)]));
            if (call.name === 'ask_user') {
                return finalText;
            }
        }
        messages.push(vscode.LanguageModelChatMessage.User(results));
    }
    throw new Error(`Language model exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
}
function boundedHistory(history, maxInputTokens, reservedCharacters) {
    const budget = Math.max(8_000, maxInputTokens * 3 - reservedCharacters - 12_000);
    const selected = [];
    let characters = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const entry = history[index];
        if (characters + entry.content.length > budget && selected.length > 0) {
            break;
        }
        selected.unshift(entry);
        characters += entry.content.length;
    }
    return selected;
}
function throwIfCancelled(cancellation) {
    if (cancellation.token.isCancellationRequested || cancellation.signal.aborted) {
        throw new vscode.CancellationError();
    }
}
//# sourceMappingURL=agent.js.map