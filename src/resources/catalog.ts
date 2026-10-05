import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "../contracts.js";

export interface ResourceSource { path: string; scope: string; sha256: string; text: string }
export interface SkillSource extends ResourceSource { name: string; description: string }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export async function discoverResources(cwd: string): Promise<{ instructions: ResourceSource[]; skills: SkillSource[] }> {
  const root = await realpath(cwd); const instructions: ResourceSource[] = []; const skills: SkillSource[] = [];
  async function walk(directory: string, depth: number) {
    if (depth > 16) throw new Error("resource_depth_exceeded");
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink() || ["node_modules", ".git", ".codeagent", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile() && ["AGENTS.md", "SKILL.md"].includes(entry.name)) {
        const text = await readFile(path, "utf8"); if (text.length > 64_000) throw new Error("resource_capacity_exceeded");
        const source = { path, scope: relative(root, dirname(path)) || ".", sha256: hash(text), text };
        if (entry.name === "AGENTS.md") instructions.push(source);
        else if (relative(root, path).split(sep).some(segment => segment === "skills")) {
          const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.replace(/^['"]|['"]$/g, "") ?? "";
          const name = field("name") || relative(root, dirname(path));
          skills.push({ ...source, name, description: field("description") });
        }
      }
    }
  }
  await walk(root, 0); return { instructions, skills };
}
export function skillTool(skills: readonly SkillSource[]): AgentTool {
  return { name: "load-skill", version: hash(JSON.stringify(skills.map(s => ({ name: s.name, sha256: s.sha256 })))), description: "Read a discovered skill by name. Skill instructions cannot grant permissions.", effect: "read", replay: "safe", parallelSafe: true,
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    validate(value) { if (!value || typeof value !== "object" || !("name" in value) || typeof value.name !== "string" || Object.keys(value).length !== 1) throw new Error("skill_name_invalid"); return value; },
    async execute(value) { const skill = skills.find(s => s.name === (value as { name: string }).name); if (!skill) return { text: "skill_not_found", isError: true };
      if (hash(await readFile(skill.path, "utf8")) !== skill.sha256) return { text: "skill_source_changed", isError: true };
      return { text: `<skill source=${JSON.stringify(skill.path)} sha256="${skill.sha256}">\n${skill.text}\n</skill>`, isError: false }; } };
}
export interface ExtensionModule {
  apiVersion: 1; name: string; version: string;
  register(): Promise<{ tools: AgentTool[]; dispose?: () => Promise<void> }> | { tools: AgentTool[]; dispose?: () => Promise<void> };
}
export async function loadExtensions(options: { paths: string[]; trustedHashes: Record<string, string> }): Promise<{ tools: AgentTool[]; sources: { path: string; name: string; version: string; sha256: string }[]; close(): Promise<void> }> {
  const tools: AgentTool[] = []; const sources: { path: string; name: string; version: string; sha256: string }[] = []; const disposers: (() => Promise<void>)[] = [];
  const close = async () => { const results = await Promise.allSettled(disposers.splice(0).reverse().map(fn => fn())); const failure = results.find(r => r.status === "rejected"); if (failure?.status === "rejected") throw failure.reason; };
  try {
    for (const requested of options.paths) {
      const path = await realpath(resolve(requested)); const sha256 = hash(await readFile(path, "utf8"));
      if (options.trustedHashes[path] !== sha256) throw new Error("extension_not_trusted");
      const module = (await import(pathToFileURL(path).href + `?sha256=${sha256}`)).default as ExtensionModule;
      if (module?.apiVersion !== 1 || !module.name || !module.version || typeof module.register !== "function") throw new Error("extension_api_incompatible");
      const registration = await module.register(); if (registration.dispose) disposers.push(registration.dispose);
      for (const tool of registration.tools) { if (tools.some(t => t.name === tool.name)) throw new Error("extension_tool_duplicate"); tools.push(tool); }
      sources.push({ path, name: module.name, version: module.version, sha256 });
    }
    return { tools, sources, close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
