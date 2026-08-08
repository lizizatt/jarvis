import { useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Search } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';

function fileUrl(repositoryId: string, path: string): string {
  return `/previews/${repositoryId}/repo/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function PreviewPanel({ repositoryId, repositoryName, previewUrl }: { repositoryId: string; repositoryName: string; previewUrl?: string }) {
  const files = useLoad(() => api.previewFiles(repositoryId), [repositoryId]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const autoSelected = useRef(false);

  // Give the tab something useful to show immediately, without re-firing while the user searches.
  useEffect(() => {
    if (autoSelected.current || !files.data) return;
    autoSelected.current = true;
    const rootReadme = files.data.find((file) => file.path.toLowerCase() === 'readme.md');
    if (rootReadme) { setSelected(rootReadme.path); setQuery(rootReadme.path); }
  }, [files.data]);

  const matches = useMemo(() => {
    const list = files.data ?? [];
    const needle = query.trim().toLowerCase();
    return (needle ? list.filter((file) => file.path.toLowerCase().includes(needle)) : list).slice(0, 40);
  }, [files.data, query]);

  function choose(path: string) {
    window.clearTimeout(closeTimer.current);
    setSelected(path); setQuery(path); setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && matches[0]) { event.preventDefault(); choose(matches[0].path); }
    if (event.key === 'Escape') setOpen(false);
  }

  const previewSrc = selected ? fileUrl(repositoryId, selected) : previewUrl;
  return <div className="preview-view" data-testid="preview-view">
    <div className="preview-picker">
      <div className="preview-picker-field">
        <Search size={16} />
        <input type="text" placeholder="Search README and HTML files…" value={query}
          onChange={(event) => { setQuery(event.target.value); setSelected(undefined); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => { closeTimer.current = window.setTimeout(() => setOpen(false), 120); }}
          onKeyDown={handleKeyDown}
          aria-label="Search README and HTML files" data-testid="preview-search" />
      </div>
      {open && <ul className="preview-picker-list" data-testid="preview-results">
        {files.loading ? <li className="preview-picker-empty">Loading files…</li>
          : matches.length ? matches.map((file) => <li key={file.path}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(file.path)}>
                <span className={`preview-kind preview-kind-${file.kind}`}>{file.kind === 'readme' ? 'Readme' : 'HTML'}</span>
                <span className="preview-path">{file.path}</span>
              </button>
            </li>)
          : <li className="preview-picker-empty">No matching README or HTML files.</li>}
      </ul>}
    </div>
    {files.error && <div className="notice error">{files.error}</div>}
    {previewSrc
      ? <iframe title={selected ?? `${repositoryName} preview`} src={previewSrc} data-testid="preview-frame" />
      : <div className="empty"><Monitor /><h2>No preview available</h2><p>Search for a README or HTML file above, or register a Jarvis-managed landing page.</p></div>}
  </div>;
}
