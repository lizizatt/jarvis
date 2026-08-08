export type TerminalCommand =
  | { action: 'create'; id: string; cwd: string; cols: number; rows: number }
  | { action: 'attach'; id: string }
  | { action: 'input'; id: string; data: string }
  | { action: 'resize'; id: string; cols: number; rows: number };

export type TerminalMessage =
  | { type: 'ready'; id: string; replay?: string }
  | { type: 'output'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number; signal?: number }
  | { type: 'missing'; id: string }
  | { type: 'error'; id?: string; message: string };
