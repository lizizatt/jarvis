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
const paths_1 = require("../paths");
suite('path containment', () => {
    test('accepts contained paths and rejects traversal and symlink escapes', async () => {
        const base = await (0, promises_1.mkdtemp)(node_path_1.default.join((0, node_os_1.tmpdir)(), 'jarvis-worker-path-'));
        const root = node_path_1.default.join(base, 'repo');
        const outside = node_path_1.default.join(base, 'outside');
        await (0, promises_1.mkdir)(root);
        await (0, promises_1.mkdir)(outside);
        await (0, promises_1.writeFile)(node_path_1.default.join(root, 'inside.txt'), 'inside');
        await (0, promises_1.writeFile)(node_path_1.default.join(outside, 'outside.txt'), 'outside');
        await (0, promises_1.symlink)(outside, node_path_1.default.join(root, 'escape'));
        await (0, promises_1.symlink)(node_path_1.default.join(outside, 'outside.txt'), node_path_1.default.join(root, 'file-link'));
        await (0, promises_1.symlink)(node_path_1.default.join(outside, 'missing.txt'), node_path_1.default.join(root, 'dangling-link'));
        assert.strictEqual((0, paths_1.isPathInside)(root, node_path_1.default.join(root, 'inside.txt')), true);
        assert.strictEqual((0, paths_1.isPathInside)(root, outside), false);
        assert.strictEqual(await (0, paths_1.resolveExistingPath)(root, 'inside.txt'), node_path_1.default.join(root, 'inside.txt'));
        await assert.rejects((0, paths_1.resolveExistingPath)(root, '../outside/outside.txt'), /outside/);
        await assert.rejects((0, paths_1.resolveExistingPath)(root, 'escape/outside.txt'), /outside/);
        await assert.rejects((0, paths_1.resolveWritablePath)(root, 'escape/new.txt'), /outside/);
        await assert.rejects((0, paths_1.resolveWritablePath)(root, 'file-link'), /outside/);
        await assert.rejects((0, paths_1.resolveWritablePath)(root, 'dangling-link'), /symbolic link/);
    });
});
//# sourceMappingURL=paths.test.js.map