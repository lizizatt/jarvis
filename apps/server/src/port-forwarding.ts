import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { encoding: 'utf8' as const, timeout: 10_000 };

export interface PortForward {
  port: number;
  url: string;
}

export class PortForwarder {
  constructor(private readonly executable = 'tailscale') {}

  async expose(port: number): Promise<PortForward> {
    validatePort(port);
    const { stdout } = await execFileAsync(this.executable, ['status', '--json'], EXEC_OPTIONS);
    const dnsName = tailscaleDnsName(stdout);
    await execFileAsync(this.executable, [
      'serve', '--bg', '--yes', `--https=${port}`, `http://127.0.0.1:${port}`,
    ], EXEC_OPTIONS);
    return { port, url: `https://${dnsName}:${port}/` };
  }

  async close(port: number): Promise<void> {
    validatePort(port);
    await execFileAsync(this.executable, [
      'serve', '--yes', `--https=${port}`, 'off',
    ], EXEC_OPTIONS);
  }

  // Reads live Serve config rather than tracking state locally, since it also survives Jarvis restarts.
  async list(): Promise<PortForward[]> {
    const { stdout } = await execFileAsync(this.executable, ['serve', 'status', '--json'], EXEC_OPTIONS);
    const status = JSON.parse(stdout) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    const forwards: PortForward[] = [];
    for (const [hostPort, entry] of Object.entries(status.Web ?? {})) {
      const hostMatch = hostPort.match(/^(.+):(\d+)$/);
      const proxyMatch = entry.Handlers?.['/']?.Proxy?.match(/^http:\/\/127\.0\.0\.1:(\d+)\/?$/);
      // Only surface our own self-mapped (front port === backend port) forwards, not Jarvis's own 443 binding.
      if (!hostMatch || !proxyMatch || hostMatch[2] !== proxyMatch[1]) continue;
      forwards.push({ port: Number(hostMatch[2]), url: `https://${hostPort}/` });
    }
    return forwards.sort((a, b) => a.port - b.port);
  }
}

export function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
}

function tailscaleDnsName(output: string): string {
  const status = JSON.parse(output) as { Self?: { DNSName?: unknown } };
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName !== 'string' || !dnsName.trim()) throw new Error('Tailscale did not report a device DNS name');
  return dnsName.replace(/\.$/, '');
}
