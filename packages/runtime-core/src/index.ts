export type SessionId = string;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number;
}

export interface RuntimeInitOptions {
  workspaceName?: string;
  seedFiles?: Array<{ path: string; contents: string | Buffer }>;
  env?: Record<string, string>;
  net?: { allowOutbound: boolean; allowlist?: string[] };
  fs?: { persist?: boolean; readOnly?: string[] };
}

export interface Runtime {
  init(opts?: RuntimeInitOptions): Promise<SessionId>;
  dispose(session: SessionId): Promise<void>;

  write(session: SessionId, path: string, data: string | Buffer): Promise<void>;
  read(session: SessionId, path: string): Promise<string | Buffer>;
  list(session: SessionId, path: string): Promise<string[]>;

  execShell(
    session: SessionId,
    cmd: string,
    args?: string[],
    opts?: { timeoutMs?: number }
  ): Promise<ExecResult>;
  execJS(session: SessionId, code: string): Promise<ExecResult>;
  execPy(session: SessionId, code: string): Promise<ExecResult>;

  snapshot(session: SessionId): Promise<Buffer>;
  restore(snapshot: Buffer): Promise<SessionId>;

  info(): Promise<{ name: "elide" | "docker"; version: string; features: string[] }>;
}

