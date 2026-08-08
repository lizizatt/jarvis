"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPathInside = isPathInside;
exports.resolveExistingPath = resolveExistingPath;
exports.resolveWritablePath = resolveWritablePath;
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:fs/promises");
function isPathInside(root, candidate) {
    const relative = node_path_1.default.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${node_path_1.default.sep}`) && relative !== '..' && !node_path_1.default.isAbsolute(relative));
}
async function resolveExistingPath(root, requestedPath) {
    const canonicalRoot = await (0, promises_1.realpath)(root);
    const candidate = await (0, promises_1.realpath)(node_path_1.default.resolve(canonicalRoot, requestedPath));
    if (!isPathInside(canonicalRoot, candidate)) {
        throw new Error(`Path is outside the repository: ${requestedPath}`);
    }
    return candidate;
}
async function resolveWritablePath(root, requestedPath) {
    const canonicalRoot = await (0, promises_1.realpath)(root);
    const candidate = node_path_1.default.resolve(canonicalRoot, requestedPath);
    try {
        const canonicalCandidate = await (0, promises_1.realpath)(candidate);
        if (!isPathInside(canonicalRoot, canonicalCandidate)) {
            throw new Error(`Path is outside the repository: ${requestedPath}`);
        }
        return canonicalCandidate;
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
        try {
            if ((await (0, promises_1.lstat)(candidate)).isSymbolicLink()) {
                throw new Error(`Path is an unresolved symbolic link: ${requestedPath}`);
            }
        }
        catch (statError) {
            if (statError.code !== 'ENOENT') {
                throw statError;
            }
        }
    }
    const canonicalParent = await (0, promises_1.realpath)(node_path_1.default.dirname(candidate));
    if (!isPathInside(canonicalRoot, canonicalParent)) {
        throw new Error(`Path is outside the repository: ${requestedPath}`);
    }
    return node_path_1.default.join(canonicalParent, node_path_1.default.basename(candidate));
}
//# sourceMappingURL=paths.js.map