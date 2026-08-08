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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("node:assert"));
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const tools_1 = require("../tools");
suite('repository tools', () => {
    test('writes, reads, and exactly replaces repository text while emitting file events', async () => {
        const repositoryPath = await (0, promises_1.mkdtemp)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'jarvis-worker-tools-'));
        const events = [];
        const context = {
            repositoryPath,
            signal: new AbortController().signal,
            emit: (kind) => events.push(kind),
        };
        await (0, tools_1.executeTool)('write_file', { path: 'file.txt', content: 'before' }, context);
        assert.strictEqual(await (0, tools_1.executeTool)('read_file', { path: 'file.txt' }, context), 'before');
        await (0, tools_1.executeTool)('replace_text', { path: 'file.txt', oldText: 'before', newText: 'after' }, context);
        assert.strictEqual(await (0, promises_1.readFile)(node_path_1.default.join(repositoryPath, 'file.txt'), 'utf8'), 'after');
        assert.ok(events.includes('file-written'));
        assert.ok(events.includes('file-read'));
        assert.ok(events.includes('file-changed'));
    });
    test('rejects non-exact text replacement', async () => {
        const repositoryPath = await (0, promises_1.mkdtemp)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'jarvis-worker-tools-'));
        const context = {
            repositoryPath,
            signal: new AbortController().signal,
            emit: () => undefined,
        };
        await (0, tools_1.executeTool)('write_file', { path: 'file.txt', content: 'same same' }, context);
        await assert.rejects((0, tools_1.executeTool)('replace_text', { path: 'file.txt', oldText: 'same', newText: 'new' }, context), /exactly once/);
    });
    test('emits structured questions for phone approval', async () => {
        const repositoryPath = await (0, promises_1.mkdtemp)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'jarvis-worker-tools-'));
        const events = [];
        await (0, tools_1.executeTool)('ask_user', { prompt: 'Push this branch?', choices: ['Yes', 'No'], requiresApproval: true }, {
            repositoryPath,
            signal: new AbortController().signal,
            emit: (kind, payload) => events.push({ kind, payload }),
        });
        assert.ok(events.some(event => event.kind === 'question'
            && event.payload.prompt === 'Push this branch?'));
    });
});
//# sourceMappingURL=tools.test.js.map