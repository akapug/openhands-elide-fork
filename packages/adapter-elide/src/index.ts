import type {
  Runtime,
  RuntimeInitOptions,
  SessionId,
  ExecResult,
} from "@openhands-elide/runtime-core";

export interface ElideConfig {
  allowHostReadPaths?: string[];
  allowOutboundNet?: boolean;
  pythonFallback?: { enabled: boolean; pythonBin?: string };
}

export class ElideRuntime implements Runtime {
  constructor(private readonly config: ElideConfig = {}) {}

  async init(_opts?: RuntimeInitOptions): Promise<SessionId> {
    // TODO: Initialize Elide guest VFS and session
    throw new Error("ElideRuntime.init not implemented");
  }
  async dispose(_session: SessionId): Promise<void> {
    // TODO: Tear down Elide guest session
    throw new Error("ElideRuntime.dispose not implemented");
  }

  async write(_s: SessionId, _path: string, _data: string | Buffer): Promise<void> {
    throw new Error("ElideRuntime.write not implemented");
  }
  async read(_s: SessionId, _path: string): Promise<string | Buffer> {
    throw new Error("ElideRuntime.read not implemented");
  }
  async list(_s: SessionId, _path: string): Promise<string[]> {
    throw new Error("ElideRuntime.list not implemented");
  }

  async execShell(
    _s: SessionId,
    _cmd: string,
    _args?: string[],
    _opts?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    throw new Error("ElideRuntime.execShell not implemented");
  }
  async execJS(_s: SessionId, _code: string): Promise<ExecResult> {
    throw new Error("ElideRuntime.execJS not implemented");
  }
  async execPy(_s: SessionId, _code: string): Promise<ExecResult> {
    throw new Error("ElideRuntime.execPy not implemented");
  }

  async snapshot(_s: SessionId): Promise<Buffer> {
    throw new Error("ElideRuntime.snapshot not implemented");
  }
  async restore(_snapshot: Buffer): Promise<SessionId> {
    throw new Error("ElideRuntime.restore not implemented");
  }

  async info(): Promise<{ name: "elide" | "docker"; version: string; features: string[] }> {
    return { name: "elide", version: "0.0.0-dev", features: [] };
  }
}

