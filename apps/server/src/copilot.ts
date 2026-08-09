import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };
const CACHE_TTL_MS = 60_000;

export interface CopilotUsage {
  creditsUsed: number;
  quotaResetDate: string;
  timestamp: string;
}

export class CopilotUsageFetcher {
  private cached: CopilotUsage | null = null;
  private cachedAt = 0;

  async current(): Promise<CopilotUsage | null> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_TTL_MS) return this.cached;
    const fresh = await this.fetch();
    if (fresh) { this.cached = fresh; this.cachedAt = Date.now(); }
    return fresh ?? this.cached;
  }

  private async fetch(): Promise<CopilotUsage | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['api', '/copilot_internal/user'], EXEC_OPTIONS);
      const data = JSON.parse(stdout) as Record<string, unknown>;
      const snapshots = data['quota_snapshots'] as Record<string, unknown> | undefined;
      const premium = snapshots?.['premium_interactions'] as Record<string, unknown> | undefined;
      const creditsUsed = premium?.['credits_used'];
      const quotaResetDate = data['quota_reset_date_utc'];
      if (typeof creditsUsed !== 'number' || typeof quotaResetDate !== 'string') return null;
      return { creditsUsed, quotaResetDate, timestamp: new Date().toISOString() };
    } catch {
      return null;
    }
  }
}
