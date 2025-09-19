import type {
  Runtime,
  RuntimeInitOptions,
  SessionId,
  ExecResult,
} from "@openhands-elide/runtime-core";

export interface DockerConfig {
  image?: string;
  cpuShares?: number;
  memoryMb?: number;
  timeoutMs?: number;
}

export class DockerRuntime implements Runtime {
  constructor(private readonly config: DockerConfig = {}) {}

  async init(_opts?: RuntimeInitOptions): Promise<SessionId> {
    throw new Error("DockerRuntime.init not implemented");
  }
  async dispose(_session: SessionId): Promise<void> {
    throw new Error("DockerRuntime.dispose not implemented");
  }

  async write(_s: SessionId, _path: string, _data: string | Buffer): Promise<void> {
    throw new Error("DockerRuntime.write not implemented");
  }
  async read(_s: SessionId, _path: string): Promise<string | Buffer> {
    throw new Error("DockerRuntime.read not implemented");
  }
  async list(_s: SessionId, _path: string): Promise<string[]> {
    throw new Error("DockerRuntime.list not implemented");
  }

  async execShell(
    _s: SessionId,
    _cmd: string,
    _args?: string[],
    _opts?: { timeoutMs?: number }
  ): Promise<ExecResult> {
    throw new Error("DockerRuntime.execShell not implemented");
  }
  async execJS(_s: SessionId, _code: string): Promise<ExecResult> {
    throw new Error("DockerRuntime.execJS not implemented");
  }
  async execPy(_s: SessionId, _code: string): Promise<ExecResult> {
    throw new Error("DockerRuntime.execPy not implemented");
  }

  async snapshot(_s: SessionId): Promise<Buffer> {
    throw new Error("DockerRuntime.snapshot not implemented");
  }
  async restore(_snapshot: Buffer): Promise<SessionId> {
    throw new Error("DockerRuntime.restore not implemented");
  }

  async info(): Promise<{ name: "elide" | "docker"; version: string; features: string[] }> {
    return { name: "docker", version: "0.0.0-dev", features: [] };
  }
}

