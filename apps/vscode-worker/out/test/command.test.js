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
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = __importDefault(require("node:path"));
const command_1 = require("../command");
suite('command execution', () => {
    test('captures output and exit status in the requested cwd', async () => {
        const cwd = await (0, promises_1.mkdtemp)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'jarvis-worker-command-'));
        const result = await (0, command_1.runCommand)('printf output; printf error >&2; exit 7', cwd, new AbortController().signal);
        assert.strictEqual(result.stdout, 'output');
        assert.strictEqual(result.stderr, 'error');
        assert.strictEqual(result.exitCode, 7);
    });
    test('cancels the spawned process group', async () => {
        const controller = new AbortController();
        let childPid;
        const pending = (0, command_1.runCommand)('sleep 30 & child=$!; printf "$child"; wait', process.cwd(), controller.signal, {
            onStdout: text => {
                childPid = Number.parseInt(text, 10);
                controller.abort();
            },
        });
        await assert.rejects(pending, /cancelled/);
        if (childPid === undefined) {
            assert.fail('Child PID was not emitted');
        }
        assert.strictEqual(isProcessRunning(childPid), false);
    });
});
function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        if (process.platform !== 'linux') {
            return true;
        }
        const stat = (0, node_fs_1.readFileSync)(`/proc/${pid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
        return state !== 'Z';
    }
    catch (error) {
        if (error.code === 'ESRCH' || error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}
//# sourceMappingURL=command.test.js.map