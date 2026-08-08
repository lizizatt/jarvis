import { marked } from 'marked';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

// Rendered to real HTML (not served as text/plain) since some mobile browsers won't frame plain text inline.
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

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
  const extension = extname(canonical).toLowerCase();
  const raw = await readFile(canonical);
  if (MARKDOWN_EXTENSIONS.has(extension)) return { body: renderMarkdownPreview(raw.toString('utf8')), contentType: 'text/html; charset=utf-8' };
  return { body: raw, contentType: TYPES[extension] ?? 'application/octet-stream' };
}

function renderMarkdownPreview(source: string): Buffer {
  const html = marked.parse(source, { async: false }) as string;
  return Buffer.from(`<!doctype html><meta charset="utf-8"><style>${MARKDOWN_STYLE}</style>${html}`);
}

const MARKDOWN_STYLE = `
  body{margin:0;padding:20px;max-width:860px;background:#fff;color:#1b1f1e;font:15px/1.6 -apple-system,system-ui,sans-serif}
  h1,h2,h3,h4,h5,h6{margin:1.2em 0 .5em;line-height:1.25}
  h1{font-size:1.7em;border-bottom:1px solid #e2e2e2;padding-bottom:.3em}
  h2{font-size:1.35em;border-bottom:1px solid #eee;padding-bottom:.25em}
  p,ul,ol,table,blockquote,pre{margin:0 0 1em}
  code{padding:.15em .35em;background:#f2f2f2;border-radius:3px;font-size:.9em}
  pre{padding:12px;overflow:auto;background:#f6f8fa;border-radius:4px}
  pre code{padding:0;background:none}
  blockquote{margin:0 0 1em;padding-left:12px;border-left:3px solid #d8d8d8;color:#57606a}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #d8d8d8;padding:6px 10px;text-align:left}
  img{max-width:100%}
  a{color:#0969da}
`;

export class PreviewError extends Error { constructor(message: string, readonly statusCode: number) { super(message); } }
export function rewritePreviewHtml(body: Buffer, repositoryId: string): Buffer {
  const prefix = `/previews/${repositoryId}/repo/`;
  const html = body.toString('utf8')
    .replace(/\b(src|href|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`)
    .replace(/url\(\s*(['"]?)\/(?!\/)/gi, `url($1${prefix}`);
  return Buffer.from(html);
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`); }
