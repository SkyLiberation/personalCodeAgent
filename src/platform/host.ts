import { LinuxHost } from "./linux.js";

export interface ExecutionLease { close(): Promise<void> }
export interface ProcessResult { stdout: string; stderr: string; output: string; exitCode: number; timedOut: boolean }

export interface ExecutionHost {
  acquire(path: string): Promise<ExecutionLease>;
  restoreProcessGroups(path: string): Promise<void>;
  exec(executable: string, args: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ProcessResult>;
  close(): Promise<void>;
}

export function assertLinuxPlatform(): void {
  if (process.platform !== "linux") throw new Error(`unsupported_platform: Linux required; received ${process.platform}`);
}

export async function createExecutionHost(): Promise<ExecutionHost> {
  assertLinuxPlatform();
  return LinuxHost.create();
}
