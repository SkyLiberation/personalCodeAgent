import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { LocalEnvironment, isPrivatePath } from "../environment/local.js";
import { errorText, SecretRedactor, throwIfAborted } from "../security.js";
import type { TaskRepository } from "../storage/task.js";
import type { TaskDefinition, VerificationEvidence, VerificationSpec } from "../task-contracts.js";
import type { ExecutionHost } from "../platform/host.js";

export function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export async function trustedHashes(spec: TaskDefinition): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of new Set(spec.verifiers.flatMap(v => v.trustedFiles))) hashes[file] = hash(await readFile(file));
  return hashes;
}

export async function inputFingerprint(environment: LocalEnvironment, inputs: readonly string[]): Promise<string> {
  const records: [string, string][] = [];
  const visited = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    if (isPrivatePath(relative)) return;
    const path = await environment.path(relative);
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { records.push([relative, "missing"]); return; }
      throw error;
    }
    if (info.isDirectory()) {
      const canonical = await realpath(path);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      records.push([relative, "directory"]);
      for (const name of (await readdir(path)).sort()) {
        if (!["node_modules", ".git"].includes(name)) await visit(join(relative, name));
      }
    } else if (info.isFile()) records.push([relative, hash(await readFile(path))]);
    else throw new Error(`不支持的验收输入类型：${relative}`);
  };
  for (const input of [...new Set(inputs)].sort()) await visit(input);
  return hash(JSON.stringify(records));
}

interface CheckReport { checks: number; passed: number; failures: string[] }
function parseReport(stdout: string): CheckReport {
  const lastLine = stdout.trim().split(/\r?\n/).at(-1);
  const report = JSON.parse(lastLine ?? "") as Partial<CheckReport>;
  if (!Number.isSafeInteger(report.checks) || report.checks! < 1 || !Number.isSafeInteger(report.passed) ||
      report.passed! < 0 || report.passed! > report.checks! || !Array.isArray(report.failures) ||
      report.failures.some(value => typeof value !== "string")) throw new Error("验收报告必须包含实际执行的 checks / passed / failures");
  return report as CheckReport;
}

export class Verifier {
  constructor(private readonly repository: TaskRepository, private readonly redactor: SecretRedactor, private readonly host?: ExecutionHost) {}

  async verify(spec: VerificationSpec, signal: AbortSignal, sessionCursor: string | null): Promise<VerificationEvidence> {
    throwIfAborted(signal);
    const state = this.repository.view();
    const environment = await LocalEnvironment.create(state.spec.workspaceRoot, spec.timeoutMs, this.host);
    const evidence: VerificationEvidence = {
      id: randomUUID(), taskId: state.id, specVersion: state.specVersion, verificationId: spec.id,
      inputFingerprint: "", verifierManifestHash: state.verifierManifestHash, artifactHashes: {},
      result: "unavailable", checks: 0, passed: 0, failures: [], reportArtifact: "", sessionCursor, observedAt: Date.now(),
    };
    let execution: unknown;
    try {
      const beforeTrusted = await trustedHashes(state.spec);
      if (JSON.stringify(beforeTrusted) !== JSON.stringify(state.trustedHashes)) throw new Error("trusted_file_changed：可信验收文件或不可修改的输入被改变");
      evidence.inputFingerprint = await inputFingerprint(environment, spec.inputs);
      const process = await environment.exec(spec.command, spec.args, signal);
      execution = this.redactor.json(process);
      throwIfAborted(signal);
      if (process.timedOut) throw new Error("verification_timeout：验收程序超时");
      const report = parseReport(process.stdout);
      evidence.checks = report.checks;
      evidence.passed = report.passed;
      evidence.failures = report.failures;
      if (JSON.stringify(await trustedHashes(state.spec)) !== JSON.stringify(state.trustedHashes)) throw new Error("trusted_file_changed：验收期间可信文件被改变");
      if (await inputFingerprint(environment, spec.inputs) !== evidence.inputFingerprint) throw new Error("verification_inputs_changed：验收期间源码或输入被改变");
      evidence.result = process.exitCode === 0 && report.passed === report.checks && !report.failures.length ? "passed" : "failed";
      if (evidence.result === "failed" && !evidence.failures.length) evidence.failures.push(`验收退出码 ${process.exitCode} 或通过数量不匹配`);
      if (evidence.result === "passed") {
        for (const output of spec.outputs) {
          const path = await environment.path(output);
          try { evidence.artifactHashes[output] = hash(await readFile(path)); }
          catch (error) {
            evidence.result = "failed";
            evidence.failures.push(`缺少预期产物 ${output}：${errorText(error)}`);
          }
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      evidence.result = "unavailable";
      evidence.failures = [errorText(error)];
    }
    const safe = this.redactor.json(evidence);
    safe.reportArtifact = await this.repository.artifact(evidence.id, { evidence: safe, execution });
    return safe;
  }
}
