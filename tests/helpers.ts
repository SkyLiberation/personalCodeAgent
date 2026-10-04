import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { TestContext } from "node:test";
import type { AgentConfig } from "../src/config.js";
import type { AssistantMessage, ModelGateway, ModelRequest, ToolCall } from "../src/contracts.js";

export const config: AgentConfig = {
  apiKey: "unit-test-secret", modelId: "mimo-v2.6-flash", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  thinking: "low", maxTurns: 5, requestTimeoutMs: 5000, toolTimeoutMs: 5000,
};

export async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "personal-code-agent-tests-"));
  const cwd = join(root, "workspace");
  const dataDirectory = join(root, "sessions");
  const cleanups: Array<() => Promise<void>> = [];
  await mkdir(cwd);
  context.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    const target = resolve(root);
    const rel = relative(resolve(tmpdir()), target);
    if (!basename(target).startsWith("personal-code-agent-tests-") || rel.startsWith(`..${sep}`) || rel === "..") {
      throw new Error("Refusing to remove a directory outside this test fixture");
    }
    await rm(target, { recursive: true, force: true });
  });
  return { root, cwd, dataDirectory, cleanupAfter: (cleanup: () => Promise<void>) => { cleanups.push(cleanup); } };
}

export function assistant(text = "done", toolCalls: ToolCall[] = []): AssistantMessage {
  return { role: "assistant", text, toolCalls, stopReason: toolCalls.length ? "tool_calls" : "stop", timestamp: Date.now() };
}

export class FakeGateway implements ModelGateway {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly answer: (request: ModelRequest, signal: AbortSignal, index: number) =>
    AssistantMessage | Promise<AssistantMessage>) {}

  async *stream(request: ModelRequest, signal: AbortSignal) {
    const index = this.requests.length;
    this.requests.push(structuredClone(request));
    const message = await this.answer(request, signal, index);
    if (message.text) yield { type: "text_delta" as const, delta: message.text };
    yield { type: "done" as const, message };
  }
}
