import { useState } from 'react';
import { ExternalLink, GitPullRequest, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useLoad } from '../hooks';

function diffLineClass(line: string): string {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-line diff-addition';
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-line diff-deletion';
  if (line.startsWith('@@')) return 'diff-line diff-hunk';
  if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) return 'diff-line diff-header';
  return 'diff-line';
}

function DiffText({ text }: { text: string }) {
  return <>{text.split('\n').map((line, index) => <span className={diffLineClass(line)} key={index}>{line || ' '}</span>)}</>;
}

// Two-letter porcelain codes: index status then worktree status (e.g. "M ", " M", "??", "R ").
function fileStatusKind(status: string): 'untracked' | 'conflict' | 'deleted' | 'added' | 'renamed' | 'modified' {
  if (status.includes('?')) return 'untracked';
  if (status.includes('U')) return 'conflict';
  if (status.includes('D')) return 'deleted';
  if (status.includes('A')) return 'added';
  if (status.includes('R')) return 'renamed';
  return 'modified';
}

const FILE_STATUS_LABELS: Record<ReturnType<typeof fileStatusKind>, string> = {
  untracked: 'Untracked', conflict: 'Conflict', deleted: 'Deleted', added: 'Added', renamed: 'Renamed', modified: 'Modified',
};

type Mode = 'worktree' | 'staged' | 'files';
type View = { kind: 'diff'; text: string } | { kind: 'files'; files: Array<{ status: string; path: string }> };

export function DiffPanel({ repositoryId }: { repositoryId: string }) {
  const [mode, setMode] = useState<Mode>('worktree');
  const view = useLoad<View>(async () => mode === 'files'
    ? { kind: 'files', files: await api.statusFiles(repositoryId) }
    : { kind: 'diff', text: await api.diff(repositoryId, mode) }, [repositoryId, mode]);
  const pullRequest = useLoad(() => api.pullRequest(repositoryId), [repositoryId]);
  const files = view.data?.kind === 'files' ? view.data.files : [];
  const text = view.data?.kind === 'diff' ? view.data.text : '';
  return <div className="changes-view" data-testid="changes-view">
    <section className="pr-strip"><GitPullRequest size={19} />{pullRequest.loading ? <span>Checking pull request…</span> : pullRequest.data ? <><div><strong>#{pullRequest.data.number} {pullRequest.data.title}</strong><span className={`pr-state state-${pullRequest.data.state}`}>{pullRequest.data.state}</span></div>{pullRequest.data.url && <a className="icon-button" href={pullRequest.data.url} target="_blank" rel="noreferrer" aria-label="Open pull request"><ExternalLink /></a>}</> : <span>No pull request for this branch</span>}</section>
    {pullRequest.data?.checks?.length ? <div className="checks">{pullRequest.data.checks.map((check) => <span key={check.name} className={`check check-${check.state}`}>{check.name}</span>)}</div> : null}
    <div className="section-toolbar"><div className="segmented" aria-label="Diff mode"><button className={mode === 'worktree' ? 'active' : ''} onClick={() => setMode('worktree')}>Worktree</button><button className={mode === 'staged' ? 'active' : ''} onClick={() => setMode('staged')}>Staged</button><button className={mode === 'files' ? 'active' : ''} onClick={() => setMode('files')}>Files</button></div><button className="icon-button" aria-label="Refresh diff" onClick={() => void view.reload()}><RefreshCw size={18} /></button></div>
    {view.error && <div className="notice error">{view.error}</div>}
    {mode === 'files'
      ? <ul className="status-files" data-testid="repository-status-files">
          {view.loading ? <li className="status-files-empty">Loading files…</li> : files.length
            ? files.map((file) => { const kind = fileStatusKind(file.status); return <li key={file.path}><span className={`file-status file-status-${kind}`}>{FILE_STATUS_LABELS[kind]}</span><span className="file-path">{file.path}</span></li>; })
            : <li className="status-files-empty">No changes in this view.</li>}
        </ul>
      : <pre className="diff" data-testid="repository-diff"><DiffText text={view.loading ? 'Loading diff…' : text || 'No changes in this view.'} /></pre>}
  </div>;
}
