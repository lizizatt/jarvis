import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveExistingPath(root: string, requestedPath: string): Promise<string> {
	const canonicalRoot = await realpath(root);
	const candidate = await realpath(path.resolve(canonicalRoot, requestedPath));
	if (!isPathInside(canonicalRoot, candidate)) {
		throw new Error(`Path is outside the repository: ${requestedPath}`);
	}
	return candidate;
}

export async function resolveWritablePath(root: string, requestedPath: string): Promise<string> {
	const canonicalRoot = await realpath(root);
	const candidate = path.resolve(canonicalRoot, requestedPath);
	try {
		const canonicalCandidate = await realpath(candidate);
		if (!isPathInside(canonicalRoot, canonicalCandidate)) {
			throw new Error(`Path is outside the repository: ${requestedPath}`);
		}
		return canonicalCandidate;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
		try {
			if ((await lstat(candidate)).isSymbolicLink()) {
				throw new Error(`Path is an unresolved symbolic link: ${requestedPath}`);
			}
		} catch (statError) {
			if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw statError;
			}
		}
	}
	const canonicalParent = await realpath(path.dirname(candidate));
	if (!isPathInside(canonicalRoot, canonicalParent)) {
		throw new Error(`Path is outside the repository: ${requestedPath}`);
	}
	return path.join(canonicalParent, path.basename(candidate));
}
