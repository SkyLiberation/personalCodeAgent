import type { TaskState } from "../task-contracts.js";

export interface WorkflowNode { id: string; dependsOn: string[]; run(signal: AbortSignal): Promise<TaskState> }
/** Host composition of independent durable controllers; dependencies consume verified success only. */
export async function runWorkflow(nodes: WorkflowNode[], options: { concurrency: number; signal: AbortSignal }): Promise<Record<string, { status: "succeeded" | "failed" | "blocked" | "cancelled"; task?: TaskState; reason?: string }>> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error("workflow_concurrency_invalid");
  const map = new Map(nodes.map(n => [n.id, n])); if (map.size !== nodes.length || nodes.some(n => !n.id || n.dependsOn.some(id => !map.has(id) || id === n.id))) throw new Error("workflow_dependency_invalid");
  const visiting = new Set<string>(); const visited = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw new Error("workflow_cycle"); if (visited.has(id)) return; visiting.add(id); for (const dep of map.get(id)!.dependsOn) visit(dep); visiting.delete(id); visited.add(id); }
  for (const node of nodes) visit(node.id);
  const results: Record<string, { status: "succeeded" | "failed" | "blocked" | "cancelled"; task?: TaskState; reason?: string }> = {};
  const running = new Map<string, Promise<void>>(); const pending = new Set(map.keys());
  while (pending.size || running.size) {
    for (const id of [...pending]) {
      const node = map.get(id)!;
      if (options.signal.aborted) { results[id] = { status: "cancelled" }; pending.delete(id); continue; }
      if (node.dependsOn.some(dep => results[dep] && results[dep]!.status !== "succeeded")) { results[id] = { status: "blocked", reason: "dependency_not_verified" }; pending.delete(id); continue; }
      if (running.size >= options.concurrency || node.dependsOn.some(dep => !results[dep])) continue;
      pending.delete(id);
      const execution = Promise.resolve().then(() => node.run(options.signal)).then(task => {
        results[id] = { status: task.status === "succeeded" && task.finalEvidenceIds.length ? "succeeded" : options.signal.aborted ? "cancelled" : "failed", task };
      }, error => { results[id] = { status: options.signal.aborted ? "cancelled" : "failed", reason: error instanceof Error ? error.message : String(error) }; }).finally(() => { running.delete(id); });
      running.set(id, execution);
    }
    if (running.size) await Promise.race(running.values());
    else if (pending.size) throw new Error("workflow_deadlock");
  }
  return results;
}
