"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKER_PROTOCOL_VERSION = void 0;
exports.parseServerMessage = parseServerMessage;
exports.WORKER_PROTOCOL_VERSION = 1;
function parseServerMessage(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw new Error('Worker message is not valid JSON');
    }
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error('Worker message must be an object with a type');
    }
    if (value.version !== exports.WORKER_PROTOCOL_VERSION) {
        throw new Error('Unsupported worker protocol version');
    }
    if (value.type === 'ready') {
        return { type: 'ready', version: exports.WORKER_PROTOCOL_VERSION, workerId: requiredString(value, 'workerId') };
    }
    if (value.type === 'cancel') {
        return {
            type: 'cancel',
            version: exports.WORKER_PROTOCOL_VERSION,
            taskId: requiredString(value, 'taskId'),
        };
    }
    if (value.type === 'turn') {
        if (!Array.isArray(value.history) || !value.history.every(isHistoryEntry)) {
            throw new Error('Turn history must contain user or assistant text entries');
        }
        return {
            type: 'turn',
            version: exports.WORKER_PROTOCOL_VERSION,
            taskId: requiredString(value, 'taskId'),
            sessionId: requiredString(value, 'sessionId'),
            repositoryPath: requiredString(value, 'repositoryPath'),
            policy: requiredString(value, 'policy', true),
            prompt: requiredString(value, 'prompt'),
            history: value.history,
        };
    }
    throw new Error(`Unsupported worker message type: ${value.type}`);
}
function requiredString(value, key, allowEmpty = false) {
    const field = value[key];
    if (typeof field !== 'string' || (!allowEmpty && field.length === 0)) {
        throw new Error(`Worker message field ${key} must be a string`);
    }
    return field;
}
function isHistoryEntry(value) {
    return isRecord(value)
        && (value.role === 'user' || value.role === 'assistant')
        && typeof value.content === 'string';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=protocol.js.map