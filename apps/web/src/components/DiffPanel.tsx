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

export function DiffPanel({ repositoryId }: { repositoryId: string }) {
  const [mode, setMode] = useState<'worktree' | 'staged'>('worktree');
  const diff = useLoad(() => api.diff(repositoryId, mode), [repositoryId, mode]);
  const pullRequest = useLoad(() => api.pullRequest(repositoryId), [repositoryId]);
  return <div className="changes-view" data-testid="changes-view">
    <section className="pr-strip"><GitPullRequest size={19} />{pullRequest.loading ? <span>Checking pull request…</span> : pullRequest.data ? <><div><strong>#{pullRequest.data.number} {pullRequest.data.title}</strong><span className={`pr-state state-${pullRequest.data.state}`}>{pullRequest.data.state}</span></div>{pullRequest.data.url && <a className="icon-button" href={pullRequest.data.url} target="_blank" rel="noreferrer" aria-label="Open pull request"><ExternalLink /></a>}</> : <span>No pull request for this branch</span>}</section>
    {pullRequest.data?.checks?.length ? <div className="checks">{pullRequest.data.checks.map((check) => <span key={check.name} className={`check check-${check.state}`}>{check.name}</span>)}</div> : null}
    <div className="section-toolbar"><div className="segmented" aria-label="Diff mode"><button className={mode === 'worktree' ? 'active' : ''} onClick={() => setMode('worktree')}>Worktree</button><button className={mode === 'staged' ? 'active' : ''} onClick={() => setMode('staged')}>Staged</button></div><button className="icon-button" aria-label="Refresh diff" onClick={() => void diff.reload()}><RefreshCw size={18} /></button></div>
    {diff.error && <div className="notice error">{diff.error}</div>}
    <pre className="diff" data-testid="repository-diff"><DiffText text={diff.loading ? 'Loading diff…' : diff.data || 'No changes in this view.'} /></pre>
  </div>;
}
