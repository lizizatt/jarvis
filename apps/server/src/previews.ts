import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.markdown': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp',
};

export async function ensureLanding(previewsRoot: string, repositoryId: string, repositoryName: string): Promise<string> {
  const directory = join(previewsRoot, repositoryId);
  const filename = join(directory, 'index.html');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await stat(filename); }
  catch { await writeFile(filename, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(repositoryName)}</title><h1>${escapeHtml(repositoryName)}</h1>`, { mode: 0o600 }); }
  return filename;
}

export async function readPreviewFile(root: string, requestedPath: string): Promise<{ body: Buffer; contentType: string }> {
  const canonicalRoot = await realpath(root);
  let decoded: string;
  try { decoded = decodeURIComponent(requestedPath); } catch { throw new PreviewError('Malformed preview path', 400); }
  if (decoded.includes('\0')) throw new PreviewError('Invalid preview path', 400);
  const candidate = resolve(canonicalRoot, decoded || '.');
  let canonical: string;
  try { canonical = await realpath(candidate); } catch { throw new PreviewError('Preview file not found', 404); }
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new PreviewError('Preview path escapes its registered root', 403);
  }
  const file = await stat(canonical);
  if (!file.isFile()) throw new PreviewError('Preview path is not a file', 404);
  return { body: await readFile(canonical), contentType: TYPES[extname(canonical).toLowerCase()] ?? 'application/octet-stream' };
}

export class PreviewError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }
export function rewritePreviewHtml(body: Buffer, repositoryId: string): Buffer {
  const prefix = `/previews/${repositoryId}/repo/`;
  const html = body.toString('utf8')
    .replace(/\b(src|href|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`)
    .replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${prefix}`);
  return Buffer.from(html);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`); }
